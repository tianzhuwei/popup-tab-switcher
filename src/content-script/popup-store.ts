import {createStore, reconcile} from 'solid-js/store'
import {defaultSettings, ISettings} from '../utils/settings'
import {getModel, sendMessageAndGetResponse, togglePinTab} from '../utils/messages'
import {log} from '../utils/logger'

interface IStore {
  tabs: chrome.tabs.Tab[]
  isOpen: boolean
  settings: ISettings
  zoomFactor: number
  selectedTabIndex: number
  pinnedTabIds: Set<number>
}

export function createPopupStore() {
  const [store, setStore] = createStore<IStore>({
    tabs: [],
    isOpen: false,
    settings: defaultSettings,
    zoomFactor: 1,
    selectedTabIndex: 0,
    pinnedTabIds: new Set(),
  })

  const closePopup = () => {
    setStore('isOpen', false)
    setStore('selectedTabIndex', 0)
  }

  const openPopup = () => {
    setStore('isOpen', true)
  }

  const syncStoreWithBackground = async () => {
    const model = await sendMessageAndGetResponse(getModel())
    log(`[syncStoreWithBackground model]`, model)
    setStore({
      zoomFactor: model.zoomFactor,
      pinnedTabIds: new Set(model.pinnedTabIds),
    })
    // This makes DOM updates efficient https://github.com/solidjs/solid/discussions/366#discussioncomment-5004420
    setStore('settings', reconcile(model.settings))
    setStore('tabs', reconcile(model.tabs))
  }

  const togglePin = async (tabId: number) => {
    chrome.runtime.sendMessage(togglePinTab(tabId))
    const newPinnedTabIds = new Set(store.pinnedTabIds)
    if (newPinnedTabIds.has(tabId)) {
      newPinnedTabIds.delete(tabId)
    } else {
      newPinnedTabIds.add(tabId)
    }
    setStore('pinnedTabIds', newPinnedTabIds)
  }

  const isPinned = (tabId: number) => {
    return store.pinnedTabIds.has(tabId)
  }

  return {
    store,
    closePopup,
    openPopup,
    syncStoreWithBackground,
    selectNextTab,
    togglePin,
    isPinned,
  }

  function selectNextTab(increment: number) {
    const newIndex = rangedIncrement(store.selectedTabIndex, increment, store.tabs.length)
    setStore('selectedTabIndex', newIndex)
  }
}

/**
 * Restricts result of a number increment between [0, maxInteger - 1]
 */
export function rangedIncrement(number: number, increment: number, maxInteger: number) {
  return (number + (increment % maxInteger) + maxInteger) % maxInteger
}
