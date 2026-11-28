import { basename, dirname, join } from "node:path";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createSyntheticSourceInfo,
  createWriteToolDefinition,
  DefaultResourceLoader,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type BuildSystemPromptOptions,
  type ExtensionActions,
  type NormalizedBuildSystemPromptOptions,
  type ProjectTrustContext,
  type ScopedModel,
  type SessionShutdownEvent,
  type SessionStartEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Scope } from "@harness/di";
import {
  FunctionToolDeclaration,
  LlmService,
  TextBlock,
  ToolCallBlock,
  ToolResultMessage,
  type ToolDeclaration,
} from "@harness/llm";
import { ModelSelectionService } from "@harness/model-selection";
import { useMcp } from "@harness/mcp";
import {
  truncateTail,
  useBashTool,
  useEditTool,
  useFindTool,
  useGrepTool,
  useLsTool,
  useReadTool,
  useWriteTool,
} from "@harness/pi-tools";
import { ToolCallService, functionTool } from "@harness/tool-call";
import {
  effectScope,
  onScopeDispose,
  shallowReactive,
  shallowRef,
  watch,
  type EffectScope,
} from "reactivity";
import { z } from "zod";
import {
  fromPiContent,
  parseToolInput,
  readToolResultData,
  stampToolResultData,
  toPiContent,
  type PiMessage,
  type PiToolResult,
} from "./extension-content.ts";
import { PiModelProviders, PiRuntimeApiKey } from "./model-providers.ts";
import { expandResourcePrompt } from "./pi-input.ts";
import type { ProjectTrustResolver } from "./project-trust.ts";
import {
  builtinTools,
  createToolSelection,
  type PiToolOptions,
  type ToolHistory,
} from "./tool-selection.ts";

const builtinToolSetups: Record<(typeof builtinTools)[number], (sessionId: string) => void> = {
  read: useReadTool,
  bash: useBashTool,
  edit: useEditTool,
  write: useWriteTool,
  grep: useGrepTool,
  find: useFindTool,
  ls: useLsTool,
};

type InputImages = Parameters<ExtensionRunner["emitInput"]>[1];
type ExtensionContextActions = Parameters<ExtensionRunner["bindCore"]>[1];
type GetCallableTools = NonNullable<ExtensionContextActions["getCallableTools"]>;
type ExecuteNestedTool = NonNullable<ExtensionContextActions["executeTool"]>;
type NestedOutcome = Awaited<ReturnType<ExecuteNestedTool>>;
type NestedEvent = Extract<
  AgentSessionEvent,
  { type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end" }
>;
type NestedRecord = Pick<ReturnType<typeof readToolResultData>, "nestedCalls" | "usage">;
const sdk = import.meta.resolve("@earendil-works/pi-coding-agent");
const [
  { NestedToolCallRunner },
  { combineUsage },
  { buildSystemPrompt, buildSystemPromptSections, normalizeBuildSystemPromptOptions },
] = await Promise.all([
  import(new URL("core/nested-tool-calls.js", sdk).href) as Promise<{
    NestedToolCallRunner: new (host: {
      getTools: GetCallableTools;
      isSequential(): boolean;
      runToolCall(
        call: NestedOutcome["toolCall"],
        parent: string,
        signal: AbortSignal | undefined,
        onUpdate: (update: NestedOutcome["result"]) => Promise<void>,
      ): Promise<NestedOutcome>;
      emit(event: NestedEvent): Promise<void>;
    }) => {
      execute: ExecuteNestedTool;
      takeRecord(
        id: string,
      ): { calls: NestedRecord["nestedCalls"]; usage: NestedRecord["usage"] } | undefined;
      clear(): void;
    };
  }>,
  import(new URL("core/usage-totals.js", sdk).href) as Promise<{
    combineUsage(
      usage: NonNullable<NestedRecord["usage"]>,
      nested: NonNullable<NestedRecord["usage"]>,
    ): NonNullable<NestedRecord["usage"]>;
  }>,
  import(new URL("core/system-prompt.js", sdk).href) as Promise<{
    buildSystemPrompt(options: BuildSystemPromptOptions): string;
    buildSystemPromptSections(options: BuildSystemPromptOptions): Record<string, string>;
    normalizeBuildSystemPromptOptions(
      options: BuildSystemPromptOptions,
    ): NormalizedBuildSystemPromptOptions;
  }>,
]);
interface ExtensionResources {
  readonly settings: SettingsManager;
  readonly resources: DefaultResourceLoader;
}

export interface ExtensionOptions {
  readonly agentDir: string;
  readonly mode: "tui" | "print" | "json" | "rpc";
  readonly paths: readonly string[];
  readonly disabled: boolean;
  readonly noMcp?: boolean;
  readonly skillPaths?: readonly string[];
  readonly promptTemplatePaths?: readonly string[];
  readonly themePaths?: readonly string[];
  readonly noSkills?: boolean;
  readonly noPromptTemplates?: boolean;
  readonly noThemes?: boolean;
  readonly noContextFiles?: boolean;
  readonly trustOverride?: boolean;
  readonly flagValues?: ReadonlyMap<string, boolean | string>;
  readonly toolOptions?: PiToolOptions;
}

export function getExtensionFlags(resources: DefaultResourceLoader) {
  return new Map(resources.getExtensions().extensions.flatMap((extension) => [...extension.flags]));
}

function applyExtensionFlags(
  resources: DefaultResourceLoader,
  values?: ExtensionOptions["flagValues"],
): string[] {
  if (!values?.size) return [];
  const registered = getExtensionFlags(resources);
  const { flagValues } = resources.getExtensions().runtime;
  const errors: string[] = [];
  const unknown: string[] = [];
  for (const [name, value] of values) {
    const flag = registered.get(name);
    if (!flag) {
      unknown.push(`--${name}`);
    } else if (flag.type === "boolean") {
      flagValues.set(name, true);
    } else if (typeof value === "string") {
      flagValues.set(name, value);
    } else {
      errors.push(`Extension flag "--${name}" requires a value`);
    }
  }
  if (unknown.length)
    errors.push(`Unknown option${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  return errors;
}

export async function prepareExtensionResources(
  cwd: string,
  options: ExtensionOptions,
  trust: ProjectTrustResolver,
  startup: boolean,
  context?: ProjectTrustContext,
): Promise<ExtensionResources & { readonly flagErrors: readonly string[] }> {
  const settings = SettingsManager.create(cwd, options.agentDir, { projectTrusted: false });
  type Factories = NonNullable<
    ConstructorParameters<typeof DefaultResourceLoader>[0]["extensionFactories"]
  >;
  const { builtInExtensions } = (await import(new URL("extensions/index.js", sdk).href)) as {
    builtInExtensions: Factories;
  };
  const resources = new DefaultResourceLoader({
    cwd,
    agentDir: options.agentDir,
    settingsManager: settings,
    additionalExtensionPaths: [...options.paths],
    additionalSkillPaths: options.skillPaths && [...options.skillPaths],
    additionalPromptTemplatePaths: options.promptTemplatePaths && [...options.promptTemplatePaths],
    additionalThemePaths: options.themePaths && [...options.themePaths],
    noExtensions: options.disabled,
    noSkills: options.noSkills,
    noPromptTemplates: options.noPromptTemplates,
    noThemes: options.noThemes,
    noContextFiles: options.noContextFiles,
    extensionFactories: builtInExtensions.filter(
      (extension) =>
        typeof extension === "object" &&
        (extension.name === "llama.cpp" ||
          extension.name === "mcp" ||
          extension.name === "tool-search" ||
          extension.name === "codemode"),
    ),
    disabledBuiltinExtensions: options.noMcp ? ["mcp"] : [],
    packageCommandOutput: "capture",
  });
  await resources.reload(trust(cwd, settings, startup, context));
  return { settings, resources, flagErrors: applyExtensionFlags(resources, options.flagValues) };
}

export async function loadExtensions(
  scope: Scope,
  options: ExtensionOptions &
    ExtensionResources & {
      readonly cwd: string;
      readonly systemPrompt?: string;
      readonly appendSystemPrompt?: string;
      readonly toolHistory?: ToolHistory;
      readonly reloadToolNames?: readonly string[];
      readonly abort: () => void;
      readonly compact: AgentSession["compact"];
      readonly setSessionName: AgentSession["setSessionName"];
      readonly setModel: (provider: string, model: string) => Promise<void>;
      readonly getScopedModels: () => readonly ScopedModel[];
      readonly onModelsChange: () => void;
      readonly setThinking: (level: AgentSession["thinkingLevel"]) => void;
      readonly getThinking: () => AgentSession["thinkingLevel"];
      readonly getContextUsage: AgentSession["getContextUsage"];
      readonly hasNativeCredentials: (provider: string) => boolean;
      readonly hasPendingMessages: () => boolean;
      readonly startReason: SessionStartEvent["reason"];
      readonly transcript: SessionManager;
      readonly sendMessage: ExtensionActions["sendMessage"];
      readonly sendUserMessage: ExtensionActions["sendUserMessage"];
      readonly appendEntry: ExtensionActions["appendEntry"];
      readonly onToolUpdate: (callId: string, result: PiToolResult) => void;
      readonly onNestedToolEvent: (event: NestedEvent) => void;
    },
  previousFlagValues?: ReadonlyMap<string, boolean | string>,
) {
  const { settings, resources } = options;
  const previousDefaults =
    previousFlagValues &&
    createToolSelection(settings.getDefaultTools(), options.toolOptions).active(builtinTools);
  if (previousFlagValues) await resources.reload();
  const toolSelection = createToolSelection(settings.getDefaultTools(), options.toolOptions);
  const { extensions, runtime, errors, warnings } = resources.getExtensions();
  for (const [name, value] of previousFlagValues ?? []) runtime.flagValues.set(name, value);
  for (const error of errors) console.error(`Extension error (${error.path}): ${error.error}`);
  for (const warning of warnings ?? [])
    console.error(`Extension warning (${warning.path}): ${warning.warning}`);

  const toolCall = scope.get(ToolCallService);
  const selection = scope.get(ModelSelectionService);
  const llm = scope.get(LlmService);
  const modelProviders = scope.get(PiModelProviders);
  const { transcript } = options;
  const models = await ModelRuntime.create({
    modelsPath: join(options.agentDir, "models.json"),
    authPath: join(options.agentDir, "auth.json"),
    refreshOnCreate: false,
  });
  modelProviders.registerNativeProviders(models, options.hasNativeCredentials);
  const catalog = new ModelRegistry(models);
  const runner = new ExtensionRunner(extensions, runtime, options.cwd, transcript, catalog);
  const hostEffects = scope.run(() => effectScope());
  const catalogScope = scope.createChild();
  catalogScope.provide(ToolCallService);
  const catalogTools = catalogScope.get(ToolCallService);
  catalogScope.run(useMcp);
  const nestedScope = scope.createChild();
  nestedScope.provide(ToolCallService);
  const nestedToolCall = nestedScope.get(ToolCallService);
  hostEffects.run(() => {
    onScopeDispose(() => catalogScope.dispose());
    onScopeDispose(() => nestedScope.dispose());
    nestedToolCall.hooks.execute.use((input, next) => toolCall.hooks.execute.run(input, next));
    nestedToolCall.hooks.streamOutput.use((input, next) =>
      toolCall.hooks.streamOutput.run(input, next),
    );
  });
  let providersReady = false;
  function updateProviders(update: () => void): void {
    update();
    if (providersReady) options.onModelsChange();
  }
  let shutdown = options.abort;
  const registered = shallowReactive(
    new Map<string, { readonly definition: ToolDefinition; readonly owner: EffectScope }>(),
  );
  const builtinOwners = new Map<string, EffectScope>();
  const toolResults = new Map<string, PiToolResult>();
  const enabled = shallowRef<readonly string[]>();
  let restored = new Set<string>();
  let disabledByHistory = new Set<string>();
  let signal: AbortSignal | undefined;
  let runPromptOptions: NormalizedBuildSystemPromptOptions | undefined;

  const builtinPromptTools = new Map(
    [
      createReadToolDefinition,
      createBashToolDefinition,
      createEditToolDefinition,
      createWriteToolDefinition,
      createGrepToolDefinition,
      createFindToolDefinition,
      createLsToolDefinition,
    ].map((createDefinition) => {
      const { name, promptSnippet, promptGuidelines } = createDefinition(options.cwd);
      return [name, { promptSnippet, promptGuidelines }] as const;
    }),
  );
  const promptTool = (name: string) =>
    registered.get(name)?.definition ?? builtinPromptTools.get(name);

  const getTools = () => runner.getAllRegisteredTools();
  const getActiveTools = () => modelTools().map((tool) => tool.declaration().name);
  const getExposure = (name: string) => registered.get(name)?.definition.exposure ?? "direct";
  function callableTools(active: ReadonlySet<string> = new Set(getActiveTools())) {
    return catalogTools.tools.filter((tool) => {
      const { name } = tool.declaration();
      const exposure = getExposure(name);
      return (
        exposure === "codemode" ||
        exposure === "deferred" ||
        (exposure === "direct" && active.has(name))
      );
    });
  }
  function toolOutcome(native: ToolResultMessage): NestedOutcome["result"] {
    return {
      content: toPiContent(native.content),
      details: {},
      ...readToolResultData(native),
      isError: native.isError ?? false,
    };
  }
  const getRegisteredTools: GetCallableTools = () => {
    const declarations = new Map(
      catalogTools.tools
        .map((tool) => tool.declaration())
        .filter((tool) => tool instanceof FunctionToolDeclaration)
        .map((tool) => [tool.name, tool]),
    );
    const names = new Set([...builtinTools, ...registered.keys(), ...declarations.keys()]);
    return [...names].flatMap((name) => {
      const tool = declarations.get(name);
      if (!tool) return [];
      const definition = registered.get(tool.name)?.definition;
      return [
        {
          ...tool,
          parameters: tool.parameters as ToolDefinition["parameters"],
          label: definition?.label ?? tool.name,
          outputSchema: definition?.outputSchema,
          executionMode: definition?.executionMode,
          async execute(id: string, args: unknown, signal: AbortSignal = AbortSignal.any([])) {
            const [result] = await nestedToolCall.execute(
              [
                ToolCallBlock.create({
                  id,
                  name: tool.name,
                  arguments: JSON.stringify(args ?? {}),
                }),
              ],
              signal,
            );
            return toolOutcome(result!);
          },
        },
      ];
    });
  };
  const getCallableTools: GetCallableTools = () => {
    const tools = new Set(callableTools().map((tool) => tool.declaration().name));
    return getRegisteredTools().filter(({ name }) => tools.has(name));
  };
  function projectTools(
    tools: readonly ToolDeclaration[] | undefined,
  ): readonly ToolDeclaration[] | undefined {
    const hooks = (tools ?? []).flatMap(({ name }) => {
      const definition = registered.get(name)?.definition;
      return definition?.prepareLoadout ? [definition] : [];
    });
    if (!tools || hooks.length === 0) return tools;
    const available = getRegisteredTools();
    const byName = new Map(available.map((tool) => [tool.name, tool]));
    const callable = new Set(
      callableTools(new Set(tools.map(({ name }) => name))).map((tool) => tool.declaration().name),
    );
    const loadout = {
      declared: tools.flatMap(({ name }) => (byName.has(name) ? [byName.get(name)!] : [])),
      callable: available.filter(({ name }) => callable.has(name)),
      registered: available,
      getExposure,
      getNamespace: (name: string) => registered.get(name)?.definition.namespace,
      getPromptGuidelines: (name: string) => promptTool(name)?.promptGuidelines ?? [],
    };
    const descriptions = new Map<string, string>();
    const hidden = new Set<string>();
    for (const definition of hooks) {
      try {
        const changes = definition.prepareLoadout?.(loadout);
        for (const [name, description] of Object.entries(changes?.descriptions ?? {}))
          descriptions.set(name, description);
        for (const name of changes?.hiddenDeclarations ?? []) hidden.add(name);
      } catch (error) {
        runner.emitError({
          extensionPath:
            getTools().find((tool) => tool.definition === definition)?.sourceInfo.path ??
            definition.name,
          event: "prepare_loadout",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return tools
      .filter(({ name }) => !hidden.has(name))
      .map((tool) => {
        const description = descriptions.get(tool.name);
        return description === undefined
          ? tool
          : tool instanceof FunctionToolDeclaration
            ? FunctionToolDeclaration.create({ ...tool, description })
            : tool;
      });
  }
  function promptLoadout() {
    const active = modelDeclarations();
    const visible = new Set(projectTools(active)?.map(({ name }) => name));
    return {
      selectedTools: active.map(({ name }) => name),
      hiddenTools: active.filter(({ name }) => !visible.has(name)).map(({ name }) => name),
    };
  }
  function toolPromptMetadata() {
    const toolSnippets: Record<string, string> = {};
    const toolGuidelines: Record<string, string[]> = {};
    for (const declared of toolCall.tools) {
      const name = declared.declaration().name;
      const tool = promptTool(name);
      const snippet = tool?.promptSnippet?.trim();
      if (snippet) toolSnippets[name] = snippet;
      if (tool?.promptGuidelines) toolGuidelines[name] = [...tool.promptGuidelines];
    }
    return { toolSnippets, toolGuidelines };
  }
  function basePromptOptions(): BuildSystemPromptOptions {
    return {
      cwd: options.cwd,
      ...promptLoadout(),
      ...toolPromptMetadata(),
      customPrompt: options.systemPrompt ?? resources.getSystemPrompt(),
      appendSystemPrompt:
        options.appendSystemPrompt ?? resources.getAppendSystemPrompt().join("\n\n"),
      contextFiles: resources.getAgentsFiles().agentsFiles,
      skills: resources.getSkills().skills,
    };
  }
  function currentPromptOptions(): BuildSystemPromptOptions {
    return runPromptOptions ? { ...runPromptOptions, ...promptLoadout() } : basePromptOptions();
  }
  const nestedUpdates = new Map<
    string,
    {
      parentToolCallId: string;
      update: (result: NestedOutcome["result"]) => Promise<void>;
      output: string;
    }
  >();
  const nestedTools = new NestedToolCallRunner({
    getTools: getCallableTools,
    isSequential: () => false,
    async runToolCall(call, parent, signal, onUpdate) {
      const start = performance.now();
      nestedUpdates.set(call.id, { parentToolCallId: parent, update: onUpdate, output: "" });
      try {
        const [message] = await nestedToolCall.execute(
          [
            ToolCallBlock.create({
              id: call.id,
              name: call.name,
              arguments: JSON.stringify(call.arguments),
            }),
          ],
          signal,
        );
        return {
          toolCall: call,
          result: toolOutcome(message!),
          isError: message!.isError ?? false,
          durationMs: Math.round(performance.now() - start),
        };
      } catch (error) {
        return {
          toolCall: call,
          result: {
            content: [
              { type: "text", text: error instanceof Error ? error.message : String(error) },
            ],
            details: {},
          },
          isError: true,
        };
      } finally {
        nestedUpdates.delete(call.id);
      }
    },
    async emit(event) {
      await runner.emit(event);
      options.onNestedToolEvent(event);
    },
  });
  hostEffects.run(() =>
    toolCall.hooks.streamOutput.use(({ callId, delta }, next) => {
      next();
      const progress = nestedUpdates.get(callId);
      if (!progress) return;
      progress.output = truncateTail(progress.output + delta).content;
      void progress.update({ content: [{ type: "text", text: progress.output }], details: {} });
    }),
  );
  const isDeclarable = (tool: ToolDefinition) =>
    tool.exposure === undefined || tool.exposure === "direct" || tool.exposure === "model-only";
  const activatesOnRegistration = (tool: ToolDefinition) =>
    isDeclarable(tool) &&
    tool.defaultActive !== false &&
    toolSelection.isAllowed(tool.name) &&
    !toolSelection.isRemovedByModifier(tool.name);
  function modelTools() {
    const definitions = new Map(catalogTools.tools.map((tool) => [tool.declaration().name, tool]));
    const names = [
      ...builtinTools.filter((name) => definitions.has(name)),
      ...[...definitions.keys()].filter((name) => !builtinTools.includes(name)),
    ];
    const extensionDefaults = [...registered.values()]
      .map(({ definition }) => definition)
      .filter(activatesOnRegistration)
      .map(({ name }) => name);
    const auto = [
      ...extensionDefaults,
      ...names.filter((name) => !builtinTools.includes(name) && !registered.has(name)),
    ];
    const declarable = names.filter((name) => {
      const entry = registered.get(name);
      return !entry || isDeclarable(entry.definition);
    });
    const selected =
      enabled.value === undefined
        ? toolSelection.active(declarable, auto)
        : enabled.value.filter(
            (name) =>
              names.includes(name) &&
              toolSelection.isAllowed(
                name,
                registered.has("tool_search") && !declarable.includes(name),
              ),
          );
    return selected.map((name) => definitions.get(name)!);
  }
  function modelDeclarations(): readonly ToolDeclaration[] {
    return modelTools().map((tool) => tool.declaration());
  }
  const setActiveTools = (names: readonly string[]) => {
    const active = new Set(getActiveTools());
    const replacesRestored = [...active].some(
      (name) => restored.has(name) && !names.includes(name),
    );
    const pending = (enabled.value ?? []).filter((name) => restored.has(name) && !active.has(name));
    if (replacesRestored) for (const name of pending) disabledByHistory.add(name);
    enabled.value = [...new Set(replacesRestored ? names : [...names, ...pending])];
  };
  function restoreTools(history: ToolHistory | undefined, useModifiers = false): void {
    restored.clear();
    disabledByHistory.clear();
    if (!history) {
      if (enabled.value) enabled.value = getActiveTools();
      return;
    }
    const added = [...registered.values()]
      .map(({ definition }) => definition)
      .filter(
        (tool) =>
          !builtinTools.includes(tool.name) &&
          !history.mentioned.has(tool.name) &&
          activatesOnRegistration(tool),
      )
      .map(({ name }) => name);
    const names = [...history.active, ...added];
    enabled.value = useModifiers ? toolSelection.applyModifiers(names) : names;
    restored = new Set(
      useModifiers ? toolSelection.applyModifiers(history.active) : history.active,
    );
    disabledByHistory = new Set([...history.mentioned].filter((name) => !restored.has(name)));
  }
  const refreshTools = () => {
    const previouslyAutomatic = new Set(
      [...registered.values()]
        .map(({ definition }) => definition)
        .filter(activatesOnRegistration)
        .map(({ name }) => name),
    );
    const desired = new Map(
      getTools()
        .map(({ definition }) => definition)
        .filter((tool) => tool.exposure !== "hidden" && toolSelection.isAllowed(tool.name, true))
        .map((tool) => [tool.name, tool]),
    );
    for (const [name, entry] of registered) {
      if (entry.definition !== desired.get(name)) {
        entry.owner.stop();
        registered.delete(name);
      }
    }
    const occupied = new Set(catalogTools.tools.map((tool) => tool.declaration().name));
    for (const [name, definition] of desired) {
      if (registered.has(name)) continue;
      if (occupied.has(name) && !builtinOwners.has(name)) {
        console.error(`Extension tool '${name}' conflicts with an existing Harness tool`);
        continue;
      }
      const owner = hostEffects.run(() => effectScope())!;
      try {
        const parameters = z.fromJSONSchema(JSON.parse(JSON.stringify(definition.parameters)));
        builtinOwners.get(name)?.stop();
        builtinOwners.delete(name);
        owner.run(() =>
          catalogTools.useTool(
            functionTool({
              name,
              description: definition.description,
              parameters,
              async execute(input, ctx) {
                const result = await definition.execute(
                  ctx.callId,
                  input,
                  ctx.signal,
                  (update) => {
                    const nested = nestedUpdates.get(ctx.callId);
                    if (nested) void nested.update(update);
                    else options.onToolUpdate(ctx.callId, update);
                  },
                  runner.createToolContext(ctx.callId, ctx.signal),
                );
                toolResults.set(ctx.callId, result);
                return fromPiContent(result.content);
              },
            }),
          ),
        );
        registered.set(name, { definition, owner });
        if (
          enabled.value &&
          !enabled.value.includes(name) &&
          !disabledByHistory.has(name) &&
          !previouslyAutomatic.has(name) &&
          activatesOnRegistration(definition)
        ) {
          enabled.value = [...enabled.value, name];
        }
      } catch (error) {
        owner.stop();
        console.error(
          `Extension tool '${name}': ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    for (const [name, setup] of Object.entries(builtinToolSetups)) {
      if (registered.has(name) || builtinOwners.has(name)) continue;
      const owner = hostEffects.run(() => effectScope())!;
      catalogScope.run(() => owner.run(() => setup(transcript.getSessionId())));
      builtinOwners.set(name, owner);
    }
  };

  hostEffects.run(() =>
    watch(
      () => [modelTools(), callableTools()] as const,
      ([model, callable], _previous, onCleanup) => {
        const owner = effectScope();
        onCleanup(() => owner.stop());
        owner.run(() => {
          for (const tool of model) toolCall.useTool(tool);
          for (const tool of callable) nestedToolCall.useTool(tool);
        });
      },
      { immediate: true, flush: "sync" },
    ),
  );

  runner.bindCore(
    {
      sendMessage: options.sendMessage,
      sendUserMessage: options.sendUserMessage,
      appendEntry: options.appendEntry,
      setSessionName: options.setSessionName,
      getSessionName: () => transcript.getSessionName(),
      setLabel: (id, label) => {
        transcript.appendLabelChange(id, label);
      },
      getActiveTools,
      getAllTools: () => [
        ...catalogTools.tools
          .filter((tool) => {
            const { name } = tool.declaration();
            return !registered.has(name) && toolSelection.isAllowed(name);
          })
          .map((tool) => tool.declaration())
          .filter((tool) => tool instanceof FunctionToolDeclaration)
          .map((tool) => ({
            ...tool,
            parameters: tool.parameters as ToolDefinition["parameters"],
            exposure: "direct" as const,
            sourceInfo: builtinTools.includes(tool.name)
              ? createSyntheticSourceInfo(`builtin:${tool.name}`, { source: "builtin" })
              : createSyntheticSourceInfo(`<harness:${tool.name}>`, { source: "harness" }),
          })),
        ...getTools()
          .filter(({ definition }) => toolSelection.isAllowed(definition.name, true))
          .map(({ definition, sourceInfo }) => ({
            ...definition,
            exposure: definition.exposure ?? "direct",
            sourceInfo,
          })),
      ],
      getSettings: () => settings.getSettings(),
      setActiveTools,
      refreshTools,
      getCommands: () =>
        runner.getRegisteredCommands().map((command) => ({
          name: command.invocationName,
          description: command.description,
          source: "extension",
          sourceInfo: command.sourceInfo,
        })),
      async setModel(model) {
        if (
          !llm.models.some(
            (candidate) => candidate.provider === model.provider && candidate.id === model.id,
          )
        )
          return false;
        await options.setModel(model.provider, model.id);
        return true;
      },
      getThinkingLevel: options.getThinking,
      setThinkingLevel: options.setThinking,
    },
    {
      getModel() {
        const { provider, model } = selection.current;
        const selected = llm.models.find(
          (candidate) => candidate.provider === provider && candidate.id === model,
        );
        return selected && modelProviders.toPiModel(selected);
      },
      getScopedModels: options.getScopedModels,
      isIdle: () => signal === undefined,
      isProjectTrusted: () => settings.isProjectTrusted(),
      getSignal: () => signal,
      abort: options.abort,
      shutdown: () => shutdown(),
      hasPendingMessages: options.hasPendingMessages,
      getContextUsage: options.getContextUsage,
      getCallableTools,
      executeTool: (callerId, name, args, options) =>
        nestedTools.execute(callerId, name, args, options),
      compact: (request) => {
        void options
          .compact(request?.customInstructions)
          .then(request?.onComplete, (error: unknown) => {
            if (request?.onError)
              request.onError(error instanceof Error ? error : new Error(String(error)));
          });
      },
      getSystemPrompt: () => buildSystemPrompt(currentPromptOptions()),
      getSystemPromptOptions: () => normalizeBuildSystemPromptOptions(basePromptOptions()),
    },
    {
      registerProvider: (name, config) =>
        updateProviders(() => catalog.registerProvider(name, config)),
      registerNativeProvider: (provider) =>
        updateProviders(() => catalog.registerProvider(provider)),
      unregisterProvider: (name) =>
        updateProviders(() => {
          catalog.unregisterProvider(name);
          modelProviders.restoreNativeProvider(models, name);
        }),
      registerVirtualModel: (definition) =>
        updateProviders(() => catalog.registerVirtualModel(definition)),
      unregisterVirtualModel: (provider, id) =>
        updateProviders(() => catalog.unregisterVirtualModel(provider, id)),
    },
  );

  await scope.get(PiRuntimeApiKey).apply(models);
  await models.refresh({ allowNetwork: false });
  modelProviders.setRuntime(models, runner, settings);
  providersReady = true;

  hostEffects.run(() =>
    toolCall.hooks.execute.use(async ({ call, signal: toolSignal }, next) => {
      const parentToolCallId = nestedUpdates.get(call.id)?.parentToolCallId;
      if (toolSignal.aborted) return next();
      const input = parseToolInput(call.arguments);
      if (!input) return next();
      const gate = await runner.emitToolCall({
        type: "tool_call",
        toolCallId: call.id,
        toolName: call.name,
        input,
        parentToolCallId,
      });
      if (gate?.block) {
        return ToolResultMessage.create({
          toolCallId: call.id,
          toolName: call.name,
          isError: true,
          content: [TextBlock.create({ text: gate.reason ?? `Tool ${call.name} is disabled` })],
        });
      }
      const effective = ToolCallBlock.create({ ...call, arguments: JSON.stringify(input) });
      const result = await next({ call: effective, signal: toolSignal });
      const extensionResult = toolResults.get(call.id);
      toolResults.delete(call.id);
      const content = toPiContent(result.content);
      const isError = extensionResult?.isError ?? result.isError;
      const replacement = await runner.emitToolResult({
        type: "tool_result",
        toolCallId: call.id,
        toolName: call.name,
        input,
        parentToolCallId,
        content,
        isError: isError ?? false,
        details: extensionResult?.details,
        structuredContent: extensionResult?.structuredContent,
        usage: extensionResult?.usage,
      });
      const final =
        replacement || result.isError !== isError
          ? ToolResultMessage.create({
              ...result,
              content:
                replacement?.content === undefined || replacement.content === content
                  ? result.content
                  : fromPiContent(replacement.content),
              isError: replacement?.isError ?? isError,
            })
          : result;
      const nested = parentToolCallId === undefined ? nestedTools.takeRecord(call.id) : undefined;
      const ownUsage = replacement?.usage ?? extensionResult?.usage;
      stampToolResultData(final, {
        details:
          replacement?.details === undefined ? extensionResult?.details : replacement.details,
        structuredContent:
          replacement?.structuredContent === undefined
            ? extensionResult?.structuredContent
            : replacement.structuredContent,
        usage:
          ownUsage && nested?.usage
            ? combineUsage(ownUsage, nested.usage)
            : (ownUsage ?? nested?.usage),
        nestedCalls: nested?.calls,
      });
      return final;
    }),
  );
  refreshTools();
  if (previousDefaults && options.reloadToolNames) {
    const addedDefaults = toolSelection
      .active(builtinTools)
      .filter((name) => !previousDefaults.includes(name));
    restoreTools({
      active: [...new Set([...options.reloadToolNames, ...addedDefaults])],
      mentioned: new Set(builtinTools),
    });
  } else if (toolSelection.restoreOnStartup) {
    restoreTools(options.toolHistory, true);
  }

  let bound = false;
  return {
    runner,
    resources,
    settings,
    modelDeclarations,
    isNestedToolCall: (callId: string) => nestedUpdates.has(callId),
    projectTools,
    restoreTools,
    getSelectedToolNames: () => enabled.value ?? getActiveTools(),
    getCallableTools,
    systemPromptSections: () => buildSystemPromptSections(currentPromptOptions()),
    refreshPromptTools() {
      if (!runPromptOptions) return;
      const { toolSnippets, toolGuidelines } = toolPromptMetadata();
      runPromptOptions.toolSnippets = { ...toolSnippets, ...runPromptOptions.toolSnippets };
      runPromptOptions.toolGuidelines = { ...toolGuidelines, ...runPromptOptions.toolGuidelines };
    },
    modelRuntime: models,
    get systemPrompt() {
      return buildSystemPrompt(currentPromptOptions());
    },
    get forceSystemPrompt() {
      return runPromptOptions?.forceSystemPrompt;
    },
    async bind(bindings: Parameters<AgentSession["bindExtensions"]>[0]) {
      if (bound) return;
      bound = true;
      shutdown = bindings.shutdownHandler ?? options.abort;
      runner.setUIContext(bindings.uiContext, bindings.mode ?? options.mode);
      runner.bindCommandContext(bindings.commandContextActions);
      runner.onError(
        bindings.onError ??
          ((error) => {
            console.error(`Extension error (${error.extensionPath}): ${error.error}`);
          }),
      );
      await runner.emit({ type: "session_start", reason: options.startReason });
      runner.reportUnhandledMcpServers();
      if (runner.hasHandlers("resources_discover")) {
        const reason = options.startReason === "reload" ? "reload" : "startup";
        const { skillPaths, promptPaths, themePaths } = await runner.emitResourcesDiscover(
          options.cwd,
          reason,
        );
        const resourcePaths = (entries: typeof skillPaths) =>
          entries.map(({ path, extensionPath }) => ({
            path,
            metadata: {
              source: `extension:${basename(extensionPath).replace(/[<>]/g, "")}`,
              scope: "temporary" as const,
              origin: "top-level" as const,
              baseDir: extensionPath.startsWith("<") ? undefined : dirname(extensionPath),
            },
          }));
        resources.extendResources({
          skillPaths: resourcePaths(skillPaths),
          promptPaths: resourcePaths(promptPaths),
          themePaths: resourcePaths(themePaths),
        });
      }
    },
    async command(text: string): Promise<boolean> {
      if (!text.startsWith("/")) return false;
      const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
      if (!match) return false;
      const command = runner.getCommand(match[1]!);
      if (!command) return false;
      await command.handler(match[2] ?? "", runner.createCommandContext());
      return true;
    },
    async input(
      text: string,
      images?: InputImages,
      queue?: "steer" | "followUp",
      source?: "extension",
    ) {
      return runner.emitInput(
        text,
        images,
        source ?? (options.mode === "rpc" ? "rpc" : "interactive"),
        queue,
      );
    },
    expandPrompt(text: string) {
      return expandResourcePrompt(text, resources, (path, error) => {
        runner.emitError({
          extensionPath: path,
          event: "skill_expansion",
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
    async prepareRun(
      trigger: Parameters<ExtensionRunner["emitBeforeAgentStart"]>[0],
      abortSignal: AbortSignal,
    ) {
      signal = abortSignal;
      const base = basePromptOptions();
      const { messages, systemPromptOptions } = await runner.emitBeforeAgentStart(trigger, base);
      const { selectedTools } = systemPromptOptions;
      const previous = base.selectedTools ?? [];
      if (
        selectedTools.length !== previous.length ||
        selectedTools.some((name, i) => name !== previous[i])
      ) {
        setActiveTools(selectedTools);
      }
      runPromptOptions = systemPromptOptions;
      return messages;
    },
    finishActivity() {
      nestedTools.clear();
    },
    finishRun() {
      signal = undefined;
      runPromptOptions = undefined;
      nestedTools.clear();
    },
    async dispose(reason: SessionShutdownEvent["reason"] = "quit", beforeInvalidate?: () => void) {
      try {
        if (bound) await runner.emit({ type: "session_shutdown", reason });
        beforeInvalidate?.();
      } finally {
        runner.invalidate();
        hostEffects.stop();
      }
    },
  };
}
