import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  AgentSession,
  SessionManager,
  type ExtensionRunner,
} from "@earendil-works/pi-coding-agent";
import { readPiSessionFile } from "./session-import.ts";
import type { CliSession } from "./session.ts";

export function exportJsonl(session: CliSession, outputPath?: string): string {
  return AgentSession.prototype.exportToJsonl.call(
    { sessionManager: session.transcript },
    outputPath,
  );
}

export async function exportHtml(
  session: CliSession,
  outputPath?: string,
  options?: { themeName?: string },
): Promise<string> {
  if (!session.persisted) throw new Error("Cannot export in-memory session to HTML");
  const { transcript } = session;
  const header = transcript.getHeader();
  const entries = transcript.getEntries();
  if (
    !header ||
    !entries.some(
      (entry) =>
        entry.type === "message" &&
        (entry.message.role === "user" || entry.message.role === "assistant"),
    )
  ) {
    throw new Error("Nothing to export yet - start a conversation first");
  }
  return renderHtml(
    transcript,
    `${header.timestamp.replace(/[:.]/g, "-")}_${session.id}.jsonl`,
    outputPath,
    {
      themeName: options?.themeName,
      fallbackThemeName: session.extensions.settings.getTheme(),
      systemPrompt: session.extensions.systemPrompt,
      runner: session.extensions.runner,
    },
  );
}

export async function exportPiSessionFile(
  input: string,
  cwd: string,
  outputPath?: string,
): Promise<string> {
  const { filename, source } = await readPiSessionFile(input, cwd);
  return renderHtml(source, basename(filename), outputPath);
}

async function renderHtml(
  transcript: SessionManager,
  sourceName: string,
  outputPath?: string,
  options?: {
    themeName?: string;
    fallbackThemeName?: string;
    systemPrompt?: string;
    runner?: ExtensionRunner;
  },
): Promise<string> {
  // Pi's renderer requires a readable JSONL session file. The snapshot lives only for this export.
  const dir = mkdtempSync(join(tmpdir(), "harness-pi-export-"));
  try {
    const source = join(dir, sourceName);
    const snapshot = [transcript.getHeader(), ...transcript.getEntries()]
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    writeFileSync(source, `${snapshot}\n`, { encoding: "utf8", mode: 0o600 });
    const sessionManager = SessionManager.open(source);
    const leafId = transcript.getLeafId();
    if (leafId === null) sessionManager.resetLeaf();
    else if (leafId !== sessionManager.getLeafId()) sessionManager.branch(leafId);
    const runner = options?.runner;
    return await AgentSession.prototype.exportToHtml.call(
      {
        sessionManager,
        settingsManager: { getTheme: () => options?.fallbackThemeName },
        state: { systemPrompt: options?.systemPrompt },
        _extensionRunner: runner ?? { resolveToolRenderers: () => undefined },
        getToolDefinition: (name: string) => runner?.getToolDefinition(name),
      },
      outputPath,
      options,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
