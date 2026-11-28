import { describe, expect, it } from "vite-plus/test";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { CwdService } from "../../packages/cwd/src/index.ts";

describe("CwdService", () => {
  it("resolves relative, absolute, @-prefixed and home-relative paths", () => {
    const service = new CwdService("/work/project");

    expect(service.cwd).toBe("/work/project");
    expect(service.resolve("src/index.ts")).toBe("/work/project/src/index.ts");
    expect(service.resolve("./src/../package.json")).toBe("/work/project/package.json");
    expect(service.resolve("/etc/hosts")).toBe("/etc/hosts");
    expect(service.resolve("@src/index.ts")).toBe("/work/project/src/index.ts");
    expect(service.resolve("@/etc/hosts")).toBe("/etc/hosts");
    expect(service.resolve("~")).toBe(homedir());
    expect(service.resolve("~/notes")).toBe(resolve(homedir(), "notes"));
    expect(service.resolve("~\\notes")).toBe(resolve(homedir(), "notes"));
    expect(service.resolve("~someone/notes")).toBe("/work/project/~someone/notes");
  });

  it("defaults to the process working directory", () => {
    const service = new CwdService();
    expect(service.cwd).toBe(process.cwd());
    expect(service.resolve("a")).toBe(resolve(process.cwd(), "a"));
  });
});
