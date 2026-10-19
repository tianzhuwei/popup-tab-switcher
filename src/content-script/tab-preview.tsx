import { createEffect, on, onCleanup, onMount } from "solid-js";
import { openTabPreview, sendMessageAndGetResponse } from "../utils/messages";

interface IProps {
  element: HTMLElement;
  tab: chrome.tabs.Tab | undefined;
  zoomFactor: number;
  isDark: boolean;
  isEnhanced: boolean;
}

const CHANNEL = "popup-tab-switcher-preview";
const SESSION_REFRESH_INTERVAL = 25 * 60 * 1000;

export function TabPreview(props: IProps) {
  let frame: HTMLIFrameElement;
  let token: string | undefined;
  let sessionOpenedAt = 0;
  let sessionPending = false;
  let ready = false;
  let hasImage = false;
  let requestId = 0;
  let settled = false;
  let disposed = false;
  let selectionTimer: number | undefined;
  let layoutFrame: number | undefined;
  const origin = `chrome-extension://${chrome.runtime.id}`;
  const resizeObserver = new ResizeObserver(scheduleLayout);
  let tabList: Element | null = null;

  createEffect(
    on(
      () => [props.tab?.id, props.tab?.url],
      () => {
        settled = false;
        clearTimeout(selectionTimer);
        clearPreview();
        selectionTimer = window.setTimeout(() => {
          settled = true;
          publishTarget();
        }, 200);
      }
    )
  );

  createEffect(
    on(
      () => [
        props.isDark,
        props.isEnhanced,
        props.zoomFactor,
        props.tab?.title,
      ],
      publishTarget
    )
  );

  onMount(() => {
    window.addEventListener("message", onFrameMessage);
    window.addEventListener("resize", scheduleLayout);
    const card = props.element.shadowRoot?.querySelector(".card");
    if (card) resizeObserver.observe(card);
    tabList = props.element.shadowRoot?.querySelector(".card__tabs") || null;
    tabList?.addEventListener("scroll", scheduleLayout, { passive: true });
    requestSession();
  });

  onCleanup(() => {
    disposed = true;
    clearTimeout(selectionTimer);
    if (layoutFrame !== undefined) cancelAnimationFrame(layoutFrame);
    window.removeEventListener("message", onFrameMessage);
    window.removeEventListener("resize", scheduleLayout);
    tabList?.removeEventListener("scroll", scheduleLayout);
    resizeObserver.disconnect();
    clearPreview();
    token = undefined;
  });

  return (
    <iframe
      ref={frame!}
      class="tab-preview"
      classList={{ "tab-preview_dark": props.isDark }}
      src={chrome.runtime.getURL("preview/index.html")}
      title="Selected tab preview"
      tabindex="-1"
      aria-hidden="true"
    />
  );

  function post(message: object) {
    frame?.contentWindow?.postMessage({ channel: CHANNEL, ...message }, origin);
  }

  function requestSession() {
    if (disposed || sessionPending) return;
    sessionPending = true;
    token = undefined;
    clearPreview();
    void sendMessageAndGetResponse(openTabPreview())
      .then(
        (session) => {
          if (disposed) return;
          token = session;
          sessionOpenedAt = Date.now();
          publishTarget();
        },
        () => clearPreview()
      )
      .finally(() => {
        sessionPending = false;
      });
  }

  function clearPreview() {
    hasImage = false;
    requestId += 1;
    if (!frame) return;
    frame.style.visibility = "hidden";
    post({ type: "clear" });
  }

  function onFrameMessage(event: MessageEvent) {
    if (
      disposed ||
      event.source !== frame?.contentWindow ||
      event.origin !== origin ||
      event.data?.channel !== CHANNEL
    )
      return;
    if (event.data.type === "ready") {
      hasImage = false;
      frame.style.visibility = "hidden";
      ready = true;
      publishTarget();
    } else if (
      event.data.type === "preview-state" &&
      event.data.requestId === requestId &&
      event.data.tabId === props.tab?.id &&
      typeof event.data.available === "boolean"
    ) {
      hasImage = event.data.available;
      if (hasImage) {
        scheduleLayout();
      } else {
        frame.style.visibility = "hidden";
      }
    }
  }

  function publishTarget() {
    const tab = props.tab;
    if (disposed || !ready || !settled || !token || tab?.id === undefined)
      return;
    // Refresh lazily when a long-open popup next requests a target.
    if (Date.now() - sessionOpenedAt >= SESSION_REFRESH_INTERVAL) {
      requestSession();
      return;
    }
    post({
      requestId: ++requestId,
      token,
      tabId: tab.id,
      title: tab.title || "",
      url: tab.url || tab.pendingUrl || "",
      dark: props.isDark,
      enhanced: props.isEnhanced,
      zoomFactor: props.zoomFactor,
    });
    scheduleLayout();
  }

  function scheduleLayout() {
    if (disposed || layoutFrame !== undefined) return;
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = undefined;
      positionPreview();
    });
  }

  function positionPreview() {
    if (disposed || !frame || !ready || !settled || !token || !hasImage) return;
    const card = props.element.shadowRoot?.querySelector(".card");
    if (!card) return;
    const rect = card.getBoundingClientRect();
    const selected = card
      .querySelector(".tab_selected")
      ?.getBoundingClientRect();
    const unit = 1 / props.zoomFactor;
    const margin = 20 * unit;
    const gap = 16 * unit;
    const maxWidth = 520 * unit;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const rightSpace = viewportWidth - margin - rect.right - gap;
    const leftSpace = rect.left - gap - margin;
    const clamp = (value: number, max: number) =>
      Math.max(margin, Math.min(value, max));
    let width: number;
    let height: number;
    let left: number;
    let top: number;
    if (Math.max(rightSpace, leftSpace) >= 260 * unit) {
      const onRight = rightSpace >= maxWidth || rightSpace >= leftSpace;
      width = Math.min(maxWidth, onRight ? rightSpace : leftSpace);
      height = Math.min(width * 0.625 + 64 * unit, viewportHeight - 2 * margin);
      left = onRight ? rect.right + gap : rect.left - gap - width;
      top = clamp(
        (selected
          ? selected.top + selected.height / 2
          : rect.top + rect.height / 2) -
          height / 2,
        viewportHeight - margin - height
      );
    } else {
      const below = viewportHeight - margin - rect.bottom - gap;
      const above = rect.top - gap - margin;
      const atBottom = below >= above;
      width = Math.min(maxWidth, viewportWidth - 2 * margin);
      height = Math.min(width * 0.625 + 64 * unit, Math.max(below, above));
      if (width < 260 * unit || height < 140 * unit) {
        frame.style.visibility = "hidden";
        return;
      }
      left = clamp(
        rect.left + (rect.width - width) / 2,
        viewportWidth - margin - width
      );
      top = atBottom ? rect.bottom + gap : rect.top - gap - height;
    }
    frame.style.left = `${left}px`;
    frame.style.top = `${top}px`;
    frame.style.width = `${width}px`;
    frame.style.height = `${height}px`;
    frame.style.visibility = "visible";
  }
}
