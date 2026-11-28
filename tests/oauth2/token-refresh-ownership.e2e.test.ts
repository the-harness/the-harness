import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vite-plus/test";
import { createHarnessModules } from "../helpers/harness-modules.ts";

function reply(response: ServerResponse, accessToken: string) {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ access_token: accessToken, expires_in: 3600 }));
}

it("prevents superseded OAuth2 refreshes from publishing or replacing the active refresh", async () => {
  const responses: ServerResponse[] = [];
  const server = createServer((request, response) => {
    request.resume();
    responses.push(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const modules = await createHarnessModules();
    try {
      const [di, oauth, authModule] = await Promise.all([
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
        root.provide(
          di.createDescriptor(oauth.OAuth2AuthService, {
            clientId: "harness-test",
            tokenUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`,
            accessToken: "original-access",
            refreshToken: "original-refresh",
            expiresAt: 0,
          }),
        );
        const auth = root.get(authModule.AuthService);
        if (!(auth instanceof oauth.OAuth2AuthService)) throw new Error("Expected OAuth2 auth");

        const fromClearedToken = auth.authorize().catch((error: unknown) => error);
        await expect.poll(() => responses.length).toBe(1);
        auth.setToken(undefined);
        reply(responses[0]!, "logged-out-access");
        expect(await fromClearedToken).toMatchObject({ name: "AbortError" });
        expect(auth.getToken()).toBeUndefined();
        expect((await auth.authorize()).headers).toEqual({});

        auth.setToken({ accessToken: "older-access", refreshToken: "older-refresh", expiresAt: 0 });
        const fromOlderToken = auth.authorize().catch((error: unknown) => error);
        await expect.poll(() => responses.length).toBe(2);

        auth.setToken({ accessToken: "new-access", refreshToken: "new-refresh", expiresAt: 0 });
        const fromNewToken = auth.authorize().catch((error: unknown) => error);
        await expect.poll(() => responses.length).toBe(3);
        reply(responses[1]!, "superseded-access");
        expect(await fromOlderToken).toMatchObject({ name: "AbortError" });
        expect(auth.getToken()?.accessToken).toBe("new-access");

        const sharedRefresh = auth.authorize({ signal: AbortSignal.timeout(2500) });
        reply(responses[2]!, "current-access");
        const [first, second] = await Promise.all([fromNewToken, sharedRefresh]);
        for (const result of [first, second]) {
          expect(result).toMatchObject({ headers: { Authorization: "Bearer current-access" } });
        }
        expect(responses).toHaveLength(3);

        auth.setToken({
          accessToken: "expired-access",
          refreshToken: "current-refresh",
          expiresAt: 0,
        });
        const firstCaller = new AbortController();
        const canceledFirst = auth
          .authorize({ signal: firstCaller.signal })
          .catch((error: unknown) => error);
        await expect.poll(() => responses.length).toBe(4);
        const interestedCaller = auth.authorize().catch((error: unknown) => error);
        const lastCaller = new AbortController();
        const canceledLast = auth
          .authorize({ signal: lastCaller.signal })
          .catch((error: unknown) => error);
        firstCaller.abort();
        lastCaller.abort();
        expect(await canceledFirst).toMatchObject({ name: "AbortError" });
        expect(await canceledLast).toMatchObject({ name: "AbortError" });
        reply(responses[3]!, "still-interested-access");
        expect(await interestedCaller).toMatchObject({
          headers: { Authorization: "Bearer still-interested-access" },
        });
        expect(responses).toHaveLength(4);
      } finally {
        root.dispose();
      }
    } finally {
      await modules.close();
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
