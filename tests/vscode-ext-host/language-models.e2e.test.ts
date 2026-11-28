import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import { expect, it, vi } from "vite-plus/test";
import { createHarnessModules } from "../helpers/harness-modules.ts";

const extension = String.raw`
const v = require('vscode');
exports.activate = context => {
  let registration, original, canceled = 0, tokensWaiting = 0;
  const changes = new v.EventEmitter();
  context.subscriptions.push(changes);
  context.subscriptions.push(v.commands.registerCommand('model.native', async (mode = 'normal') => {
    const [model] = await v.lm.selectChatModels({vendor:'http-fixture',id:'fixture-model'});
    if (!model) throw new Error('Real configured model missing');
    const token = new v.CancellationTokenSource();
    const messages = [new v.LanguageModelChatMessage(v.LanguageModelChatMessageRole.System, 'system instruction'), v.LanguageModelChatMessage.User([new v.LanguageModelTextPart(mode),new v.LanguageModelDataPart(Uint8Array.from([0,255,42]),'image/png')])];
    const response = await model.sendRequest(messages,{tools:[{name:'lookup',description:'look up a value',inputSchema:{type:'object'}}],modelOptions:{temperature:0.2,maxTokens:80,reasoning:false}},token.token);
    const parts=[];
    try { for await (const part of response.stream) {parts.push(part instanceof v.LanguageModelTextPart ? {type:'text',value:part.value}:part instanceof v.LanguageModelToolCallPart ? {type:'tool',name:part.name,input:part.input}: {type:'unknown'}); if(mode==='cancel')token.cancel();} }
    catch(error) {if(mode!=='cancel')throw error;return {parts,error:error.name};}
    finally {token.dispose()}
    const replay=[];for await(const text of response.text)replay.push(text);
    return {model:{id:model.id,vendor:model.vendor,maxInputTokens:model.maxInputTokens},parts,replay};
  }));
  context.subscriptions.push(v.commands.registerCommand('model.register', async endpoint => {
    original={id:'extension-model',name:'Extension model',family:'word-stream',version:'1',maxInputTokens:2048,maxOutputTokens:128,capabilities:{toolCalling:true},secret:'must remain in worker'};
    registration=v.lm.registerLanguageModelChatProvider('extension-fixture',{
      onDidChangeLanguageModelChatInformation:changes.event,
      provideLanguageModelChatInformation(options){if(!options.silent)throw new Error('Unexpected interactive model enumeration');return [original]},
      async provideTokenCount(model,text,token){if(model!==original)throw new Error('Model identity lost');if(text==='hold'){tokensWaiting++;await new Promise(resolve=>token.onCancellationRequested(resolve));tokensWaiting--;return 99;}return (typeof text==='string'?text:text.content.map(p=>p.value||'').join(' ')).trim().split(/\s+/).filter(Boolean).length},
      async provideLanguageModelChatResponse(model,messages,options,progress,token){
        if(model!==original)throw new Error('Model identity lost');
        if(!messages.every(m=>m instanceof v.LanguageModelChatMessage))throw new Error('Message revival lost');
        const controller=new AbortController();const stop=token.onCancellationRequested(()=>{canceled++;controller.abort()});
        try{const response=await fetch(endpoint,{method:'POST',body:JSON.stringify({messages:messages.map(m=>({role:m.role,text:m.content.filter(p=>p instanceof v.LanguageModelTextPart).map(p=>p.value).join('')})),options}),signal:controller.signal});
          const reader=response.body.pipeThrough(new TextDecoderStream()).getReader();let pending='';
          while(true){const part=await reader.read();if(part.done)break;pending+=part.value;let end;while((end=pending.indexOf('\n'))>=0){const value=JSON.parse(pending.slice(0,end));pending=pending.slice(end+1);if(value.text)progress.report(new v.LanguageModelTextPart(value.text));if(value.tool)progress.report(new v.LanguageModelToolCallPart('extension-call','lookup',value.tool));}}
        }finally{stop.dispose()}
      }
    });context.subscriptions.push(registration);
    const [model]=await v.lm.selectChatModels({vendor:'extension-fixture'});
    return {model,tokenCount:await model.countTokens('one two three')};
  }));
  context.subscriptions.push(v.commands.registerCommand('model.lazy', async()=>{const extension=v.extensions.getExtension('harness.lazy-model');const before=extension.isActive;const [model]=await v.lm.selectChatModels({vendor:'lazy-fixture'});const response=await model.sendRequest([v.LanguageModelChatMessage.User('lazy activation')]);let text='';for await(const value of response.text)text+=value;return {before,after:extension.isActive,id:model.id,text}}));
  context.subscriptions.push(v.commands.registerCommand('model.holdTokens',async()=>{const [model]=await v.lm.selectChatModels({vendor:'extension-fixture'});return model.countTokens('hold')}));
  context.subscriptions.push(v.commands.registerCommand('model.tokensWaiting',()=>tokensWaiting));
  context.subscriptions.push(v.commands.registerCommand('model.crash',()=>process.exit(9)));
  context.subscriptions.push(v.commands.registerCommand('model.change',()=>{original={...original,name:'Changed model'};changes.fire()}));
  context.subscriptions.push(v.commands.registerCommand('model.unregister',()=>registration.dispose()));
  context.subscriptions.push(v.commands.registerCommand('model.canceled',()=>canceled));
};
`;

async function setup() {
  const root = mkdtempSync(join(process.cwd(), "temp/artifacts/language-model-"));
  const installed = join(root, "extensions/probe");
  mkdirSync(installed, { recursive: true });
  writeFileSync(
    join(installed, "package.json"),
    JSON.stringify({
      publisher: "harness",
      name: "model-probe",
      version: "1.0.0",
      main: "extension.cjs",
      activationEvents: ["onStartup"],
    }),
  );
  writeFileSync(join(installed, "extension.cjs"), extension);
  const modules = await createHarnessModules();
  const [di, llm, managerModule, deepseek, mcp, sqlite, hostModule, bridgeModule] =
    await Promise.all([
      modules.load<typeof import("../../packages/di/src/index.ts")>("/packages/di/src/index.ts"),
      modules.load<typeof import("../../packages/llm/src/index.ts")>("/packages/llm/src/index.ts"),
      modules.load<typeof import("../../packages/model-provider/src/index.ts")>(
        "/packages/model-provider/src/index.ts",
      ),
      modules.load<typeof import("../../packages/deepseek/src/llm.ts")>(
        "/packages/deepseek/src/llm.ts",
      ),
      modules.load<typeof import("../../packages/mcp/src/index.ts")>("/packages/mcp/src/index.ts"),
      modules.load<typeof import("../../packages/sqlite/src/index.ts")>(
        "/packages/sqlite/src/index.ts",
      ),
      modules.load<typeof import("../../packages/vscode-ext-host/src/index.ts")>(
        "/packages/vscode-ext-host/src/index.ts",
      ),
      modules.load<
        typeof import("../../packages/vscode-ext-host/src/main-thread/language-models.ts")
      >("/packages/vscode-ext-host/src/main-thread/language-models.ts"),
    ]);
  const scope = di.createRootScope();
  scope.provideAll([
    llm.LlmService,
    managerModule.ProviderManager,
    mcp.McpService,
    di.createDescriptor(sqlite.SqliteService, { path: ":memory:" }),
    hostModule.ExtensionHostService,
  ]);
  const service = scope.get(llm.LlmService),
    manager = scope.get(managerModule.ProviderManager),
    host = scope.get(hostModule.ExtensionHostService);
  const bridge = bridgeModule.createMainThreadLanguageModels(service, manager, host);
  const offRouter = host.registerMainThreadRouter((session, method, args) =>
    bridge.handle(session, method, args),
  );
  const cleanupErrors: string[] = [];
  const lifecycle = scope.createChild();
  lifecycle.run(() =>
    host.hooks.sessionStopped.use((session, next) => {
      void bridge.clearSession(session, true).catch((error) => cleanupErrors.push(String(error)));
      return next();
    }),
  );
  const errors: string[] = [],
    calls: unknown[] = [];
  const off = host.onMainThreadCall(async (session, method, args, requestId) => {
    try {
      if (["commands.register", "commands.unregister", "auth.unregisterSession"].includes(method))
        host.resolveMainCall(requestId!);
      else if (method === "memento.load") host.resolveMainCall(requestId!, {});
      else throw new Error(`Unexpected main call: ${method}`);
    } catch (error) {
      errors.push(String(error));
      host.resolveMainCall(requestId!, undefined, String(error));
    }
  });
  let canceled = 0;
  const active = new Set<ServerResponse>();
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push({ url: request.url, body });
    active.add(response);
    response.on("close", () => {
      active.delete(response);
    });
    const slow = JSON.stringify(body).includes('"cancel"');
    if (request.url === "/extension") {
      response.setHeader("content-type", "application/x-ndjson");
      response.write(JSON.stringify({ text: "extension " }) + "\n");
      if (slow) {
        response.on("close", () => {
          canceled++;
        });
        return;
      }
      response.end(
        JSON.stringify({
          text: body.messages.map((message: { text: string }) => message.text).join(" "),
        }) +
          "\n" +
          JSON.stringify({ tool: { actual: true } }) +
          "\n",
      );
      return;
    }
    response.setHeader("content-type", "text/event-stream");
    const emit = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
    emit({ type: "message_start", message: { usage: { input_tokens: 3 } } });
    emit({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    emit({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "native " } });
    if (slow) {
      response.on("close", () => {
        canceled++;
      });
      return;
    }
    emit({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: body.messages[0].content[0].text },
    });
    emit({ type: "content_block_stop", index: 0 });
    emit({
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "native-call", name: "lookup" },
    });
    emit({
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"actual":true}' },
    });
    emit({ type: "content_block_stop", index: 1 });
    emit({
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 4 },
    });
    emit({ type: "message_stop" });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const providerScope = manager.create({ id: "http-fixture" });
  providerScope.provide(
    llm.LlmProvider,
    di.createDescriptor(deepseek.DeepSeekLlmProvider, {
      baseUrl: url,
      preferFilesApi: false,
      models: [
        {
          id: "fixture-model",
          name: "HTTP fixture",
          contextWindow: 4096,
          maxTokens: 256,
          inputModalities: [llm.TextModality.create({}), llm.ImageModality.create({})],
        },
      ],
    }),
  );
  const lazy = join(root, "extensions/lazy");
  mkdirSync(lazy);
  writeFileSync(
    join(lazy, "package.json"),
    JSON.stringify({
      publisher: "harness",
      name: "lazy-model",
      version: "1.0.0",
      main: "extension.cjs",
      contributes: {
        languageModelChatProviders: [{ vendor: "lazy-fixture", displayName: "Lazy HTTP model" }],
      },
    }),
  );
  writeFileSync(
    join(lazy, "extension.cjs"),
    `const v=require('vscode');exports.activate=context=>context.subscriptions.push(v.lm.registerLanguageModelChatProvider('lazy-fixture',{
    provideLanguageModelChatInformation:()=>[{id:'lazy-model',name:'Lazy model',family:'lazy',version:'1',maxInputTokens:2048,maxOutputTokens:128,capabilities:{}}],
    provideTokenCount:async(_model,text)=>String(text).split(/\\s+/).length,
    async provideLanguageModelChatResponse(_model,messages,_options,progress,token){const controller=new AbortController();const subscription=token.onCancellationRequested(()=>controller.abort());try{const response=await fetch(${JSON.stringify(url + "/extension")},{method:'POST',body:JSON.stringify({messages:messages.map(m=>({text:m.content.map(p=>p.value).join('')}))}),signal:controller.signal});for(const line of (await response.text()).trim().split('\\n')){const part=JSON.parse(line);if(part.text)progress.report(new v.LanguageModelTextPart(part.text));}}finally{subscription.dispose()}}
  }));`,
  );
  await host.scanExtensions(join(root, "extensions"));
  await host.startSession("models", [root], { storageRoot: join(root, "storage") });
  await host.activateByEvent("models", "onStartup");
  return {
    root,
    host,
    service,
    manager,
    llm,
    url,
    calls,
    errors,
    cleanupErrors,
    get canceled() {
      return canceled;
    },
    async dispose() {
      await host.stopSession("caller");
      await host.stopSession("models");
      await bridge.clearSession("models", true);
      await bridge.dispose();
      off();
      offRouter();
      lifecycle.dispose();
      await scope.get(mcp.McpService).dispose();
      scope.dispose();
      for (const response of active) response.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await modules.close();
    },
  };
}

it(
  "streams actual HTTP provider text and tools through vscode.lm and cancels the HTTP request",
  { timeout: 30_000 },
  async () => {
    const runtime = await setup();
    try {
      const result = (await runtime.host.executeCommand("models", "model.native")) as {
        parts: unknown[];
        replay: string[];
      };
      expect(result.parts).toEqual([
        { type: "text", value: "native " },
        { type: "text", value: "normal" },
        { type: "tool", name: "lookup", input: { actual: true } },
      ]);
      expect(result.replay).toEqual(["native ", "normal"]);
      expect(runtime.calls[0]).toMatchObject({
        body: {
          system: "system instruction",
          temperature: 0.2,
          max_tokens: 80,
          tools: [{ name: "lookup" }],
          messages: [
            {
              content: [{ text: "normal" }, { source: { data: "AP8q", media_type: "image/png" } }],
            },
          ],
        },
      });
      const canceled = await runtime.host.executeCommand("models", "model.native", "cancel");
      expect(canceled).toMatchObject({
        error: "Canceled",
        parts: [{ type: "text", value: "native " }],
      });
      await vi.waitFor(() => expect(runtime.canceled).toBe(1));
      expect(runtime.errors).toEqual([]);
    } finally {
      await runtime.dispose();
    }
  },
);

it(
  "exposes an extension model through core LlmService with identity, tokenizer, changes, streams and cancellation",
  { timeout: 30_000 },
  async () => {
    const runtime = await setup();
    try {
      const result = (await runtime.host.executeCommand(
        "models",
        "model.register",
        runtime.url + "/extension",
      )) as { model: { id: string }; tokenCount: number };
      expect(result).toMatchObject({
        model: { id: "extension-model", vendor: "extension-fixture" },
        tokenCount: 3,
      });
      expect(result.model).not.toHaveProperty("secret");
      const model = runtime.service.models.find((model) => model.id === "extension-model")!;
      expect(model).toBeDefined();
      const stream = runtime.service.stream({
        provider: model.provider,
        model: model.id,
        messages: [
          runtime.llm.SystemMessage.create({
            content: [runtime.llm.TextBlock.create({ text: "core instructions" })],
          }),
          runtime.llm.UserMessage.create({
            content: [runtime.llm.TextBlock.create({ text: "core input" })],
          }),
        ],
      });
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      expect(chunks).toContainEqual({ type: "text_delta", delta: "core instructions core input" });
      expect(runtime.calls[0]!.body.messages).toEqual([
        { role: 3, text: "core instructions" },
        { role: 1, text: "core input" },
      ]);
      expect(chunks).toContainEqual({
        type: "tool_call_end",
        id: "extension-call",
        name: "lookup",
        arguments: '{"actual":true}',
      });
      expect((await stream.result()).stopReason).toBe("tool_calls");
      const controller = new AbortController();
      const slow = runtime.service.stream({
        provider: model.provider,
        model: model.id,
        signal: controller.signal,
        messages: [
          runtime.llm.UserMessage.create({
            content: [runtime.llm.TextBlock.create({ text: "cancel" })],
          }),
        ],
      });
      const iterator = slow[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toEqual({ type: "text_delta", delta: "extension " });
      controller.abort();
      await expect(iterator.next()).rejects.toThrow();
      await vi.waitFor(() => expect(runtime.canceled).toBe(1));
      expect(await runtime.host.executeCommand("models", "model.canceled")).toBe(1);
      await runtime.host.executeCommand("models", "model.change");
      await vi.waitFor(() =>
        expect(runtime.service.models.find((model) => model.id === "extension-model")?.name).toBe(
          "Changed model",
        ),
      );
      await runtime.host.executeCommand("models", "model.unregister");
      await vi.waitFor(() =>
        expect(runtime.service.models.some((model) => model.id === "extension-model")).toBe(false),
      );
      expect(runtime.errors).toEqual([]);
    } finally {
      await runtime.dispose();
    }
  },
);

it(
  "activates a contributed language model provider on demand before enumerating and sending",
  { timeout: 30_000 },
  async () => {
    const runtime = await setup();
    try {
      expect(await runtime.host.executeCommand("models", "model.lazy")).toEqual({
        before: false,
        after: true,
        id: "lazy-model",
        text: "extension lazy activation",
      });
      expect(runtime.errors).toEqual([]);
    } finally {
      await runtime.dispose();
    }
  },
);

it(
  "retiring a provider worker clears both local and cross-worker token requests without retaining its models",
  { timeout: 30_000 },
  async () => {
    const runtime = await setup();
    try {
      await runtime.host.executeCommand("models", "model.register", runtime.url + "/extension");
      await runtime.host.startSession("caller", [runtime.root], {
        storageRoot: join(runtime.root, "caller-storage"),
      });
      await runtime.host.activateByEvent("caller", "onStartup");
      const own = runtime.host.executeCommand("models", "model.holdTokens").then(
        (value) => ({ value }),
        (error) => ({ error: String(error) }),
      );
      const remote = runtime.host.executeCommand("caller", "model.holdTokens").then(
        (value) => ({ value }),
        (error) => ({ error: String(error) }),
      );
      await vi.waitFor(async () =>
        expect(await runtime.host.executeCommand("models", "model.tokensWaiting")).toBe(2),
      );
      await expect(runtime.host.executeCommand("models", "model.crash")).rejects.toThrow(
        "Extension host stopped",
      );
      expect(await own).toHaveProperty("error");
      expect(await remote).toHaveProperty("error");
      await vi.waitFor(() =>
        expect(runtime.service.models.some((model) => model.id === "extension-model")).toBe(false),
      );
      expect(runtime.cleanupErrors).toEqual([]);
      expect(runtime.errors).toEqual([]);
    } finally {
      await runtime.dispose();
    }
  },
);

it(
  "unregistering a live extension model cancels its actual pending stream and removes the provider",
  { timeout: 30_000 },
  async () => {
    const runtime = await setup();
    try {
      await runtime.host.executeCommand("models", "model.register", runtime.url + "/extension");
      const model = runtime.service.models.find((item) => item.id === "extension-model")!;
      const response = runtime.service.stream({
        provider: model.provider,
        model: model.id,
        messages: [
          runtime.llm.UserMessage.create({
            content: [runtime.llm.TextBlock.create({ text: "cancel" })],
          }),
        ],
      });
      const iterator = response[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toEqual({ type: "text_delta", delta: "extension " });
      const pending = iterator.next().then(
        (value) => ({ value }),
        (error) => ({ error: String(error) }),
      );
      await runtime.host.executeCommand("models", "model.unregister");
      expect(await pending).toHaveProperty("error");
      await expect(response.result()).rejects.toThrow();
      await vi.waitFor(() =>
        expect(runtime.service.models.some((item) => item.id === "extension-model")).toBe(false),
      );
      await vi.waitFor(() => expect(runtime.canceled).toBe(1));
      expect(runtime.cleanupErrors).toEqual([]);
      expect(runtime.errors).toEqual([]);
    } finally {
      await runtime.dispose();
    }
  },
);
