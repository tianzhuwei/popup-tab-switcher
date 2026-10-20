import { Command, Port } from "./utils/constants";
import {
  closePopup,
  demoSettings,
  handleMessage,
  IHandlers,
  IPopupRankingUpdate,
  Message,
  selectTab,
} from "./utils/messages";
import isCodeExecutionForbidden from "./utils/is-code-execution-forbidden";
import { isBrowserFocused } from "./utils/is-browser-focused";
import { checkTab, ITab } from "./utils/check-tab";
import { log } from "./utils/logger";
import { ServiceFactory } from "./service-factory";
import { getActiveTab } from "./background/get-active-tab";
import { websiteGroupingHandlers } from "./background/website-grouping-handlers";
import {
  getAvailableTabPreviewIds,
  initTabPreviews,
  notifyPreviewPopupHidden,
  notifyPreviewPopupShown,
  openTabPreviewSession,
  readTabPreview,
  setTabPreviewsEnabled,
} from "./background/tab-previews";
import {
  getSmartRankingSettings,
  getSmartRankingSnapshot,
  initSmartRanking,
  requestSmartRankingSnapshot,
  resetSmartRanking,
  saveSmartRankingConfig,
  scheduleSmartRanking,
} from "./background/smart-ranking";
import { testSmartRankingConfig } from "./background/smart-ranking/connection-check";
import {
  defaultSmartRankingConfig,
  normalizeSmartRankingProviders,
} from "./utils/smart-ranking";
import {
  createRankingInput,
  IRankingInput,
} from "./background/smart-ranking/policy";
import { ISettings } from "./utils/settings";
import TabRegistry from "./utils/tab-registry";

type ChromeTab = chrome.tabs.Tab;
type IPort = chrome.runtime.Port;
const suppressAutoSwitchTabIds = new Set<number>();
const CLOSE_TAB_MENU_ID = "close-current-tab";
interface IPopupSnapshot {
  popupId?: string;
  ownerUrl?: string;
  documentId?: string;
  tabIds?: number[];
  rankingInput?: IRankingInput;
  rankingFingerprint?: string;
  rankingUpdate?: Promise<IPopupRankingUpdate | undefined>;
}

const popupSnapshots = new Map<number, IPopupSnapshot>();

// Tracks the requested tab while asynchronous activation events arrive.
let tabIdToBeActivated: undefined | number;

if (DEVELOPMENT) {
  chrome.tabs.onCreated.addListener(async (tab) => {
    const url = tab.url || tab.pendingUrl;
    const isReloadUrl = url === "https://popuptabswitcher/reload";
    if (isReloadUrl) {
      log(`[Reload extension]`);
      chrome.tabs.remove(tab.id!);
      chrome.runtime.reload();
    }
  });
}

initTabPreviews();
initSmartRanking();
initListeners();

function initListeners() {
  /** NOTE:
   *  The order of events on tab creation in a new window:
   *  1. Tab created
   *  2. Window activated (focus changed)
   *  3. Tab activated
   */
  chrome.tabs.onCreated.addListener(handleTabCreation);
  chrome.windows.onFocusChanged.addListener(handleWindowActivation);
  chrome.tabs.onActivated.addListener(handleTabActivation);
  chrome.tabs.onUpdated.addListener(handleTabUpdate);
  chrome.tabs.onRemoved.addListener(handleTabRemove);
  chrome.tabs.onMoved.addListener(() =>
    ServiceFactory.scheduleRegistryRefresh()
  );
  chrome.tabs.onAttached.addListener(() =>
    ServiceFactory.scheduleRegistryRefresh()
  );
  chrome.tabs.onDetached.addListener(() =>
    ServiceFactory.scheduleRegistryRefresh()
  );
  chrome.tabs.onReplaced.addListener((addedId, removedId) => {
    ServiceFactory.replaceTab(addedId, removedId).catch((error) =>
      log("[Tab replacement failed]", error)
    );
  });
  chrome.runtime.onConnect.addListener(handleConnection);
  chrome.commands.onCommand.addListener(handleCommand);
  chrome.runtime.onMessage.addListener(handleMessage(messageHandlers()));
  chrome.permissions.onRemoved.addListener(() => {
    void chrome.permissions
      .contains({ origins: ["<all_urls>"] })
      .then(async (granted) => {
        if (!granted) {
          const settings = await ServiceFactory.getSettings();
          if (settings.isTabPreviewEnabled) {
            await settings.update({ isTabPreviewEnabled: false });
          }
          await setTabPreviewsEnabled(false);
        }
      })
      .catch((error) => log("[Tab preview permission update failed]", error));
  });
  chrome.runtime.onInstalled.addListener(() => {
    installCloseTabMenu();
    removeLegacyBlankCloseGesture().catch((error) =>
      log("[Legacy gesture cleanup failed]", error)
    );
  });
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === CLOSE_TAB_MENU_ID && tab?.id !== undefined) {
      closeRegistryTab(tab.id).catch((error) =>
        log("[Context menu close failed]", error)
      );
    }
  });
  // Clear the legacy redirect for installations that registered it previously.
  chrome.runtime.setUninstallURL("");
}

function installCloseTabMenu(): void {
  chrome.contextMenus.remove(CLOSE_TAB_MENU_ID, () => {
    // A fresh installation has no previous item to remove.
    void chrome.runtime.lastError;
    chrome.contextMenus.create(
      {
        id: CLOSE_TAB_MENU_ID,
        title: "关闭标签页",
        contexts: ["all"],
      },
      () => {
        if (chrome.runtime.lastError) {
          log("[Context menu registration failed]", chrome.runtime.lastError);
        }
      }
    );
  });
}

async function removeLegacyBlankCloseGesture(): Promise<void> {
  const scripts = await chrome.scripting.getRegisteredContentScripts({
    ids: ["blank-double-click-close"],
  });
  if (scripts.length) {
    await chrome.scripting.unregisterContentScripts({
      ids: ["blank-double-click-close"],
    });
  }
  const settings = await ServiceFactory.getSettings();
  const legacy = settings as typeof settings & {
    isDoubleClickClosingTab?: boolean;
  };
  if (Object.prototype.hasOwnProperty.call(legacy, "isDoubleClickClosingTab")) {
    delete legacy.isDoubleClickClosingTab;
    // Also turns off any old injected listener still observing this setting.
    await settings.update({});
  }
}

async function switchToPreviousTab() {
  const registry = await ServiceFactory.getTabRegistry();
  const previousTab = registry.getPreviouslyActive();
  if (previousTab) {
    await activateTab(previousTab as ChromeTab);
  }
}

async function handleCommand(command: string) {
  const activeTab = await getActiveTab();
  if (!activeTab) {
    return;
  }
  log(`[handleCommand]`, activeTab.id, activeTab.title);
  const active = checkTab(activeTab);
  if (isCodeExecutionForbidden(active)) {
    // If the content script can't be initialized then switch to the previous tab.
    // TODO: Create popup window in the center of a screen and show PTS in it.
    await switchToPreviousTab();
    return;
  }
  notifyPreviewPopupShown(active.id);
  if (await initializeContentScript(active)) {
    // This forced activation solves the problem with document.contentType === 'application/pdf'
    // when the document.hasFocus() returns false.
    await activateTab(activeTab as ChromeTab);
    // send the command to the content script
    await chrome.tabs.sendMessage(
      active.id,
      selectTab(command === Command.NEXT ? 1 : -1)
    );
  } else {
    notifyPreviewPopupHidden(active.id);
    // Tab initialization may fail due to different reasons:
    // - the page is not loaded,
    // - the initialization timeout passed.
    // If this happens we are switching to the previous tab
    await switchToPreviousTab();
  }
}

async function handleWindowActivation(windowId: number) {
  log(`[handleWindowActivation start]`, windowId);
  // Do not react on windows without ids.
  // This happens on each window activation in some Linux window managers.
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    return;
  }
  await handleTabActivation();
}

async function handleTabActivation(info?: chrome.tabs.TabActiveInfo) {
  const registry = await ServiceFactory.getTabRegistry();
  log(`[handleTabActivation info]`, info);
  const isNotTheTargetTab =
    tabIdToBeActivated && tabIdToBeActivated !== info?.tabId;
  if (isNotTheTargetTab) {
    log(
      `[handleTabActivation is skipped because previous tab activation is in process]`
    );
    log(`[current registry]`, registry.titles());
    return;
  }
  const active = await getActiveTab();
  // the tab can be instantly closed and therefore currentTab can be null
  if (active) {
    const activatedTabWasClosed = info && info.tabId !== active.id;
    if (activatedTabWasClosed) {
      registry.setActive(info.tabId);
    } else {
      registry.push(checkTab(active));
    }
  }
  log(`[handleTabActivation end]`, active?.id);
  log(`[current registry]`, registry.titles());
}

async function handleTabCreation(tab: ChromeTab) {
  ServiceFactory.scheduleRegistryRefresh();
  const registry = await ServiceFactory.getTabRegistry();
  if (tab.active) {
    registry.push(checkTab(tab));
  } else {
    registry.pushUnderTop(checkTab(tab));
  }
  log(`[handleTabCreation end]`, tab.id);
  log(`[current registry]`, registry.titles());
}

async function handleTabUpdate(
  tabId: number,
  changeInfo: chrome.tabs.TabChangeInfo,
  tab: ChromeTab
) {
  const hasRecoveryMetadata =
    changeInfo.url !== undefined ||
    changeInfo.title !== undefined ||
    changeInfo.status !== undefined ||
    changeInfo.discarded !== undefined;
  if (hasRecoveryMetadata) {
    ServiceFactory.scheduleRegistryRefresh();
  }
  const registry = await ServiceFactory.getTabRegistry();
  // Restored/discarded tabs may supply their identity without a complete event.
  if (hasRecoveryMetadata) {
    registry.update(checkTab(tab));
  }
  if (changeInfo.status === "complete") {
    log(`[handleTabUpdate tabId]`, tabId, tab.title);
    registry.removeFromInitialized(tabId);
  }
}

async function handleTabRemove(tabId: number) {
  popupSnapshots.delete(tabId);
  ServiceFactory.scheduleRegistryRefresh();
  const registry = await ServiceFactory.getTabRegistry();
  log(`[handleTabRemove start]`, tabId);
  log(`[current registry]`, registry.titles());
  ServiceFactory.cancelPinRecovery(tabId, true);
  registry.remove(tabId);
  if (suppressAutoSwitchTabIds.has(tabId)) {
    suppressAutoSwitchTabIds.delete(tabId);
    return;
  }
  const settings = await ServiceFactory.getSettings();
  const isSwitchingNeeded = settings.isSwitchingToPreviouslyUsedTab;
  if (isSwitchingNeeded) {
    const currentTab = registry.getActive();
    if (currentTab) {
      log(
        `[handleTabRemove will activate tab]`,
        currentTab.id,
        currentTab.title
      );
      await activateTab(currentTab as ChromeTab);
    }
  }
}

function messageHandlers(): Partial<IHandlers> {
  return {
    ...websiteGroupingHandlers,
    [Message.ContentScriptStarted]: async (_m, sender) => {
      log(`[ContentScriptStarted]`, sender.tab);
      const registry = await ServiceFactory.getTabRegistry();
      registry.addToInitialized(checkTab(sender.tab!));
    },
    [Message.ContentScriptStopped]: async (_m, sender) => {
      log(`[ContentScriptStopped]`, sender.tab);
      if (sender.tab?.id !== undefined) notifyPreviewPopupHidden(sender.tab.id);
      if (sender.tab?.id !== undefined) popupSnapshots.delete(sender.tab.id);
      const registry = await ServiceFactory.getTabRegistry();
      registry.removeFromInitialized(sender.tab!.id!);
    },
    [Message.SWITCH_TAB]: async ({ selectedTab }) => {
      await activateTab(selectedTab);
    },
    [Message.DEMO_SETTINGS]: async () => {
      const settings = await ServiceFactory.getSettings();
      const registry = await ServiceFactory.getTabRegistry();
      registry.setNumberOfTabsToShow(settings.numberOfTabsToShow);
      const activeTab = await getActiveTab();
      if (!activeTab) {
        return;
      }
      const active = checkTab(activeTab);
      if (isCodeExecutionForbidden(active)) {
        const previousNormalTab = registry.findBackward(
          (tab) => !isCodeExecutionForbidden(tab)
        );
        if (previousNormalTab) {
          await activateTab(previousNormalTab as ChromeTab);
        }
        return;
      }
      notifyPreviewPopupShown(active.id);
      if (await initializeContentScript(active)) {
        await chrome.tabs.sendMessage(active.id, demoSettings());
      } else {
        notifyPreviewPopupHidden(active.id);
      }
    },
    [Message.GET_MODEL]: async ({ popupId }, sender) => {
      const ownerId = sender.frameId === 0 ? sender.tab?.id : undefined;
      const validPopupId =
        typeof popupId === "string" &&
        popupId.length > 0 &&
        popupId.length <= 128
          ? popupId
          : undefined;
      const existing =
        ownerId === undefined ? undefined : popupSnapshots.get(ownerId);
      const snapshot: IPopupSnapshot | undefined =
        ownerId === undefined
          ? undefined
          : existing && (!validPopupId || existing.popupId === validPopupId)
          ? existing
          : {
              popupId: validPopupId,
              ownerUrl: sender.url,
              documentId: sender.documentId,
            };
      if (ownerId !== undefined && snapshot)
        popupSnapshots.set(ownerId, snapshot);
      const settings = await ServiceFactory.getSettings();
      const registry = await ServiceFactory.getTabRegistry();
      const senderWindowId = sender.tab?.windowId;
      const input = getPopupRankingInput(registry, settings, senderWindowId);
      const ranked = await getSmartRankingSnapshot(input);
      if (
        ownerId !== undefined &&
        snapshot &&
        popupSnapshots.get(ownerId) === snapshot &&
        !snapshot.tabIds
      ) {
        snapshot.tabIds = ranked.tabs.map((tab) => tab.id);
        if (ranked.pending && validPopupId) {
          snapshot.rankingInput = input;
          snapshot.rankingFingerprint = getRankingFingerprint(input);
        }
      }
      return {
        tabs: ranked.tabs as chrome.tabs.Tab[],
        tabVisitRanks: getTabVisitRanks(ranked.tabs, input),
        tabProbabilities: ranked.tabProbabilities,
        rankingPending: ranked.pending,
        tabPreviewIds:
          settings.isTabPreviewEnabled && !settings.isTabPreviewAutoEnabled
            ? await getAvailableTabPreviewIds(ranked.tabs)
            : [],
        settings,
        zoomFactor:
          sender.tab?.id !== undefined
            ? await chrome.tabs.getZoom(sender.tab.id)
            : await chrome.tabs.getZoom(),
        pinnedTabIds: registry.getPinnedTabIds(),
        activeTabId: input.activeTabId,
        previousTabId: input.previousTabId,
      };
    },
    [Message.GetSmartRankingUpdate]: async ({ popupId }, sender) => {
      const ownerId = sender.frameId === 0 ? sender.tab?.id : undefined;
      if (sender.id !== chrome.runtime.id || ownerId === undefined) return;
      const snapshot = popupSnapshots.get(ownerId);
      if (
        !snapshot ||
        snapshot.popupId !== popupId ||
        !snapshot.rankingInput ||
        snapshot.ownerUrl !== sender.url ||
        snapshot.documentId !== sender.documentId
      )
        return;
      if (!snapshot.rankingUpdate) {
        snapshot.rankingUpdate = preparePopupRankingUpdate(
          ownerId,
          snapshot
        ).catch(() => undefined);
      }
      return snapshot.rankingUpdate;
    },
    [Message.TogglePinTab]: async ({ tabId }) => {
      const registry = await ServiceFactory.getTabRegistry();
      ServiceFactory.cancelPinRecovery(tabId);
      registry.togglePin(tabId);
    },
    [Message.CloseTab]: async ({ tabId }) => {
      await closeRegistryTab(tabId);
    },
    [Message.CreateTab]: async (_m, sender) => {
      await chrome.tabs.create({ windowId: sender.tab?.windowId });
    },
    [Message.OpenTabPreview]: async (_m, sender) => {
      const owner = sender.tab;
      if (owner?.id === undefined || sender.frameId !== 0) return;
      notifyPreviewPopupShown(owner.id);
      const settings = await ServiceFactory.getSettings();
      if (!settings.isTabPreviewEnabled) return;
      const registry = await ServiceFactory.getTabRegistry();
      const scopedTabs = registry
        .getTabs()
        .filter(
          (tab) =>
            settings.isShowingTabsFromAllWindows ||
            tab.windowId === owner.windowId
        );
      return openTabPreviewSession(
        owner.id,
        (
          popupSnapshots.get(owner.id)?.tabIds ||
          registry
            .getTabsToShow(
              (tab) =>
                settings.isShowingTabsFromAllWindows ||
                tab.windowId === owner.windowId
            )
            .map((tab) => tab.id)
        ).filter((id) => scopedTabs.some((tab) => tab.id === id))
      );
    },
    [Message.GetTabPreview]: async ({ token, tabId }, sender) => {
      if (
        sender.url !== chrome.runtime.getURL("preview/index.html") ||
        sender.frameId === 0 ||
        sender.tab?.id === undefined ||
        typeof token !== "string" ||
        !Number.isInteger(tabId)
      )
        return;
      return readTabPreview(token, tabId, sender.tab.id);
    },
    [Message.CloseTabPreview]: (_m, sender) => {
      if (sender.frameId === 0 && sender.tab?.id !== undefined) {
        notifyPreviewPopupHidden(sender.tab.id);
        popupSnapshots.delete(sender.tab.id);
      }
    },
    [Message.SetSettings]: async ({ settings }) => {
      log(`[Settings received]`, settings);
      const currentSettings = await ServiceFactory.getSettings();
      if (settings) {
        await currentSettings.update(settings);
      } else {
        await currentSettings.reset();
        await resetSmartRanking();
      }
      if (
        currentSettings.isTabPreviewEnabled &&
        !(await chrome.permissions.contains({ origins: ["<all_urls>"] }))
      ) {
        await currentSettings.update({ isTabPreviewEnabled: false });
      }
      await setTabPreviewsEnabled(currentSettings.isTabPreviewEnabled);
      scheduleSmartRanking();
    },
    [Message.GetSettings]: async () => {
      log(`[Settings requested]`);
      const currentSettings = await ServiceFactory.getSettings();
      return currentSettings.getSettingsObject();
    },
    [Message.GetSmartRankingSettings]: async (_m, sender) => {
      if (!isRankingSettingsSender(sender)) return deniedRankingSettings();
      return getSmartRankingSettings();
    },
    [Message.SetSmartRankingConfig]: async ({ config, providers }, sender) => {
      if (!isRankingSettingsSender(sender)) return deniedRankingSettings();
      return saveSmartRankingConfig(config, providers);
    },
    [Message.TestSmartRankingConfig]: async ({ config }, sender) => {
      if (!isRankingSettingsSender(sender)) {
        return {
          ok: false,
          message: "Open the extension settings to test smart ranking.",
        };
      }
      return testSmartRankingConfig(config);
    },
  };
}

function getPopupRankingInput(
  registry: TabRegistry,
  settings: ISettings,
  windowId?: number
): IRankingInput {
  return createRankingInput(
    registry,
    settings.isShowingTabsFromAllWindows,
    windowId
  );
}

function getRankingFingerprint(input: IRankingInput): string {
  return JSON.stringify([
    input.scope,
    input.activeTabId,
    input.previousTabId,
    input.pinnedTabIds,
    input.visibleTabs.map((tab) => tab.id),
    // Titles are excluded: counters/timers change them without affecting order.
    input.recentTabs.map((tab) => [tab.id, tab.url, tab.incognito]),
  ]);
}

function getTabVisitRanks(
  tabs: chrome.tabs.Tab[],
  input: IRankingInput
): Record<string, number> {
  const ranks = new Map(input.recentTabs.map((tab, index) => [tab.id, index]));
  // Only visible tabs' ranks enter the content popup, never the full registry.
  return Object.fromEntries(
    tabs.map((tab) => [
      String(tab.id),
      ranks.get(tab.id!) ?? Number.MAX_SAFE_INTEGER,
    ])
  );
}

async function preparePopupRankingUpdate(
  ownerId: number,
  snapshot: IPopupSnapshot
): Promise<IPopupRankingUpdate | undefined> {
  const input = snapshot.rankingInput;
  if (!input || !snapshot.popupId) return;
  const ranked = await requestSmartRankingSnapshot(input);
  if (!ranked || popupSnapshots.get(ownerId) !== snapshot) return;
  const [owner, settings, registry] = await Promise.all([
    chrome.tabs.get(ownerId),
    ServiceFactory.getSettings(),
    ServiceFactory.getTabRegistry(),
  ]);
  if (
    popupSnapshots.get(ownerId) !== snapshot ||
    !owner.active ||
    owner.url !== snapshot.ownerUrl ||
    getRankingFingerprint(
      getPopupRankingInput(registry, settings, owner.windowId)
    ) !== snapshot.rankingFingerprint
  )
    return;
  const tabPreviewIds =
    settings.isTabPreviewEnabled && !settings.isTabPreviewAutoEnabled
      ? await getAvailableTabPreviewIds(ranked.tabs)
      : [];
  if (popupSnapshots.get(ownerId) !== snapshot) return;
  // A locked popup can retain its initial rows; preview sessions may serve either snapshot.
  snapshot.tabIds = [
    ...new Set([
      ...(snapshot.tabIds || []),
      ...ranked.tabs.map((tab) => tab.id),
    ]),
  ];
  return {
    popupId: snapshot.popupId,
    tabs: ranked.tabs,
    tabVisitRanks: getTabVisitRanks(ranked.tabs, input),
    tabProbabilities: ranked.tabProbabilities,
    tabPreviewIds,
  };
}

function isRankingSettingsSender(
  sender: chrome.runtime.MessageSender
): boolean {
  return (
    sender.id === chrome.runtime.id &&
    sender.url === chrome.runtime.getURL("settings/index.html") &&
    (sender.frameId === undefined || sender.frameId === 0)
  );
}

function deniedRankingSettings() {
  return {
    config: { ...defaultSmartRankingConfig },
    providers: normalizeSmartRankingProviders(
      undefined,
      defaultSmartRankingConfig
    ),
    status: {
      state: "error" as const,
      message: "Open the extension settings to configure smart ranking.",
    },
  };
}

async function closeRegistryTab(tabId: number): Promise<void> {
  await ServiceFactory.getTabRegistry();
  suppressAutoSwitchTabIds.add(tabId);
  try {
    await chrome.tabs.remove(tabId);
    ServiceFactory.cancelPinRecovery(tabId, true);
  } catch (error) {
    suppressAutoSwitchTabIds.delete(tabId);
    throw error;
  }
}

async function initializeContentScript(tab: ITab): Promise<boolean> {
  const registry = await ServiceFactory.getTabRegistry();
  if (registry.isInitialized(tab)) {
    return true;
  }
  const initialization = registry.tabInitializations.get(tab.id);
  if (initialization) {
    log("[tab initialisation is in progress]", tab);
    return initialization.promise;
  }
  const newInitialization = registry.startInitialization(tab);
  return newInitialization.promise;
}

async function activateTab({ id, windowId }: ChromeTab) {
  log(`[tab activation is started]`, { id, windowId });
  tabIdToBeActivated = id;
  try {
    // The tab can disappear before update; the catch below handles that race.
    // @ts-expect-error Todo: fix this
    await chrome.tabs.update(id, { active: true });
    if (await isBrowserFocused()) {
      await chrome.windows.update(windowId, { focused: true });
    }
  } catch (e) {
    console.error(
      `Can not activate the tab id: ${id}, windowId: ${windowId}`,
      e
    );
  } finally {
    tabIdToBeActivated = undefined;
    log(`[tab activation is finished]`, { id, windowId });
  }
}

function handleConnection(port: IPort) {
  if (Port.POPUP_SCRIPT === port.name) {
    port.onDisconnect.addListener(closeSwitcherInActiveTab);
  }
}

async function closeSwitcherInActiveTab() {
  const registry = await ServiceFactory.getTabRegistry();
  const currentTab = await getActiveTab();
  if (currentTab && registry.isInitialized(checkTab(currentTab))) {
    await chrome.tabs.sendMessage(checkTab(currentTab).id, closePopup());
  }
}
