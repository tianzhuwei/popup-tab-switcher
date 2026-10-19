import styles from "./preview.scss";
import { getTabPreview, sendMessageAndGetResponse } from "../utils/messages";

interface IPreviewTarget {
  channel: string;
  requestId: number;
  token: string;
  tabId: number;
  title: string;
  url: string;
  dark: boolean;
  enhanced: boolean;
  zoomFactor: number;
  animated: boolean;
}

/** "none" hides the frame, "empty" shows a placeholder, "image" a snapshot. */
type IPreviewState = "none" | "empty" | "image";

const CHANNEL = "popup-tab-switcher-preview";
const FADE_DURATION = 180;
const style = document.createElement("style");
style.textContent = styles;
document.head.appendChild(style);

const stage = document.querySelector<HTMLDivElement>(".preview__stage")!;
const placeholder = document.querySelector<HTMLDivElement>(
  ".preview__placeholder"
)!;
const placeholderIcon = document.querySelector<HTMLImageElement>(
  ".preview__placeholderIcon"
)!;
const placeholderDomain = document.querySelector<HTMLDivElement>(
  ".preview__placeholderDomain"
)!;
const meta = document.querySelector<HTMLElement>(".preview__meta")!;
const metaFavicon =
  document.querySelector<HTMLImageElement>(".preview__favicon")!;
const metaDomain = document.querySelector<HTMLSpanElement>(".preview__domain")!;
const metaTime = document.querySelector<HTMLSpanElement>(".preview__time")!;
let requestRevision = 0;
let isDisabled = false;
let isLoading = false;
let state: IPreviewState = "none";
let aspectRatio: number | undefined;
let currentTarget: IPreviewTarget | undefined;

function publishState() {
  if (!currentTarget) {
    return;
  }
  window.parent.postMessage(
    {
      channel: CHANNEL,
      type: "preview-state",
      requestId: currentTarget.requestId,
      tabId: currentTarget.tabId,
      state,
      aspectRatio,
    },
    "*"
  );
}

function getImages() {
  return Array.from(
    stage.querySelectorAll<HTMLImageElement>(".preview__image")
  );
}

function removeImages(images: HTMLImageElement[], animated: boolean) {
  if (!animated) {
    images.forEach((image) => image.remove());
    return;
  }
  images.forEach((image) => image.classList.add("preview__image_leaving"));
  window.setTimeout(
    () => images.forEach((image) => image.remove()),
    FADE_DURATION
  );
}

function resetContent() {
  removeImages(getImages(), false);
  placeholder.hidden = true;
  meta.hidden = true;
}

function invalidate() {
  requestRevision += 1;
  isLoading = false;
}

function clearPreview() {
  invalidate();
  resetContent();
  state = "none";
  aspectRatio = undefined;
  publishState();
  currentTarget = undefined;
}

function getDomain(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function getFaviconUrl(pageUrl: string) {
  const faviconUrl = new URL(chrome.runtime.getURL("/_favicon/"));
  faviconUrl.searchParams.set("pageUrl", pageUrl);
  faviconUrl.searchParams.set("size", "64");
  return faviconUrl.href;
}

function formatCapturedAt(capturedAt: number) {
  const seconds = Math.max(0, (Date.now() - capturedAt) / 1000);
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function showEmpty(target: IPreviewTarget) {
  removeImages(getImages(), target.animated);
  meta.hidden = true;
  placeholderIcon.src = getFaviconUrl(target.url);
  placeholderDomain.textContent = getDomain(target.url) || target.title;
  placeholder.hidden = false;
  state = "empty";
  publishState();
}

function showImage(
  target: IPreviewTarget,
  nextImage: HTMLImageElement,
  capturedAt: number
) {
  const previous = getImages();
  placeholder.hidden = true;
  metaFavicon.src = getFaviconUrl(target.url);
  metaDomain.textContent = getDomain(target.url);
  metaTime.textContent = formatCapturedAt(capturedAt);
  meta.hidden = false;
  if (target.animated && previous.length > 0) {
    // Cross-fade over the previous snapshot instead of flashing an empty frame.
    nextImage.classList.add("preview__image_entering");
    stage.appendChild(nextImage);
    void nextImage.offsetWidth;
    nextImage.classList.remove("preview__image_entering");
    removeImages(previous, true);
  } else {
    removeImages(previous, false);
    stage.appendChild(nextImage);
  }
  aspectRatio = nextImage.naturalWidth / nextImage.naturalHeight;
  state = "image";
  publishState();
}

function isPreviewTarget(data: unknown): data is IPreviewTarget {
  if (typeof data !== "object" || data === null) {
    return false;
  }
  const target = data as Partial<IPreviewTarget>;
  return (
    target.channel === CHANNEL &&
    typeof target.requestId === "number" &&
    Number.isSafeInteger(target.requestId) &&
    target.requestId > 0 &&
    typeof target.token === "string" &&
    target.token.length > 0 &&
    typeof target.tabId === "number" &&
    Number.isSafeInteger(target.tabId) &&
    target.tabId >= 0 &&
    typeof target.title === "string" &&
    typeof target.url === "string" &&
    typeof target.dark === "boolean" &&
    typeof target.enhanced === "boolean" &&
    typeof target.animated === "boolean" &&
    typeof target.zoomFactor === "number" &&
    Number.isFinite(target.zoomFactor) &&
    target.zoomFactor > 0
  );
}

async function showPreview(target: IPreviewTarget) {
  const isSameDocument =
    currentTarget?.token === target.token &&
    currentTarget.tabId === target.tabId &&
    currentTarget.url === target.url;
  currentTarget = target;
  document.documentElement.classList.toggle("dark", target.dark);
  document.documentElement.classList.toggle("enhanced", target.enhanced);
  document.documentElement.style.setProperty(
    "--preview-unit",
    `${1 / target.zoomFactor}px`
  );
  if (isSameDocument && (state !== "none" || isLoading)) {
    if (!isLoading) publishState();
    return;
  }
  // Keep the previous content visible until the next one is ready.
  invalidate();
  const revision = requestRevision;
  isLoading = true;

  try {
    const preview = await sendMessageAndGetResponse(
      getTabPreview(target.token, target.tabId)
    );
    if (revision !== requestRevision || isDisabled) {
      return;
    }
    if (
      !preview ||
      typeof preview.dataUrl !== "string" ||
      !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(preview.dataUrl)
    ) {
      showEmpty(target);
      return;
    }

    // Decode separately so a previous target cannot deliver a late image event.
    const nextImage = new Image();
    nextImage.className = "preview__image";
    nextImage.alt = "Selected tab screenshot";
    nextImage.src = preview.dataUrl;
    await nextImage.decode();
    if (revision !== requestRevision || isDisabled) {
      return;
    }
    if (nextImage.naturalWidth <= 0 || nextImage.naturalHeight <= 0) {
      showEmpty(target);
      return;
    }
    showImage(target, nextImage, preview.capturedAt);
  } catch {
    if (revision === requestRevision && !isDisabled) {
      showEmpty(target);
    }
  } finally {
    if (revision === requestRevision) {
      isLoading = false;
    }
  }
}

function onParentMessage(event: MessageEvent<unknown>) {
  if (event.source !== window.parent || window.parent === window) {
    return;
  }
  const data = event.data;
  const message = data as { channel?: unknown; type?: unknown } | null;
  if (
    typeof data === "object" &&
    data !== null &&
    message?.channel === CHANNEL &&
    message.type === "clear"
  ) {
    clearPreview();
    return;
  }
  if (message?.channel !== CHANNEL) {
    return;
  }
  if (!isDisabled && isPreviewTarget(data)) {
    void showPreview(data);
  } else {
    clearPreview();
  }
}

function onSettingsChanged(
  changes: { [key: string]: chrome.storage.StorageChange },
  area: string
) {
  if (area !== "local" || !changes.settings) {
    return;
  }
  isDisabled = changes.settings.newValue?.isTabPreviewEnabled !== true;
  if (isDisabled) {
    clearPreview();
  }
}

function onPermissionsRemoved(permissions: chrome.permissions.Permissions) {
  if (permissions.origins?.length) {
    clearPreview();
  }
}

function onTabRemoved(tabId: number) {
  if (tabId === currentTarget?.tabId) {
    clearPreview();
  }
}

function onTabUpdated(tabId: number, change: chrome.tabs.TabChangeInfo) {
  if (
    currentTarget &&
    tabId === currentTarget.tabId &&
    (change.status === "loading" || typeof change.url === "string")
  ) {
    // A navigation invalidates the cached document, including same-URL reloads.
    invalidate();
    showEmpty(currentTarget);
  }
}

function dispose() {
  clearPreview();
  window.removeEventListener("message", onParentMessage);
  window.removeEventListener("pagehide", dispose);
  chrome.storage.onChanged.removeListener(onSettingsChanged);
  // @types/chrome 0.0.235 omits removeListener, though Chrome provides it.
  (
    chrome.permissions.onRemoved as chrome.events.Event<
      typeof onPermissionsRemoved
    >
  ).removeListener(onPermissionsRemoved);
  chrome.tabs.onRemoved.removeListener(onTabRemoved);
  chrome.tabs.onUpdated.removeListener(onTabUpdated);
}

placeholderIcon.addEventListener("error", () => {
  placeholderIcon.removeAttribute("src");
});
metaFavicon.addEventListener("error", () => {
  metaFavicon.removeAttribute("src");
});
window.addEventListener("message", onParentMessage);
window.addEventListener("pagehide", dispose);
chrome.storage.onChanged.addListener(onSettingsChanged);
chrome.permissions.onRemoved.addListener(onPermissionsRemoved);
chrome.tabs.onRemoved.addListener(onTabRemoved);
chrome.tabs.onUpdated.addListener(onTabUpdated);
window.parent.postMessage({ channel: CHANNEL, type: "ready" }, "*");
