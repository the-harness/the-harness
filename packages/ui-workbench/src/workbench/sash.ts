/*
 * UI reference skill: vscode-ui
 * Reference revision: 4378eb0b965339a354d357fcb5ae33d2e10bf20e
 * Reference components: Sash
 * Adaptation: Enhances Dockview .dv-sash elements with VS Code 300ms hover delay, immediate active drag state, global drag cursor locking, macOS resize cursors, and view/iframe pointer-events suppression during drag.
 * Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT License.
 */
const HOVER_DELAY_MS = 300;

function sashCursor(sash: HTMLElement, isMac: boolean): string {
  const verticalLayout = !!sash
    .closest(".dv-split-view-container")
    ?.classList.contains("dv-vertical");
  if (verticalLayout) {
    if (sash.classList.contains("dv-minimum")) return "s-resize";
    if (sash.classList.contains("dv-maximum")) return "n-resize";
    return isMac ? "row-resize" : "ns-resize";
  }
  if (sash.classList.contains("dv-minimum")) return "e-resize";
  if (sash.classList.contains("dv-maximum")) return "w-resize";
  return isMac ? "col-resize" : "ew-resize";
}

function isSashDisabled(sash: HTMLElement): boolean {
  return sash.classList.contains("dv-disabled") || !!sash.closest(".dv-splitview-disabled");
}

export function attachDockSashBehavior(container: HTMLElement): () => void {
  const isMac = typeof navigator !== "undefined" && navigator.platform.includes("Mac");
  if (isMac) container.classList.add("dv-sash-mac");

  let activeSash: HTMLElement | null = null;
  let hoveredSash: HTMLElement | null = null;
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  let cursorStyle: HTMLStyleElement | null = null;
  let observer: MutationObserver | null = null;
  let disabledIframes: HTMLIFrameElement[] = [];

  const clearHover = () => {
    clearTimeout(hoverTimer);
    hoverTimer = undefined;
    hoveredSash?.classList.remove("dv-sash-hover");
    hoveredSash = null;
  };

  const updateCursor = () => {
    if (!activeSash || !cursorStyle) return;
    cursorStyle.textContent = `* { cursor: ${sashCursor(activeSash, isMac)} !important; }`;
  };

  const cleanup = () => {
    if (!activeSash) return;
    const doc = activeSash.ownerDocument;
    const win = doc.defaultView ?? window;
    activeSash.classList.remove("dv-sash-active");
    activeSash = null;
    container.classList.remove("dv-sash-dragging");
    observer?.disconnect();
    observer = null;
    cursorStyle?.remove();
    cursorStyle = null;
    for (const iframe of disabledIframes) {
      iframe.classList.remove("pointer-events-disabled");
    }
    disabledIframes = [];
    win.removeEventListener("pointerup", cleanup);
    win.removeEventListener("pointercancel", cleanup);
    win.removeEventListener("contextmenu", cleanup);
    win.removeEventListener("blur", cleanup);
  };

  const onPointerOver = (event: PointerEvent) => {
    if (activeSash) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const sash = target.closest(".dv-sash") as HTMLElement | null;
    if (!sash || !container.contains(sash) || isSashDisabled(sash)) return;
    if (hoveredSash === sash) return;
    clearHover();
    hoveredSash = sash;
    hoverTimer = setTimeout(() => {
      hoverTimer = undefined;
      if (hoveredSash === sash && !isSashDisabled(sash)) {
        sash.classList.add("dv-sash-hover");
      }
    }, HOVER_DELAY_MS);
  };

  const onPointerOut = (event: PointerEvent) => {
    if (!hoveredSash) return;
    const related = event.relatedTarget;
    if (related instanceof Node && hoveredSash.contains(related)) return;
    clearHover();
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const sash = target.closest(".dv-sash") as HTMLElement | null;
    if (!sash || !container.contains(sash) || isSashDisabled(sash)) return;

    cleanup();
    clearTimeout(hoverTimer);
    hoverTimer = undefined;

    const doc = sash.ownerDocument;
    const win = doc.defaultView ?? window;
    activeSash = sash;
    hoveredSash = sash;
    sash.classList.add("dv-sash-active", "dv-sash-hover");
    container.classList.add("dv-sash-dragging");

    disabledIframes = Array.from(doc.getElementsByTagName("iframe"));
    for (const iframe of disabledIframes) {
      iframe.classList.add("pointer-events-disabled");
    }

    cursorStyle = doc.createElement("style");
    cursorStyle.media = "screen";
    updateCursor();
    doc.head.append(cursorStyle);

    observer = new MutationObserver(updateCursor);
    observer.observe(sash, { attributes: true, attributeFilter: ["class"] });

    win.addEventListener("pointerup", cleanup);
    win.addEventListener("pointercancel", cleanup);
    win.addEventListener("contextmenu", cleanup);
    win.addEventListener("blur", cleanup);
  };

  container.addEventListener("pointerover", onPointerOver, true);
  container.addEventListener("pointerout", onPointerOut, true);
  container.addEventListener("pointerdown", onPointerDown, true);

  return () => {
    cleanup();
    clearHover();
    container.removeEventListener("pointerover", onPointerOver, true);
    container.removeEventListener("pointerout", onPointerOut, true);
    container.removeEventListener("pointerdown", onPointerDown, true);
    container.classList.remove("dv-sash-mac");
  };
}
