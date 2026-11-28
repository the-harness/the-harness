import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { createHarnessModules } from "../helpers/harness-modules.ts";

it("reports Bash output while the process is running and keeps the final exit status", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "harness-bash-output-"));
  const harness = await createHarnessModules();
  try {
    const [context, cwdModule, di, linkedTree, llm, modelSelection, sqlite, bash, toolCall] =
      await Promise.all([
        harness.load<typeof import("../../packages/context/src/index.ts")>(
          "/packages/context/src/index.ts",
        ),
        harness.load<typeof import("../../packages/cwd/src/index.ts")>(
          "/packages/cwd/src/index.ts",
        ),
        harness.load<typeof import("../../packages/di/src/index.ts")>("/packages/di/src/index.ts"),
        harness.load<typeof import("../../packages/linked-tree/src/index.ts")>(
          "/packages/linked-tree/src/index.ts",
        ),
        harness.load<typeof import("../../packages/llm/src/index.ts")>(
          "/packages/llm/src/index.ts",
        ),
        harness.load<typeof import("../../packages/model-selection/src/index.ts")>(
          "/packages/model-selection/src/index.ts",
        ),
        harness.load<typeof import("../../packages/sqlite/src/index.ts")>(
          "/packages/sqlite/src/index.ts",
        ),
        harness.load<typeof import("../../packages/pi-tools/src/bash.ts")>(
          "/packages/pi-tools/src/bash.ts",
        ),
        harness.load<typeof import("../../packages/tool-call/src/index.ts")>(
          "/packages/tool-call/src/index.ts",
        ),
      ]);
    const scope = di.createRootScope();
    scope.provideAll([
      di.createDescriptor(sqlite.SqliteService, { path: ":memory:" }),
      linkedTree.LinkedTree,
      context.Context,
      di.createDescriptor(cwdModule.CwdService, cwd),
      di.createDescriptor(modelSelection.ModelSelectionService, {
        provider: "mock",
        model: "mock",
      }),
      toolCall.ToolCallService,
    ]);
    try {
      scope.run(() => bash.useBashTool());
      await writeFile(
        join(cwd, "script.cjs"),
        `const fs = require("node:fs");
process.stdout.write("first\\n");
const timer = setInterval(() => {
  if (!fs.existsSync("release")) return;
  clearInterval(timer);
  process.stderr.write("second\\n");
  process.exitCode = 7;
}, 10);
`,
      );
      const service = scope.get(toolCall.ToolCallService);
      const firstOutput = Promise.withResolvers<string>();
      let output = "";
      const chunks: string[] = [];
      scope.run(() => {
        service.hooks.streamOutput.use(({ delta }, next) => {
          chunks.push(delta);
          return next();
        });
        service.hooks.streamOutput.use(({ callId, delta }, next) => {
          if (callId === "bash-call") {
            output += delta;
            if (output.includes("\n")) firstOutput.resolve(output);
          }
          return next();
        });
      });
      const finished = service.execute([
        llm.ToolCallBlock.create({
          id: "bash-call",
          name: "bash",
          arguments: JSON.stringify({ command: "node script.cjs", timeout: 4 }),
        }),
      ]);
      try {
        const first = await Promise.race([
          firstOutput.promise,
          finished.then(() => "process finished"),
        ]);
        expect(first).toBe("first\n");
        await writeFile(join(cwd, "release"), "");
        const [result] = await finished;
        expect(output).toBe("first\nsecond\n");
        expect(chunks.join("")).toBe(output);
        expect(result?.isError).toBe(true);
        expect(llm.extractText(result!.content)).toContain("Command exited with code 7");
      } finally {
        await writeFile(join(cwd, "release"), "");
        await finished;
      }
    } finally {
      scope.dispose();
    }
  } finally {
    await harness.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
