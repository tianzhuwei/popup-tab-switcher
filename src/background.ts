import { Command, Port } from "./utils/constants";
import {
  closePopup,
  demoSettings,
  handleMessage,
  IHandlers,
  Message,
  selectTab,
} from "./utils/messages";
import isCodeExecutionForbidden from "./utils/is-code-execution-forbidden";
import { isBrowserFocused } from "./utils/is-browser-focused";
import { checkTab, ITab } from "./utils/check-tab";
import { log } from "./utils/logger";
import { ServiceFactory } from "./service-factory";
import { getActiveTab } from "./background/get-active-tab";

type ChromeTab = chrome.tabs.Tab;
type IPort = chrome.runtime.Port;
const suppressAutoSwitchTabIds = new Set<number>();

// NOTE: This is somehow related to the test "focuses previously active window on a tab closing".
// TODO: Describe the problem in more details.
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
  // Clear the legacy redirect for installations that registered it previously.
  chrome.runtime.setUninstallURL("");
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
    [Message.ContentScriptStarted]: async (_m, sender) => {
      log(`[ContentScriptStarted]`, sender.tab);
      const registry = await ServiceFactory.getTabRegistry();
      registry.addToInitialized(checkTab(sender.tab!));
    },
    [Message.ContentScriptStopped]: async (_m, sender) => {
      log(`[ContentScriptStopped]`, sender.tab);
      const registry = await ServiceFactory.getTabRegistry();
      registry.removeFromInitialized(sender.tab!.id!);
    },
    [Message.SWITCH_TAB]: async ({ selectedTab }) => {
      await activateTab(selectedTab);
    },
    [Message.DEMO_SETTINGS]: async () => {
      const settings = await ServiceFactory.getSettings(true);
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
      if (await initializeContentScript(active)) {
        await chrome.tabs.sendMessage(active.id, demoSettings());
      } else {
        // TODO: Show extension in a separate window
      }
    },
    [Message.GET_MODEL]: async (_m, sender) => {
      const settings = await ServiceFactory.getSettings();
      const registry = await ServiceFactory.getTabRegistry();
      const senderWindowId = sender.tab?.windowId;
      const isInScope = (tab: ITab) =>
        settings.isShowingTabsFromAllWindows || tab.windowId === senderWindowId;
      const recentTabs = registry.getTabs().filter(isInScope);
      const activeTab = recentTabs[recentTabs.length - 1];
      const previousTab = recentTabs[recentTabs.length - 2];
      const tabs = registry.getTabsToShow(isInScope);
      return {
        tabs: tabs as chrome.tabs.Tab[],
        settings,
        zoomFactor:
          sender.tab?.id !== undefined
            ? await chrome.tabs.getZoom(sender.tab.id)
            : await chrome.tabs.getZoom(),
        pinnedTabIds: registry.getPinnedTabIds(),
        activeTabId: activeTab?.id,
        previousTabId: previousTab?.id,
      };
    },
    [Message.TogglePinTab]: async ({ tabId }) => {
      const registry = await ServiceFactory.getTabRegistry();
      ServiceFactory.cancelPinRecovery(tabId);
      registry.togglePin(tabId);
    },
    [Message.CloseTab]: async ({ tabId }) => {
      await ServiceFactory.getTabRegistry();
      suppressAutoSwitchTabIds.add(tabId);
      await chrome.tabs.remove(tabId);
      ServiceFactory.cancelPinRecovery(tabId, true);
    },
    [Message.CreateTab]: async (_m, sender) => {
      await chrome.tabs.create({ windowId: sender.tab?.windowId });
    },
    [Message.SetSettings]: async ({ settings }) => {
      log(`[Settings received]`, settings);
      const currentSettings = await ServiceFactory.getSettings();
      if (settings) {
        await currentSettings.update(settings);
      } else {
        await currentSettings.reset();
      }
    },
    [Message.GetSettings]: async () => {
      log(`[Settings requested]`);
      const currentSettings = await ServiceFactory.getSettings();
      return currentSettings.getSettingsObject();
    },
  };
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
    // The tab can already be removed from the browser, for example when a user quickly closes multiple tabs.
    // To handle this situation without an error we can use debounce technique.
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
