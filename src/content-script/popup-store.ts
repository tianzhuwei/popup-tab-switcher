import { batch } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import {
  closeTab,
  getModel,
  IPopupRankingUpdate,
  sendMessageAndGetResponse,
  togglePinTab,
} from "../utils/messages";
import { log } from "../utils/logger";
import { defaultSettings, ISettings } from "../utils/settings";

interface IStore {
  tabs: chrome.tabs.Tab[];
  isOpen: boolean;
  settings: ISettings;
  zoomFactor: number;
  selectedTabIndex: number;
  pinnedTabIds: Set<number>;
  activeTabId: number | undefined;
  previousTabId: number | undefined;
  tabProbabilities: Record<string, number>;
  tabPreviewIds: number[];
}

export function createPopupStore() {
  let hasRankingUpdate = false;
  let openingTabIds: number[] = [];
  let tabVisitRanks: Record<string, number> = {};
  const [store, setStore] = createStore<IStore>({
    tabs: [],
    isOpen: false,
    settings: defaultSettings,
    zoomFactor: 1,
    selectedTabIndex: 0,
    pinnedTabIds: new Set(),
    activeTabId: undefined,
    previousTabId: undefined,
    tabProbabilities: {},
    tabPreviewIds: [],
  });

  const closePopup = () => {
    setStore("isOpen", false);
    // Keep the highlight stable during dismissal; the next sync resets selection.
  };

  const openPopup = () => {
    setStore("isOpen", true);
  };

  const syncStoreWithBackground = async (
    isCurrent = () => true,
    popupId?: string
  ) => {
    const model = await sendMessageAndGetResponse(getModel(popupId));
    if (!isCurrent()) {
      return;
    }
    log(`[syncStoreWithBackground model]`, model);
    setStore("zoomFactor", model.zoomFactor);
    setStore("settings", reconcile(model.settings));
    if (!store.isOpen) hasRankingUpdate = false;
    if (!hasRankingUpdate)
      setStore("tabPreviewIds", reconcile(model.tabPreviewIds || []));

    if (!store.isOpen) {
      // Keep this opening's order and probabilities stable across shortcut repeats.
      const pinnedTabIds = new Set(model.pinnedTabIds);
      tabVisitRanks = model.tabVisitRanks || {};
      const tabs = orderPopupTabs(
        model.tabs,
        pinnedTabIds,
        model.activeTabId,
        model.previousTabId,
        model.tabProbabilities || {},
        tabVisitRanks
      );
      openingTabIds = tabs.map((tab) => tab.id!);
      const activeIndex = tabs.findIndex((tab) => tab.id === model.activeTabId);
      batch(() => {
        setStore({
          pinnedTabIds,
          activeTabId: model.activeTabId,
          previousTabId: model.previousTabId,
          selectedTabIndex: Math.max(0, activeIndex),
        });
        setStore("tabProbabilities", reconcile(model.tabProbabilities || {}));
        setStore("tabs", reconcile(tabs));
      });
    }
    return model;
  };

  const applyRankingUpdate = (update: IPopupRankingUpdate): boolean => {
    const tabs = orderPopupTabs(
      update.tabs,
      store.pinnedTabIds,
      store.activeTabId,
      store.previousTabId,
      update.tabProbabilities,
      update.tabVisitRanks || {}
    );
    const selectedTabId = store.tabs[store.selectedTabIndex]?.id;
    const selectedTabIndex = tabs.findIndex((tab) => tab.id === selectedTabId);
    if (selectedTabId === undefined || selectedTabIndex === -1) {
      return false;
    }
    hasRankingUpdate = true;
    tabVisitRanks = update.tabVisitRanks || {};
    openingTabIds = tabs.map((tab) => tab.id!);
    batch(() => {
      setStore("tabs", reconcile(tabs));
      setStore("tabProbabilities", reconcile(update.tabProbabilities));
      setStore("tabPreviewIds", reconcile(update.tabPreviewIds));
      setStore("selectedTabIndex", selectedTabIndex);
    });
    return true;
  };

  const togglePin = async (tabId: number) => {
    chrome.runtime.sendMessage(togglePinTab(tabId));
    const newPinnedTabIds = new Set(store.pinnedTabIds);
    if (newPinnedTabIds.has(tabId)) {
      newPinnedTabIds.delete(tabId);
    } else {
      newPinnedTabIds.add(tabId);
    }
    const selectedTabId = store.tabs[store.selectedTabIndex]?.id;
    const byId = new Map(store.tabs.map((tab) => [tab.id, tab]));
    // Restore the opening's candidate slots when a pin is removed again.
    const openingTabs = openingTabIds
      .map((id) => byId.get(id))
      .filter((tab): tab is chrome.tabs.Tab => tab !== undefined);
    const newTabs = orderPopupTabs(
      openingTabs,
      newPinnedTabIds,
      store.activeTabId,
      store.previousTabId,
      store.tabProbabilities,
      tabVisitRanks
    );
    const newSelectedIndex =
      selectedTabId !== undefined
        ? newTabs.findIndex((tab) => tab.id === selectedTabId)
        : store.selectedTabIndex;
    batch(() => {
      setStore("pinnedTabIds", newPinnedTabIds);
      setStore("tabs", newTabs);
      if (newSelectedIndex >= 0) {
        setStore("selectedTabIndex", newSelectedIndex);
      }
    });
  };

  const isPinned = (tabId: number) => {
    return store.pinnedTabIds.has(tabId);
  };

  const isProtected = (tabId: number | undefined) =>
    tabId !== undefined &&
    (isPinned(tabId) ||
      tabId === store.activeTabId ||
      tabId === store.previousTabId);

  const removeTab = (tabId: number) => {
    const removedIndex = store.tabs.findIndex((tab) => tab.id === tabId);
    if (removedIndex === -1) {
      return;
    }
    const newTabs = store.tabs.filter((tab) => tab.id !== tabId);
    let newSelectedIndex = store.selectedTabIndex;
    if (removedIndex < newSelectedIndex) {
      newSelectedIndex = Math.max(0, newSelectedIndex - 1);
    }
    if (newSelectedIndex >= newTabs.length) {
      newSelectedIndex = Math.max(0, newTabs.length - 1);
    }
    setStore("tabs", newTabs);
    setStore("selectedTabIndex", newSelectedIndex);
    chrome.runtime.sendMessage(closeTab(tabId));
  };

  return {
    store,
    closePopup,
    openPopup,
    syncStoreWithBackground,
    applyRankingUpdate,
    selectNextTab,
    selectTabIndex,
    togglePin,
    isPinned,
    isProtected,
    removeTab,
  };

  function selectNextTab(increment: number) {
    const listLength = store.tabs.length;
    if (listLength <= 0) {
      return;
    }
    const newIndex = rangedIncrement(
      store.selectedTabIndex,
      increment,
      listLength
    );
    setStore("selectedTabIndex", newIndex);
  }

  function selectTabIndex(index: number) {
    if (index < 0 || index >= store.tabs.length) {
      return;
    }
    if (index === store.selectedTabIndex) {
      return;
    }
    setStore("selectedTabIndex", index);
  }
}

function orderPopupTabs(
  tabs: chrome.tabs.Tab[],
  pinnedTabIds: Set<number>,
  activeTabId: number | undefined,
  previousTabId: number | undefined,
  probabilities: Record<string, number>,
  visitRanks: Record<string, number>
): chrome.tabs.Tab[] {
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const leading: chrome.tabs.Tab[] = [];
  const protectedIds = new Set<number>();
  for (const id of [...pinnedTabIds, activeTabId, previousTabId]) {
    const tab = id !== undefined ? byId.get(id) : undefined;
    if (tab && id !== undefined && !protectedIds.has(id)) {
      leading.push(tab);
      protectedIds.add(id);
    }
  }
  const ordinary = tabs.filter(
    (tab) => tab.id === undefined || !protectedIds.has(tab.id)
  );
  const hasPrediction = (tab: chrome.tabs.Tab) =>
    typeof probabilities[String(tab.id)] === "number";
  const compareVisits = (left: chrome.tabs.Tab, right: chrome.tabs.Tab) =>
    (visitRanks[String(left.id)] ?? Number.MAX_SAFE_INTEGER) -
    (visitRanks[String(right.id)] ?? Number.MAX_SAFE_INTEGER);
  const ranked = ordinary
    .filter(hasPrediction)
    .sort(
      (left, right) =>
        probabilities[String(right.id)] - probabilities[String(left.id)] ||
        compareVisits(left, right)
    );
  if (!ranked.length) return [...leading, ...ordinary.sort(compareVisits)];
  let rankIndex = 0;
  return [
    ...leading,
    ...ordinary.map((tab) => (hasPrediction(tab) ? ranked[rankIndex++] : tab)),
  ];
}

function rangedIncrement(
  number: number,
  increment: number,
  maxInteger: number
) {
  return (number + (increment % maxInteger) + maxInteger) % maxInteger;
}
