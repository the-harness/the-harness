import { dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import MagicString from "magic-string";
import {
  parseAst,
  type EnvironmentModuleGraph,
  type EnvironmentModuleNode,
  type Plugin,
  type TransformResult,
} from "vite-plus";
import { getOrCreate } from "./collections.ts";
import type { Rebind, Settled } from "./hot.ts";

export interface DiHmrPluginOptions {
  // Modules whose state other modules rely on (registries, the composition root's holders) must stay
  // out, so their updates re-run their importers instead of replacing them in place.
  readonly include: (id: string) => boolean;
}

interface HotModuleNode {
  readonly id: string | null;
  readonly isSelfAccepting?: boolean;
  readonly importers: Set<HotModuleNode>;
  readonly acceptedHmrDeps: Set<HotModuleNode>;
}

interface Node {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [key: string]: any;
}

// Re-exported names of a source: [name in the source, name exported here]; "*" re-exports every
// name as is, ["*", ns] exports the namespace.
type ReexportNames = Array<readonly [from: string, to: string]>;

interface ExportAnalysis {
  readonly reexports: ReadonlyMap<string, ReexportNames>;
  readonly forwarded: ReadonlySet<string>;
  // Initializers of forwarded function variables, wrapped in place; declarations are hoisted.
  readonly forwardedVariables: ReadonlyMap<string, Node>;
  readonly values: ReadonlyMap<string, string>;
  // Initializers of const class bindings, wrapped in place: the binding stays const.
  readonly constClasses: ReadonlyMap<string, Node>;
  // Initializers of exported value declarations, wrapped in place to keep equal plain data.
  readonly dataVariables: ReadonlyMap<string, Node>;
  readonly classes: ReadonlyMap<string, number>;
  readonly signature: string;
  // An anonymous default export, given the binding DEFAULT_LOCAL by the transform.
  readonly anonymousDefault: { readonly statement: Node; readonly node: Node } | undefined;
  // `const x = defineSetup(fn)`: the call and its function.
  readonly setupUnits: ReadonlyMap<string, { readonly call: Node; readonly fn: Node }>;
}

interface ImportAnalysis {
  // Imported names used other than as an identity handed to DI, by source specifier.
  readonly sensitive: ReadonlyMap<string, ReadonlySet<string>>;
  // Imported bindings exported again.
  readonly reexports: ReadonlyMap<string, ReexportNames>;
  // Every imported source, also those without sensitive uses.
  readonly sources: ReadonlySet<string>;
}

const DI_SOURCE = /^@harness\/(?:ui-)?di$|\/packages\/(?:ui-)?di\/src\/index\.ts$/;
// DI resolves any version of a class handed to these to the latest one.
const IDENTITY_CALLEES = new Set([
  "inject",
  "optionalInject",
  "createDescriptor",
  "useService",
  "useOptionalService",
]);

const RUNTIME_PATH = fileURLToPath(new URL("./hot.ts", import.meta.url));
const HMR_ID = "__harness_hmr__";
const CREATE_ID = "__harness_hmr_create__";
// Binding of an anonymous default export; the runtime names its function or class "default".
const DEFAULT_LOCAL = "__harness_default";

function label(name: string): string {
  return JSON.stringify(name === DEFAULT_LOCAL ? "default" : name);
}

function classCall(name: string): string {
  return `${name} = ${HMR_ID}.class(${label(name)}, ${name});`;
}

function forwardCall(name: string): string {
  return `${name} = ${HMR_ID}.fn(${label(name)}, ${name});`;
}

function cleanModuleId(id: string): string | undefined {
  return id.includes("?") || id.includes("\0") ? undefined : id;
}

// The hot runtime cannot instrument itself, and re-executing it would split its registries.
function isHotRuntime(id: string): boolean {
  return id.includes("/packages/di/src/") || id.includes("/packages/hot/src/");
}

// Mirrors Vite's propagation: modules up to and including the accepting boundaries re-execute.
function reachesHotRuntime(start: Iterable<HotModuleNode>): boolean {
  const seen = new Set<HotModuleNode>();
  const queue = [...start];
  while (queue.length > 0) {
    const mod = queue.pop()!;
    if (seen.has(mod)) continue;
    seen.add(mod);
    if (mod.id !== null && isHotRuntime(mod.id)) return true;
    if (mod.isSelfAccepting) continue;
    for (const importer of mod.importers) {
      if (!importer.acceptedHmrDeps.has(mod)) queue.push(importer);
    }
  }
  return false;
}

// Instrumented modules may not depend on @harness/di, so the runtime is imported by path.
function runtimeSpecifier(fromFile: string): string {
  const specifier = relative(dirname(fromFile), RUNTIME_PATH).split(sep).join("/");
  return specifier.startsWith(".") ? specifier : `./${specifier}`;
}

function isFunctionNode(node: Node | null | undefined): boolean {
  return node?.type === "ArrowFunctionExpression" || node?.type === "FunctionExpression";
}

function hasTopLevelAwait(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasTopLevelAwait);
  if (node === null || typeof node !== "object") return false;
  const { type } = node as Node;
  // Class bodies are walked: computed keys evaluate at the top level.
  if (
    type === "FunctionDeclaration" ||
    type === "FunctionExpression" ||
    type === "ArrowFunctionExpression"
  ) {
    return false;
  }
  if (type === "AwaitExpression") return true;
  if (type === "ForOfStatement" && (node as Node).await) return true;
  if (type === "VariableDeclaration" && (node as Node).kind === "await using") return true;
  return Object.values(node).some(hasTopLevelAwait);
}

const READ_ONLY_IMPORT_META = new Set(["url", "env", "dirname", "filename", "resolve", "main", "glob"]);

// Any use of import.meta other than these read-only properties may reach import.meta.hot.
function usesImportMetaHot(body: readonly Node[]): boolean {
  let uses = false;
  visit(body, undefined, (node, parent) => {
    if (node.type !== "MetaProperty" || node.meta.name !== "import") return;
    const readOnly =
      parent?.type === "MemberExpression" &&
      parent.object === node &&
      !parent.computed &&
      READ_ONLY_IMPORT_META.has(parent.property.name);
    if (!readOnly) uses = true;
  });
  return uses;
}

// A forwarder cannot expose properties written to the function it stands for, nor serve as its
// prototype owner, so such functions stay plain values. Over-approximates (ignores shadowing).
function functionsWithProperties(body: readonly Node[]): Set<string> {
  const names = new Set<string>();
  const target = (node: Node | undefined): void => {
    if (node?.type === "MemberExpression" && node.object.type === "Identifier") {
      names.add(node.object.name);
    }
  };
  visit(body, undefined, (node) => {
    if (node.type === "AssignmentExpression") target(node.left);
    else if (node.type === "UpdateExpression") target(node.argument);
    else if (node.type === "UnaryExpression" && node.operator === "delete") target(node.argument);
    else if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      node.callee.object.type === "Identifier" &&
      node.callee.object.name === "Object" &&
      node.arguments[0]?.type === "Identifier"
    ) {
      names.add(node.arguments[0].name);
    } else if (
      node.type === "MemberExpression" &&
      !node.computed &&
      node.property.name === "prototype" &&
      node.object.type === "Identifier"
    ) {
      names.add(node.object.name);
    }
  });
  return names;
}

function reassignedNames(body: readonly Node[]): Set<string> {
  const names: string[] = [];
  visit(body, undefined, (node) => {
    if (node.type === "AssignmentExpression") {
      if (node.left.type === "Identifier") names.push(node.left.name);
      else if (node.left.type === "ObjectPattern" || node.left.type === "ArrayPattern") {
        patternNames(node.left, names);
      }
    } else if (node.type === "UpdateExpression" && node.argument.type === "Identifier") {
      names.push(node.argument.name);
    } else if (
      (node.type === "ForInStatement" || node.type === "ForOfStatement") &&
      node.left.type === "Identifier"
    ) {
      names.push(node.left.name);
    }
  });
  return new Set(names);
}

function functionKind(fn: Node): string {
  return `${fn.type === "ArrowFunctionExpression" ? "arrow" : "function"}${fn.async ? "-async" : ""}${fn.generator ? "-generator" : ""}`;
}

function refersToOwnName(fn: Node): boolean {
  const name = fn.type === "FunctionExpression" ? fn.id?.name : undefined;
  if (name === undefined) return false;
  let refers = false;
  visit(fn.body, fn, (node, parent) => {
    if (node.type === "Identifier" && node.name === name && isReference(node, parent)) refers = true;
  });
  return refers;
}

function patternNames(pattern: Node, names: string[]): void {
  switch (pattern.type) {
    case "Identifier":
      names.push(pattern.name);
      break;
    case "ObjectPattern":
      for (const property of pattern.properties) {
        patternNames(property.type === "RestElement" ? property.argument : property.value, names);
      }
      break;
    case "ArrayPattern":
      for (const element of pattern.elements) if (element) patternNames(element, names);
      break;
    case "RestElement":
      patternNames(pattern.argument, names);
      break;
    case "AssignmentPattern":
      patternNames(pattern.left, names);
      break;
  }
}

function moduleExportName(node: Node): string {
  return node.type === "Identifier" ? node.name : String(node.value);
}

// Local bindings of the import declarations; a namespace import imports "*".
function importBindings(body: readonly Node[]) {
  return body.flatMap((statement) =>
    statement.type !== "ImportDeclaration"
      ? []
      : statement.specifiers.map((specifier: Node) => ({
          local: specifier.local.name as string,
          source: String(statement.source.value),
          imported:
            specifier.type === "ImportNamespaceSpecifier"
              ? "*"
              : specifier.type === "ImportDefaultSpecifier"
                ? "default"
                : moduleExportName(specifier.imported),
        })),
  );
}

function analyzeExports(
  body: readonly Node[],
  forwardFunctions: boolean,
): ExportAnalysis | undefined {
  const functions = new Set<string>();
  const functionVariables = new Map<string, Node>();
  // A forwarder takes the shape of the first implementation: a different kind re-binds importers.
  const functionKinds = new Map<string, string>();
  const dataVariables = new Map<string, Node>();
  // Top-level class bindings and the end of the statement that declares them.
  const classes = new Map<string, number>();
  const constClasses = new Map<string, Node>();
  // Local import bindings -> "source#imported", so a re-export switching sources changes the signature.
  const imported = new Map<string, string>();
  const defineSetupLocals = new Set<string>();
  const setupUnits = new Map<string, { readonly call: Node; readonly fn: Node }>();
  for (const { local, source, imported: name } of importBindings(body)) {
    imported.set(local, `${source}#${name}`);
    if (name === "defineSetup" && DI_SOURCE.test(source)) defineSetupLocals.add(local);
  }
  const setupUnitFn = (init: Node | null | undefined): Node | undefined => {
    if (
      init?.type !== "CallExpression" ||
      init.callee.type !== "Identifier" ||
      !defineSetupLocals.has(init.callee.name) ||
      init.arguments.length !== 1
    ) {
      return undefined;
    }
    const fn = init.arguments[0];
    return isFunctionNode(fn) && !refersToOwnName(fn) ? fn : undefined;
  };
  const declare = (statement: Node | null | undefined, end: number): void => {
    if (!statement) return;
    if (statement.type === "FunctionDeclaration" && statement.id) {
      functions.add(statement.id.name);
      functionKinds.set(statement.id.name, functionKind(statement));
    } else if (statement.type === "ClassDeclaration" && statement.id) {
      classes.set(statement.id.name, end);
    } else if (statement.type === "VariableDeclaration") {
      for (const declarator of statement.declarations) {
        if (declarator.id.type !== "Identifier") continue;
        if (isFunctionNode(declarator.init)) {
          // A named function expression calling or constructing itself by its own name would
          // reach the implementation, not the forwarder: it stays a value.
          if (!refersToOwnName(declarator.init)) {
            functionVariables.set(declarator.id.name, declarator.init);
            functionKinds.set(declarator.id.name, functionKind(declarator.init));
          }
        } else if (statement.kind === "const" && setupUnitFn(declarator.init) !== undefined) {
          setupUnits.set(declarator.id.name, { call: declarator.init, fn: setupUnitFn(declarator.init)! });
        } else if (
          declarator.init &&
          declarator.init.type !== "ClassExpression" &&
          declarator.init.type !== "SequenceExpression"
        ) {
          dataVariables.set(declarator.id.name, declarator.init);
        } else if (declarator.init?.type === "ClassExpression") {
          if (statement.kind === "const") constClasses.set(declarator.id.name, declarator.init);
          else classes.set(declarator.id.name, end);
        }
      }
    }
  };
  for (const statement of body) {
    declare(
      statement.type.startsWith("Export") ? statement.declaration : statement,
      statement.end,
    );
  }

  const exported: Array<readonly [exported: string, local: string]> = [];
  const signature: string[] = [];
  const reexports = new Map<string, ReexportNames>();
  const reexport = (source: string, from: string, to: string): void => {
    getOrCreate(reexports, source, () => []).push([from, to]);
  };
  let anonymousDefault: ExportAnalysis["anonymousDefault"];
  for (const statement of body) {
    if (statement.type === "ExportAllDeclaration") {
      const name = statement.exported ? moduleExportName(statement.exported) : "*";
      signature.push(`${name}=*@${statement.source.value}`);
      reexport(String(statement.source.value), "*", name);
    } else if (statement.type === "ExportNamedDeclaration") {
      if (statement.source) {
        for (const specifier of statement.specifiers) {
          const from = moduleExportName(specifier.local);
          const to = moduleExportName(specifier.exported);
          signature.push(`${to}=${from}@${statement.source.value}`);
          reexport(String(statement.source.value), from, to);
        }
        continue;
      }
      const declaration = statement.declaration as Node | null;
      if (declaration?.type === "FunctionDeclaration" || declaration?.type === "ClassDeclaration") {
        exported.push([declaration.id.name, declaration.id.name]);
      } else if (declaration?.type === "VariableDeclaration") {
        const names: string[] = [];
        for (const declarator of declaration.declarations) patternNames(declarator.id, names);
        for (const name of names) exported.push([name, name]);
      } else if (declaration) {
        return undefined;
      }
      for (const specifier of statement.specifiers) {
        if (specifier.local.type !== "Identifier") return undefined;
        const name = moduleExportName(specifier.exported);
        // Re-exported imports are tracked as re-exports; reading them here could hit an
        // uninitialized binding in an import cycle.
        const origin = imported.get(specifier.local.name);
        if (origin !== undefined) signature.push(`${name}=import:${origin}`);
        else exported.push([name, specifier.local.name]);
      }
    } else if (statement.type === "ExportDefaultDeclaration") {
      const declaration = statement.declaration as Node;
      if (
        (declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") &&
        declaration.id
      ) {
        exported.push(["default", declaration.id.name]);
      } else {
        // Given a binding, an anonymous default export is forwarded, linked or compared like any
        // other: a declaration keeps hoisting under the inserted name, an expression becomes the
        // initializer of a const.
        anonymousDefault = { statement, node: declaration };
        if (declaration.type === "FunctionDeclaration") {
          functions.add(DEFAULT_LOCAL);
          functionKinds.set(DEFAULT_LOCAL, functionKind(declaration));
        } else if (declaration.type === "ClassDeclaration") {
          classes.set(DEFAULT_LOCAL, statement.end);
        } else if (isFunctionNode(declaration) && !refersToOwnName(declaration)) {
          functionVariables.set(DEFAULT_LOCAL, declaration);
          functionKinds.set(DEFAULT_LOCAL, functionKind(declaration));
        } else if (declaration.type === "ClassExpression") {
          constClasses.set(DEFAULT_LOCAL, declaration);
        } else if (declaration.type !== "SequenceExpression") {
          dataVariables.set(DEFAULT_LOCAL, declaration);
        }
        exported.push(["default", DEFAULT_LOCAL]);
      }
    }
  }
  if (exported.length === 0 && signature.length === 0) return undefined;

  const forwarded = new Set<string>();
  const forwardedVariables = new Map<string, Node>();
  const values = new Map<string, string>();
  const withProperties = functionsWithProperties(body);
  // Module code assigning the binding would replace the forwarder.
  const reassigned = reassignedNames(body);
  for (const [name, local] of exported) {
    if (!forwardFunctions || withProperties.has(local) || reassigned.has(local)) {
      values.set(name, local);
      signature.push(`${name}=v`);
    } else if (functions.has(local)) {
      forwarded.add(local);
      // The local is part of the signature: importers hold the forwarder of that local.
      signature.push(`${name}=f:${local}:${functionKinds.get(local)}`);
    } else if (functionVariables.has(local)) {
      forwarded.add(local);
      forwardedVariables.set(local, functionVariables.get(local)!);
      signature.push(`${name}=f:${local}:${functionKinds.get(local)}`);
    } else {
      values.set(name, local);
      signature.push(`${name}=v`);
    }
  }
  return {
    reexports,
    forwarded,
    forwardedVariables,
    values,
    constClasses,
    dataVariables: new Map([...dataVariables].filter(([local]) => [...values.values()].includes(local))),
    classes,
    signature: signature.sort().join("|"),
    anonymousDefault,
    setupUnits,
  };
}

function isReference(node: Node, parent: Node | undefined): boolean {
  if (parent === undefined) return true;
  switch (parent.type) {
    case "MemberExpression":
      return parent.object === node || parent.computed;
    case "Property":
      return parent.value === node || parent.computed;
    case "MethodDefinition":
    case "PropertyDefinition":
    case "AccessorProperty":
      return parent.key !== node || parent.computed;
    case "LabeledStatement":
    case "BreakStatement":
    case "ContinueStatement":
      return false;
    case "ExportSpecifier":
      return parent.local === node;
    default:
      return true;
  }
}

function visit(node: unknown, parent: Node | undefined, enter: (node: Node, parent: Node | undefined) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) visit(child, parent, enter);
    return;
  }
  if (node === null || typeof node !== "object" || typeof (node as Node).type !== "string") return;
  enter(node as Node, parent);
  for (const [key, child] of Object.entries(node)) {
    if (key !== "type" && typeof child === "object") visit(child, node as Node, enter);
  }
}

function declaredNames(body: readonly Node[]): Set<string> {
  const names: string[] = [];
  visit(body, undefined, (node) => {
    if (node.type === "VariableDeclarator") patternNames(node.id, names);
    else if (node.type === "CatchClause" && node.param) patternNames(node.param, names);
    else if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression"
    ) {
      if (node.id) names.push(node.id.name);
      for (const param of node.params) patternNames(param, names);
    } else if ((node.type === "ClassDeclaration" || node.type === "ClassExpression") && node.id) {
      names.push(node.id.name);
    }
  });
  return new Set(names);
}

// Imported names a module uses so that only re-evaluating it reaches a replaced class: construction,
// extension, static access and instanceof. Handing a class to DI by any means is redirected by DI.
function classUses(body: readonly Node[]): Map<string, Set<string>> {
  const bindings = new Map<string, { readonly source: string; readonly imported: string }>();
  const namespaces = new Map<string, string>();
  for (const { local, source, imported } of importBindings(body)) {
    if (imported === "*") namespaces.set(local, source);
    else bindings.set(local, { source, imported });
  }
  const holds = (node: Node, parent: Node): boolean =>
    (parent.type === "NewExpression" && parent.callee === node) ||
    ((parent.type === "ClassDeclaration" || parent.type === "ClassExpression") &&
      parent.superClass === node) ||
    (parent.type === "MemberExpression" && parent.object === node) ||
    (parent.type === "BinaryExpression" && parent.operator === "instanceof" && parent.right === node);
  const uses = new Map<string, Set<string>>();
  const use = (source: string, imported: string): void => {
    getOrCreate(uses, source, () => new Set()).add(imported);
  };
  visit(body, undefined, (node, parent) => {
    if (parent === undefined) return;
    if (node.type === "Identifier" && bindings.has(node.name)) {
      if (!holds(node, parent)) return;
      const { source, imported } = bindings.get(node.name)!;
      use(source, imported);
    } else if (
      node.type === "MemberExpression" &&
      !node.computed &&
      node.object.type === "Identifier" &&
      namespaces.has(node.object.name) &&
      holds(node, parent)
    ) {
      use(namespaces.get(node.object.name)!, node.property.name);
    }
  });
  return uses;
}

// Conservative: any reference that is not the first argument of a DI identity callee counts, so
// aliases, map keys, extends, new and static access all make the binding sensitive.
function analyzeImports(body: readonly Node[]): ImportAnalysis {
  const bindings = new Map<string, { readonly source: string; readonly imported: string }>();
  const identityCallees = new Set<string>();
  for (const { local, source, imported } of importBindings(body)) {
    if (!DI_SOURCE.test(source)) bindings.set(local, { source, imported });
    else if (IDENTITY_CALLEES.has(imported)) identityCallees.add(local);
  }
  // A callee name declared again anywhere may be shadowed where it is called: no identity calls.
  for (const name of declaredNames(body)) identityCallees.delete(name);
  const sensitiveLocals = new Set<string>();
  const reexports = new Map<string, ReexportNames>();
  // A dynamically imported namespace holds every export.
  const dynamic = new Set<string>();
  visit(
    body.filter((statement) => statement.type !== "ImportDeclaration"),
    undefined,
    (node, parent) => {
      if (node.type === "ImportExpression" && typeof node.source?.value === "string") {
        dynamic.add(node.source.value);
        return;
      }
      if (node.type !== "Identifier" || !bindings.has(node.name) || !isReference(node, parent)) {
        return;
      }
      if (parent?.type === "ExportSpecifier") {
        const { source, imported } = bindings.get(node.name)!;
        getOrCreate(reexports, source, () => []).push([imported, moduleExportName(parent.exported)]);
      }
      const isIdentityArgument =
        parent?.type === "CallExpression" &&
        parent.arguments[0] === node &&
        parent.callee.type === "Identifier" &&
        identityCallees.has(parent.callee.name);
      if (!isIdentityArgument) sensitiveLocals.add(node.name);
    },
  );
  const sensitive = new Map<string, Set<string>>();
  const use = (source: string, imported: string) => getOrCreate(sensitive, source, () => new Set()).add(imported);
  for (const local of sensitiveLocals) {
    const { source, imported } = bindings.get(local)!;
    use(source, imported);
  }
  for (const source of dynamic) use(source, "*");
  const sources = new Set([
    ...dynamic,
    ...body.flatMap((statement) =>
      statement.type === "ImportDeclaration" ? [String(statement.source.value)] : [],
    ),
  ]);
  return { sensitive, reexports, sources };
}

function decoratorHelpers(body: readonly Node[]): Set<string> {
  const helpers = new Set(["_decorate", "__decorate"]);
  for (const statement of body) {
    if (statement.type !== "ImportDeclaration" || !/decorate/.test(String(statement.source.value))) {
      continue;
    }
    for (const specifier of statement.specifiers) helpers.add(specifier.local.name);
  }
  return helpers;
}

// Legacy decorators compile to helper calls right after the class declaration
// (`_decorate([...], A.prototype, ...)`, `A = _decorate([...], A)`).
function decoratedEnd(body: readonly Node[], name: string, end: number): number {
  const helpers = decoratorHelpers(body);
  const isHelperCall = (node: Node | undefined): boolean =>
    node?.type === "CallExpression" && node.callee.type === "Identifier" && helpers.has(node.callee.name);
  let index = body.findIndex((statement) => statement.end === end);
  let result = end;
  while (++index > 0 && index < body.length) {
    const statement = body[index]!;
    if (statement.type !== "ExpressionStatement") break;
    const expression = statement.expression;
    const decorates =
      isHelperCall(expression) ||
      (expression.type === "AssignmentExpression" &&
        expression.left.type === "Identifier" &&
        expression.left.name === name &&
        isHelperCall(expression.right));
    if (!decorates) break;
    result = statement.end;
  }
  return result;
}

export interface HotTransformOptions {
  // Off where callers re-run without tracking (Vue component setup): forwarding would stop the
  // update from reaching the components that need to reload.
  readonly forwardFunctions?: boolean;
  readonly resolve?: (source: string) => Promise<string | undefined>;
}

export async function transformHotModule(
  code: string,
  id: string,
  options: HotTransformOptions = {},
): Promise<{ code: string; map: any } | undefined> {
  const forwardFunctions = options.forwardFunctions ?? true;
  if (code.includes(HMR_ID) || code.includes(CREATE_ID)) return undefined;
  let program: { body: Node[] };
  try {
    program = parseAst(code, { lang: "js" }) as unknown as { body: Node[] };
  } catch {
    return undefined;
  }
  if (hasTopLevelAwait(program.body) || usesImportMetaHot(program.body)) return undefined;
  const analysis = analyzeExports(program.body, forwardFunctions);
  if (analysis === undefined) return undefined;
  const imports = analyzeImports(program.body);
  // Every resolved source, so that a module without a record is known not to be tracked.
  const dependencies: Record<string, string[]> = {};
  for (const source of new Set([...imports.sources, ...analysis.reexports.keys()])) {
    const resolved = await options.resolve?.(source);
    if (resolved === undefined) continue;
    const names = new Set([...(dependencies[resolved] ?? []), ...(imports.sensitive.get(source) ?? [])]);
    dependencies[resolved] = [...names].sort();
  }
  const reexports: Record<string, ReexportNames> = {};
  for (const [source, names] of [...analysis.reexports, ...imports.reexports]) {
    const resolved = await options.resolve?.(source);
    if (resolved !== undefined) (reexports[resolved] ??= []).push(...names);
  }

  const s = new MagicString(code);
  // Imports are hoisted, so the module body from here to the footer runs synchronously.
  const bodyStart =
    program.body.find((statement) => statement.type !== "ImportDeclaration")?.start ?? code.length;
  const hoisted = [...analysis.forwarded].filter((name) => !analysis.forwardedVariables.has(name));
  const anonymous = analysis.anonymousDefault;
  s.appendLeft(
    bodyStart,
    [
      `const ${HMR_ID} = ${CREATE_ID}(import.meta.hot, ${JSON.stringify(id)}, ${JSON.stringify(analysis.signature)});`,
      // The name an anonymous default function declaration gets natively.
      ...(anonymous?.node.type === "FunctionDeclaration"
        ? [`Object.defineProperty(${DEFAULT_LOCAL}, "name", { value: "default" });`]
        : []),
      // Function declarations are hoisted: module code sees only forwarders.
      ...hoisted.map(forwardCall),
      "",
    ].join("\n"),
  );
  if (anonymous !== undefined) {
    const { statement, node } = anonymous;
    if (node.type === "FunctionDeclaration") {
      s.appendLeft(code.indexOf("(", node.start), ` ${DEFAULT_LOCAL}`);
    } else if (node.type === "ClassDeclaration") {
      s.appendLeft(node.start + "class".length, ` ${DEFAULT_LOCAL}`);
    } else {
      s.overwrite(statement.start, statement.start + "export default".length, `const ${DEFAULT_LOCAL} =`);
      s.appendLeft(statement.end, `\nexport { ${DEFAULT_LOCAL} as default };`);
      // A property key names an anonymous function or class like `export default` does; wrappers
      // added at the same positions stay outside.
      if ((isFunctionNode(node) || node.type === "ClassExpression") && node.id == null) {
        s.appendRight(node.start, "({ default: ");
        s.prependLeft(node.end, " }).default");
      }
    }
  }
  const wrap = (node: Node, call: string, name: string): void => {
    s.appendLeft(node.start, `${HMR_ID}.${call}(${label(name)}, `);
    s.appendRight(node.end, ")");
  };
  for (const [name, init] of analysis.forwardedVariables) wrap(init, "fn", name);
  // Right after the declaration and its decorators, before module code can use the class.
  for (const [name, end] of analysis.classes) {
    s.appendLeft(decoratedEnd(program.body, name, end), `\n${classCall(name)}`);
  }
  // The unit stays the first one created: it calls the function through a forwarder, read inside
  // the nested setup, so only units running changed code re-run, not the setups calling them.
  for (const [name, { call, fn }] of analysis.setupUnits) {
    wrap(call, "unit", name);
    wrap(fn, "fn", name);
  }
  for (const [name, init] of analysis.dataVariables) wrap(init, "data", name);
  for (const [name, init] of analysis.constClasses) wrap(init, "class", name);
  const footer = [
    "",
    `import { createHotModule as ${CREATE_ID} } from ${JSON.stringify(runtimeSpecifier(id))};`,
    // Again at the end: legacy decorators may replace the class after its declaration.
    ...[...analysis.classes.keys()].map(classCall),
    ...[...analysis.values].map(
      ([name, local]) =>
        `${HMR_ID}.value(${JSON.stringify(name)}, ${local}${analysis.classes.has(local) || analysis.constClasses.has(local) ? ", true" : ""});`,
    ),
    `${HMR_ID}.deps(${JSON.stringify(dependencies)}, ${JSON.stringify(reexports)});`,
    `${HMR_ID}.commit();`,
    "if (import.meta.hot) import.meta.hot.accept();",
    "",
  ].join("\n");
  s.append(footer);
  const result = s.toString();
  try {
    parseAst(result, { lang: "js" });
  } catch {
    return undefined;
  }
  return { code: result, map: s.generateMap({ hires: "boundary", source: id, includeContent: true }) };
}

// An update invalidates every importer of a changed module up the graph, and the runner evaluates
// an invalidated module again whenever anything imports it next. Importers whose code did not change
// (soft-invalidated, see Vite's `invalidateModule`) and that the settled updates did not need are
// valid again; those below a re-imported module are not, as its evaluation may have stopped
// before reaching them.
function restoreUnchangedImporters(
  graph: EnvironmentModuleGraph,
  urls: ReadonlySet<string>,
  timestamps: ReadonlySet<number>,
): void {
  const below = new Set<EnvironmentModuleNode>();
  const visit = (mod: EnvironmentModuleNode): void => {
    if (below.has(mod)) return;
    below.add(mod);
    for (const imported of mod.importedModules) if (imported.transformResult === null) visit(imported);
  };
  for (const url of urls) {
    const mod = graph.urlToModuleMap.get(url);
    if (mod !== undefined) visit(mod);
  }
  for (const mod of graph.idToModuleMap.values()) {
    const node = mod as EnvironmentModuleNode & { invalidationState?: TransformResult | string };
    const soft = node.invalidationState;
    if (mod.transformResult !== null || below.has(mod) || typeof soft !== "object") continue;
    // Invalidated last by one of these updates.
    if (!timestamps.has(mod.lastHMRTimestamp) || mod.lastInvalidationTimestamp > mod.lastHMRTimestamp) continue;
    node.invalidationState = undefined;
    graph.updateModuleTransformResult(mod, soft);
  }
}

export function DiHmrPlugin(options: DiHmrPluginOptions): Plugin {
  const { include } = options;
  // Per environment: modules left uninstrumented -> resolved source -> names they hold as classes.
  const classUsers = new Map<string, Map<string, Map<string, Set<string>>>>();
  // Per environment: modules re-evaluated by re-binding since the last edit. In the browser, every
  // re-import instantiates the imported modules that took part in an update again, with new
  // function exports, so re-binding could re-bind the same modules forever; like Vite's
  // `hot.invalidate()`, each module is re-bound once per edit.
  const rebound = new Map<string, Set<string>>();

  return {
    name: "harness:di-hmr",
    apply: "serve",
    enforce: "post",
    configureServer(server) {
      for (const environment of Object.values(server.environments)) {
        const reboundHere = new Set<string>();
        rebound.set(environment.name, reboundHere);
        environment.hot.on("harness:hmr-rebind", (data: Rebind) => {
          const ids = new Set(data.ids);
          // Importers that recorded no dependency on the module: outside the instrumentation (e.g. Vue
          // components), or not resolved when instrumented.
          const instrumented = new Set(data.instrumented);
          const untracked = (id: string) => {
            const recorded = new Set(data.recorded[id]);
            return [...(environment.moduleGraph.getModuleById(id)?.importers ?? [])].flatMap((importer) =>
              importer.id === null || recorded.has(importer.id) ? [] : [importer.id],
            );
          };
          const uses = classUsers.get(environment.name);
          for (const [replaced, names] of Object.entries(data.replaced)) {
            for (const importer of untracked(replaced)) {
              const used = uses?.get(importer)?.get(replaced);
              const holds = used !== undefined && names.some((name) => used.has(name));
              if (holds || instrumented.has(importer)) ids.add(importer);
            }
          }
          // Any use of a changed binding holds the previous one.
          for (const id of Object.keys(data.changed)) for (const importer of untracked(id)) ids.add(importer);
          const mods = [...ids]
            .filter((id) => !reboundHere.has(id))
            .flatMap((id) => environment.moduleGraph.getModuleById(id) ?? []);
          if (mods.length === 0) return;
          for (const mod of mods) reboundHere.add(mod.id!);
          if (reachesHotRuntime(mods as HotModuleNode[])) {
            environment.hot.send({ type: "full-reload" });
            return;
          }
          // All first: a module re-evaluated here imports the others (e.g. a barrel) afresh.
          for (const mod of mods) environment.moduleGraph.invalidateModule(mod);
          for (const mod of mods) void environment.reloadModule(mod);
        });
        if (environment.config.consumer !== "server") continue;
        // Re-imported modules of the updates settled since the last restore, and their timestamps.
        const settled = { urls: new Set<string>(), timestamps: new Set<number>() };
        environment.hot.on("harness:hmr-settled", (data: Settled) => {
          for (const url of data.urls) settled.urls.add(url);
          settled.timestamps.add(data.timestamp);
          const graph = environment.moduleGraph;
          let latest = 0;
          for (const mod of graph.idToModuleMap.values()) latest = Math.max(latest, mod.lastHMRTimestamp);
          // Wait for the runner to finish every update sent.
          if (data.timestamp < latest) return;
          restoreUnchangedImporters(graph, settled.urls, settled.timestamps);
          settled.urls.clear();
          settled.timestamps.clear();
        });
      }
    },
    async transform(code, rawId) {
      const id = cleanModuleId(rawId);
      if (id === undefined || isHotRuntime(id)) return null;
      const resolve = async (source: string) => {
        const resolved = await this.resolve(source, id);
        return resolved === null ? undefined : cleanModuleId(resolved.id);
      };
      const users = getOrCreate(classUsers, this.environment.name, () => new Map());
      users.delete(id);
      const forwardFunctions = this.environment.config.consumer === "server";
      const result = include(id)
        ? await transformHotModule(code, id, { forwardFunctions, resolve })
        : undefined;
      // Uninstrumented modules (e.g. Vue components) record no dependencies at runtime.
      if (result === undefined && !id.includes("/node_modules/") && /\.(?:[cm]?[jt]sx?|vue)$/.test(id)) {
        let program: { body: Node[] } | undefined;
        try {
          program = parseAst(code, { lang: "js" }) as unknown as { body: Node[] };
        } catch {}
        const used = new Map<string, Set<string>>();
        for (const [source, names] of program === undefined ? [] : classUses(program.body)) {
          const resolved = await resolve(source);
          if (resolved !== undefined) used.set(resolved, names);
        }
        if (used.size > 0) users.set(id, used);
      }
      return result ?? null;
    },
    hotUpdate({ modules, file }) {
      rebound.get(this.environment.name)?.clear();
      if (!reachesHotRuntime(modules as Iterable<HotModuleNode>)) return;
      this.environment.hot.send({ type: "full-reload", triggeredBy: file });
      return [];
    },
  };
}
