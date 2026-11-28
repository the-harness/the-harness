const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  vue: "html",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  json: "json",
  jsonc: "json",
  md: "markdown",
  markdown: "markdown",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  xml: "xml",
  sql: "sql",
};

export function inferLanguage(filePath: string, _firstLine = ""): string {
  const name = filePath.split("/").at(-1)?.toLowerCase() ?? "";
  if (name === "dockerfile") return "dockerfile";
  const ext = name.includes(".") ? (name.split(".").at(-1) ?? "") : "";
  return LANGUAGE_BY_EXT[ext] ?? "plaintext";
}
