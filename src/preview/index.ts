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
}

const CHANNEL = "popup-tab-switcher-preview";
const style = document.createElement("style");
style.textContent = styles;
document.head.appendChild(style);

const title = document.querySelector<HTMLDivElement>(".preview__title")!;
const url = document.querySelector<HTMLDivElement>(".preview__url")!;
let image = document.querySelector<HTMLImageElement>(".preview__image")!;
let requestRevision = 0;
let isDisabled = false;
let isLoading = false;
let isAvailable = false;
let currentTarget: IPreviewTarget | undefined;

function publishAvailability() {
  if (!currentTarget) {
    return;
  }
  window.parent.postMessage(
    {
      channel: CHANNEL,
      type: "preview-state",
      requestId: currentTarget.requestId,
      tabId: currentTarget.tabId,
      available: isAvailable,
    },
    "*"
  );
}

function clearImage() {
  requestRevision += 1;
  isLoading = false;
  isAvailable = false;
  image.hidden = true;
  image.removeAttribute("src");
  publishAvailability();
}

function clearPreview() {
  clearImage();
  currentTarget = undefined;
  title.textContent = "";
  title.removeAttribute("title");
  url.textContent = "";
  url.removeAttribute("title");
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
  title.textContent = target.title || "Untitled tab";
  title.title = target.title;
  url.textContent = target.url;
  url.title = target.url;
  if (isSameDocument) {
    publishAvailability();
    if (isAvailable || isLoading) {
      return;
    }
  }
  clearImage();
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
      return;
    }

    // Decode separately so a previous target cannot deliver a late image event.
    const nextImage = new Image();
    nextImage.className = "preview__image";
    nextImage.alt = image.alt;
    nextImage.src = preview.dataUrl;
    await nextImage.decode();
    if (
      revision !== requestRevision ||
      isDisabled ||
      nextImage.naturalWidth <= 0 ||
      nextImage.naturalHeight <= 0
    ) {
      return;
    }

    image.replaceWith(nextImage);
    image = nextImage;
    isAvailable = true;
    publishAvailability();
  } catch {
    if (revision === requestRevision) {
      clearImage();
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
    tabId === currentTarget?.tabId &&
    (change.status === "loading" || typeof change.url === "string")
  ) {
    // A navigation invalidates the cached document, including same-URL reloads.
    clearImage();
  }
}

function dispose() {
  clearPreview();
  window.removeEventListener("message", onParentMessage);
  window.removeEventListener("pagehide", dispose);
  chrome.storage.onChanged.removeListener(onSettingsChanged);
  chrome.permissions.onRemoved.removeListener(onPermissionsRemoved);
  chrome.tabs.onRemoved.removeListener(onTabRemoved);
  chrome.tabs.onUpdated.removeListener(onTabUpdated);
}

window.addEventListener("message", onParentMessage);
window.addEventListener("pagehide", dispose);
chrome.storage.onChanged.addListener(onSettingsChanged);
chrome.permissions.onRemoved.addListener(onPermissionsRemoved);
chrome.tabs.onRemoved.addListener(onTabRemoved);
chrome.tabs.onUpdated.addListener(onTabUpdated);
window.parent.postMessage({ channel: CHANNEL, type: "ready" }, "*");
