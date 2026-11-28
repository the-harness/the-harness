import { expect, it, vi } from "vite-plus/test";
import { createHarnessModules } from "../helpers/harness-modules.ts";

it("rejects pre-aborted OAuth2 callers with or without a cached token", async () => {
  const modules = await createHarnessModules();
  try {
    const [di, authModule, oauth] = await Promise.all([
      modules.load<typeof import("../../packages/di/src/index.ts")>("/packages/di/src/index.ts"),
      modules.load<typeof import("../../packages/auth/src/index.ts")>(
        "/packages/auth/src/index.ts",
      ),
      modules.load<typeof import("../../packages/oauth2/src/index.ts")>(
        "/packages/oauth2/src/index.ts",
      ),
    ]);
    const root = di.createRootScope();
    const refresh = vi.fn(async () => {
      throw new Error("Unexpected token refresh");
    });
    try {
      root.provide(
        di.createDescriptor(oauth.OAuth2AuthService, {
          clientId: "harness-test",
          tokenUrl: "http://127.0.0.1/token",
          fetch: refresh,
        }),
      );
      const auth = root.get(authModule.AuthService) as InstanceType<typeof oauth.OAuth2AuthService>;
      const reason = new Error("Caller canceled before authorization");
      const signal = AbortSignal.abort(reason);
      await expect(auth.authorize({ signal })).rejects.toBe(reason);
      expect((await auth.authorize()).headers).toEqual({});

      auth.setToken({
        accessToken: "cached-access",
        refreshToken: "cached-refresh",
        expiresAt: Number.MAX_SAFE_INTEGER,
      });
      await expect(auth.authorize({ signal })).rejects.toBe(reason);
      expect((await auth.authorize()).headers).toEqual({ Authorization: "Bearer cached-access" });
      expect(refresh).not.toHaveBeenCalled();
    } finally {
      root.dispose();
    }
  } finally {
    await modules.close();
  }
});
