/* eslint-disable no-restricted-globals */
import {ITab} from './check-tab'
import {log} from './logger'
import {getTabsInfo} from './registry-utils'

interface ITabRegistryOptions {
  tabs: ITab[]
  numberOfTabsToShow: number
  pinnedTabIds: number[]
  onUpdate: (tabs: ITab[]) => void
  onPinnedUpdate: (pinnedTabIds: number[]) => void
}

interface IInitializedTabs {
  [key: number]: ITab
}

export interface ITabInitialization {
  resolver: (status: boolean) => void
  promise: Promise<boolean>
  timeout: number
}

export default class TabRegistry {
  tabInitializations: Map<number, ITabInitialization>

  private tabs: ITab[]

  private numberOfTabsToShow: number

  private pinnedTabIds: Set<number>

  private initializedTabs: IInitializedTabs

  private onUpdate: (tabs: ITab[]) => void

  private onPinnedUpdate: (pinnedTabIds: number[]) => void

  constructor({
    tabs = [],
    numberOfTabsToShow = 7,
    pinnedTabIds = [],
    onUpdate = () => {},
    onPinnedUpdate = () => {},
  }: Partial<ITabRegistryOptions> = {}) {
    this.initializedTabs = {}
    this.tabInitializations = new Map()
    this.tabs = tabs
    this.numberOfTabsToShow = numberOfTabsToShow
    this.pinnedTabIds = new Set(pinnedTabIds)
    this.onUpdate = onUpdate
    this.onPinnedUpdate = onPinnedUpdate
  }

  setNumberOfTabsToShow(n: number) {
    this.numberOfTabsToShow = n
  }

  togglePin(tabId: number) {
    if (this.pinnedTabIds.has(tabId)) {
      this.pinnedTabIds.delete(tabId)
    } else {
      this.pinnedTabIds.add(tabId)
    }
    this.onPinnedUpdate(this.getPinnedTabIds())
  }

  isPinned(tabId: number): boolean {
    return this.pinnedTabIds.has(tabId)
  }

  getPinnedTabIds(): number[] {
    return Array.from(this.pinnedTabIds)
  }

  setPinnedTabIds(pinnedTabIds: number[]) {
    this.pinnedTabIds = new Set(pinnedTabIds)
  }

  addToInitialized(tab: ITab) {
    this.initializedTabs[tab.id] = tab
    const initialization = this.tabInitializations.get(tab.id)
    if (initialization) {
      log('[tab initialized]', tab)
      initialization.resolver(true)
    }
  }

  removeFromInitialized(tabId: number) {
    delete this.initializedTabs[tabId]
  }

  isInitialized(tab: ITab) {
    return this.initializedTabs[tab.id]
  }

  push(current: ITab) {
    this.tabs = this.removeTab(current.id)
    this.tabs.push(current)
    this.onUpdate(this.tabs)
  }

  remove(tabId: number) {
    this.tabs = this.removeTab(tabId)
    this.removeFromInitialized(tabId)
    if (this.pinnedTabIds.has(tabId)) {
      this.pinnedTabIds.delete(tabId)
      this.onPinnedUpdate(this.getPinnedTabIds())
    }
    this.onUpdate(this.tabs)
  }

  update(tabToUpdate: ITab) {
    this.tabs = this.tabs.map((t) => {
      if (t.id === tabToUpdate.id) {
        return tabToUpdate
      }
      return t
    })
    this.onUpdate(this.tabs)
  }

  getTabs() {
    return this.tabs.slice()
  }

  getTabsToShow(): ITab[] {
    const recentTabs = this.tabs.slice(-this.numberOfTabsToShow).reverse()
    const pinnedTabs: ITab[] = []
    const unpinnedTabs: ITab[] = []

    for (const tab of recentTabs) {
      if (this.pinnedTabIds.has(tab.id)) {
        pinnedTabs.push(tab)
      } else {
        unpinnedTabs.push(tab)
      }
    }

    return [...pinnedTabs, ...unpinnedTabs]
  }

  getActive(): ITab | undefined {
    return this.tabs[this.tabs.length - 1]
  }

  getPreviouslyActive() {
    return this.tabs[this.tabs.length - 2]
  }

  findBackward(findFn: (t: ITab) => boolean) {
    for (let i = this.tabs.length - 1; i >= 0; i -= 1) {
      if (findFn(this.tabs[i])) {
        return this.tabs[i]
      }
    }
    return undefined
  }

  pushUnderTop(tab: ITab) {
    const top = this.getActive()
    if (top) {
      this.tabs.push(top)
      this.tabs[this.tabs.length - 2] = tab
    } else {
      this.tabs.push(tab)
    }
    this.onUpdate(this.tabs)
  }

  /**
   * [0,1,2,3,4] -(active 2)-> [0,1,3,4,2]
   * */
  setActive(tabId: number) {
    this.tabs.sort((_a, b) => (b.id === tabId ? -1 : 0))
    this.onUpdate(this.tabs)
  }

  titles() {
    return getTabsInfo(this.tabs)
  }

  startInitialization(tab: ITab): ITabInitialization {
    let promiseResolve: (status: boolean) => void = () => {}
    const promise = new Promise<boolean>((resolve) => {
      promiseResolve = resolve
      chrome.scripting
        .executeScript({
          target: {tabId: tab.id, allFrames: false},
          files: ['content.js'],
        })
        .catch((e) => {
          log(`[tab initialization failed due to executeScript()]`, tab, e)
          promiseResolve(false)
        })
    })
    const tabSwitchingTimeoutMs = 400
    const timeout = self.setTimeout(() => {
      log(`[tab initialization failed due to timeout]`, tab)
      promiseResolve(false)
    }, tabSwitchingTimeoutMs)
    const result: ITabInitialization = {
      resolver: (status) => {
        this.tabInitializations.delete(tab.id)
        clearTimeout(timeout)
        promiseResolve(status)
      },
      promise,
      timeout,
    }
    this.tabInitializations.set(tab.id, result)
    return result
  }

  private removeTab(tabId: number): ITab[] {
    return this.tabs.filter(({id}) => id !== tabId)
  }
}
