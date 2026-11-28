import { definePlugin, defineRule } from "vite-plus/lint/plugins";

type Node = { readonly type: string; readonly parent: Node; readonly [key: string]: any };

const CONTAINERS = new Set(["Map", "Set", "WeakMap", "WeakSet", "Array"]);
const REACTIVE = new Set(["ref", "shallowRef", "reactive", "shallowReactive"]);
const MUTATORS = new Set([
  "set",
  "add",
  "delete",
  "clear",
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "sort",
  "reverse",
  "fill",
  "copyWithin",
]);

function isContainer(init: Node | null): boolean {
  if (init === null) return false;
  if (init.type === "ArrayExpression" || init.type === "ObjectExpression") return true;
  return (
    init.type === "NewExpression" &&
    init.callee.type === "Identifier" &&
    CONTAINERS.has(init.callee.name)
  );
}

function isReactive(init: Node | null): boolean {
  return (
    init?.type === "CallExpression" &&
    init.callee.type === "Identifier" &&
    REACTIVE.has(init.callee.name)
  );
}

function mutates(identifier: Node): boolean {
  const member = identifier.parent;
  if (member.type !== "MemberExpression" || member.object !== identifier) return false;
  const user = member.parent;
  if (user.type === "CallExpression" && user.callee === member) {
    return !member.computed && MUTATORS.has(member.property.name);
  }
  if (user.type === "AssignmentExpression") return user.left === member;
  if (user.type === "UpdateExpression") return true;
  return user.type === "UnaryExpression" && user.operator === "delete";
}

function isImportMetaHot(node: Node): boolean {
  return (
    !node.computed &&
    node.property.name === "hot" &&
    node.object.type === "MetaProperty" &&
    node.object.meta.name === "import"
  );
}

const noModuleState = defineRule({
  meta: {
    type: "problem",
    messages: {
      state:
        "Module-level mutable state '{{name}}' splits when the module is hot updated; keep it in a DI service or manage it with import.meta.hot.",
    },
  },
  create(context) {
    const found: Array<{ node: Node; name: string }> = [];
    let managesHot = false;
    return {
      MemberExpression(node) {
        if (isImportMetaHot(node as unknown as Node)) managesHot = true;
      },
      VariableDeclarator(rawNode) {
        const node = rawNode as unknown as Node;
        const declaration = node.parent;
        const container = declaration.parent;
        const topLevel =
          container.type === "Program" ||
          (container.type === "ExportNamedDeclaration" && container.parent.type === "Program");
        if (!topLevel) return;
        for (const variable of context.sourceCode.getDeclaredVariables(rawNode)) {
          const state =
            declaration.kind !== "const"
              ? variable.references.some((ref) => ref.isWrite() && !ref.init)
              : isReactive(node.init) ||
                (isContainer(node.init) &&
                  variable.references.some((ref) => mutates(ref.identifier as unknown as Node)));
          if (state) found.push({ node, name: variable.name });
        }
      },
      "Program:exit"() {
        if (managesHot) return;
        for (const { node, name } of found) {
          context.report({ node: node as never, messageId: "state", data: { name } });
        }
      },
    };
  },
});

export default definePlugin({
  meta: { name: "harness" },
  rules: { "no-module-state": noModuleState },
});
