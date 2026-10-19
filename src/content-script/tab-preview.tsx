import { createEffect, on, onCleanup, onMount } from "solid-js";
import { openTabPreview, sendMessageAndGetResponse } from "../utils/messages";

interface IProps {
  element: HTMLElement;
  tab: chrome.tabs.Tab | undefined;
  zoomFactor: number;
  isDark: boolean;
  isEnhanced: boolean;
  isAnimated: boolean;
  sessionRevision: number;
}

type IPreviewState = "none" | "empty" | "image";

interface ISize {
  width: number;
  height: number;
}

const CHANNEL = "popup-tab-switcher-preview";
const SESSION_REFRESH_INTERVAL = 25 * 60 * 1000;
const DEFAULT_ASPECT_RATIO = 16 / 10;
// Border (1px) plus inner padding (6px) on each side of the preview frame.
const FRAME_CHROME = 14;

export function TabPreview(props: IProps) {
  let frame: HTMLIFrameElement;
  let token: string | undefined;
  let sessionOpenedAt = 0;
  let sessionPending = false;
  let sessionRefreshRequested = false;
  let ready = false;
  let previewState: IPreviewState = "none";
  let aspectRatio = DEFAULT_ASPECT_RATIO;
  let isShown = false;
  let requestId = 0;
  let disposed = false;
  let layoutFrame: number | undefined;
  const origin = `chrome-extension://${chrome.runtime.id}`;
  const resizeObserver = new ResizeObserver(scheduleLayout);

  createEffect(
    on(
      () => [props.tab?.id, props.tab?.url],
      () => {
        // Keep the current content on screen until the next target resolves.
        if (props.tab?.id === undefined) {
          clearPreview();
        } else {
          publishTarget();
        }
      }
    )
  );

  createEffect(
    on(() => props.sessionRevision, requestSession, { defer: true })
  );

  createEffect(
    on(
      () => [
        props.isDark,
        props.isEnhanced,
        props.isAnimated,
        props.zoomFactor,
        props.tab?.title,
      ],
      publishTarget,
      { defer: true }
    )
  );

  onMount(() => {
    window.addEventListener("message", onFrameMessage);
    window.addEventListener("resize", scheduleLayout);
    const card = props.element.shadowRoot?.querySelector(".card");
    if (card) resizeObserver.observe(card);
    requestSession();
  });

  onCleanup(() => {
    disposed = true;
    if (layoutFrame !== undefined) cancelAnimationFrame(layoutFrame);
    window.removeEventListener("message", onFrameMessage);
    window.removeEventListener("resize", scheduleLayout);
    resizeObserver.disconnect();
    clearPreview();
    token = undefined;
    sessionRefreshRequested = false;
  });

  return (
    <iframe
      ref={frame!}
      class="tab-preview"
      classList={{
        "tab-preview_dark": props.isDark,
        "tab-preview_enhanced": props.isEnhanced,
        "tab-preview_animated": props.isAnimated,
      }}
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
    if (disposed) return;
    if (sessionPending) {
      sessionRefreshRequested = true;
      token = undefined;
      clearPreview();
      return;
    }
    sessionPending = true;
    token = undefined;
    clearPreview();
    void sendMessageAndGetResponse(openTabPreview())
      .then(
        (session) => {
          if (disposed || sessionRefreshRequested) return;
          token = session;
          sessionOpenedAt = Date.now();
          publishTarget();
        },
        () => clearPreview()
      )
      .finally(() => {
        sessionPending = false;
        if (sessionRefreshRequested && !disposed) {
          sessionRefreshRequested = false;
          requestSession();
        }
      });
  }

  function clearPreview() {
    previewState = "none";
    requestId += 1;
    if (!frame) return;
    setShown(false);
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
      previewState = "none";
      setShown(false);
      ready = true;
      publishTarget();
    } else if (
      event.data.type === "preview-state" &&
      event.data.requestId === requestId &&
      event.data.tabId === props.tab?.id &&
      ["none", "empty", "image"].includes(event.data.state)
    ) {
      previewState = event.data.state;
      const ratio = event.data.aspectRatio;
      if (
        previewState === "image" &&
        typeof ratio === "number" &&
        Number.isFinite(ratio) &&
        ratio > 0
      ) {
        // Clamp unusual window shapes so the frame never becomes a sliver.
        aspectRatio = Math.max(1, Math.min(ratio, 2.4));
      }
      if (previewState === "none") {
        setShown(false);
      } else {
        scheduleLayout();
      }
    }
  }

  function publishTarget() {
    const tab = props.tab;
    if (disposed || !ready || !token || tab?.id === undefined) return;
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
      animated: props.isAnimated,
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

  function setShown(value: boolean) {
    isShown = value;
    frame?.classList.toggle("tab-preview_visible", value);
  }

  /** Fits the snapshot ratio inside the given bounds, including frame chrome. */
  function fitSize(maxWidth: number, maxHeight: number, unit: number): ISize {
    const chrome = FRAME_CHROME * unit;
    let width = maxWidth;
    let height = (width - chrome) / aspectRatio + chrome;
    if (height > maxHeight) {
      height = maxHeight;
      width = (height - chrome) * aspectRatio + chrome;
    }
    return { width, height };
  }

  function positionPreview() {
    if (
      disposed ||
      !frame ||
      !ready ||
      !token ||
      previewState === "none" ||
      props.tab?.id === undefined
    )
      return;
    const card = props.element.shadowRoot?.querySelector(".card");
    if (!card) return;
    const rect = card.getBoundingClientRect();
    const unit = 1 / props.zoomFactor;
    const margin = 20 * unit;
    const gap = 14 * unit;
    const minWidth = 260 * unit;
    const preferredWidth = Math.max(
      300 * unit,
      Math.min(rect.width * 1.3, 560 * unit)
    );
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const rightSpace = viewportWidth - margin - rect.right - gap;
    const leftSpace = rect.left - gap - margin;
    const clamp = (value: number, max: number) =>
      Math.max(margin, Math.min(value, max));
    let left: number;
    let top: number;
    let transformOrigin: string;
    const sideSpace = Math.max(rightSpace, leftSpace);
    let size = fitSize(
      Math.min(preferredWidth, sideSpace),
      viewportHeight - 2 * margin,
      unit
    );
    if (sideSpace >= minWidth && size.width >= minWidth) {
      const onRight = rightSpace >= size.width || rightSpace >= leftSpace;
      left = onRight ? rect.right + gap : rect.left - gap - size.width;
      // Align with the card instead of the selected row so arrow-key
      // navigation does not make the preview jump around.
      top = clamp(
        rect.top + (rect.height - size.height) / 2,
        viewportHeight - margin - size.height
      );
      transformOrigin = onRight ? "left center" : "right center";
    } else {
      const below = viewportHeight - margin - rect.bottom - gap;
      const above = rect.top - gap - margin;
      const atBottom = below >= above;
      size = fitSize(
        Math.min(preferredWidth, viewportWidth - 2 * margin),
        Math.max(below, above),
        unit
      );
      if (size.width < minWidth || size.height < 140 * unit) {
        setShown(false);
        return;
      }
      left = clamp(
        rect.left + (rect.width - size.width) / 2,
        viewportWidth - margin - size.width
      );
      top = atBottom ? rect.bottom + gap : rect.top - gap - size.height;
      transformOrigin = atBottom ? "center top" : "center bottom";
    }
    if (!isShown) {
      // Jump to the new geometry before fading in rather than sliding there.
      frame.style.transition = "none";
    }
    frame.style.transformOrigin = transformOrigin;
    frame.style.left = `${left}px`;
    frame.style.top = `${top}px`;
    frame.style.width = `${size.width}px`;
    frame.style.height = `${size.height}px`;
    if (!isShown) {
      void frame.offsetWidth;
      frame.style.removeProperty("transition");
    }
    setShown(true);
  }
}
