type Tab = chrome.tabs.Tab

/**
 * Internal tab shape used by the registry. checkTab warns about missing API
 * fields before narrowing to this shape; it does not populate those fields.
 * */
export interface ITab extends Tab {
  id: number
  url: string
  windowId: number
}

export function checkTab(tab: Tab): ITab {
  if (!tab.id) {
    console.warn('The tab.id is empty', tab)
  }
  if (!tab.windowId) {
    console.warn('The tab.windowId is empty', tab)
  }
  if (!tab.url) {
    console.warn('The tab.url is empty', tab)
  }

  return tab as ITab
}
