import { basename, extname } from "node:path";
import {
  CODEX_APPROVAL_NEVER,
  CODEX_APPROVAL_ON_REQUEST,
  CODEX_BASE_INSTRUCTIONS,
  CODEX_COLLABORATION_MODE_DEFAULT,
  CODEX_SANDBOX_DANGER_FULL_ACCESS,
  CODEX_SANDBOX_READ_ONLY,
  CODEX_SANDBOX_WORKSPACE_WRITE,
} from "./instructions.ts";

export type CodexApprovalPolicy = "on-request" | "never";
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexAgentsMdMode = "first" | "replacement" | "removal";

export interface CodexPermissionsOptions {
  readonly approvalPolicy?: CodexApprovalPolicy;
  readonly sandboxMode?: CodexSandboxMode;
  readonly networkAccess?: boolean;
  readonly writableRoots?: readonly string[];
}

export interface CodexSystemPromptOptions extends CodexPermissionsOptions {
  readonly instructions?: string;
  readonly developerInstructions?: string;
  readonly updatePlan?: boolean;
  readonly includePermissionsInstructions?: boolean;
  readonly includeCollaborationMode?: boolean;
}

export interface CodexSystemPromptSection {
  readonly id: string;
  readonly text: string;
}

export interface CodexEnvironmentContextOptions {
  readonly includeTime?: boolean;
  readonly shell?: string;
  readonly timezone?: string;
  readonly currentDate?: string;
}

export interface CodexAgentsMdFile {
  readonly path: string;
  readonly content: string;
  readonly global?: boolean;
}

const AGENTS_MD_SEPARATOR = "\n\n--- project-doc ---\n\n";
const AGENTS_MD_REPLACEMENT_NOTICE =
  "These AGENTS.md instructions replace all previously provided AGENTS.md instructions.";
const AGENTS_MD_REMOVAL_NOTICE = "The previously provided AGENTS.md instructions no longer apply.";
const CHECKLIST_HEADINGS = [
  "## Planning",
  "## `update_plan`",
  "## Plan tool",
  "## Plan Mode vs update_plan tool",
] as const;
const PLAN_TOOL_LINES = [
  "- Use the plan tool ",
  "- If you create a checklist or task list,",
] as const;
const SANDBOX_TEMPLATES: Readonly<Record<CodexSandboxMode, string>> = {
  "danger-full-access": CODEX_SANDBOX_DANGER_FULL_ACCESS,
  "workspace-write": CODEX_SANDBOX_WORKSPACE_WRITE,
  "read-only": CODEX_SANDBOX_READ_ONLY,
};
const SHELL_NAMES: Readonly<Record<string, string>> = {
  bash: "bash",
  zsh: "zsh",
  sh: "sh",
  cmd: "cmd",
  pwsh: "powershell",
  powershell: "powershell",
};

function splitInclusiveNewline(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\n") {
      lines.push(text.slice(start, index + 1));
      start = index + 1;
    }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

export function filterUpdatePlanInstructions(text: string): string {
  const lines = splitInclusiveNewline(text);
  let rendered = "";
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!.trimEnd();
    if ((CHECKLIST_HEADINGS as readonly string[]).includes(line)) {
      let end = lines.length;
      for (let next = index + 1; next < lines.length; next++) {
        if (lines[next]!.startsWith("# ") || lines[next]!.startsWith("## ")) {
          end = next;
          break;
        }
      }
      const isChecklistSection =
        line !== "## Planning" ||
        lines.slice(index, end).some(
          (sectionLine) =>
            sectionLine.startsWith("You have access to an `update_plan` tool") ||
            sectionLine.startsWith("When `update_plan` is available, follow this section"),
        );
      if (isChecklistSection) {
        index = end;
        continue;
      }
    }
    if (
      line === "Progress visibility:" &&
      lines[index + 1]?.startsWith("If update_plan is available") === true
    ) {
      index += 2;
      if (lines[index] !== undefined && lines[index]!.trim() === "") index += 1;
      continue;
    }
    if (PLAN_TOOL_LINES.some((prefix) => line.startsWith(prefix))) {
      index += 1;
      while (
        index < lines.length &&
        (lines[index]!.startsWith(" ") || lines[index]!.startsWith("\t"))
      ) {
        index += 1;
      }
      continue;
    }
    rendered += lines[index];
    index += 1;
  }
  return rendered;
}

export function renderCodexInstructions(options: CodexSystemPromptOptions = {}): string {
  if (options.instructions !== undefined) return options.instructions;
  return options.updatePlan === true
    ? CODEX_BASE_INSTRUCTIONS
    : filterUpdatePlanInstructions(CODEX_BASE_INSTRUCTIONS);
}

function stripTrailingNewlines(text: string): string {
  return text.replace(/\n+$/, "");
}

export function renderPermissionsInstructions(options: CodexPermissionsOptions = {}): string {
  const sandboxMode = options.sandboxMode ?? "danger-full-access";
  const networkAccess = options.networkAccess === false ? "restricted" : "enabled";
  const sandbox = SANDBOX_TEMPLATES[sandboxMode].replace("{{ network_access }}", networkAccess);
  const approval =
    (options.approvalPolicy ?? "never") === "on-request"
      ? CODEX_APPROVAL_ON_REQUEST
      : CODEX_APPROVAL_NEVER;
  const sections = [sandbox, approval];
  const writableRoots = options.writableRoots ?? [];
  if (writableRoots.length > 0) {
    const roots = writableRoots.map((root) => `\`${root}\``).join(", ");
    const noun = writableRoots.length === 1 ? "root is" : "roots are";
    sections.push(` The writable ${noun} ${roots}.`);
  }
  return `<permissions instructions>\n${sections.map(stripTrailingNewlines).join("\n")}\n</permissions instructions>`;
}

export function buildCodexSystemPromptSections(
  options: CodexSystemPromptOptions = {},
): readonly CodexSystemPromptSection[] {
  const sections: CodexSystemPromptSection[] = [];
  const baseInstructions = renderCodexInstructions(options);
  if (baseInstructions.length > 0) {
    sections.push({ id: "instructions", text: baseInstructions });
  }
  const developerInstructions = options.developerInstructions;
  if (developerInstructions !== undefined && developerInstructions.length > 0) {
    sections.push({ id: "developer-instructions", text: developerInstructions });
  }
  if (options.includePermissionsInstructions !== false) {
    sections.push({ id: "permissions", text: renderPermissionsInstructions(options) });
  }
  if (options.includeCollaborationMode !== false) {
    sections.push({
      id: "collaboration-mode",
      text: `<collaboration_mode>${CODEX_COLLABORATION_MODE_DEFAULT}\n</collaboration_mode>`,
    });
  }
  return sections;
}

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function detectShell(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  const name = basename(path);
  return SHELL_NAMES[name] ?? SHELL_NAMES[name.slice(0, name.length - extname(name).length)];
}

function detectTimezone(): string | undefined {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return timezone.length > 0 ? timezone : undefined;
}

function detectCurrentDate(): string {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

export function renderEnvironmentContext(
  cwd: string,
  options: CodexEnvironmentContextOptions = {},
): string {
  const fields = [`  <cwd>${escapeXml(cwd)}</cwd>`];
  const shell = options.shell ?? detectShell(process.env["SHELL"] ?? process.env["ComSpec"]);
  if (shell !== undefined) fields.push(`  <shell>${escapeXml(shell)}</shell>`);
  if (options.includeTime !== false) {
    fields.push(
      `  <current_date>${escapeXml(options.currentDate ?? detectCurrentDate())}</current_date>`,
    );
    const timezone = options.timezone ?? detectTimezone();
    if (timezone !== undefined) fields.push(`  <timezone>${escapeXml(timezone)}</timezone>`);
  }
  return `<environment_context>\n${fields.join("\n")}\n</environment_context>`;
}

function concatenateAgentsMd(files: readonly CodexAgentsMdFile[]): string {
  let text = "";
  let hasPrevious = false;
  let previousWasProject = false;
  for (const file of files) {
    const isProject = file.global !== true;
    if (hasPrevious) {
      text += isProject && !previousWasProject ? AGENTS_MD_SEPARATOR : "\n\n";
    }
    text += file.global === true ? file.content.trim() : file.content;
    hasPrevious = true;
    previousWasProject = isProject;
  }
  return text;
}

export function renderAgentsMd(
  files: readonly CodexAgentsMdFile[],
  cwd: string,
  mode: CodexAgentsMdMode = "first",
): string {
  const header =
    mode === "removal" ? "# AGENTS.md instructions" : `# AGENTS.md instructions for ${cwd}`;
  const body =
    mode === "removal"
      ? AGENTS_MD_REMOVAL_NOTICE
      : mode === "replacement"
        ? `${AGENTS_MD_REPLACEMENT_NOTICE}\n\n${concatenateAgentsMd(files)}`
        : concatenateAgentsMd(files);
  return `${header}\n\n<INSTRUCTIONS>\n${body}\n</INSTRUCTIONS>`;
}
