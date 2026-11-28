import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { baselinePath, evaluate, parseBaseline, summarize, testStats } from "./results.mjs";

const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
const run = event.workflow_run;
const repository = process.env.GITHUB_REPOSITORY;
const prefix = `/repos/${repository}`;

async function api(path, method = "GET", body) {
  const response = await fetch(
    `${process.env.GITHUB_API_URL ?? "https://api.github.com"}${prefix}${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
  if (!response.ok)
    throw new Error(`${method} ${path}: HTTP ${response.status} ${await response.text()}`);
  return response.json();
}

let baseline = [];
let result;
try {
  const baselineFile = await api(`/contents/${baselinePath}?ref=${run.head_sha}`);
  baseline = parseBaseline(Buffer.from(baselineFile.content, "base64").toString("utf8"));
  const report = JSON.parse(readFileSync(join(process.argv[2], "report.json"), "utf8"));
  if (report.sha !== run.head_sha) throw new Error("Report commit does not match the workflow run");
  if (!Array.isArray(report.errors) || report.errors.some((error) => typeof error !== "string")) {
    throw new Error("Invalid execution errors");
  }
  if (["cancelled", "timed_out"].includes(run.conclusion)) {
    report.errors.push(`Test workflow ${run.conclusion}`);
  }
  result = evaluate(report.tests, baseline, report.errors);
} catch (error) {
  result = evaluate([], baseline, [
    `No usable test report: ${error.message}. See the test workflow logs.`,
  ]);
}

async function updateBaseline() {
  if (result.errors.length || !result.newlyPassed.length) return;
  if (run.head_repository.full_name !== repository) return;
  if (run.event === "pull_request") {
    const pulls = await api(`/commits/${run.head_sha}/pulls`);
    if (
      !pulls.some(
        (pr) =>
          pr.state === "open" &&
          pr.head.repo?.full_name === repository &&
          pr.head.ref === run.head_branch &&
          pr.head.sha === run.head_sha,
      )
    )
      return;
  } else if (run.head_branch !== event.repository.default_branch) {
    return;
  }
  const refPath = `/git/refs/heads/${encodeURIComponent(run.head_branch)}`;
  const current = await api(`/git/ref/heads/${encodeURIComponent(run.head_branch)}`);
  if (current.object.sha !== run.head_sha) return;
  const parent = await api(`/git/commits/${run.head_sha}`);
  const ids = [...new Set([...baseline, ...result.newlyPassed])].sort((a, b) =>
    a.localeCompare(b, "en"),
  );
  const tree = await api("/git/trees", "POST", {
    base_tree: parent.tree.sha,
    tree: [
      {
        path: baselinePath,
        mode: "100644",
        type: "blob",
        content: `${JSON.stringify(ids, null, 2)}\n`,
      },
    ],
  });
  const commit = await api("/git/commits", "POST", {
    message: "test: record newly passing scenarios",
    tree: tree.sha,
    parents: [run.head_sha],
  });
  try {
    await api(refPath, "PATCH", { sha: commit.sha, force: false });
  } catch (error) {
    const latest = await api(`/git/ref/heads/${encodeURIComponent(run.head_branch)}`);
    if (latest.object.sha === commit.sha) return commit.sha;
    if (latest.object.sha !== run.head_sha) return;
    throw error;
  }
  return commit.sha;
}

let baselineCommit;
let updateError;
try {
  baselineCommit = await updateBaseline();
} catch (error) {
  updateError = error;
}
let summary = `Tested commit: ${run.head_sha}\n\n${summarize(result, 5, 1200)}`;
if (baselineCommit) {
  summary += `\n\nBaseline commit: ${baselineCommit}. Only the baseline file changed; these results are from the tested commit above.`;
} else if (result.newlyPassed.length) {
  summary +=
    "\n\nThe proposed baseline is in the artifact. It was not committed (the branch may have advanced, be a fork, or the run was incomplete).";
}
if (updateError) summary += "\n\nAutomatic baseline update failed. See the report workflow logs.";

for (const sha of [run.head_sha, baselineCommit].filter(Boolean)) {
  const existing = await api(`/commits/${sha}/check-runs?per_page=100`);
  for (const [name, tests, blockingFailures] of [
    ["App tests", result.apps, result.appFailures.length],
    ["Scenario tests", result.scenarios, result.regressions.length],
  ]) {
    const { total, passed, failed, skipped, rate } = testStats(tests, result.errors.length > 0);
    const conclusion =
      result.errors.length || blockingFailures
        ? "failure"
        : total && passed === total
          ? "success"
          : "neutral";
    const title =
      `${failed} failed / ${total} total · ${rate}${total && !result.errors.length ? " passed" : ""}` +
      (skipped ? ` · ${skipped} skipped` : "") +
      (name === "Scenario tests" && result.regressions.length
        ? ` · ${result.regressions.length} regressions`
        : "") +
      (result.errors.length ? ` · ${result.errors.length} execution errors` : "");
    const externalId = `${run.id}:${name}`;
    const check = existing.check_runs.find(
      (item) => item.external_id === externalId && item.app.slug === "github-actions",
    );
    const body = {
      name,
      head_sha: sha,
      external_id: externalId,
      status: "completed",
      conclusion,
      details_url: run.html_url,
      output: { title, summary },
    };
    if (check) delete body.head_sha;
    await api(check ? `/check-runs/${check.id}` : "/check-runs", check ? "PATCH" : "POST", body);
  }
}
appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
if (updateError) throw updateError;
