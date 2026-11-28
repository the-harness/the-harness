import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vite-plus/test";
import { createHarnessModules } from "../helpers/harness-modules.ts";

it("retires OAuth2 authorization when DI replaces its owner during a refresh", async () => {
  let requested = false;
  let disconnected = false;
  const server = createServer((request, response) => {
    request.resume();
    response.on("close", () => {
      disconnected = !response.writableEnded;
    });
    requested = true;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const modules = await createHarnessModules();
    try {
      const [di, oauth, auth] = await Promise.all([
        modules.load<typeof import("../../packages/di/src/index.ts")>("/packages/di/src/index.ts"),
        modules.load<typeof import("../../packages/oauth2/src/index.ts")>(
          "/packages/oauth2/src/index.ts",
        ),
        modules.load<typeof import("../../packages/auth/src/index.ts")>(
          "/packages/auth/src/index.ts",
        ),
      ]);
      const root = di.createRootScope();
      try {
        const options = {
          clientId: "harness-test",
          tokenUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`,
        };
        root.provide(
          di.createDescriptor(oauth.OAuth2AuthService, {
            ...options,
            accessToken: "original-access",
            refreshToken: "original-refresh",
            expiresAt: 0,
          }),
        );
        const retired = root.get(auth.AuthService);
        if (!(retired instanceof oauth.OAuth2AuthService)) throw new Error("Expected OAuth2 auth");

        const pending = retired.authorize().catch((error: unknown) => error);
        await expect.poll(() => requested).toBe(true);
        root.provide(
          di.createDescriptor(oauth.OAuth2AuthService, { ...options, accessToken: "replacement" }),
        );

        await expect.poll(() => disconnected).toBe(true);
        expect(await pending).toMatchObject({ name: "AbortError" });
        await expect(retired.authorize()).rejects.toMatchObject({ name: "AbortError" });
        expect(retired.getToken()).toBeUndefined();
        expect(() => retired.setToken({ accessToken: "late" })).toThrow(
          "OAuth2 auth service is disposed",
        );
        await expect(root.get(auth.AuthService).authorize()).resolves.toMatchObject({
          headers: { Authorization: "Bearer replacement" },
        });
        const standalone = new oauth.OAuth2AuthService({ ...options, accessToken: "standalone" });
        await expect(standalone.authorize()).resolves.toMatchObject({
          headers: { Authorization: "Bearer standalone" },
        });
      } finally {
        root.dispose();
      }
    } finally {
      await modules.close();
    }
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
  }
});
