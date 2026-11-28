export function workspaceNodeId(root: string, relativePath = ""): string {
  return relativePath ? `entry:${root}::${relativePath}` : `root:${root}`;
}

export function parseWorkspaceNodeId(id: string): { root: string; relativePath: string } | null {
  if (id.startsWith("root:")) {
    return { root: id.slice("root:".length), relativePath: "" };
  }
  if (id.startsWith("entry:")) {
    const rest = id.slice("entry:".length);
    const sep = rest.indexOf("::");
    if (sep === -1) return null;
    return { root: rest.slice(0, sep), relativePath: rest.slice(sep + 2) };
  }
  return null;
}
