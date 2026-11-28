import { writeFileSync } from "node:fs";
import { relative } from "node:path";
import { stripVTControlCharacters } from "node:util";

export const baselinePath = "tests/passed-baseline.json";

export function errorText(error) {
  return stripVTControlCharacters(String(error.stack || error.message || error));
}

export function testResult(runner, project, file, title, status, errors = [], logs = []) {
  file = relative(process.cwd(), file).replaceAll("\\", "/");
  return {
    id: JSON.stringify([runner, project, file, title]),
    file,
    title,
    status,
    errors: errors.map(errorText),
    logs: logs.map((log) => stripVTControlCharacters(String(log))),
  };
}

export function saveRunnerResult(tests, errors) {
  writeFileSync(process.env.HARNESS_TEST_RESULT, JSON.stringify({ tests, errors }, null, 2));
}

export function parseBaseline(text) {
  const ids = JSON.parse(text);
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
    throw new Error(`${baselinePath} must contain an array of test IDs`);
  }
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate baseline test IDs");
  return ids;
}

export function evaluate(tests, baseline, errors) {
  const ids = new Set();
  for (const test of tests) {
    if (
      !["passed", "failed", "skipped"].includes(test.status) ||
      !/^(apps|tests)\//.test(test.file) ||
      typeof test.title !== "string" ||
      typeof test.id !== "string" ||
      !Array.isArray(test.errors) ||
      !Array.isArray(test.logs)
    ) {
      throw new Error("Invalid test result");
    }
    if (ids.has(test.id)) errors.push(`Duplicate test ID: ${test.id}`);
    ids.add(test.id);
  }
  const apps = tests.filter((test) => test.file.startsWith("apps/"));
  const scenarios = tests.filter((test) => test.file.startsWith("tests/"));
  const passed = new Set(
    scenarios.filter((test) => test.status === "passed").map((test) => test.id),
  );
  const known = new Set(baseline);
  const regressions = baseline.filter((id) => !passed.has(id));
  const newlyPassed = [...passed]
    .filter((id) => !known.has(id))
    .sort((a, b) => a.localeCompare(b, "en"));
  const appFailures = apps.filter((test) => test.status !== "passed");
  return {
    apps,
    scenarios,
    regressions,
    newlyPassed,
    appFailures,
    errors,
    exitCode: errors.length ? 2 : regressions.length || appFailures.length ? 1 : 0,
  };
}

const escape = (value) =>
  String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function testStats(tests, incomplete = false) {
  const total = tests.length;
  const passed = tests.filter((test) => test.status === "passed").length;
  const failed = tests.filter((test) => test.status === "failed").length;
  const skipped = total - passed - failed;
  const rate = incomplete
    ? "N/A (incomplete)"
    : total
      ? `${(passed === total ? 100 : Math.min(99.9, (100 * passed) / total)).toFixed(1)}%`
      : "N/A";
  return { total, passed, failed, skipped, rate };
}

export function summarize(result, limit = 30, detailLimit = 4000) {
  const stats = (tests) => {
    const { passed, failed, skipped, rate } = testStats(tests, result.errors.length > 0);
    return `${rate} · ${passed} passed / ${failed} failed / ${skipped} skipped`;
  };
  const lines = [
    "## Test results",
    "",
    `- App tests: ${stats(result.apps)}`,
    `- Scenario tests: ${stats(result.scenarios)}`,
    `- Regressions: **${result.regressions.length}**`,
    `- Newly passing: **${result.newlyPassed.length}**`,
    `- Execution errors: **${result.errors.length}**`,
    "",
  ];
  const section = (title, entries) => {
    if (!entries.length) return;
    lines.push(`### ${title}`, "");
    for (const [name, details] of entries.slice(0, limit)) {
      lines.push(
        `<details><summary>${escape(name).slice(0, 1000)}</summary>`,
        "",
        `<pre>${escape(details).slice(0, detailLimit)}</pre>`,
        "",
        "</details>",
        "",
      );
    }
    if (entries.length > limit)
      lines.push(`${entries.length - limit} more in the result artifact.`, "");
  };
  const tests = new Map([...result.apps, ...result.scenarios].map((test) => [test.id, test]));
  const details = (test) => [test.status, ...test.errors, ...test.logs].join("\n\n");
  section(
    "Execution errors",
    result.errors.map((error) => ["Execution failed", error]),
  );
  section(
    "Regressions",
    result.regressions.map((id) => {
      const test = tests.get(id);
      return [id, test ? details(test) : "Baseline test was not collected."];
    }),
  );
  section(
    "App failures",
    result.appFailures.map((test) => [test.id, details(test)]),
  );
  section(
    "Other scenario failures (non-blocking)",
    result.scenarios
      .filter((test) => test.status === "failed" && !result.regressions.includes(test.id))
      .map((test) => [test.id, details(test)]),
  );
  section(
    "Newly passing",
    result.newlyPassed.map((id) => [
      id,
      result.errors.length
        ? "Observed passing; baseline update deferred because this run is incomplete."
        : "Added to the next baseline.",
    ]),
  );
  lines.push("Full results and logs are available in this run's test-results artifact.");
  return lines.join("\n");
}
