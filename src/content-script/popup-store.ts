import { createStore, reconcile } from "solid-js/store";
import {
  closeTab,
  getModel,
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
}

export function createPopupStore() {
  const [store, setStore] = createStore<IStore>({
    tabs: [],
    isOpen: false,
    settings: defaultSettings,
    zoomFactor: 1,
    selectedTabIndex: 0,
    pinnedTabIds: new Set(),
  });

  const closePopup = () => {
    setStore("isOpen", false);
    setStore("selectedTabIndex", 0);
  };

  const openPopup = () => {
    setStore("isOpen", true);
  };

  const syncStoreWithBackground = async () => {
    const model = await sendMessageAndGetResponse(getModel());
    log(`[syncStoreWithBackground model]`, model);
    setStore({
      zoomFactor: model.zoomFactor,
      pinnedTabIds: new Set(model.pinnedTabIds),
    });
    setStore("settings", reconcile(model.settings));
    setStore("tabs", reconcile(model.tabs));
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
    const newTabs = [
      ...store.tabs.filter((tab) => newPinnedTabIds.has(tab.id ?? -1)),
      ...store.tabs.filter((tab) => !newPinnedTabIds.has(tab.id ?? -1)),
    ];
    const newSelectedIndex =
      selectedTabId !== undefined
        ? newTabs.findIndex((tab) => tab.id === selectedTabId)
        : store.selectedTabIndex;
    setStore("pinnedTabIds", newPinnedTabIds);
    setStore("tabs", newTabs);
    if (newSelectedIndex >= 0) {
      setStore("selectedTabIndex", newSelectedIndex);
    }
  };

  const isPinned = (tabId: number) => {
    return store.pinnedTabIds.has(tabId);
  };

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
    selectNextTab,
    selectTabIndex,
    togglePin,
    isPinned,
    removeTab,
  };

  function selectNextTab(increment: number, listLength = store.tabs.length) {
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

export function rangedIncrement(
  number: number,
  increment: number,
  maxInteger: number
) {
  return (number + (increment % maxInteger) + maxInteger) % maxInteger;
}
