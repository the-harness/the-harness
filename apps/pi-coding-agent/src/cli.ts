import { Console } from "node:console";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import type { ExtensionOptions } from "./extensions.ts";
import { runPackageCommand } from "./package-commands.ts";
import type { LaunchPrompts } from "./pi-mode-runtime.ts";
import type { SessionOptions } from "./session.ts";

const help = `harness-pi [options] [--] [@files...] [messages...]
harness-pi install <source> [-l]
harness-pi remove <source> [-l]
harness-pi update [source | --extensions | --models]
harness-pi list
harness-pi config [-l]
harness-pi mcp <command>
harness-pi auth <command>

Options:
  --help, -h                   Show help
  --version, -v                Show version
  --print, -p                  Process prompts and exit
  --mode <text|json|rpc>        Select text output, JSON events, or the RPC protocol
  --continue, -c               Continue the most recent session in this directory
  --resume, -r                 Pick a session to resume
  --session <path|id>          Open a Pi JSONL file or a full or partial native session ID
  --session-id <id>            Reuse or create a session with this ID
  --fork <path|id>             Fork a session into the startup directory
  --name, -n <name>             Set the session display name
  --session-dir <dir>          Directory to store sessions
  --export <file> [output]     Export a Pi JSONL session to HTML and exit
  --no-session                 Run without saving a session
  --provider <name>            Restrict model selection to a provider
  --model <pattern>            Model ID, name, or provider/model, optionally with :thinking
  --models <patterns>          Set the comma-separated scope for model cycling
  --list-models [search]       List available models and exit
  --thinking <level>           Thinking level
  --api-key <key>              API key
  --tools, -t <tools>          Enable tool names or patterns, or modify defaults with +name/-name
  --exclude-tools, -xt <tools> Disable tool names or patterns
  --no-tools, -nt               Disable built-in and extension tools by default
  --no-builtin-tools, -nbt       Disable built-in tools by default
  --system-prompt <text|file>   Replace the default system prompt
  --append-system-prompt <text|file>
                               Append to the system prompt (repeatable)
  --extension <source>, -e     Load a Pi extension or package
  --no-extensions, -ne         Disable automatic extension discovery
  --no-mcp                     Disable built-in MCP support for this run
  --skill <path>               Load a skill file or directory (repeatable)
  --no-skills, -ns              Disable automatic skill discovery
  --prompt-template <path>     Load a prompt template file or directory (repeatable)
  --no-prompt-templates, -np    Disable automatic prompt template discovery
  --theme <path>                Load a theme file or directory (repeatable)
  --no-themes                   Disable automatic theme discovery
  --use-theme <name>            Select the initial theme
  --no-context-files, -nc       Disable project context file discovery
  --offline                    Disable remote model catalogs and version checks
  --tui-mode <mode>             Select fullscreen or regular terminal mode
  --verbose                    Show startup details
  --approve, -a                 Trust project-local files for this run
  --no-approve, -na             Ignore project-local files for this run`;

function promptValue(value: string | undefined): string | undefined {
  return value && existsSync(resolve(value)) ? readFileSync(resolve(value), "utf8") : value;
}

function toolNames(value: string | undefined): string[] | undefined {
  return value
    ?.split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

function resolveExtensionSource(source: string): string {
  const value = source.trim();
  if (/^(?:npm|git|github|https?|ssh|builtin):/.test(value)) return value;
  if (value.startsWith("file:")) return fileURLToPath(value);
  if (value === "~") return homedir();
  if (/^~[/\\]/.test(value)) return join(homedir(), value.slice(2));
  return resolve(value);
}

function readSettingsSessionDir(agentDir: string): string | undefined {
  const path = join(agentDir, "settings.json");
  if (!existsSync(path)) return undefined;
  try {
    const settings: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof settings !== "object" || settings === null) return undefined;
    const value = (settings as Record<string, unknown>)["sessionDir"];
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
  } catch {
    return undefined;
  }
}

function resolveSessionDir(value: string): string {
  const expanded = value === "~" ? homedir()
    : /^~[/\\]/.test(value) ? join(homedir(), value.slice(2))
    : value.startsWith("file:") ? fileURLToPath(value)
    : value;
  return resolve(expanded);
}

function normalizeArgs(args: string[]): string[] {
  const aliases = new Map([
    ["-ne", "--no-extensions"],
    ["-nt", "--no-tools"],
    ["-nbt", "--no-builtin-tools"],
    ["-xt", "--exclude-tools"],
    ["-t", "--tools"],
    ["-na", "--no-approve"],
    ["-a", "--approve"],
    ["-ns", "--no-skills"],
    ["-np", "--no-prompt-templates"],
    ["-nc", "--no-context-files"],
  ]);
  const normalized: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--") {
      normalized.push(...args.slice(index));
      break;
    }
    const option = aliases.get(argument) ?? argument;
    const value = args[index + 1];
    if (option === "--list-models") {
      const search = value && !value.startsWith("-") && !value.startsWith("@") ? value : undefined;
      normalized.push(`--list-models=${search ?? ""}`);
      if (search !== undefined) index += 1;
      continue;
    }
    if (
      (option === "--tools" || option === "--exclude-tools") &&
      value !== undefined &&
      value !== "--"
    ) {
      normalized.push(`${option}=${value}`);
      index += 1;
      continue;
    }
    normalized.push(option);
  }
  return normalized;
}

const cliOptions = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  print: { type: "boolean", short: "p" },
  mode: { type: "string" },
  continue: { type: "boolean", short: "c" },
  resume: { type: "boolean", short: "r" },
  session: { type: "string" },
  "session-dir": { type: "string" },
  export: { type: "string" },
  "session-id": { type: "string" },
  fork: { type: "string" },
  name: { type: "string", short: "n" },
  "no-session": { type: "boolean" },
  provider: { type: "string" },
  model: { type: "string" },
  models: { type: "string" },
  "list-models": { type: "string" },
  thinking: { type: "string" },
  "api-key": { type: "string" },
  tools: { type: "string" },
  "exclude-tools": { type: "string" },
  "no-tools": { type: "boolean" },
  "no-builtin-tools": { type: "boolean" },
  "system-prompt": { type: "string" },
  "append-system-prompt": { type: "string", multiple: true },
  extension: { type: "string", short: "e", multiple: true },
  "no-extensions": { type: "boolean" },
  "no-mcp": { type: "boolean" },
  skill: { type: "string", multiple: true },
  "no-skills": { type: "boolean" },
  "prompt-template": { type: "string", multiple: true },
  "no-prompt-templates": { type: "boolean" },
  theme: { type: "string", multiple: true },
  "no-themes": { type: "boolean" },
  "use-theme": { type: "string" },
  "no-context-files": { type: "boolean" },
  offline: { type: "boolean" },
  "tui-mode": { type: "string" },
  verbose: { type: "boolean" },
  approve: { type: "boolean" },
  "no-approve": { type: "boolean" },
} as const satisfies ParseArgsOptionsConfig;

function parseCliArgs(argv: string[]) {
  const args = normalizeArgs(argv);
  const config = { args, allowPositionals: true, tokens: true, options: cliOptions } as const;
  const { tokens } = parseArgs({ ...config, strict: false });
  const extensionFlags = new Map<string, boolean | string>();
  const consumed = new Set<number>();
  for (const token of tokens) {
    if (
      token.kind !== "option" ||
      !token.rawName.startsWith("--") ||
      Object.hasOwn(cliOptions, token.name)
    )
      continue;
    consumed.add(token.index);
    const next = args[token.index + 1];
    const spaced =
      token.value === undefined &&
      next !== undefined &&
      !next.startsWith("-") &&
      !next.startsWith("@");
    if (spaced) consumed.add(token.index + 1);
    extensionFlags.set(token.name, token.value ?? (spaced ? next : true));
  }
  return {
    ...parseArgs({ ...config, args: args.filter((_, index) => !consumed.has(index)) }),
    extensionFlags,
  };
}

async function main(): Promise<void> {
  process.title = "pi";
  process.env["PI_CODING_AGENT"] = "true";
  process.env["AI_AGENT"] = "pi";
  const argv = process.argv.slice(2);
  if (await runPackageCommand(argv)) return;
  const agentDir = process.env["PI_CODING_AGENT_DIR"] ?? join(homedir(), ".pi", "agent");
  if (argv[0] === "auth") {
    // The pinned Pi CLI handles auth before creating a coding session.
    const sdk = import.meta.resolve("@earendil-works/pi-coding-agent");
    const { main: runPiCommand } = (await import(new URL("main.js", sdk).href)) as {
      main(args: string[]): Promise<void>;
    };
    await runPiCommand(argv);
    return;
  }
  if (argv[0] === "mcp") {
    const sdk = import.meta.resolve("@earendil-works/pi-coding-agent");
    const { runMcpCommand } = (await import(new URL("extensions/mcp/cli.js", sdk).href)) as {
      runMcpCommand(args: string[], options: { cwd: string; agentDir: string }): Promise<number>;
    };
    process.exitCode = await runMcpCommand(argv.slice(1), { cwd: process.cwd(), agentDir });
    return;
  }
  const { values, positionals, tokens, extensionFlags } = parseCliArgs(argv);
  if (values.version) {
    console.log("1.6.1");
    return;
  }
  if (values.offline) {
    process.env["PI_OFFLINE"] = "1";
    process.env["PI_SKIP_VERSION_CHECK"] = "1";
  }
  if (values.export !== undefined && !values.help) {
    const { exportPiSessionFile } = await import("./session-export.ts");
    const path = await exportPiSessionFile(values.export, process.cwd(), positionals[0]);
    console.log(`Exported to: ${path}`);
    return;
  }
  const mode = values.mode ?? "text";
  const listModels = values["list-models"];
  if (mode !== "text" && mode !== "json" && mode !== "rpc") {
    throw new Error(`Invalid mode: ${mode}`);
  }
  const nonInteractive =
    listModels !== undefined ||
    mode !== "text" ||
    values.print ||
    !process.stdin.isTTY ||
    !process.stdout.isTTY;

  const trust = tokens.findLast(
    (token) => token.kind === "option" && (token.name === "approve" || token.name === "no-approve"),
  );
  const extensions: ExtensionOptions = {
    agentDir,
    mode: mode === "text" ? (nonInteractive ? "print" : "tui") : mode,
    paths: values.extension?.map(resolveExtensionSource) ?? [],
    disabled: values["no-extensions"] ?? false,
    noMcp: values["no-mcp"],
    skillPaths: values.skill?.map(resolveExtensionSource),
    promptTemplatePaths: values["prompt-template"]?.map(resolveExtensionSource),
    themePaths: values.theme?.map(resolveExtensionSource),
    noSkills: values["no-skills"],
    noPromptTemplates: values["no-prompt-templates"],
    noThemes: values["no-themes"],
    noContextFiles: values["no-context-files"],
    trustOverride: trust?.kind === "option" ? trust.name === "approve" : undefined,
    flagValues: extensionFlags,
    toolOptions: {
      tools: toolNames(values.tools),
      excludeTools: toolNames(values["exclude-tools"]),
      noTools: values["no-tools"],
      noBuiltinTools: values["no-builtin-tools"],
    },
  };
  if (values.help) {
    const { getExtensionFlags, prepareExtensionResources } = await import("./extensions.ts");
    const { createProjectTrustResolver } = await import("./project-trust.ts");
    const resolveTrust = createProjectTrustResolver(agentDir, "print", extensions.trustOverride);
    const { resources, flagErrors } = await prepareExtensionResources(
      process.cwd(),
      extensions,
      resolveTrust,
      true,
    );
    for (const error of flagErrors) console.error(error);
    const flags = [...getExtensionFlags(resources).values()].map(
      ({ name, type, description, extensionPath }) =>
        `  --${name}${type === "string" ? " <value>" : ""}`.padEnd(30) +
        (description ?? `Registered by ${extensionPath}`),
    );
    console.log(flags.length ? [help, "", "Extension CLI Flags:", ...flags].join("\n") : help);
    return;
  }
  if (listModels === undefined && values.provider && !values.model) {
    throw new Error(
      `--provider requires --model (for example: --provider ${values.provider} --model <pattern>)`,
    );
  }
  if (
    values["session-id"] !== undefined &&
    (values.session !== undefined || values.continue || values.resume)
  ) {
    throw new Error("--session-id cannot be combined with --session, --continue, or --resume");
  }
  const sessionId = values["session-id"];
  if (sessionId !== undefined && !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(sessionId)) {
    throw new Error(
      "Session id must be non-empty, contain only alphanumeric characters, '-', '_', and '.', and start and end with an alphanumeric character",
    );
  }
  if (values.fork !== undefined) {
    const conflicts = [
      values.session !== undefined ? "--session" : undefined,
      values.continue ? "--continue" : undefined,
      values.resume ? "--resume" : undefined,
      values["no-session"] ? "--no-session" : undefined,
    ].filter(Boolean);
    if (conflicts.length) throw new Error(`--fork cannot be combined with ${conflicts.join(", ")}`);
  }
  const pickSession =
    listModels === undefined &&
    values.resume &&
    !values["no-session"] &&
    values.session === undefined;
  if (pickSession && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error("--resume requires an interactive terminal");
  }

  const tuiMode = values["tui-mode"];
  if (tuiMode !== undefined && tuiMode !== "fullscreen" && tuiMode !== "regular") {
    throw new Error(`Invalid TUI mode "${tuiMode}". Valid values: regular, fullscreen`);
  }
  const messages: string[] = [];
  const paths: string[] = [];
  for (const argument of listModels === undefined ? positionals : []) {
    if (argument.startsWith("@")) paths.push(argument.slice(1));
    else messages.push(argument);
  }
  if (mode === "rpc" && paths.length > 0) {
    throw new Error("@file arguments are not supported in RPC mode");
  }
  let piped = "";
  if (listModels === undefined && mode !== "rpc" && !process.stdin.isTTY) {
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) piped += chunk;
  }
  const configuredSessionDir =
    values["session-dir"] ||
    process.env["PI_CODING_AGENT_SESSION_DIR"] ||
    readSettingsSessionDir(agentDir);
  const sessionDir = configuredSessionDir
    ? resolveSessionDir(configuredSessionDir)
    : join(agentDir, "sessions");
  const sessionOptions: SessionOptions = {
    cwd: process.cwd(),
    database:
      values["no-session"] || listModels !== undefined
        ? ":memory:"
        : join(sessionDir, "harness.sqlite"),
    sessionId,
    sessionReference: values["no-session"] ? undefined : values.session,
    forkReference: values.fork,
    pickSession,
    name: values.name,
    continueRecent: values.continue,
    provider: values.provider,
    model: values.model,
    modelPatterns: toolNames(values.models),
    thinking: values.thinking,
    apiKey: listModels === undefined ? values["api-key"] : undefined,
    systemPrompt: promptValue(values["system-prompt"]),
    appendSystemPrompt: values["append-system-prompt"]
      ?.map(promptValue)
      .filter(Boolean)
      .join("\n\n"),
    extensions,
  };
  const previousConsole = globalThis.console;
  if (mode !== "text" && listModels === undefined) globalThis.console = new Console(process.stderr);
  try {
    const files =
      paths.length > 0
        ? await (
            await import("./pi-input.ts")
          ).processFileArguments(paths, { autoResizeImages: false })
        : undefined;
    const initialMessage = piped.trim() + (files?.text ?? "") + (messages.shift() ?? "");
    const prompts: LaunchPrompts = {
      initialMessage: initialMessage || undefined,
      initialImages: files?.images,
      messages,
      tuiMode,
      theme: values["use-theme"],
      verbose: values.verbose,
    };
    const { runPiMode } = await import("./pi-mode-runtime.ts");
    process.exitCode = await runPiMode(
      sessionOptions,
      nonInteractive ? mode : "tui",
      prompts,
      listModels,
    );
  } finally {
    globalThis.console = previousConsole;
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
