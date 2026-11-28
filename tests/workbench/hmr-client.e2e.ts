import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

// apps/web's DiHmrPlugin only instruments modules under a `/packages/` path.
const fixtures = fileURLToPath(new URL("../../apps/web/tests/hmr/packages/", import.meta.url));
const originals = new Map<string, string>();
// Every page of the shared dev server receives the HMR updates of every edit, so tests in
// different workers must not overlap at all, not only while editing.
const lock = fileURLToPath(new URL("../../node_modules/.cache/hmr-client-fixtures.lock", import.meta.url));

function holder(): number | undefined {
  try {
    return Number(readFileSync(join(lock, "pid"), "utf8"));
  } catch {
    return undefined;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test.beforeEach(async ({}, testInfo) => {
  const started = Date.now();
  mkdirSync(join(lock, ".."), { recursive: true });
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, "pid"), String(process.pid));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = holder();
      if (pid !== undefined && !alive(pid)) rmSync(lock, { recursive: true, force: true });
      else await sleep(100);
    }
  }
  testInfo.setTimeout(testInfo.timeout + Date.now() - started);
});

function edit(path: string, ...replacements: Array<readonly [from: string, to: string]>): void {
  const file = join(fixtures, path);
  const source = readFileSync(file, "utf8");
  if (!originals.has(file)) originals.set(file, source);
  let next = source;
  for (const [from, to] of replacements) {
    if (!next.includes(from)) throw new Error(`${path} does not contain ${JSON.stringify(from)}`);
    next = next.replace(from, to);
  }
  writeFileSync(file, next);
}

test.afterEach(async ({ page }) => {
  for (const [file, source] of originals) writeFileSync(file, source);
  const restored = originals.size > 0;
  originals.clear();
  // Pages opened by the next test must not receive the restore as an update.
  await page.close();
  if (restored) await sleep(500);
  rmSync(lock, { recursive: true, force: true });
});

async function open(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto("/tests/vscode-empty.fixture.html");
  await page.evaluate(async (url) => (await import(url)).setup(), "/tests/hmr/hmr-client.fixture.ts");
  return errors;
}

function count(log: readonly string[], event: string): number {
  return log.filter((entry) => entry === event).length;
}

test("client HMR replaces an edited service class through DI and rebuilds its dependents without a reload", async ({
  page,
}) => {
  const errors = await open(page);
  edit("class-edit/base.ts", ['readonly version = "v1";', 'readonly version = "v2";']);
  await expect
    .poll(() => page.evaluate(() => (window as any).__hmrClient.classEditBase().version))
    .toBe("v2");
  const result = await page.evaluate(() => {
    const probe = (window as any).__hmrClient;
    const base = probe.classEditBase();
    const dependent = probe.classEditDependent();
    return {
      instanceReplaced: base !== probe.initial.classEditBase,
      classReplaced: base.constructor !== probe.initial.classEditBase.constructor,
      dependentRebuilt: dependent !== probe.initial.classEditDependent,
      dependentUsesNewInstance: dependent.base === base,
      log: (window as any).__hmrClientLog as string[],
      noReload: (window as any).__hmrClientNoReload === true,
    };
  });
  expect(result).toMatchObject({
    instanceReplaced: true,
    classReplaced: true,
    dependentRebuilt: true,
    dependentUsesNewInstance: true,
    noReload: true,
  });
  expect(result.log).toContain("construct:ClassEditDependent:v2");
  expect(count(result.log, "evaluate:class-edit/base")).toBe(2);
  // The dependent only hands the class to inject, so its module is not re-executed.
  expect(count(result.log, "evaluate:class-edit/dependent")).toBe(1);
  expect(errors).toEqual([]);
});

test("client HMR propagates an edited exported function to importers and keeps unrelated service instances", async ({
  page,
}) => {
  const errors = await open(page);
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__hmrClientRender((window as any).__hmrClient.functionEditService()),
      ),
    )
    .toBe("[service]");
  edit("function-edit/format.ts", ["return `[${value}]`;", "return `<${value}>`;"]);
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__hmrClientRender((window as any).__hmrClient.functionEditService()),
      ),
    )
    .toBe("<service>");
  const result = await page.evaluate(() => {
    const probe = (window as any).__hmrClient;
    const service = probe.functionEditService();
    return {
      instanceKept: service === probe.initial.functionEditService,
      classKept: service.constructor === probe.initial.functionEditService.constructor,
      log: (window as any).__hmrClientLog as string[],
      noReload: (window as any).__hmrClientNoReload === true,
    };
  });
  expect(result).toMatchObject({ instanceKept: true, classKept: true, noReload: true });
  expect(count(result.log, "evaluate:function-edit/format")).toBe(2);
  expect(count(result.log, "evaluate:function-edit/view")).toBe(2);
  expect(count(result.log, "evaluate:function-edit-consumer")).toBe(2);
  expect(count(result.log, "evaluate:function-edit/service")).toBe(1);
  expect(count(result.log, "construct:FunctionEditService")).toBe(1);
  expect(errors).toEqual([]);
});

test("client HMR settles after editing a component in an import cycle with the module registering it", async ({
  page,
}) => {
  const errors = await open(page);
  await expect.poll(() => page.evaluate(() => (window as any).__hmrClientRebindLoop !== undefined)).toBe(true);
  edit("rebind-loop/Panel.vue", ["{{ panelTitle() }}: v1", "{{ panelTitle() }}: v2"]);
  await sleep(3000);
  const first = await page.evaluate(() => [...((window as any).__hmrClientLog as string[])]);
  await sleep(1000);
  const result = await page.evaluate(() => ({
    log: (window as any).__hmrClientLog as string[],
    noReload: (window as any).__hmrClientNoReload === true,
  }));
  // Each re-import of the component instantiates the registering module again, with a new
  // function export; re-binding its importers must not keep re-importing both.
  expect(result.log).toEqual(first);
  expect(count(result.log, "evaluate:rebind-loop/workbench")).toBeLessThanOrEqual(4);
  expect(result.noReload).toBe(true);
  expect(errors.filter((error) => !error.includes("WebSocket"))).toEqual([]);
});

test("client HMR rolls back a service class whose new constructor throws and applies the next fixing edit", async ({
  page,
}) => {
  const errors = await open(page);
  const constructed = "log(`construct:FailedConstructionService:${this.version}`);";
  edit(
    "failed-construction/service.ts",
    [constructed, 'throw new Error("fixture construction failure");'],
    ['readonly version = "v1";', 'readonly version = "v2";'],
  );
  await expect.poll(() => errors.length).toBeGreaterThan(0);
  expect(errors).toEqual([expect.stringMatching(/^\[hmr\] update of 1 module\(s\) rejected/)]);
  expect(errors[0]).toContain("fixture construction failure");
  const rolledBack = await page.evaluate(() => {
    const probe = (window as any).__hmrClient;
    const service = probe.failedConstructionService();
    return {
      version: service.version,
      previousClass: service.constructor === probe.initial.failedConstructionService.constructor,
      dependentConsistent: probe.failedConstructionDependent().service === service,
    };
  });
  expect(rolledBack).toEqual({ version: "v1", previousClass: true, dependentConsistent: true });

  edit(
    "failed-construction/service.ts",
    ['throw new Error("fixture construction failure");', constructed],
    ['readonly version = "v2";', 'readonly version = "v3";'],
  );
  await expect
    .poll(() => page.evaluate(() => (window as any).__hmrClient.failedConstructionService().version))
    .toBe("v3");
  const fixed = await page.evaluate(() => {
    const probe = (window as any).__hmrClient;
    const service = probe.failedConstructionService();
    return {
      classReplaced: service.constructor !== probe.initial.failedConstructionService.constructor,
      dependentConsistent: probe.failedConstructionDependent().service === service,
      log: (window as any).__hmrClientLog as string[],
      noReload: (window as any).__hmrClientNoReload === true,
    };
  });
  expect(fixed).toMatchObject({ classReplaced: true, dependentConsistent: true, noReload: true });
  expect(fixed.log).toContain("construct:FailedConstructionService:v3");
  expect(errors).toHaveLength(1);
});

test("client HMR keeps instanceof and deserializeValue consistent across versions of an edited @variant class", async ({
  page,
}) => {
  const errors = await open(page);
  edit("variant-edit/shape.ts", ["return `v1:${this.radius}`;", "return `v2:${this.radius}`;"]);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const probe = (window as any).__hmrClient;
        return probe.deserialize(probe.initial.serializedCircle).describe();
      }),
    )
    .toBe("v2:2");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).__hmrClientCircle !== (window as any).__hmrClient.InitialCircle,
      ),
    )
    .toBe(true);
  const result = await page.evaluate(() => {
    const probe = (window as any).__hmrClient;
    const Initial = probe.InitialCircle;
    const Latest = (window as any).__hmrClientCircle;
    const deserialized = probe.deserialize(probe.initial.serializedCircle);
    const created = Latest.create({ radius: 3 });
    return {
      deserializedIsLatest: deserialized.constructor === Latest,
      deserializedInstanceOfBoth: deserialized instanceof Latest && deserialized instanceof Initial,
      initialInstanceOfLatest: probe.initial.circle instanceof Latest,
      latestInstanceOfInitial: created instanceof Initial,
      plainObjectRejected: !({ radius: 3 } instanceof Latest),
      initialClassCreatesLatest: Initial.create({ radius: 1 }).describe(),
      noReload: (window as any).__hmrClientNoReload === true,
    };
  });
  expect(result).toEqual({
    deserializedIsLatest: true,
    deserializedInstanceOfBoth: true,
    initialInstanceOfLatest: true,
    latestInstanceOfInitial: true,
    plainObjectRejected: true,
    initialClassCreatesLatest: "v2:1",
    noReload: true,
  });
  expect(errors).toEqual([]);
});

// #245: useService reads the instance once in setup.
test.fixme("client HMR re-renders a Vue component using useService with the rebuilt service instance", async ({
  page,
}) => {
  const errors = await open(page);
  const probe = page.getByTestId("hmr-client-vue-probe");
  await expect(probe).toHaveText("v1");
  edit("vue-edit/service.ts", ['readonly label = "v1";', 'readonly label = "v2";']);
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__hmrClient.vueEditService().label),
    )
    .toBe("v2");
  await expect(probe).toHaveText("v2");
  expect(await page.evaluate(() => (window as any).__hmrClientNoReload === true)).toBe(true);
  expect(errors).toEqual([]);
});
