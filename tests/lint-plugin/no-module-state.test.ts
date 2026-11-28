import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

interface Diagnostic {
  message: string;
  code: string;
  filename: string;
}

const FIXTURES: Record<string, string> = {
  "reassigned-let.ts": `
let count = 0;
export function increment() {
  count++;
}
let renamed = "a";
renamed = "b";
let untouched = 1;
console.log(untouched);
`,
  "reassigned-var.ts": `
var later;
later = 1;
`,
  "reactive.ts": `
import { reactive, ref, shallowReactive, shallowRef } from "vue";
const counter = ref(0);
const current = shallowRef();
const state = reactive({});
const index = shallowReactive(new Map());
`,
  "mutated-containers.ts": `
const map = new Map();
map.set("a", 1);
const set = new Set();
set.add("a");
const weakMap = new WeakMap();
weakMap.delete({});
const weakSet = new WeakSet();
weakSet.add({});
const list = [];
list.push(1);
const assigned = {};
assigned.field = 1;
const deleted = { field: 1 };
delete deleted.field;
const incremented = { n: 0 };
incremented.n++;
`,
  "exported.ts": `
export let current = 0;
export function setCurrent(value) {
  current = value;
}
export const registry = new Map();
registry.set("a", 1);
`,
  "constant-tables.ts": `
const ALWAYS = new Set([".git", "node_modules"]);
const TABLE = { ts: "typescript" };
const LIST = [1, 2, 3];
const LOOKUP = new Map([["a", 1]]);
export function check(name) {
  return ALWAYS.has(name) && TABLE[name] !== undefined && LIST.map((n) => n * 2)[0] && LOOKUP.get(name);
}
`,
  "locals.ts": `
import { ref } from "vue";
export function local() {
  let count = 0;
  count++;
  const map = new Map();
  map.set("a", 1);
  const counter = ref(0);
  return [count, map, counter];
}
`,
  "hot.ts": `
let count = 0;
count++;
const map = new Map();
map.set("a", 1);
if (import.meta.hot) {
  import.meta.hot.dispose(() => map.clear());
}
`,
};

const execFileAsync = promisify(execFile);
const root = process.cwd();
const pluginPath = resolve(root, "packages/lint-plugin/src/index.ts");
const vitePlusRequire = createRequire(join(root, "node_modules/vite-plus/package.json"));
const oxlintBin = join(
  dirname(vitePlusRequire.resolve("oxlint/package.json")),
  (vitePlusRequire("oxlint/package.json") as { bin: { oxlint: string } }).bin.oxlint,
);

let fixtureDir: string;
let diagnostics: Diagnostic[];

function namesIn(file: string): string[] {
  return diagnostics
    .filter((diagnostic) => diagnostic.filename === file)
    .map((diagnostic) => /'([^']+)'/.exec(diagnostic.message)?.[1] ?? "<unnamed>")
    .sort();
}

beforeAll(async () => {
  fixtureDir = mkdtempSync(join(tmpdir(), "harness-no-module-state-"));
  writeFileSync(
    join(fixtureDir, ".oxlintrc.json"),
    JSON.stringify({
      jsPlugins: [{ name: "harness", specifier: pluginPath }],
      categories: { correctness: "off" },
      rules: { "harness/no-module-state": "error" },
    }),
  );
  for (const [name, source] of Object.entries(FIXTURES)) {
    writeFileSync(join(fixtureDir, name), source);
  }
  const result = await execFileAsync(
    process.execPath,
    [oxlintBin, "-c", ".oxlintrc.json", "-f", "json", "."],
    { cwd: fixtureDir },
  ).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "" }));
  diagnostics = (JSON.parse(result.stdout) as { diagnostics: Diagnostic[] }).diagnostics;
  for (const diagnostic of diagnostics) {
    expect(diagnostic.code).toBe("harness(no-module-state)");
  }
}, 60_000);

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe("harness/no-module-state", () => {
  it("reports reassigned top-level let but not an unreassigned one", () => {
    expect(namesIn("reassigned-let.ts")).toEqual(["count", "renamed"]);
  });

  it("reports a reassigned top-level var", () => {
    expect(namesIn("reassigned-var.ts")).toEqual(["later"]);
  });

  it("reports ref, shallowRef, reactive and shallowReactive constants", () => {
    expect(namesIn("reactive.ts")).toEqual(["counter", "current", "index", "state"]);
  });

  it("reports mutated Map, Set, WeakMap, WeakSet, array and object constants", () => {
    expect(namesIn("mutated-containers.ts")).toEqual([
      "assigned",
      "deleted",
      "incremented",
      "list",
      "map",
      "set",
      "weakMap",
      "weakSet",
    ]);
  });

  it("reports exported declarations", () => {
    expect(namesIn("exported.ts")).toEqual(["current", "registry"]);
  });

  it("does not report constant tables that are only read", () => {
    expect(namesIn("constant-tables.ts")).toEqual([]);
  });

  it("does not report locals inside functions", () => {
    expect(namesIn("locals.ts")).toEqual([]);
  });

  it("does not report modules that use import.meta.hot", () => {
    expect(namesIn("hot.ts")).toEqual([]);
  });

  it("names the variable in the message", () => {
    const [diagnostic] = diagnostics.filter((d) => d.filename === "reassigned-var.ts");
    expect(diagnostic?.message).toBe(
      "Module-level mutable state 'later' splits when the module is hot updated; keep it in a DI service or manage it with import.meta.hot.",
    );
  });
});
