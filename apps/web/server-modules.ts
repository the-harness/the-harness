import { isRunnableDevEnvironment, type ViteDevServer } from "vite-plus";

export function createServerModuleLoader(server: ViteDevServer) {
  const ssrEnv = server.environments.ssr;
  const runner = ssrEnv && isRunnableDevEnvironment(ssrEnv) ? ssrEnv.runner : undefined;
  return async <T>(url: string): Promise<T> => {
    if (!runner) return (await server.ssrLoadModule(url)) as T;
    // Vite invalidates the importers of an updated module on the server even when the runner
    // applied the update; importing again would evaluate them a second time beside the old ones.
    // The cached promise rejects when evaluation threw, while `exports` would be partial.
    const cached = runner.evaluatedModules.getModuleByUrl(url)?.promise;
    return (await (cached ?? runner.import(url))) as T;
  };
}
