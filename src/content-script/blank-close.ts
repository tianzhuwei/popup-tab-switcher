import { closeTabFromBlankDoubleClick } from "../utils/messages";

interface IBlankClick {
  target: HTMLElement;
  x: number;
  y: number;
  time: number;
}

interface IGestureWindow extends Window {
  __popupTabSwitcherBlankCloseDispose?: () => void;
}

const CONTAINERS = new Set([
  "HTML",
  "BODY",
  "MAIN",
  "SECTION",
  "ARTICLE",
  "ASIDE",
  "DIV",
  "HEADER",
  "FOOTER",
  "NAV",
  "P",
  "BLOCKQUOTE",
  "UL",
  "OL",
  "LI",
  "DL",
  "DT",
  "DD",
  "FIGURE",
  "FIGCAPTION",
  "SPAN",
]);
const EXCLUDED = [
  "a",
  "button",
  "input",
  "textarea",
  "select",
  "label",
  "summary",
  "details",
  "form",
  "fieldset",
  "table",
  "pre",
  "code",
  "img",
  "picture",
  "audio",
  "video",
  "svg",
  "canvas",
  "iframe",
  "embed",
  "object",
  "dialog",
  "[popover]",
  "[draggable=true]",
  "[aria-haspopup]",
  '[contenteditable]:not([contenteditable="false"])',
  ...[
    "button",
    "link",
    "textbox",
    "checkbox",
    "radio",
    "switch",
    "slider",
    "spinbutton",
    "combobox",
    "listbox",
    "option",
    "menu",
    "menubar",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "tab",
    "tablist",
    "tree",
    "treeitem",
    "grid",
    "img",
    "graphics-document",
    "graphics-object",
    "graphics-symbol",
    "application",
    "scrollbar",
    "separator",
    "tooltip",
  ].map((role) => `[role="${role}"]`),
].join(",");
const INLINE_HANDLERS = "[onclick],[ondblclick],[onmousedown],[onpointerdown]";

function isProtected(element: HTMLElement): boolean {
  if (
    element.matches(EXCLUDED) ||
    element.isContentEditable ||
    element.shadowRoot ||
    element.localName.includes("-")
  ) {
    return true;
  }
  // Page-wide focus/delegation hooks do not make every blank area a control.
  const isPageRoot =
    element === document.body || element === document.documentElement;
  return (
    !isPageRoot &&
    (element.tabIndex >= 0 ||
      element.matches(INLINE_HANDLERS) ||
      !!(
        element.onclick ||
        element.ondblclick ||
        element.onmousedown ||
        element.onpointerdown
      ))
  );
}

function hasImage(style: CSSStyleDeclaration): boolean {
  const mask =
    style.getPropertyValue("mask-image") ||
    style.getPropertyValue("-webkit-mask-image");
  // Gradients are common page decoration, unlike image URLs or paint worklets.
  return (
    /\b(?:url|image-set|cross-fade|image|paint)\s*\(/i.test(
      style.backgroundImage
    ) || !!(mask && mask !== "none")
  );
}

function hasPseudoContent(element: HTMLElement): boolean {
  return ["::before", "::after"].some((pseudo) => {
    const style = getComputedStyle(element, pseudo);
    const content = style.content;
    if (
      style.display === "none" ||
      style.visibility !== "visible" ||
      Number(style.opacity) === 0 ||
      ["none", "normal"].includes(content)
    ) {
      return false;
    }
    return (
      !(content === "" || /^(["'])\s*\1$/.test(content)) || hasImage(style)
    );
  });
}

function containsPoint(
  rect: DOMRect,
  x: number,
  y: number,
  margin = 0
): boolean {
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    x >= rect.left - margin &&
    x <= rect.right + margin &&
    y >= rect.top - margin &&
    y <= rect.bottom + margin
  );
}

function hasContentAtPoint(target: HTMLElement, x: number, y: number): boolean {
  const pending: Element[] = [target];
  const text = document.createRange();
  let remaining = 256;
  while (pending.length) {
    const element = pending.pop()!;
    const style = getComputedStyle(element);
    if (style.display === "none" || Number(style.opacity) === 0) {
      continue;
    }
    if (element !== target) {
      if (
        !Array.from(element.getClientRects()).some((rect) =>
          containsPoint(rect, x, y)
        )
      ) {
        continue;
      }
      if (
        style.visibility === "visible" &&
        (!(element instanceof HTMLElement) ||
          !CONTAINERS.has(element.tagName) ||
          isProtected(element) ||
          hasImage(style) ||
          hasPseudoContent(element) ||
          !["auto", "default"].includes(style.cursor))
      ) {
        return true;
      }
    }
    for (const child of Array.from(element.childNodes)) {
      // Unknown/deep overlays remain excluded without walking an entire page.
      if (--remaining < 0) {
        return true;
      }
      if (
        child.nodeType === Node.TEXT_NODE &&
        child.textContent?.trim() &&
        style.visibility === "visible"
      ) {
        text.selectNodeContents(child);
        if (
          Array.from(text.getClientRects()).some((rect) =>
            containsPoint(rect, x, y, 4)
          )
        ) {
          return true;
        }
      } else if (child instanceof Element) {
        pending.push(child);
      }
    }
  }
  return false;
}

// Kept separate from content.js: no popup, framework, polling or page changes.
if (
  window === window.top &&
  ["text/html", "application/xhtml+xml"].includes(document.contentType)
) {
  initBlankClose();
}

function initBlankClose(): void {
  const gestureWindow = window as IGestureWindow;
  gestureWindow.__popupTabSwitcherBlankCloseDispose?.();
  gestureWindow.__popupTabSwitcherBlankCloseDispose = dispose;
  let enabled = false;
  let closing = false;
  let disposed = false;
  let revision = 0;
  let firstClick: IBlankClick | undefined;
  let closeTimeout: number | undefined;

  chrome.storage.onChanged.addListener(onSettingsChange);
  window.addEventListener("pageshow", onPageShow);
  readSettings();

  function setEnabled(value: boolean): void {
    clearClick();
    if (closeTimeout !== undefined) {
      clearTimeout(closeTimeout);
      closeTimeout = undefined;
      closing = false;
    }
    window.removeEventListener("click", onClick);
    window.removeEventListener("dblclick", onDoubleClick);
    window.removeEventListener("scroll", clearClick, true);
    window.removeEventListener("blur", clearClick);
    enabled = value && !disposed;
    if (enabled) {
      window.addEventListener("click", onClick);
      window.addEventListener("dblclick", onDoubleClick);
      window.addEventListener("scroll", clearClick, {
        capture: true,
        passive: true,
      });
      window.addEventListener("blur", clearClick);
    }
  }

  async function readSettings(): Promise<void> {
    const current = ++revision;
    try {
      const { settings } = await chrome.storage.local.get("settings");
      if (!disposed && current === revision) {
        setEnabled(settings?.isDoubleClickClosingTab === true);
      }
    } catch {
      if (!disposed && current === revision) {
        setEnabled(false);
      }
    }
  }

  function onSettingsChange(
    changes: { [key: string]: chrome.storage.StorageChange },
    area: string
  ): void {
    if (area === "local" && changes.settings) {
      revision += 1;
      setEnabled(changes.settings.newValue?.isDoubleClickClosingTab === true);
    }
  }

  function onPageShow(event: PageTransitionEvent): void {
    if (event.persisted) {
      closing = false;
      setEnabled(false);
      readSettings();
    }
  }

  function clearClick(): void {
    firstClick = undefined;
  }

  function onClick(event: MouseEvent): void {
    if (closing) {
      clearClick();
      return;
    }
    if (event.detail === 2) {
      if (!firstClick || blankTarget(event) !== firstClick.target) {
        clearClick();
      }
      return;
    }
    if (event.detail !== 1) {
      clearClick();
      return;
    }
    const target = blankTarget(event);
    firstClick = target
      ? {
          target,
          x: event.clientX,
          y: event.clientY,
          time: performance.now(),
        }
      : undefined;
  }

  function onDoubleClick(event: MouseEvent): void {
    const first = firstClick;
    clearClick();
    const target = blankTarget(event);
    if (
      !first ||
      !target ||
      closing ||
      event.detail !== 2 ||
      first.target !== target ||
      performance.now() - first.time > 1000 ||
      Math.hypot(event.clientX - first.x, event.clientY - first.y) > 6
    ) {
      return;
    }
    closing = true;
    const path = event.composedPath();
    // Let all page handlers finish, including handlers registered after ours.
    closeTimeout = window.setTimeout(() => {
      closeTimeout = undefined;
      if (!target.isConnected || blankTarget(event, path) !== target) {
        closing = false;
        return;
      }
      try {
        if (!chrome.runtime.id) {
          dispose();
          return;
        }
        chrome.runtime
          .sendMessage(closeTabFromBlankDoubleClick())
          .then((closed) => {
            if (closed !== true) {
              closing = false;
            }
          })
          .catch(() => {
            closing = false;
          });
      } catch {
        dispose();
      }
    }, 0);
  }

  function blankTarget(
    event: MouseEvent,
    path = event.composedPath()
  ): HTMLElement | undefined {
    if (
      !enabled ||
      !event.isTrusted ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      document.hidden ||
      !document.hasFocus() ||
      document.fullscreenElement ||
      document.getSelection()?.isCollapsed === false
    ) {
      return;
    }
    const target = event.target;
    if (!(target instanceof HTMLElement) || !CONTAINERS.has(target.tagName)) {
      return;
    }
    // Include current ancestors too, in case a page handler reparented the node.
    const ancestors: Element[] = [];
    for (let node: Element | null = target; node; node = node.parentElement) {
      ancestors.push(node);
    }
    for (const node of new Set([...path, ...ancestors])) {
      if (
        node instanceof ShadowRoot ||
        (node instanceof Element && !(node instanceof HTMLElement))
      ) {
        return;
      }
      if (!(node instanceof HTMLElement)) {
        continue;
      }
      if (isProtected(node)) {
        return;
      }
      const style = getComputedStyle(node);
      if (!["auto", "default"].includes(style.cursor) || hasImage(style)) {
        return;
      }
    }
    // Inspect content at the point, not a transparent layout layer's whole box.
    // Text rectangles also protect user-select:none text without relying on caret APIs.
    if (
      hasPseudoContent(target) ||
      hasContentAtPoint(target, event.clientX, event.clientY)
    ) {
      return;
    }
    // Keep the text hit-test for overflow/overlay text, but a missing caret
    // no longer vetoes empty space already checked by DOM text rectangles.
    const caret = document.caretRangeFromPoint(event.clientX, event.clientY);
    const node = caret?.startContainer;
    if (
      caret &&
      node?.nodeType === Node.TEXT_NODE &&
      node.textContent?.trim()
    ) {
      const offset = caret.startOffset;
      caret.setStart(node, Math.max(0, offset - 1));
      caret.setEnd(node, Math.min((node.textContent || "").length, offset + 1));
      if (
        Array.from(caret.getClientRects()).some((rect) =>
          containsPoint(rect, event.clientX, event.clientY, 4)
        )
      ) {
        return;
      }
    }
    return target;
  }

  function dispose(): void {
    disposed = true;
    revision += 1;
    setEnabled(false);
    window.removeEventListener("pageshow", onPageShow);
    try {
      chrome.storage.onChanged.removeListener(onSettingsChange);
    } catch {
      // Extension reload may already have invalidated the old script context.
    }
    if (gestureWindow.__popupTabSwitcherBlankCloseDispose === dispose) {
      delete gestureWindow.__popupTabSwitcherBlankCloseDispose;
    }
  }
}
