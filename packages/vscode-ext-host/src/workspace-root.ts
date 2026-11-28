export function findWorkspaceRoot(roots: readonly string[], fullPath: string): string | undefined {
  return [...roots]
    .sort((a, b) => b.length - a.length)
    .find((root) => {
      const cleanRoot = root.replace(/\/+$/, "");
      return fullPath === cleanRoot || fullPath.startsWith(`${cleanRoot}/`);
    });
}
