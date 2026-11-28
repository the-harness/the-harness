import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createHarnessModules, type HarnessModules } from "../helpers/harness-modules.ts";

type AgentsMdModule = typeof import("../../packages/agents-md/src/index.ts");
type CwdModule = typeof import("../../packages/cwd/src/index.ts");
type DiModule = typeof import("../../packages/di/src/index.ts");
type SkillsModule = typeof import("../../packages/skills/src/index.ts");

let harness: HarnessModules;
let agentsMd: AgentsMdModule;
let cwdModule: CwdModule;
let di: DiModule;
let skills: SkillsModule;
const roots: string[] = [];

beforeAll(async () => {
  harness = await createHarnessModules();
  [agentsMd, cwdModule, di, skills] = await Promise.all([
    harness.load<AgentsMdModule>("/packages/agents-md/src/index.ts"),
    harness.load<CwdModule>("/packages/cwd/src/index.ts"),
    harness.load<DiModule>("/packages/di/src/index.ts"),
    harness.load<SkillsModule>("/packages/skills/src/index.ts"),
  ]);
});

afterAll(async () => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
  await harness.close();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-context-discovery-"));
  roots.push(dir);
  return dir;
}

function createScope(cwd: string) {
  const scope = di.createRootScope();
  scope.provideAll([
    di.createDescriptor(cwdModule.CwdService, cwd),
    agentsMd.AgentsMdService,
    skills.SkillsService,
  ]);
  return scope;
}

it("preserves the discovery order of registrations owned by other scopes", () => {
  const root = tempDir();
  const cwd = join(root, "project");
  const fallback = join(cwd, ".agents", "skills");
  const firstDir = join(root, "first");
  const secondDir = join(root, "second");
  const skillName = "discovery-registration-ownership";
  const writeSkill = (directory: string, description: string) => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${skillName}.md`), `---\ndescription: ${description}\n---\n`);
  };
  writeSkill(fallback, "project");
  writeSkill(firstDir, "first");
  writeSkill(secondDir, "second");
  const firstContext = join(firstDir, "AGENTS.md");
  const secondContext = join(secondDir, "AGENTS.md");
  writeFileSync(firstContext, "first instructions");
  writeFileSync(secondContext, "second instructions");

  const rootScope = createScope(cwd);
  try {
    const first = rootScope.createChild({ id: "first" });
    const second = rootScope.createChild({ id: "second" });
    const duplicate = rootScope.createChild({ id: "duplicate" });
    const register = (owner: ReturnType<typeof createScope>, directory: string) => {
      owner.setup(() => {
        di.inject(agentsMd.AgentsMdService).useSearchDir(directory);
        di.inject(skills.SkillsService).useRoot(directory);
      });
    };
    register(first, firstDir);
    register(second, secondDir);
    register(duplicate, firstDir);

    const context = rootScope.get(agentsMd.AgentsMdService);
    const skillsService = rootScope.get(skills.SkillsService);
    const contextPaths = () =>
      context
        .discover()
        .map((file) => file.path)
        .filter((path) => path === firstContext || path === secondContext);

    expect(contextPaths()).toEqual([firstContext, secondContext]);
    expect(skillsService.get(skillName)?.description).toBe("first");
    duplicate.dispose();
    expect(contextPaths()).toEqual([firstContext, secondContext]);
    expect(skillsService.get(skillName)?.description).toBe("second");
    second.dispose();
    expect(contextPaths()).toEqual([firstContext]);
    expect(skillsService.get(skillName)?.description).toBe("first");
    first.dispose();
    expect(contextPaths()).toEqual([]);
    expect(skillsService.get(skillName)?.description).toBe("project");
  } finally {
    rootScope.dispose();
  }
});

describe("AGENTS.md discovery", () => {
  it("walks ancestors from the root and prefers override files in each directory", () => {
    const root = tempDir();
    const workspace = join(root, "workspace");
    const nested = join(workspace, "src");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "root instructions");
    writeFileSync(join(workspace, "AGENTS.md"), "workspace instructions");
    writeFileSync(join(workspace, "AGENTS.override.md"), "workspace override");
    writeFileSync(join(nested, "CLAUDE.md"), "nested claude");
    writeFileSync(join(nested, "AGENTS.md"), "nested agents");

    const scope = createScope(nested);
    try {
      const service = scope.get(agentsMd.AgentsMdService);
      const found = service.discover();
      expect(found.map((file) => file.content)).toEqual([
        "root instructions",
        "workspace override",
        "nested agents",
      ]);
      expect(found.map((file) => file.path)).toEqual([
        join(root, "AGENTS.md"),
        join(workspace, "AGENTS.override.md"),
        join(nested, "AGENTS.md"),
      ]);
    } finally {
      scope.dispose();
    }
  });

  it("prepends explicit search directories once and deduplicates them", () => {
    const root = tempDir();
    const workspace = join(root, "workspace");
    const extra = join(root, "extra");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(extra, { recursive: true });
    writeFileSync(join(workspace, "AGENTS.md"), "workspace");
    writeFileSync(join(extra, "AGENTS.md"), "extra");

    const scope = createScope(workspace);
    try {
      const service = scope.get(agentsMd.AgentsMdService);
      scope.run(() => {
        service.useSearchDir(extra);
        service.useSearchDir(extra);
      });
      expect(service.discover().map((file) => file.content)).toEqual(["extra", "workspace"]);
    } finally {
      scope.dispose();
    }
  });
});

describe("skills discovery", () => {
  it("reads directory and flat skills, skips hidden entries and missing descriptions", () => {
    const root = tempDir();
    const cwd = join(root, "project");
    mkdirSync(join(cwd, ".agents/skills/review"), { recursive: true });
    mkdirSync(join(cwd, ".agents/skills/.hidden"), { recursive: true });
    mkdirSync(join(root, "extra-skills/summarize"), { recursive: true });
    writeFileSync(
      join(cwd, ".agents/skills/review/SKILL.md"),
      "---\nname: review\ndescription: Review code carefully\n---\nbody",
    );
    writeFileSync(join(cwd, ".agents/skills/.hidden/SKILL.md"), "---\ndescription: hidden\n---\n");
    writeFileSync(join(cwd, ".agents/skills/flat.md"), "---\ndescription: flat skill\n---\n");
    writeFileSync(join(cwd, ".agents/skills/ignored.md"), "no frontmatter");
    writeFileSync(
      join(root, "extra-skills/summarize/SKILL.md"),
      '---\nname: "summarize"\ndescription: "Summarize text"\n---\n',
    );

    const previousHome = process.env.HOME;
    process.env.HOME = join(root, "home");
    const scope = createScope(cwd);
    try {
      const service = scope.get(skills.SkillsService);
      scope.run(() => service.useRoot(join(root, "extra-skills")));
      const found = service.discover();
      expect(found.map((skill) => [skill.name, skill.description])).toEqual([
        ["flat", "flat skill"],
        ["review", "Review code carefully"],
        ["summarize", "Summarize text"],
      ]);
      expect(service.get("review")?.location).toBe(join(cwd, ".agents/skills/review/SKILL.md"));
      expect(service.get("missing")).toBeUndefined();
    } finally {
      process.env.HOME = previousHome;
      scope.dispose();
    }
  });

  it("lets a later root replace a duplicate skill name", () => {
    const root = tempDir();
    const cwd = join(root, "project");
    mkdirSync(join(cwd, ".agents/skills/tool"), { recursive: true });
    mkdirSync(join(root, "override/tool"), { recursive: true });
    writeFileSync(
      join(cwd, ".agents/skills/tool/SKILL.md"),
      "---\nname: tool\ndescription: base\n---\n",
    );
    writeFileSync(
      join(root, "override/tool/SKILL.md"),
      "---\nname: tool\ndescription: overridden\n---\n",
    );

    const previousHome = process.env.HOME;
    process.env.HOME = join(root, "home");
    const scope = createScope(cwd);
    try {
      const service = scope.get(skills.SkillsService);
      scope.run(() => service.useRoot(join(root, "override")));
      expect(service.discover().filter((skill) => skill.name === "tool")).toEqual([
        { name: "tool", description: "overridden", location: join(root, "override/tool/SKILL.md") },
      ]);
    } finally {
      process.env.HOME = previousHome;
      scope.dispose();
    }
  });
});
