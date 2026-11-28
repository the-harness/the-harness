import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { createExtensionHostFixture } from "../helpers/extension-host.ts";

const source = String.raw`
const v = require('vscode');
exports.activate = context => {
  const received = [], channels = new Map(), subscriptions = [];
  context.subscriptions.push(v.commands.registerCommand('channel.listen', id => {
    const channel = v.env.getDataChannel(id);
    channels.set(id, channel);
    const thisArg = {id};
    channel.onDidReceiveData(function(event) {received.push({channel:this.id,event})}, thisArg, subscriptions);
    return {same:channel===v.env.getDataChannel(id),string:String(channel),hasSend:'sendData' in channel};
  }));
  context.subscriptions.push(v.commands.registerCommand('channel.read', () => received));
  context.subscriptions.push(v.commands.registerCommand('channel.dispose', () => {for(const disposable of subscriptions.splice(0)) disposable.dispose()}));
  context.subscriptions.push(v.commands.registerCommand('channel.webPower', async () => {
    let events=0;
    for(const event of ['onDidSuspend','onDidResume','onDidChangeOnBatteryPower','onDidChangeThermalState','onDidChangeSpeedLimit','onWillShutdown','onDidLockScreen','onDidUnlockScreen']) context.subscriptions.push(v.env.power[event](()=>events++));
    const blocker=await v.env.power.startPowerSaveBlocker('prevent-app-suspension');
    const before=blocker.isStarted; blocker.dispose();
    return {idle:await v.env.power.getSystemIdleState(30),idleTime:await v.env.power.getSystemIdleTime(),thermal:await v.env.power.getCurrentThermalState(),battery:await v.env.power.isOnBatteryPower(),id:blocker.id,before,after:blocker.isStarted,events};
  }));
  context.subscriptions.push({dispose() {for(const disposable of subscriptions) disposable.dispose()}});
};
`;

it(
  "delivers real core data-channel events only to the selected worker and releases event subscriptions",
  { timeout: 30_000 },
  async () => {
    const root = mkdtempSync(join(process.cwd(), "temp/artifacts/env-data-channel-"));
    const extension = join(root, "extension");
    mkdirSync(extension);
    writeFileSync(
      join(extension, "package.json"),
      JSON.stringify({
        publisher: "fixture",
        name: "channels",
        version: "1.0.0",
        main: "extension.cjs",
        activationEvents: ["onStartup"],
      }),
    );
    writeFileSync(join(extension, "extension.cjs"), source);
    const fixture = await createExtensionHostFixture();
    const host = fixture.service;
    const failures: string[] = [];
    const off = host.onMainThreadCall((_session, method, _args, requestId) => {
      if (["commands.register", "commands.unregister", "auth.unregisterSession"].includes(method))
        host.resolveMainCall(requestId!);
      else if (method === "memento.load") host.resolveMainCall(requestId!, {});
      else {
        failures.push(method);
        host.resolveMainCall(requestId!, undefined, `Unexpected main call: ${method}`);
      }
    });
    try {
      await host.scanExtensions(root);
      await host.startSession("one", [root]);
      await host.startSession("two", [root]);
      await host.activateByEvent("one", "onStartup");
      await host.activateByEvent("two", "onStartup");
      expect(await host.executeCommand("one", "channel.webPower")).toEqual({
        idle: "unknown",
        idleTime: 0,
        thermal: "unknown",
        battery: false,
        id: -1,
        before: false,
        after: false,
        events: 0,
      });
      const first = host.dataChannels.getDataChannel<{
        eventName: string;
        data: { count: number; labels: string[] };
      }>("one", "editTelemetry");
      await first.sendData({ eventName: "before-subscription", data: { count: 0, labels: [] } });
      const expected = { same: true, string: "DataChannel(editTelemetry)", hasSend: false };
      expect(await host.executeCommand("one", "channel.listen", "editTelemetry")).toEqual(expected);
      expect(await host.executeCommand("two", "channel.listen", "editTelemetry")).toEqual(expected);
      await host.executeCommand("one", "channel.listen", "structuredLogger:test");
      const payload = { eventName: "actual-event", data: { count: 2, labels: ["a", "b"] } };
      await first.sendData(payload);
      expect(await host.executeCommand("one", "channel.read")).toEqual([
        { channel: "editTelemetry", event: { data: payload } },
      ]);
      expect(await host.executeCommand("two", "channel.read")).toEqual([]);
      await host.dataChannels
        .getDataChannel("one", "structuredLogger:test")
        .sendData({ sourceId: "test", nested: { ok: true } });
      await host.dataChannels.getDataChannel("two", "editTelemetry").sendData(null);
      expect(await host.executeCommand("one", "channel.read")).toHaveLength(2);
      expect(await host.executeCommand("two", "channel.read")).toEqual([
        { channel: "editTelemetry", event: { data: null } },
      ]);
      await host.executeCommand("one", "channel.dispose");
      await first.sendData(payload);
      expect(await host.executeCommand("one", "channel.read")).toHaveLength(2);
      await host.stopSession("one");
      await expect(first.sendData(payload)).rejects.toThrow();
      expect(failures).toEqual([]);
    } finally {
      await fixture.dispose("one", "two");
      off();
    }
  },
);
