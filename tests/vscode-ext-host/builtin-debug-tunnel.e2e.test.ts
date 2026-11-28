import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { createBuiltinLanguageHost } from "../helpers/builtin-languages.ts";
import { TerminalService, type CreateTerminalOptions } from "../../packages/terminal/src/index.ts";
import { createMainThreadAuthentication } from "../../packages/vscode-ext-host/src/main-thread/authentication.ts";
import { createMainThreadTerminal } from "../../packages/vscode-ext-host/src/main-thread/terminal.ts";
import { createMainThreadDebug } from "../../packages/vscode-ext-host/src/main-thread/debug.ts";

const builtins =
  process.env.HARNESS_VSCODE_BUILTINS_DIR ??
  "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions";
const names = [
  "debug-auto-launch",
  "debug-server-ready",
  "ms-vscode.js-debug",
  "ms-vscode.js-debug-companion",
  "ms-vscode.vscode-js-profile-table",
  "tunnel-forwarding",
];
describe.skipIf(!existsSync(join(builtins, "ms-vscode.js-debug/package.json")))(
  "official debug and tunnel builtins",
  () => {
    it.each([false, true])(
      "runs the official JavaScript adapter with a real breakpoint, continue and server-ready=%s",
      { timeout: 60_000 },
      async (serverReady) => {
        const root = mkdtempSync(join(process.cwd(), "temp/artifacts/builtin-dap-"));
        const extensions = join(root, "extensions");
        mkdirSync(extensions);
        for (const value of names)
          cpSync(join(builtins, value), join(extensions, value), { recursive: true });
        const script = join(root, "debuggee.cjs");
        writeFileSync(
          script,
          'const value = 40;\nconsole.log("DEBUG_RESULT", value + 2);\n' +
            (serverReady
              ? 'const server=require("http").createServer((req,res)=>{res.end("SERVER_READY_OK");server.close()});server.listen(0,"127.0.0.1",()=>console.log("listening on port "+server.address().port));\n'
              : ""),
        );
        const probe = join(extensions, "probe");
        mkdirSync(probe);
        writeFileSync(
          join(probe, "package.json"),
          JSON.stringify({
            publisher: "harness",
            name: "debug-probe",
            version: "1.0.0",
            main: "extension.cjs",
            activationEvents: ["onCommand:debug.run"],
          }),
        );
        writeFileSync(
          join(probe, "extension.cjs"),
          `const v=require('vscode');exports.activate=context=>context.subscriptions.push(v.commands.registerCommand('debug.run',async (program,serverReady)=>{
      await v.extensions.getExtension('ms-vscode.js-debug').activate();
      const messages=[],stops=[],output=[]; const record=m=>{messages.push(m);require('fs').appendFileSync(program+'.dap.jsonl',JSON.stringify(m)+'\\n')}; const completed=Promise.withResolvers();
      const timeout=setTimeout(()=>completed.reject(new Error('Debuggee did not terminate')),30000);
      const terminated=v.debug.onDidTerminateDebugSession(session=>{if(!session.parentSession)completed.resolve()});
      const tracker=v.debug.registerDebugAdapterTrackerFactory('*',{createDebugAdapterTracker:session=>({
        onWillReceiveMessage:m=>record({session:session.id,direction:'request',...m}),
        onDidSendMessage:m=>{record({session:session.id,direction:'response',...m});
          if(m.event==='output')output.push(m.body.output);
          if(m.event==='stopped')void (async()=>{const stack=await session.customRequest('stackTrace',{threadId:m.body.threadId});stops.push({reason:m.body.reason,frames:stack.stackFrames});await session.customRequest('continue',{threadId:m.body.threadId});})().catch(completed.reject);
          if(m.event==='exited'&&m.body.exitCode===0)completed.resolve();
        },onError:completed.reject})});
      const breakpoint=new v.SourceBreakpoint(new v.Location(v.Uri.file(program),new v.Position(1,0)));
      v.debug.addBreakpoints([breakpoint]);
      try {const started=await v.debug.startDebugging(v.workspace.workspaceFolders[0],{type:'pwa-node',request:'launch',name:'Real builtin debugger',program,runtimeExecutable:process.execPath,console:'internalConsole',skipFiles:[],stopOnEntry:false,...(serverReady?{serverReadyAction:{pattern:'listening on port ([0-9]+)',uriFormat:'http://127.0.0.1:%s',action:'openExternally'}}:{})});await completed.promise;return {started,messages,stops,output};}
      finally{clearTimeout(timeout);terminated.dispose();tracker.dispose();v.debug.removeBreakpoints([breakpoint]);await v.debug.stopDebugging();}
    }));`,
        );
        const opened: { url: string; body: string }[] = [];
        const registered = new Map<string, unknown>();
        const debug = createMainThreadDebug(
          {
            create() {
              throw new Error("Internal console debug must not launch a terminal");
            },
          } as never,
          {
            useCommand(name: string, callback: unknown) {
              registered.set(name, callback);
            },
          } as never,
          (session, command, args) => runtime.host.executeCommand(session, command, ...args),
        );
        const handleTerminal = createMainThreadTerminal(
          {
            create() {
              throw new Error("Unexpected terminal launch");
            },
          } as never,
          {
            useCommand(name: string, callback: unknown) {
              registered.set(name, callback);
            },
          } as never,
          (session, command, args) => runtime.host.executeCommand(session, command, ...args),
        );
        const runtime = await createBuiltinLanguageHost(root, async (session, method, args) => {
          if (method === "env.openExternal") {
            const url = String(args[0]);
            if (!url.startsWith("http://127.0.0.1:"))
              throw new Error(`Unexpected external URL: ${url}`);
            opened.push({ url, body: await (await fetch(url)).text() });
            return { handled: true, result: true };
          }
          if (await handleTerminal(session, method, args)) return { handled: true };
          const result = (await debug(session, method, args)) as {
            handled: boolean;
            value?: unknown;
          };
          return { handled: result.handled, result: result.value };
        });
        try {
          await runtime.host.scanExtensions(extensions);
          await runtime.host.startSession("debug", [root], {
            storageRoot: join(root, "storage"),
            configuration: {
              defaults: {},
              user: { "debug.javascript.autoAttachFilter": "disabled" },
              workspace: {},
            },
            environment: { language: "en" },
          });
          const result = (await runtime.host.executeCommand(
            "debug",
            "debug.run",
            script,
            serverReady,
          )) as {
            started: boolean;
            messages: unknown[];
            stops: { reason: string; frames: { line: number }[] }[];
            output: string[];
          };
          writeFileSync(join(root, "dap.json"), JSON.stringify(result, null, 2));
          expect(result.started).toBe(true);
          expect(result.messages).toContainEqual(
            expect.objectContaining({ command: "disconnect", type: "request" }),
          );
          expect(result.messages).toContainEqual(
            expect.objectContaining({
              event: "thread",
              body: expect.objectContaining({ reason: "exited" }),
            }),
          );
          expect(result.output.join("")).toContain("DEBUG_RESULT 42");
          expect(result.stops).toContainEqual(
            expect.objectContaining({
              reason: "breakpoint",
              frames: expect.arrayContaining([expect.objectContaining({ line: 2 })]),
            }),
          );
          if (serverReady)
            expect(opened).toEqual([
              {
                url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/?$/),
                body: "SERVER_READY_OK",
              },
            ]);
          else expect(opened).toEqual([]);
          expect(runtime.errors).toEqual([]);
        } finally {
          await runtime.dispose("debug");
          handleTerminal.dispose();
          debug.dispose();
        }
      },
    );
    it(
      "calls the official tunnel provider and reports the real missing GitHub authentication boundary",
      { timeout: 60_000 },
      async () => {
        const root = mkdtempSync(join(process.cwd(), "temp/artifacts/builtin-tunnel-"));
        const extensions = join(root, "extensions");
        mkdirSync(extensions);
        cpSync(join(builtins, "tunnel-forwarding"), join(extensions, "tunnel-forwarding"), {
          recursive: true,
        });
        const probe = join(extensions, "probe");
        mkdirSync(probe);
        writeFileSync(
          join(probe, "package.json"),
          JSON.stringify({
            publisher: "harness",
            name: "tunnel-probe",
            version: "1.0.0",
            main: "extension.cjs",
            activationEvents: ["onCommand:tunnel.run"],
          }),
        );
        writeFileSync(
          join(probe, "extension.cjs"),
          `const v=require('vscode');exports.activate=context=>context.subscriptions.push(v.commands.registerCommand('tunnel.run',async()=>{await v.extensions.getExtension('vscode.tunnel-forwarding').activate();try{await v.workspace.openTunnel({remoteAddress:{host:'127.0.0.1',port:3000}});throw new Error('Unexpected authenticated tunnel')}catch(error){return {error:error.message,tunnels:await v.workspace.tunnels}}}));`,
        );
        const calls: unknown[] = [];
        const auth = createMainThreadAuthentication({
          showQuickPick() {
            throw new Error("Tunnel boundary must not prompt");
          },
        } as never);
        const runtime = await createBuiltinLanguageHost(root, async (session, method, args) => {
          if (method.startsWith("auth.")) {
            calls.push({ method, args });
            try {
              return { handled: true, result: await auth(method, args, session) };
            } catch (error) {
              throw error;
            }
          }
          return { handled: false };
        });
        try {
          await runtime.host.scanExtensions(extensions);
          await runtime.host.startSession("tunnel", [root], { storageRoot: join(root, "storage") });
          const result = await runtime.host.executeCommand("tunnel", "tunnel.run");
          writeFileSync(join(root, "boundary.json"), JSON.stringify({ result, calls }, null, 2));
          expect(result).toEqual({
            error: "No authentication provider 'github' is currently registered.",
            tunnels: [],
          });
          expect(calls).toContainEqual({
            method: "auth.getSession",
            args: ["github", ["user:email", "read:org"], { createIfNone: true }],
          });
          expect(runtime.errors).toEqual([
            "No authentication provider 'github' is currently registered.",
          ]);
        } finally {
          await runtime.dispose("tunnel");
        }
      },
    );
    it(
      "auto-attaches the official debugger to a real terminal Node process",
      { timeout: 60_000 },
      async () => {
        const root = mkdtempSync(join(process.cwd(), "temp/artifacts/builtin-auto-attach-"));
        const extensions = join(root, "extensions");
        mkdirSync(extensions);
        for (const value of ["debug-auto-launch", "ms-vscode.js-debug"])
          cpSync(join(builtins, value), join(extensions, value), { recursive: true });
        writeFileSync(
          join(root, "package.json"),
          JSON.stringify({ name: "auto-attach-fixture", private: true, type: "commonjs" }),
        );
        const script = join(root, "auto.cjs");
        writeFileSync(script, 'console.log("AUTO_ATTACH_RESULT", 42);');
        const probe = join(extensions, "probe");
        mkdirSync(probe);
        writeFileSync(
          join(probe, "package.json"),
          JSON.stringify({
            publisher: "harness",
            name: "auto-probe",
            version: "1.0.0",
            main: "extension.cjs",
            activationEvents: ["onCommand:auto.activate", "onCommand:auto.run"],
          }),
        );
        writeFileSync(
          join(probe, "extension.cjs"),
          `const v=require('vscode');exports.activate=context=>context.subscriptions.push(
      v.commands.registerCommand('auto.activate',async()=>{await v.extensions.getExtension('ms-vscode.js-debug').activate();await v.extensions.getExtension('vscode.debug-auto-launch').activate()}),
      v.commands.registerCommand('auto.run',async program=>{const sessions=[],messages=[],output=[];const done=Promise.withResolvers();let terminal;
        const timeout=setTimeout(()=>done.reject(new Error('Auto attach terminal did not exit')),30000);
        const tracker=v.debug.registerDebugAdapterTrackerFactory('*',{createDebugAdapterTracker:session=>({onWillReceiveMessage:m=>messages.push({session:session.id,...m})})});
        const start=v.debug.onDidStartDebugSession(session=>sessions.push({type:session.type,name:session.name}));
        const data=v.window.onDidWriteTerminalData(event=>{if(event.terminal===terminal)output.push(event.data)});
        const close=v.window.onDidCloseTerminal(value=>{if(value===terminal)done.resolve(value.exitStatus)});
        try{terminal=v.window.createTerminal({name:'Real auto attach',cwd:require('path').dirname(program),shellPath:process.execPath,shellArgs:[program]});const pid=await terminal.processId;const exit=await done.promise;return {sessions,messages,output,pid,exit}}
        finally{clearTimeout(timeout);tracker.dispose();start.dispose();data.dispose();close.dispose();terminal?.dispose()}
      })
    );`,
        );
        const backend = new TerminalService();
        const terminal = {
          create: (options: CreateTerminalOptions) => backend.create(options),
          kill: (id: string) => backend.kill(id),
          write: (id: string, text: string) => backend.write(id, text),
          observe(
            id: string,
            listener: { onData(data: string): void; onExit(code: number): void },
          ) {
            const attachment = backend.attach(id, listener);
            if (!attachment) throw new Error(`Unknown terminal: ${id}`);
            if (attachment.snapshot.data) listener.onData(attachment.snapshot.data);
            if (attachment.snapshot.info.exited)
              queueMicrotask(() => listener.onExit(attachment.snapshot.info.exitCode ?? 0));
            return { dispose: () => attachment.detach() };
          },
        };
        const commands = new Map<string, unknown>();
        const commandApi = {
          useCommand(name: string, callback: unknown) {
            commands.set(name, callback);
          },
        };
        const debug = createMainThreadDebug(
          terminal as never,
          commandApi as never,
          (session, command, args) => runtime.host.executeCommand(session, command, ...args),
        );
        const handleTerminal = createMainThreadTerminal(
          terminal as never,
          commandApi as never,
          (session, command, args) => runtime.host.executeCommand(session, command, ...args),
        );
        const ready = Promise.withResolvers<void>();
        const runtime = await createBuiltinLanguageHost(root, async (session, method, args) => {
          if (
            method === "statusBar.update" &&
            (args[1] as { text?: string })?.text === "Auto Attach: Always"
          )
            ready.resolve();
          if (await handleTerminal(session, method, args)) return { handled: true };
          const result = await debug(session, method, args);
          return { handled: result.handled, result: result.value };
        });
        try {
          await runtime.host.scanExtensions(extensions);
          await runtime.host.startSession("auto", [root], {
            storageRoot: join(root, "storage"),
            configuration: {
              defaults: {},
              user: { "debug.javascript.autoAttachFilter": "always" },
              workspace: {},
            },
          });
          await runtime.host.executeCommand("auto", "auto.activate");
          await ready.promise;
          const result = (await runtime.host.executeCommand("auto", "auto.run", script)) as {
            sessions: unknown[];
            messages: unknown[];
            output: string[];
            pid: number;
            exit: { code: number };
          };
          writeFileSync(join(root, "auto-attach.json"), JSON.stringify(result, null, 2));
          expect(result.sessions.length).toBeGreaterThan(0);
          expect(result.messages).toContainEqual(expect.objectContaining({ command: "attach" }));
          expect(result.output.join("")).toContain("AUTO_ATTACH_RESULT 42");
          expect(result.pid).toBeGreaterThan(0);
          expect(result.exit.code).toBe(0);
          expect(runtime.errors).toEqual([]);
        } finally {
          await runtime.dispose("auto");
          handleTerminal.dispose();
          debug.dispose();
          backend.dispose();
        }
      },
    );
    it.each(names)(
      "probes the official %s extension activation",
      { timeout: 60_000 },
      async (name) => {
        const root = mkdtempSync(join(process.cwd(), "temp/artifacts/builtin-debug-"));
        const extensions = join(root, "extensions");
        mkdirSync(extensions);
        for (const value of names)
          cpSync(join(builtins, value), join(extensions, value), { recursive: true });
        const probe = join(extensions, "probe");
        mkdirSync(probe);
        writeFileSync(
          join(probe, "package.json"),
          JSON.stringify({
            publisher: "harness",
            name: "debug-probe",
            version: "1.0.0",
            main: "extension.cjs",
            activationEvents: ["onCommand:debug.probe"],
          }),
        );
        writeFileSync(
          join(probe, "extension.cjs"),
          `const v=require('vscode');exports.activate=context=>context.subscriptions.push(v.commands.registerCommand('debug.probe',async id=>{const extension=v.extensions.getExtension(id);await extension.activate();return {active:extension.isActive,commands:await v.commands.getCommands(true)};}));`,
        );
        const registered = new Map<string, unknown>();
        const debug = createMainThreadDebug(
          {
            create() {
              throw new Error("Debug activation must not launch a terminal");
            },
          } as never,
          {
            useCommand(name: string, callback: unknown) {
              registered.set(name, callback);
            },
          } as never,
          (session, command, args) => runtime.host.executeCommand(session, command, ...args),
        );
        const handleTerminal = createMainThreadTerminal(
          {
            create() {
              throw new Error("Unexpected terminal launch");
            },
          } as never,
          {
            useCommand(name: string, callback: unknown) {
              registered.set(name, callback);
            },
          } as never,
          (session, command, args) => runtime.host.executeCommand(session, command, ...args),
        );
        const runtime = await createBuiltinLanguageHost(root, async (session, method, args) => {
          if (await handleTerminal(session, method, args)) return { handled: true };
          const result = (await debug(session, method, args)) as {
            handled: boolean;
            value?: unknown;
          };
          return { handled: result.handled, result: result.value };
        });
        try {
          await runtime.host.scanExtensions(extensions);
          await runtime.host.startSession("debug", [root], {
            storageRoot: join(root, "storage"),
            configuration: {
              defaults: {},
              user: { "debug.javascript.autoAttachFilter": "disabled" },
              workspace: {},
            },
            environment: { language: "en" },
          });
          const id = name.startsWith("ms-vscode.") ? name : `vscode.${name}`;
          const result = await runtime.host.executeCommand("debug", "debug.probe", id);
          writeFileSync(join(root, "activation.json"), JSON.stringify(result, null, 2));
          expect(result).toMatchObject({ active: true });
          expect(runtime.errors).toEqual([]);
        } finally {
          await runtime.dispose("debug");
          handleTerminal.dispose();
          debug.dispose();
        }
      },
    );
  },
);
