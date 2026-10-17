import { ServiceFactory } from "../service-factory";
import { log } from "../utils/logger";

const SCRIPT_ID = "blank-double-click-close";
const ORIGINS = ["http://*/*", "https://*/*"];
let pendingSync = Promise.resolve();

export function initBlankCloseGesture(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (
      area === "local" &&
      changes.settings &&
      changes.settings.oldValue?.isDoubleClickClosingTab !==
        changes.settings.newValue?.isDoubleClickClosingTab
    ) {
      scheduleSync(true);
    }
  });
  chrome.permissions.onRemoved.addListener(() => scheduleSync());
  chrome.runtime.onInstalled.addListener(() => scheduleSync(true));
  scheduleSync();
}

function scheduleSync(injectOpenTabs = false): void {
  // A later disable must finish after an in-flight enable/registration.
  pendingSync = pendingSync
    .then(() => syncScript(injectOpenTabs))
    .catch((error) => {
      log("[Blank close registration failed]", error);
    });
}

async function syncScript(injectOpenTabs: boolean): Promise<void> {
  const [stored, permitted, registered] = await Promise.all([
    chrome.storage.local.get("settings"),
    chrome.permissions.contains({ origins: ORIGINS }),
    chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] }),
  ]);
  const enabled = stored.settings?.isDoubleClickClosingTab === true;
  if (!enabled || !permitted) {
    if (registered.length) {
      await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
    }
    if (enabled && !permitted) {
      const settings = await ServiceFactory.getSettings();
      await settings.update({ isDoubleClickClosingTab: false });
    }
    return;
  }
  if (!registered.length) {
    await chrome.scripting.registerContentScripts([
      {
        id: SCRIPT_ID,
        matches: ORIGINS,
        js: ["blank-close.js"],
        runAt: "document_idle",
        allFrames: false,
        persistAcrossSessions: true,
      },
    ]);
  }
  if (injectOpenTabs || !registered.length) {
    const tabs = await chrome.tabs.query({ url: ORIGINS });
    await Promise.all(
      tabs.map(async (tab) => {
        if (tab.id === undefined || tab.discarded) {
          return;
        }
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ["blank-close.js"],
          });
        } catch {
          // Restricted pages and tabs closed/navigated during injection are skipped.
        }
      })
    );
  }
}
