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
  "p",
  "blockquote",
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
  "[tabindex]",
  "[draggable=true]",
  "[onclick]",
  "[ondblclick]",
  "[onmousedown]",
  "[onpointerdown]",
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
      if (
        node.matches(EXCLUDED) ||
        node.isContentEditable ||
        node.shadowRoot ||
        node.localName.includes("-") ||
        node.onclick ||
        node.ondblclick ||
        node.onmousedown ||
        node.onpointerdown
      ) {
        return;
      }
      const style = getComputedStyle(node);
      const mask =
        style.getPropertyValue("mask-image") ||
        style.getPropertyValue("-webkit-mask-image");
      if (
        !["auto", "default"].includes(style.cursor) ||
        style.userSelect === "none" ||
        style.backgroundImage !== "none" ||
        (mask && mask !== "none")
      ) {
        return;
      }
    }
    for (const pseudo of ["::before", "::after"]) {
      if (
        !["none", "normal"].includes(getComputedStyle(target, pseudo).content)
      ) {
        return;
      }
    }
    // Decorative children can ignore pointer events while still painting here.
    if (
      Array.from(target.children).some((child) =>
        Array.from(child.getClientRects()).some(
          (rect) =>
            event.clientX >= rect.left &&
            event.clientX <= rect.right &&
            event.clientY >= rect.top &&
            event.clientY <= rect.bottom
        )
      )
    ) {
      return;
    }
    // Hit-test nearby characters too: unselectable/direct container text must
    // never be mistaken for blank padding merely because its tag is a DIV.
    const caret = document.caretRangeFromPoint(event.clientX, event.clientY);
    if (!caret) {
      return;
    }
    const node = caret.startContainer;
    const value = node.textContent || "";
    if (node.nodeType === Node.TEXT_NODE && value.trim()) {
      const text = document.createRange();
      text.setStart(node, Math.max(0, caret.startOffset - 1));
      text.setEnd(node, Math.min(value.length, caret.startOffset + 1));
      if (
        Array.from(text.getClientRects()).some(
          (rect) =>
            event.clientX >= rect.left - 6 &&
            event.clientX <= rect.right + 6 &&
            event.clientY >= rect.top - 6 &&
            event.clientY <= rect.bottom + 6
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
