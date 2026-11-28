import { expect, test } from "@playwright/test";
import type { TerminalInfo } from "../../packages/terminal/src/index.ts";

test("a running terminal tab shows the exit state when its shell exits", async ({
  page,
  request,
}) => {
  const title = `Terminal exit ${crypto.randomUUID()}`;
  const created = await request.post("/api/terminals", {
    data: { title, shell: "/bin/sh", args: ["-s"] },
  });
  expect(created.ok()).toBe(true);
  const { id } = (await created.json()) as { id: string };
  const terminal = `/api/terminals/${encodeURIComponent(id)}`;
  const statusFrames: unknown[] = [];
  const pageErrors: string[] = [];
  const socketErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("websocket", (socket) => {
    if (new URL(socket.url()).pathname !== `/ws/terminals/${encodeURIComponent(id)}`) return;
    socket.on("socketerror", (error) => socketErrors.push(error));
    socket.on("framereceived", ({ payload }) => {
      try {
        const frame = JSON.parse(payload.toString()) as {
          type: string;
          info?: TerminalInfo;
          exitCode?: number;
        };
        if (frame.type === "snapshot" && frame.info) {
          const { id, exited, exitCode } = frame.info;
          statusFrames.push({ type: frame.type, info: { id, exited, exitCode } });
        } else if (frame.type === "exit") {
          statusFrames.push({ type: frame.type, exitCode: frame.exitCode });
        }
      } catch {
        socketErrors.push("Received a malformed terminal frame");
      }
    });
  });

  try {
    await page.goto("/tests/terminal-exit.fixture.html");
    const tab = page.getByRole("button", { name: title });
    const exited = tab.getByText("exited", { exact: true });
    await expect(tab).toBeVisible();
    await expect(exited).toHaveCount(0);
    await expect
      .poll(() => statusFrames, { message: "The browser receives the running PTY snapshot" })
      .toContainEqual({ type: "snapshot", info: { id, exited: false, exitCode: null } });

    const input = await request.post(`${terminal}/input`, { data: { data: "exit 7\n" } });
    expect(input.status()).toBe(204);
    await expect
      .poll(
        async () => {
          const inventory = await request.get("/api/terminals");
          expect(inventory.ok()).toBe(true);
          return ((await inventory.json()) as TerminalInfo[]).find((item) => item.id === id);
        },
        { message: "The server records the real shell's exit" },
      )
      .toMatchObject({ exited: true, exitCode: 7 });
    await expect
      .poll(() => statusFrames, { message: "The browser receives the PTY exit frame" })
      .toContainEqual({ type: "exit", exitCode: 7 });
    await expect(exited, "The terminal tab renders the received exit state").toBeVisible();
  } catch (error) {
    await test.info().attach("terminal exit diagnostics", {
      body: JSON.stringify({ statusFrames, pageErrors, socketErrors }),
      contentType: "application/json",
    });
    throw error;
  } finally {
    await request.delete(terminal);
  }
});
