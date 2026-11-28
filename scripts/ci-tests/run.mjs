import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  globSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { baselinePath, errorText, evaluate, parseBaseline, summarize } from "./results.mjs";

const scripts = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: { "output-dir": { type: "string" }, "update-baseline": { type: "boolean" } },
});
const output = resolve(values["output-dir"] ?? "node_modules/.cache/ci-tests");
mkdirSync(output, { recursive: true });
const tests = [];
const errors = [];
let baseline = [];

function run(name, args) {
  const resultPath = join(output, `${name}.json`);
  rmSync(resultPath, { force: true });
  const child = spawnSync("pnpm", ["exec", ...args], {
    stdio: "inherit",
    timeout: 900_000,
    env: { ...process.env, HARNESS_TEST_RESULT: resultPath },
  });
  try {
    const result = JSON.parse(readFileSync(resultPath, "utf8"));
    if (!Array.isArray(result.tests) || !Array.isArray(result.errors))
      throw new Error("Invalid reporter output");
    tests.push(...result.tests);
    errors.push(...result.errors);
    if (
      child.error ||
      child.signal ||
      (child.status !== 0 &&
        !(child.status === 1 && result.tests.some((test) => test.status === "failed")))
    ) {
      errors.push(
        `${name}: ${child.error?.message ?? child.signal ?? `unexpected exit ${child.status}`}`,
      );
    }
  } catch (error) {
    errors.push(`${name}: ${errorText(error)}`);
  }
}

try {
  baseline = parseBaseline(readFileSync(baselinePath, "utf8"));
  run("vitest", [
    "vp",
    "test",
    "run",
    "--reporter=default",
    `--reporter=${join(scripts, "vitest-reporter.mjs")}`,
    "--retry=0",
    "--bail=0",
    "--allowOnly=false",
    "--passWithNoTests",
  ]);
  const configs = globSync("{tests,apps}/**/playwright.config.{ts,mts,js,mjs}", {
    exclude: ["**/node_modules/**", "**/dist/**"],
  }).sort((a, b) => a.localeCompare(b, "en"));
  for (const [index, config] of configs.entries()) {
    run(`playwright-${index}`, [
      "playwright",
      "test",
      "--config",
      config,
      `--reporter=line,${join(scripts, "playwright-reporter.mjs")}`,
      "--retries=0",
      "--max-failures=0",
      "--forbid-only",
      "--output",
      join(output, `playwright-${index}-files`),
    ]);
  }
} catch (error) {
  errors.push(errorText(error));
}

let result;
try {
  result = evaluate(tests, baseline, errors);
} catch (error) {
  result = evaluate([], baseline, [...errors, errorText(error)]);
}
const report = {
  sha:
    process.env.TEST_HEAD_SHA ??
    spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(),
  createdAt: new Date().toISOString(),
  tests,
  baseline,
  errors: result.errors,
  regressions: result.regressions,
  newlyPassed: result.newlyPassed,
  appFailures: result.appFailures.map((test) => test.id),
  exitCode: result.exitCode,
};
writeFileSync(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
const nextBaseline = `${JSON.stringify(
  [...new Set([...baseline, ...(result.errors.length ? [] : result.newlyPassed)])].sort((a, b) =>
    a.localeCompare(b, "en"),
  ),
  null,
  2,
)}\n`;
writeFileSync(join(output, "passed-baseline.json"), nextBaseline);
if (values["update-baseline"] && !result.errors.length && result.newlyPassed.length)
  writeFileSync(baselinePath, nextBaseline);
const summary = summarize(result);
writeFileSync(join(output, "summary.md"), summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
console.log(`\n${summary}\n\nResults: ${output}`);
process.exitCode = result.exitCode;
