import { errorText, saveRunnerResult, testResult } from "./results.mjs";

export default class Reporter {
  errors = [];

  onBegin(_config, suite) {
    this.suite = suite;
  }

  onError(error) {
    this.errors.push(errorText(error));
  }

  onEnd(run) {
    const tests = (this.suite?.allTests() ?? []).map((test) => {
      const result = test.results[0];
      if (!result || result.status === "interrupted")
        this.errors.push(`Test did not finish: ${test.title}`);
      if (test.results.length > 1) this.errors.push(`Retries are not supported: ${test.title}`);
      return testResult(
        "playwright",
        test.parent.project()?.name ?? "",
        test.location.file,
        test.titlePath().slice(3).join(" > "),
        result?.status === "passed"
          ? "passed"
          : result?.status === "skipped"
            ? "skipped"
            : "failed",
        result?.errors,
        [...(result?.stdout ?? []), ...(result?.stderr ?? [])],
      );
    });
    if (["timedout", "interrupted"].includes(run.status))
      this.errors.push(`Playwright run ${run.status}`);
    saveRunnerResult(tests, this.errors);
  }
}
