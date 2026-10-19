import { log } from "../utils/logger";

const CACHE_KEY = "tabPreviewCache";
const SESSIONS_KEY = "tabPreviewSessions";
const USAGE_KEY = "tabPreviewUsage";
const MAX_PREVIEWS = 30;
const MAX_CACHE_BYTES = 10_000_000;
// Leave space for the registry and other session state below Chrome's 10 MiB quota.
const SESSION_STORAGE_BUDGET = 9_000_000;
const CAPTURE_DELAY = 650;
const CAPTURE_INTERVAL = 1100;
const SAME_PAGE_INTERVAL = 10_000;
const SESSION_DURATION = 30 * 60 * 1000;

export interface ITabPreview {
  dataUrl: string;
  width: number;
  height: number;
  capturedAt: number;
}

interface ICachedPreview extends ITabPreview {
  tabId: number;
  url: string;
  lastUsed: number;
}

interface IPreviewSession {
  token: string;
  ownerTabId: number;
  ownerUrl: string;
  tabIds: number[];
  expiresAt: number;
}

let initialized = false;
let enabled = false;
let requestedEnabled = false;
let available = false;
let epoch = 0;
let settingsRevision = 0;
let captureRevision = 0;
let lastCapture = 0;
let capturing = false;
let captureTimer: ReturnType<typeof setTimeout> | undefined;
let pendingWindowId: number | undefined;
let queue: Promise<unknown> = Promise.resolve();
const previews = new Map<number, ICachedPreview>();
const sessions = new Map<string, IPreviewSession>();
const shownOwners = new Set<number>();
const restoredOwners = new Set<number>();
const visibilityRevisions = new Map<number, number>();

/** Register immediately, before any asynchronous background initialization. */
export function initTabPreviews(): void {
  if (initialized) return;
  initialized = true;
  queue = loadState();

  chrome.tabs.onActivated.addListener(({ windowId }) => {
    captureRevision += 1;
    scheduleCapture(windowId);
  });
  chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
    // Memory Saver discards the document, not the open tab or its last snapshot.
    if (change.url || change.status === "loading") {
      invalidateTab(tabId);
    }
    if (tab.active && (change.url || change.status === "complete")) {
      scheduleCapture(tab.windowId);
    }
  });
  chrome.tabs.onRemoved.addListener((tabId) => invalidateTab(tabId, true));
  chrome.tabs.onReplaced.addListener((addedId, removedId) => {
    invalidateTab(removedId, true);
    void chrome.tabs.get(addedId).then(
      (tab) => {
        if (tab.active) scheduleCapture(tab.windowId);
      },
      () => undefined
    );
  });
  chrome.windows.onFocusChanged.addListener((windowId) => {
    captureRevision += 1;
    if (captureTimer !== undefined) clearTimeout(captureTimer);
    if (windowId !== chrome.windows.WINDOW_ID_NONE) scheduleCapture(windowId);
  });
  chrome.permissions.onRemoved.addListener(() => {
    void hasPermission().then((granted) => {
      if (!granted) void setTabPreviewsEnabled(false);
    });
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) {
      void setTabPreviewsEnabled(
        changes.settings.newValue?.isTabPreviewEnabled === true
      );
    }
  });
}

export async function setTabPreviewsEnabled(value: boolean): Promise<void> {
  requestedEnabled = value;
  const revision = ++settingsRevision;
  if (!value) {
    enabled = false;
    epoch += 1;
    captureRevision += 1;
    if (captureTimer !== undefined) clearTimeout(captureTimer);
    await serialize(async () => {
      for (const ownerTabId of restoredOwners) shownOwners.delete(ownerTabId);
      restoredOwners.clear();
      previews.clear();
      sessions.clear();
      if (available) {
        await chrome.storage.session.remove([
          CACHE_KEY,
          SESSIONS_KEY,
          USAGE_KEY,
        ]);
      }
    });
    return;
  }
  const granted = await hasPermission();
  if (revision !== settingsRevision) return;
  enabled = granted;
  if (!enabled) {
    await setTabPreviewsEnabled(false);
    return;
  }
  scheduleCapture();
}

/** Must precede mounting the content popup, so it cannot enter a screenshot. */
export function notifyPreviewPopupShown(ownerTabId: number): void {
  visibilityRevisions.set(
    ownerTabId,
    (visibilityRevisions.get(ownerTabId) || 0) + 1
  );
  restoredOwners.delete(ownerTabId);
  shownOwners.add(ownerTabId);
  captureRevision += 1;
  void serialize(async () => {
    removeExpiredSessions();
  });
}

export function notifyPreviewPopupHidden(ownerTabId: number): void {
  const revision = (visibilityRevisions.get(ownerTabId) || 0) + 1;
  visibilityRevisions.set(ownerTabId, revision);
  restoredOwners.delete(ownerTabId);
  shownOwners.delete(ownerTabId);
  captureRevision += 1;
  void serialize(async () => {
    // Loading a persisted session may have completed after the synchronous close.
    // Do not erase a newer Show when the popup was reopened before this task ran.
    if (visibilityRevisions.get(ownerTabId) === revision) {
      restoredOwners.delete(ownerTabId);
      shownOwners.delete(ownerTabId);
    }
    if (removeOwnerSessions(ownerTabId)) await saveSessions();
  });
  void chrome.tabs.get(ownerTabId).then(
    (tab) => {
      if (tab.active) scheduleCapture(tab.windowId);
    },
    () => undefined
  );
}

/** Only the trusted extension preview frame receives this secret via messaging. */
export function openTabPreviewSession(
  ownerTabId: number,
  allowedTabIds: number[]
): Promise<string | undefined> {
  return serialize(async () => {
    if (
      !enabled ||
      !available ||
      !shownOwners.has(ownerTabId) ||
      !(await hasPermission())
    )
      return;
    const currentEpoch = epoch;
    const revision = captureRevision;
    const owner = await getTab(ownerTabId);
    if (
      !isLivePreviewable(owner) ||
      !shownOwners.has(ownerTabId) ||
      !isCurrentCapture(revision, currentEpoch)
    )
      return;
    removeExpiredSessions();
    removeOwnerSessions(ownerTabId);
    const token = crypto.randomUUID();
    sessions.set(token, {
      token,
      ownerTabId,
      ownerUrl: owner.url!,
      tabIds: [
        ...new Set(
          allowedTabIds.filter((id) => Number.isInteger(id) && id >= 0)
        ),
      ],
      expiresAt: Date.now() + SESSION_DURATION,
    });
    await saveSessions();
    return token;
  });
}

export function readTabPreview(
  token: string,
  tabId: number,
  ownerTabId: number
): Promise<ITabPreview | undefined> {
  return serialize(async () => {
    const session = sessions.get(token);
    if (
      !enabled ||
      !session ||
      session.ownerTabId !== ownerTabId ||
      session.expiresAt < Date.now() ||
      !session.tabIds.includes(tabId) ||
      !(await hasPermission())
    )
      return;
    const currentEpoch = epoch;
    const revision = captureRevision;
    const [owner, tab, stored] = await Promise.all([
      getTab(session.ownerTabId),
      getTab(tabId),
      chrome.storage.local.get("settings"),
    ]);
    const preview = previews.get(tabId);
    if (
      !isCurrentCapture(revision, currentEpoch) ||
      !isLivePreviewable(owner) ||
      owner.url !== session.ownerUrl ||
      !isPreviewable(tab) ||
      !preview ||
      preview.url !== tab.url ||
      (stored.settings?.isShowingTabsFromAllWindows === false &&
        owner.windowId !== tab.windowId)
    )
      return;
    preview.lastUsed = Date.now();
    session.expiresAt = Date.now() + SESSION_DURATION;
    // Persist access metadata and token renewal without rewriting screenshots.
    try {
      await saveAccessState();
    } catch (error) {
      log("[Tab preview access persistence unavailable]", String(error));
    }
    if (!isCurrentCapture(revision, currentEpoch)) return;
    // Never expose the cache's URL, owner, or other tabs to the embedding page.
    return {
      dataUrl: preview.dataUrl,
      width: preview.width,
      height: preview.height,
      capturedAt: preview.capturedAt,
    };
  });
}

/** Only availability IDs enter the popup model; image data stays in the trusted frame. */
export function getAvailableTabPreviewIds(
  tabs: chrome.tabs.Tab[]
): Promise<number[]> {
  return serialize(async () => {
    const currentEpoch = epoch;
    if (
      !enabled ||
      !available ||
      !(await hasPermission()) ||
      currentEpoch !== epoch
    )
      return [];
    return tabs
      .filter((tab) => {
        if (!isPreviewable(tab)) return false;
        const preview = previews.get(tab.id!);
        return preview?.url === tab.url;
      })
      .map((tab) => tab.id!);
  });
}

function serialize<T>(action: () => Promise<T>): Promise<T> {
  const result = queue.then(action);
  queue = result.catch((error) => {
    log("[Tab preview storage unavailable]", String(error));
  });
  return result;
}

async function loadState(): Promise<void> {
  try {
    const revision = settingsRevision;
    const [stored, live, local, granted] = await Promise.all([
      chrome.storage.session.get([CACHE_KEY, SESSIONS_KEY, USAGE_KEY]),
      chrome.tabs.query({}),
      chrome.storage.local.get("settings"),
      hasPermission(),
    ]);
    let loadRevision = revision;
    let loadDesired = local.settings?.isTabPreviewEnabled === true;
    let loadGranted = granted;
    // A pending enable must not be mistaken for an explicit disable at startup.
    // Recheck permissions too: the initial snapshot may predate a new grant.
    while (loadRevision !== settingsRevision) {
      loadRevision = settingsRevision;
      loadDesired = requestedEnabled;
      loadGranted = loadDesired && (await hasPermission());
    }
    enabled = loadDesired && loadGranted;
    available = true;
    if (!enabled) {
      await chrome.storage.session.remove([CACHE_KEY, SESSIONS_KEY, USAGE_KEY]);
      return;
    }
    const openTabs = new Map(live.map((tab) => [tab.id, tab]));
    for (const entry of (stored[CACHE_KEY] || []) as ICachedPreview[]) {
      const tab = openTabs.get(entry.tabId);
      if (
        isPreviewable(tab) &&
        tab.url === entry.url &&
        typeof entry.dataUrl === "string" &&
        entry.dataUrl.startsWith("data:image/jpeg;base64,") &&
        Number.isFinite(entry.capturedAt) &&
        Number.isFinite(entry.lastUsed) &&
        entry.width > 0 &&
        entry.height > 0
      ) {
        const lastUsed = stored[USAGE_KEY]?.[entry.tabId];
        if (Number.isFinite(lastUsed))
          entry.lastUsed = Math.max(entry.lastUsed, lastUsed);
        previews.set(entry.tabId, entry);
      }
    }
    for (const session of (stored[SESSIONS_KEY] || []) as IPreviewSession[]) {
      if (
        typeof session.token === "string" &&
        Array.isArray(session.tabIds) &&
        session.expiresAt > Date.now() &&
        isLivePreviewable(openTabs.get(session.ownerTabId)) &&
        openTabs.get(session.ownerTabId)?.url === session.ownerUrl
      ) {
        sessions.set(session.token, session);
        if (!visibilityRevisions.has(session.ownerTabId)) {
          shownOwners.add(session.ownerTabId);
          restoredOwners.add(session.ownerTabId);
        }
      }
    }
    await saveCache();
    await saveSessions();
    scheduleCapture();
  } catch (error) {
    available = false;
    previews.clear();
    sessions.clear();
    log("[Tab preview session storage unavailable]", String(error));
  }
}

function invalidateTab(tabId: number, closing = false): void {
  // Invalidate captures before the asynchronous cache deletion is processed.
  captureRevision += 1;
  // An in-document navigation can leave the popup mounted until its close event.
  if (closing) {
    visibilityRevisions.set(tabId, (visibilityRevisions.get(tabId) || 0) + 1);
    restoredOwners.delete(tabId);
    shownOwners.delete(tabId);
  }
  if (!enabled && available && previews.size === 0 && sessions.size === 0)
    return;
  void serialize(async () => {
    const removed = previews.delete(tabId);
    let changed = removeOwnerSessions(tabId);
    if (closing) {
      for (const session of sessions.values()) {
        if (session.tabIds.includes(tabId)) changed = true;
        session.tabIds = session.tabIds.filter((id) => id !== tabId);
      }
    }
    if (removed) await saveCache();
    if (changed) await saveSessions();
  });
}

function removeOwnerSessions(ownerTabId: number): boolean {
  let changed = false;
  for (const [token, session] of sessions) {
    if (session.ownerTabId === ownerTabId) {
      sessions.delete(token);
      changed = true;
    }
  }
  if (restoredOwners.delete(ownerTabId)) shownOwners.delete(ownerTabId);
  return changed;
}

function removeExpiredSessions(): void {
  for (const [token, session] of sessions) {
    if (session.expiresAt < Date.now()) {
      sessions.delete(token);
      if (restoredOwners.delete(session.ownerTabId)) {
        shownOwners.delete(session.ownerTabId);
      }
    }
  }
}

async function saveSessions(): Promise<void> {
  if (available) {
    await chrome.storage.session.set({
      [SESSIONS_KEY]: [...sessions.values()],
    });
  }
}

async function saveCache(): Promise<void> {
  if (!available) return;
  const [allBytes, ownBytes] = await Promise.all([
    chrome.storage.session.getBytesInUse(null),
    chrome.storage.session.getBytesInUse(CACHE_KEY),
  ]);
  const budget = Math.max(
    0,
    Math.min(MAX_CACHE_BYTES, SESSION_STORAGE_BUDGET - allBytes + ownBytes)
  );
  const entries = [...previews.values()].sort(
    (a, b) => b.lastUsed - a.lastUsed
  );
  previews.clear();
  let bytes = 0;
  for (const entry of entries) {
    // Account conservatively for both the stored and in-memory encoded string.
    const entryBytes = entry.dataUrl.length * 2 + entry.url.length * 2 + 1024;
    if (previews.size < MAX_PREVIEWS && bytes + entryBytes <= budget) {
      previews.set(entry.tabId, entry);
      bytes += entryBytes;
    }
  }
  await chrome.storage.session.set({
    [CACHE_KEY]: [...previews.values()],
    [USAGE_KEY]: getUsage(),
  });
}

function getUsage(): Record<string, number> {
  return Object.fromEntries(
    [...previews.values()].map((entry) => [entry.tabId, entry.lastUsed])
  );
}

async function saveAccessState(): Promise<void> {
  if (available) {
    await chrome.storage.session.set({
      [USAGE_KEY]: getUsage(),
      [SESSIONS_KEY]: [...sessions.values()],
    });
  }
}

function scheduleCapture(windowId?: number): void {
  if (!enabled) return;
  pendingWindowId = windowId;
  if (captureTimer !== undefined) clearTimeout(captureTimer);
  captureTimer = setTimeout(() => {
    captureTimer = undefined;
    void captureCurrentTab(pendingWindowId);
  }, Math.max(CAPTURE_DELAY, lastCapture + CAPTURE_INTERVAL - Date.now()));
}

async function captureCurrentTab(windowId?: number): Promise<void> {
  await queue;
  if (!enabled || !available) return;
  if (capturing) {
    scheduleCapture(windowId);
    return;
  }
  capturing = true;
  const revision = captureRevision;
  const currentEpoch = epoch;
  try {
    if (!(await hasPermission())) return;
    const window =
      windowId === undefined
        ? await chrome.windows.getLastFocused()
        : await chrome.windows.get(windowId);
    if (!window.focused || window.id === undefined) return;
    const [tab] = await chrome.tabs.query({
      active: true,
      windowId: window.id,
    });
    if (!isLivePreviewable(tab) || tab.status !== "complete") return;
    if (shownOwners.has(tab.id!)) return;
    const existing = previews.get(tab.id!);
    if (
      existing &&
      existing.url === tab.url &&
      Date.now() - existing.capturedAt < SAME_PAGE_INTERVAL
    )
      return;
    if (Date.now() - lastCapture < CAPTURE_INTERVAL) {
      scheduleCapture(window.id);
      return;
    }
    if (!isCurrentCapture(revision, currentEpoch)) return;
    lastCapture = Date.now();
    const screenshot = await chrome.tabs.captureVisibleTab(window.id, {
      // Capture near-lossless; the single lossy encode happens after resizing.
      format: "jpeg",
      quality: 92,
    });
    if (!isCurrentCapture(revision, currentEpoch)) return;
    const preview = await resizeScreenshot(screenshot);
    const [latestTab, latestWindow] = await Promise.all([
      getTab(tab.id!),
      chrome.windows.get(window.id),
    ]);
    if (
      !isCurrentCapture(revision, currentEpoch) ||
      !isLivePreviewable(latestTab) ||
      !latestTab.active ||
      latestTab.url !== tab.url ||
      latestTab.windowId !== tab.windowId ||
      !latestWindow.focused ||
      shownOwners.has(tab.id!)
    )
      return;
    await serialize(async () => {
      if (!isCurrentCapture(revision, currentEpoch)) return;
      previews.set(tab.id!, {
        ...preview,
        tabId: tab.id!,
        url: tab.url!,
        capturedAt: Date.now(),
        lastUsed: Date.now(),
      });
      await saveCache();
    });
  } catch (error) {
    // Closing/navigation and browser UI restrictions can invalidate a capture.
    log("[Tab preview capture skipped]", String(error));
  } finally {
    capturing = false;
  }
}

function isCurrentCapture(revision: number, currentEpoch: number): boolean {
  return enabled && revision === captureRevision && currentEpoch === epoch;
}

/** Cached snapshots remain readable while their unchanged tab is discarded. */
function isPreviewable(tab?: chrome.tabs.Tab): tab is chrome.tabs.Tab {
  return (
    !!tab &&
    Number.isInteger(tab.id) &&
    !tab.incognito &&
    typeof tab.url === "string" &&
    /^https?:\/\//.test(tab.url)
  );
}

function isLivePreviewable(tab?: chrome.tabs.Tab): tab is chrome.tabs.Tab {
  return isPreviewable(tab) && !tab.discarded;
}

async function getTab(tabId: number): Promise<chrome.tabs.Tab | undefined> {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return undefined;
  }
}

function hasPermission(): Promise<boolean> {
  return chrome.permissions
    .contains({ origins: ["<all_urls>"] })
    .catch(() => false);
}

async function resizeScreenshot(
  dataUrl: string
): Promise<Omit<ITabPreview, "capturedAt">> {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  try {
    const ratio = Math.min(1, 1040 / bitmap.width, 780 / bitmap.height);
    const width = Math.max(1, Math.round(bitmap.width * ratio));
    const height = Math.max(1, Math.round(bitmap.height * ratio));
    // The project's DOM typings predate OffscreenCanvas.convertToBlob.
    const canvas = new OffscreenCanvas(width, height) as OffscreenCanvas & {
      convertToBlob(options: { type: string; quality: number }): Promise<Blob>;
    };
    const context = canvas.getContext(
      "2d"
    ) as OffscreenCanvasRenderingContext2D | null;
    if (!context) throw new Error("Screenshot resizing is unavailable");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, width, height);
    const resized = await canvas.convertToBlob({
      type: "image/jpeg",
      quality: 0.8,
    });
    const bytes = new Uint8Array(await resized.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return { dataUrl: `data:image/jpeg;base64,${btoa(binary)}`, width, height };
  } finally {
    bitmap.close();
  }
}
