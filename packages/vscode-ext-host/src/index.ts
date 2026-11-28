export { installVsix } from "./vsix.ts";
export { readExtensionManifest, scanExtensionsDir, type ExtensionManifest } from "./manifest.ts";
export { serveWebviewResource } from "./webview-resources.ts";
export { ExtHostRpcContract, ExtHostStateSyncContract, ExtHostStreamContract } from "./rpc.ts";
export {
  ExtensionHostService,
  type ExtensionHostHooks,
  type MainThreadCallHandler,
  type MainThreadCallRouter,
} from "./service.ts";
export { useExtHostHandlers } from "./handlers.ts";
