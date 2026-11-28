/*
 * UI reference skill: vscode-ui
 * Reference revision: 4378eb0b965339a354d357fcb5ae33d2e10bf20e
 * Reference components: TreeView
 * Adaptation: Context menu keyboard shortcut detection.
 */
/* Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT License. */

export function isContextMenuKey(event: KeyboardEvent): boolean {
  if (event.isComposing) return false;
  const agent = navigator.userAgent;
  // WebKit uses 93 for the right Command key on macOS.
  const macMeta =
    agent.includes("Macintosh") && agent.includes("AppleWebKit") && !agent.includes("Firefox");
  return (event.keyCode === 93 && !macMeta) || (event.shiftKey && event.keyCode === 121);
}
