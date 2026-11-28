import type { ImageContent, ModelImageResizeOptions } from "@earendil-works/pi-ai";
import type { DefaultResourceLoader, PromptTemplate } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";

// Pi v1.6.1 ships these input helpers alongside its public SDK.
const pi = import.meta.resolve("@earendil-works/pi-coding-agent");

export const { processFileArguments } = (await import(
  new URL("cli/file-processor.js", pi).href
)) as {
  processFileArguments(
    paths: string[],
    options: { autoResizeImages: boolean },
  ): Promise<{
    text: string;
    images: ImageContent[];
  }>;
};

export const { processImage } = (await import(new URL("utils/image-process.js", pi).href)) as {
  processImage(
    bytes: Uint8Array,
    mimeType: string,
    options: {
      autoResizeImages: boolean;
      resizeOptions?: ModelImageResizeOptions;
    },
  ): Promise<
    { ok: true; data: string; mimeType: string; hints: string[] } | { ok: false; message: string }
  >;
};

const { expandPromptTemplate } = (await import(new URL("core/prompt-templates.js", pi).href)) as {
  expandPromptTemplate(text: string, templates: PromptTemplate[]): string;
};

const { stripFrontmatter } = (await import(new URL("utils/frontmatter.js", pi).href)) as {
  stripFrontmatter(text: string): string;
};

export function expandResourcePrompt(
  text: string,
  resources: DefaultResourceLoader,
  reportSkillError: (path: string, error: unknown) => void,
): string {
  const match = /^\/skill:([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
  if (match) {
    const skill = resources.getSkills().skills.find(({ name }) => name === match[1]);
    if (!skill) return text;
    try {
      const body = stripFrontmatter(readFileSync(skill.filePath, "utf8")).trim();
      const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
      const args = match[2]?.trim();
      return args ? `${block}\n\n${args}` : block;
    } catch (error) {
      reportSkillError(skill.filePath, error);
      return text;
    }
  }
  return expandPromptTemplate(text, resources.getPrompts().prompts);
}
