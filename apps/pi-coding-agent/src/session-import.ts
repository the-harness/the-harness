import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  migrateSessionEntries,
  parseSessionEntries,
  sessionEntryToContextMessages,
  SessionManager,
  type InteractiveMode,
  type SessionEntry,
  type SessionProjection,
} from "@earendil-works/pi-coding-agent";
import { SupplementaryField } from "@harness/agent-loop";
import { BatchMeta } from "@harness/context";
import { MessageMeta, SystemMessage, type Message } from "@harness/llm";
import {
  bashMessage,
  contextEditMessage,
  extensionEntry,
  sessionUsage,
  stampImportedMessage,
} from "./extension-content.ts";
import { fromPiMessage } from "./extension-context.ts";

interface ImportedTranscript {
  readonly entries: readonly SessionEntry[];
  readonly nativeToPi: readonly (readonly [nativeId: string, entryId: string])[];
}

export interface ImportedSession {
  readonly path: string;
  readonly cwd: string;
  readonly leafId: string | null;
  readonly name?: string;
  readonly createdAt?: number;
  readonly model?: { readonly provider: string; readonly model: string };
  readonly thinking: string;
  readonly messages: readonly Message[];
  readonly transcript: ImportedTranscript;
}

export const ImportedTranscriptField = BatchMeta.defineField<ImportedTranscript, typeof BatchMeta>(
  "pi:cli:imported-transcript",
);

export function isSessionFile(reference: string, cwd: string): boolean {
  return (
    isAbsolute(reference) ||
    reference.includes("/") ||
    reference.endsWith(".jsonl") ||
    statSync(resolve(cwd, reference), { throwIfNoEntry: false })?.isFile() === true
  );
}

export class SessionImportError extends Error {}

export function bindImportErrors(interactive: InteractiveMode): void {
  const host = interactive as unknown as {
    handleFatalRuntimeError(label: string, error: unknown): Promise<void>;
    showError(message: string): void;
  };
  const original = host.handleFatalRuntimeError.bind(host);
  host.handleFatalRuntimeError = async (label, error) => {
    if (error instanceof SessionImportError) {
      host.showError(`${label}: ${error.message}`);
      return;
    }
    await original(label, error);
  };
}

export async function readPiSessionFile(path: string, cwd: string) {
  const filename = resolve(cwd, path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
  let content: string;
  try {
    content = await readFile(filename, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`File not found: ${filename}`);
    throw error;
  }

  const entries = parseSessionEntries(content);
  const header = entries[0];
  if (
    header?.type !== "session" ||
    typeof header.id !== "string" ||
    !entries.every((entry) => entry && typeof entry.type === "string")
  ) {
    throw new Error(`Invalid Pi JSONL session: ${filename}`);
  }
  migrateSessionEntries(entries);
  const ids = new Set<string>();
  for (const entry of entries.slice(1)) {
    if (
      entry.type === "session" ||
      typeof entry.id !== "string" ||
      ids.has(entry.id) ||
      (entry.parentId !== null && !ids.has(entry.parentId))
    ) {
      throw new Error(`Invalid Pi JSONL session ancestry: ${filename}`);
    }
    ids.add(entry.id);
  }

  const workspace = typeof header.cwd === "string" && header.cwd ? resolve(cwd, header.cwd) : cwd;
  const source = SessionManager.inMemory(workspace, undefined, entries);
  return { filename, header, source };
}

export async function loadPiSession(path: string, cwd: string): Promise<ImportedSession> {
  const { filename, header, source } = await readPiSessionFile(path, cwd);
  const projection = source.buildSessionProjection();
  const { messages, nativeToPi } = projectPiContext(projection);
  const timestamp = Date.parse(header.timestamp);
  return {
    path: filename,
    cwd: source.getCwd(),
    leafId: source.getLeafId(),
    name: source.getSessionName(),
    createdAt: Number.isFinite(timestamp) ? timestamp : undefined,
    model: projection.model
      ? { provider: projection.model.provider, model: projection.model.modelId }
      : undefined,
    thinking: projection.thinkingLevel,
    messages,
    transcript: { entries: source.getEntries(), nativeToPi },
  };
}

export function projectPiContext(projection: SessionProjection) {
  const messages: Message[] = [];
  const nativeToPi: [string, string][] = [];
  const piToNative = new Map<string, string>();
  for (const { sourceEntry, messages: projected } of projection.entries) {
    if (sourceEntry.type === "custom") {
      const marker = extensionEntry(sourceEntry.customType, sourceEntry.data);
      messages.push(marker);
      nativeToPi.push([marker.id, sourceEntry.id]);
    }
    if (sourceEntry.type === "context_edit") {
      const edit = contextEditMessage(sourceEntry, piToNative.get(sourceEntry.targetId));
      messages.push(edit);
      nativeToPi.push([edit.id, sourceEntry.id]);
      continue;
    }
    if (sourceEntry.type === "usage") {
      const usage = sessionUsage(sourceEntry);
      messages.push(usage);
      nativeToPi.push([usage.id, sourceEntry.id]);
      continue;
    }
    const originals =
      sourceEntry.type === "message" || sourceEntry.type === "custom_message"
        ? sessionEntryToContextMessages(sourceEntry)
        : projected;
    for (const piMessage of originals) {
      const native =
        piMessage.role === "bashExecution"
          ? [bashMessage(piMessage, new MessageMeta().set(SupplementaryField, true))]
          : fromPiMessage(piMessage, messages.length, true);
      if (
        piMessage.role === "system" &&
        !native.some((message) => message instanceof SystemMessage)
      ) {
        native.push(SystemMessage.create({ content: [] }));
      }
      for (const message of native) {
        stampImportedMessage(message, piMessage);
        messages.push(message);
        nativeToPi.push([message.id, sourceEntry.id]);
        piToNative.set(sourceEntry.id, message.id);
      }
    }
  }
  return { messages, nativeToPi };
}
