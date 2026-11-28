export interface PiContextFile {
  readonly path: string;
  readonly content: string;
}

export interface PiSkill {
  readonly name: string;
  readonly description: string;
  readonly location: string;
}

export interface PiSystemPromptOptions {
  readonly cwd: string;
  readonly tools?: readonly string[];
  readonly customPrompt?: string;
  readonly appendSystemPrompt?: string;
  readonly contextFiles?: readonly PiContextFile[];
  readonly skills?: readonly PiSkill[];
  readonly sections?: Readonly<Record<string, string>>;
}

export const PI_DEFAULT_PREAMBLE =
  "You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.";

export const PI_SYSTEM_PROMPT_SECTIONS = [
  "preamble",
  "tools",
  "rules",
  "addendum",
  "project_context",
  "skills",
  "cwd",
] as const;

const DEFAULT_TOOLS = ["read", "bash", "edit", "write"] as const;

const TOOL_SNIPPETS: Readonly<Record<string, string>> = {
  read: "Read file contents",
  bash: "Execute bash commands (ls, grep, find, etc.)",
  edit: "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
  write: "Create or overwrite files",
  grep: "Search file contents for patterns (respects .gitignore)",
  find: "Find files by glob pattern (respects .gitignore)",
  ls: "List directory contents",
};

const TOOL_GUIDELINES: Readonly<Record<string, readonly string[]>> = {
  read: ["Use read to examine files instead of cat or sed."],
  bash: ["You can inspect PI_* environment variables for current model and session details."],
  edit: [
    "Use edit for targeted changes. Batch changes to one file in a single call.",
    "Each edits[].oldText must exactly and uniquely match the original file. Keep matches short and non-overlapping; merge nearby changes without including large unchanged regions.",
  ],
  write: ["Use write only for new files or complete rewrites."],
};

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function renderProjectContext(contextFiles: readonly PiContextFile[]): string {
  return [
    "Project-specific instructions and guidelines:",
    ...contextFiles.map(
      ({ path, content }) =>
        `<project_instructions path="${path}">\n${content}\n</project_instructions>`,
    ),
  ].join("\n\n");
}

function renderSkills(skills: readonly PiSkill[], readTool: "read" | "bash"): string {
  const loadInstruction =
    readTool === "read"
      ? "Use the read tool to load a skill's file when the task matches its description."
      : "Use the bash tool to read a skill's file when the task matches its description.";
  const lines = [
    "The following skills provide specialized instructions for specific tasks.",
    loadInstruction,
    "Resolve relative paths against the skill's directory (parent of SKILL.md). Use absolute paths in tool calls.",
    "",
    "<available_skills>",
  ];
  for (const skill of skills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.location)}</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

function buildRules(selectedTools: readonly string[]): string {
  const rules: string[] = [];
  const seen = new Set<string>();
  const addRule = (rule: string): void => {
    const normalized = rule.trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    rules.push(normalized);
  };

  const hasBash = selectedTools.includes("bash");
  const hasGrep = selectedTools.includes("grep");
  const hasFind = selectedTools.includes("find");
  const hasLs = selectedTools.includes("ls");

  if (hasBash && !hasGrep && !hasFind && !hasLs) {
    addRule("Use bash for file operations like ls, rg, find");
  }

  for (const name of selectedTools) {
    for (const rule of TOOL_GUIDELINES[name] ?? []) {
      addRule(rule);
    }
  }
  addRule("Be concise in your responses");
  addRule("Show file paths clearly when working with files");
  return rules.map((rule) => `- ${rule}`).join("\n");
}

export function buildPiSystemPromptSections(
  options: PiSystemPromptOptions,
): Readonly<Record<string, string>> {
  const selectedTools = options.tools ?? DEFAULT_TOOLS;
  const rawSections: Record<string, string> = {};

  if (options.customPrompt) {
    rawSections.preamble = options.customPrompt;
  } else {
    rawSections.preamble = PI_DEFAULT_PREAMBLE;
    const toolLines = selectedTools
      .filter((name) => TOOL_SNIPPETS[name] !== undefined)
      .map((name) => `- ${name}: ${TOOL_SNIPPETS[name]}`);
    const tools = toolLines.length > 0 ? toolLines.join("\n") : "(none)";
    rawSections.tools = `${tools}\n\nAdditional tools may be available.`;
    rawSections.rules = buildRules(selectedTools);
  }

  if (options.appendSystemPrompt) {
    rawSections.addendum = options.appendSystemPrompt;
  }
  if (options.contextFiles && options.contextFiles.length > 0) {
    rawSections.project_context = renderProjectContext(options.contextFiles);
  }
  const skillReadTool = selectedTools.includes("read")
    ? "read"
    : selectedTools.includes("bash")
      ? "bash"
      : undefined;
  if (skillReadTool && options.skills && options.skills.length > 0) {
    rawSections.skills = renderSkills(options.skills, skillReadTool);
  }
  rawSections.cwd = options.cwd.replaceAll("\\", "/");

  if (options.sections) {
    for (const [name, content] of Object.entries(options.sections)) {
      if (content) rawSections[name] = content;
    }
  }

  const sections: Record<string, string> = { preamble: rawSections.preamble };
  for (const [name, content] of Object.entries(rawSections)) {
    if (name !== "preamble") {
      sections[name] = `<${name}>\n${content}\n</${name}>`;
    }
  }
  return sections;
}

export function buildPiSystemPrompt(options: PiSystemPromptOptions): string {
  return Object.values(buildPiSystemPromptSections(options)).join("\n\n");
}
