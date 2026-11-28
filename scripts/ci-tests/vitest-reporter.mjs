import { errorText, saveRunnerResult, testResult } from "./results.mjs";

export default class Reporter {
  onTestRunEnd(modules, unhandledErrors, reason) {
    const errors = unhandledErrors.map(errorText);
    const tests = [];
    for (const module of modules) {
      errors.push(...module.errors().map(errorText));
      for (const suite of module.children.allSuites())
        errors.push(...suite.errors().map(errorText));
      for (const test of module.children.allTests()) {
        const result = test.result();
        if (result.state === "pending") errors.push(`Test did not finish: ${test.fullName}`);
        if (test.attempts().length > 1)
          errors.push(`Retries/repeats are not supported: ${test.fullName}`);
        tests.push(
          testResult(
            "vitest",
            test.project.name,
            module.moduleId,
            test.fullName,
            result.state === "pending" ? "skipped" : result.state,
            result.errors,
            test.logs().map((log) => log.content),
          ),
        );
      }
    }
    if (reason === "interrupted") errors.push("Vitest run was interrupted");
    saveRunnerResult(tests, errors);
  }
}
