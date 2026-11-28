import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vite-plus/test";

it(
  "sends @file images as typed attachments and keeps blocked images out of provider requests",
  {
    timeout: 60_000,
  },
  () => {
    const artifacts = join(process.cwd(), "temp", "artifacts");
    mkdirSync(artifacts, { recursive: true });
    const temp = mkdtempSync(join(artifacts, "pi-cli-image-"));
    const build = join(temp, "dist");
    const agent = join(temp, "agent");
    const extension = join(temp, "image-probe.ts");
    const image =
      "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGOQawzFihiGlgQAyGE9AedF4PwAAAAASUVORK5CYII=";
    try {
      mkdirSync(agent);
      symlinkSync(
        fileURLToPath(new URL("../node_modules", import.meta.url)),
        join(temp, "node_modules"),
        "junction",
      );
      writeFileSync(join(temp, "image.png"), Buffer.from(image, "base64"));
      writeFileSync(
        extension,
        `
      import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
      export default function(pi) {
        const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        pi.registerProvider("file-probe", {
          baseUrl: "http://127.0.0.1:1",
          api: "file-probe",
          apiKey: "fixture-only",
          models: [{
            id: "fixture", name: "File probe", input: ["text", "image"],
            reasoning: false, cost, contextWindow: 20000, maxTokens: 1000,
          }],
          streamSimple(model, context) {
            const user = context.messages.findLast(message => message.role === "user");
            const text = JSON.stringify(user?.content);
            const stream = createAssistantMessageEventStream();
            const partial = {
              role: "assistant", api: model.api, provider: model.provider, model: model.id,
              content: [], stopReason: "stop", timestamp: Date.now(),
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { ...cost, total: 0 } },
            };
            stream.push({ type: "start", partial });
            stream.push({ type: "done", reason: "stop", message: { ...partial, content: [{ type: "text", text }] } });
            stream.end();
            return stream;
          },
        });
      }
    `,
      );
      execFileSync("pnpm", [
        "--filter",
        "@harness/pi-coding-agent-cli",
        "build",
        "--outDir",
        build,
      ]);
      function run(blockImages: boolean) {
        writeFileSync(
          join(agent, "settings.json"),
          JSON.stringify({ images: { autoResize: false, blockImages } }),
        );
        return JSON.parse(
          execFileSync(
            process.execPath,
            [
              join(build, "cli.js"),
              "--offline",
              "--print",
              "--approve",
              "--no-session",
              "--model",
              "file-probe/fixture",
              "-e",
              extension,
              "@image.png",
              "Inspect the attachment.",
            ],
            {
              cwd: temp,
              env: { ...process.env, PI_CODING_AGENT_DIR: agent },
              encoding: "utf8",
              input: "",
              timeout: 15_000,
            },
          ),
        );
      }
      expect(run(false)).toContainEqual({ type: "image", mimeType: "image/png", data: image });
      expect(run(true)).toEqual([
        {
          type: "text",
          text: `<file name="${join(temp, "image.png")}"></file>\nInspect the attachment.`,
        },
        { type: "text", text: "Image reading is disabled." },
      ]);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
);
