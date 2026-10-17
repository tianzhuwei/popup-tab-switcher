import {ITab} from './check-tab'

interface IRecoveryTab {
  url: string
  title: string
  index: number
  pending: boolean
  closed?: boolean
}

interface IRecoveryWindow {
  tabs: IRecoveryTab[]
}

interface IRecoveryBatch {
  id: string
  windows: IRecoveryWindow[]
}

export interface IPinRecoveryState {
  version: 1
  sessionId: string
  batches: IRecoveryBatch[]
  windowBindings: {[key: string]: number}
  tabBindings: {[key: string]: number}
  excludedTabIds: number[]
  claimedTabIds: number[]
}

function tabUrl(tab: ITab): string {
  return tab.pendingUrl || tab.url || ''
}

function identity(tab: {url: string; title?: string}): string {
  return JSON.stringify([tab.url, tab.title || ''])
}

function groupWindows(tabs: ITab[]): ITab[][] {
  const windows = new Map<number, ITab[]>()
  for (const tab of tabs) {
    const window = windows.get(tab.windowId) || []
    window.push(tab)
    windows.set(tab.windowId, window)
  }
  return Array.from(windows.values()).map((window) =>
    window.sort((a, b) => a.index - b.index)
  )
}

function count<T>(items: T[], predicate: (item: T) => boolean): number {
  return items.filter(predicate).length
}

function activeRows(window: IRecoveryWindow): IRecoveryTab[] {
  // Partial restores compact live indices; retain the original strip positions.
  return window.tabs
    .filter((tab) => !tab.closed)
    .sort((a, b) => a.index - b.index)
}

/** Durable, unconsumed pins retain their complete original window cohort. */
export class PinRecovery {
  readonly state: IPinRecoveryState

  private sameSession: boolean

  constructor(
    saved: IPinRecoveryState | undefined,
    savedTabs: ITab[],
    pinnedTabIds: number[],
    sessionId: string,
    legacySameSession = false
  ) {
    const sameSession =
      saved?.version === 1 ? saved.sessionId === sessionId : legacySameSession
    this.sameSession = sameSession
    this.state = {
      version: 1,
      sessionId,
      batches: saved?.version === 1 ? saved.batches : [],
      windowBindings: sameSession ? saved?.windowBindings || {} : {},
      tabBindings: sameSession ? saved?.tabBindings || {} : {},
      excludedTabIds: sameSession ? saved?.excludedTabIds || [] : [],
      claimedTabIds: sameSession ? saved?.claimedTabIds || [] : []
    }
    if (!sameSession) {
      const pins = new Set(pinnedTabIds)
      const liveTabs = new Map(savedTabs.map((tab) => [tab.id, tab]))
      // A partial restore must keep the old complete cohort on a second restart.
      for (const batch of this.state.batches) {
        batch.windows.forEach((window, windowIndex) => {
          window.tabs.forEach((tab, row) => {
            const oldId =
              saved?.tabBindings?.[`${batch.id}:${windowIndex}:${row}`]
            const live = oldId === undefined ? undefined : liveTabs.get(oldId)
            if (tab.closed && oldId !== undefined) {
              pins.delete(oldId)
            } else if (oldId !== undefined && !live) {
              tab.closed = true
              tab.pending = false
            } else if (oldId !== undefined && live) {
              const previousWindow =
                saved?.windowBindings?.[`${batch.id}:${windowIndex}`]
              if (
                previousWindow !== undefined &&
                live.windowId !== previousWindow
              ) {
                tab.closed = true
                tab.pending = false
                return
              }
              // Navigation changes identity while its session ID remains stable.
              tab.url = tabUrl(live)
              tab.title = live.title || ''
              tab.closed = false
              if (pins.delete(oldId)) {
                tab.pending = true
              }
            }
          })
        })
      }
      const windows = groupWindows(savedTabs).map((tabs) => ({
        tabs: tabs.map((tab) => ({
          url: tabUrl(tab),
          title: tab.title || '',
          index: tab.index,
          pending: pins.has(tab.id)
        }))
      }))
      if (pins.size) {
        this.state.batches.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          windows
        })
      }
    }
  }

  isSameSession(): boolean {
    return this.sameSession
  }

  recover(
    tabs: ITab[],
    pinnedTabIds: number[],
    availableIds?: Set<number>
  ): number[] {
    const windows = groupWindows(tabs)
    const liveIds = new Set(tabs.map((tab) => tab.id))
    this.refreshBoundRows(tabs)
    const claimed = new Set(
      [...this.state.claimedTabIds, ...pinnedTabIds].filter((id) =>
        liveIds.has(id)
      )
    )
    const recovered: number[] = []
    this.state.excludedTabIds = this.state.excludedTabIds.filter((id) =>
      liveIds.has(id)
    )
    const excluded = new Set(this.state.excludedTabIds)
    const savedTabs = this.state.batches.flatMap((batch) =>
      batch.windows.flatMap(activeRows)
    )
    for (const batch of this.state.batches) {
      const usedWindows = new Set<number>()
      for (let index = 0; index < batch.windows.length; index += 1) {
        const window = batch.windows[index]
        const rows = activeRows(window)
        const bindingKey = `${batch.id}:${index}`
        const boundId = this.state.windowBindings[bindingKey]
        let current = windows.find(
          (candidate) => candidate[0].windowId === boundId
        )
        if (!current) {
          const candidates = windows.filter(
            (candidate) =>
              !usedWindows.has(candidate[0].windowId) &&
              this.matchesWindow(window, candidate, savedTabs, tabs)
          )
          // Identical saved windows cannot be distinguished without an anchor.
          const identicalSaved = batch.windows.filter((candidate) =>
            this.sameCohort(activeRows(candidate), rows)
          ).length
          if (candidates.length === 1 && identicalSaved === 1) {
            current = candidates[0]
            this.state.windowBindings[bindingKey] = current[0].windowId
          }
        }
        if (!current) {
          continue
        }
        usedWindows.add(current[0].windowId)
        const complete = this.sameLayout(
          rows,
          current.map((tab) => ({
            url: tabUrl(tab),
            title: tab.title || ''
          }))
        )
        for (let row = 0; row < window.tabs.length; row += 1) {
          const savedTab = window.tabs[row]
          if (savedTab.closed || !savedTab.pending || !savedTab.url) {
            continue
          }
          const sameUrl = current.filter((tab) => tabUrl(tab) === savedTab.url)
          const sameTitle = sameUrl.filter(
            (tab) => (tab.title || '') === savedTab.title
          )
          const savedUrlCount = count(rows, (tab) => tab.url === savedTab.url)
          const savedTitleCount = count(
            rows,
            (tab) => identity(tab) === identity(savedTab)
          )
          let match: ITab | undefined
          if (savedUrlCount === 1 && sameUrl.length === 1) {
            match = sameUrl[0]
          } else if (savedTitleCount === 1 && sameTitle.length === 1) {
            match = sameTitle[0]
          } else if (complete) {
            // Only a complete cohort makes identical siblings' positions safe.
            match = current[rows.indexOf(savedTab)]
          }
          if (
            match &&
            !claimed.has(match.id) &&
            (!availableIds || availableIds.has(match.id))
          ) {
            savedTab.pending = false
            claimed.add(match.id)
            this.state.tabBindings[`${bindingKey}:${row}`] = match.id
            if (!excluded.has(match.id)) {
              recovered.push(match.id)
            }
          }
        }
      }
    }
    this.state.batches = this.state.batches.filter((batch) =>
      batch.windows.some((window) => window.tabs.some((tab) => tab.pending))
    )
    this.state.claimedTabIds = Array.from(claimed)
    const activeKeys = new Set(
      this.state.batches.flatMap((batch) =>
        batch.windows.map((_window, index) => `${batch.id}:${index}`)
      )
    )
    for (const key of Object.keys(this.state.windowBindings)) {
      if (!activeKeys.has(key)) {
        delete this.state.windowBindings[key]
      }
    }
    for (const key of Object.keys(this.state.tabBindings)) {
      if (!activeKeys.has(key.slice(0, key.lastIndexOf(':')))) {
        delete this.state.tabBindings[key]
      }
    }
    return recovered
  }

  cancel(tab: ITab, tabs: ITab[], closing: boolean): void {
    if (!this.state.excludedTabIds.includes(tab.id)) {
      this.state.excludedTabIds.push(tab.id)
    }
    const windows = groupWindows(tabs)
    const current = windows.find(
      (window) => window[0].windowId === tab.windowId
    )
    const allSaved = this.state.batches.flatMap((batch) =>
      batch.windows.flatMap(activeRows)
    )
    for (const batch of this.state.batches) {
      for (let index = 0; index < batch.windows.length; index += 1) {
        const key = `${batch.id}:${index}`
        const savedWindow = batch.windows[index]
        const rows = activeRows(savedWindow)
        if (this.state.windowBindings[key] === undefined && current) {
          const matches = windows.filter((window) =>
            this.matchesWindow(savedWindow, window, allSaved, tabs)
          )
          if (matches.length === 1 && matches[0] === current) {
            this.state.windowBindings[key] = tab.windowId
          }
        }
        if (this.state.windowBindings[key] !== tab.windowId) {
          continue
        }
        const urls = rows.filter((saved) => saved.url === tabUrl(tab))
        const titles = urls.filter((saved) => saved.title === (tab.title || ''))
        const boundRow = savedWindow.tabs.find(
          (_saved, row) => this.state.tabBindings[`${key}:${row}`] === tab.id
        )
        const complete =
          current &&
          this.sameLayout(
            rows,
            current.map((item) => ({
              url: tabUrl(item)
            }))
          )
        const position = current?.findIndex((item) => item.id === tab.id) ?? -1
        const match =
          boundRow ||
          (urls.length === 1
            ? urls[0]
            : titles.length === 1
            ? titles[0]
            : complete && position > -1
            ? rows[position]
            : undefined)
        if (match) {
          match.pending = false
          if (closing) {
            match.closed = true
          } else {
            match.closed = false
          }
          const row = batch.windows[index].tabs.indexOf(match)
          this.state.tabBindings[`${batch.id}:${index}:${row}`] = tab.id
        }
      }
    }
  }

  replace(removedId: number, addedId: number): void {
    const index = this.state.excludedTabIds.indexOf(removedId)
    if (index > -1) {
      this.state.excludedTabIds[index] = addedId
    }
    const claimedIndex = this.state.claimedTabIds.indexOf(removedId)
    if (claimedIndex > -1) {
      this.state.claimedTabIds[claimedIndex] = addedId
    }
    for (const key of Object.keys(this.state.tabBindings)) {
      if (this.state.tabBindings[key] === removedId) {
        this.state.tabBindings[key] = addedId
      }
    }
  }

  private sameCohort(
    saved: {url: string; title?: string}[],
    current: {url: string; title?: string}[]
  ): boolean {
    return (
      saved.length === current.length &&
      saved.every((tab, index) => identity(tab) === identity(current[index]))
    )
  }

  private refreshBoundRows(tabs: ITab[]): void {
    const live = new Map(tabs.map((tab) => [tab.id, tab]))
    for (const batch of this.state.batches) {
      batch.windows.forEach((window, index) => {
        window.tabs.forEach((row, position) => {
          const key = `${batch.id}:${index}:${position}`
          const id = this.state.tabBindings[key]
          if (id === undefined || row.closed) {
            return
          }
          const tab = live.get(id)
          const windowId = this.state.windowBindings[`${batch.id}:${index}`]
          if (!tab || (windowId !== undefined && tab.windowId !== windowId)) {
            row.closed = true
            row.pending = false
            if (tab) {
              // A pin moved to another window belongs to its next live cohort.
              delete this.state.tabBindings[key]
            }
            return
          }
          row.url = tabUrl(tab)
          row.title = tab.title || ''
        })
      })
    }
  }

  private sameLayout(
    saved: {url: string}[],
    current: {url: string}[]
  ): boolean {
    return (
      saved.length === current.length &&
      saved.every((tab, index) => tab.url === current[index].url)
    )
  }

  private matchesWindow(
    saved: IRecoveryWindow,
    current: ITab[],
    allSaved: IRecoveryTab[],
    allCurrent: ITab[]
  ): boolean {
    let anchorFound = false
    const savedRows = activeRows(saved)
    for (const anchor of savedRows) {
      if (!anchor.url) {
        continue
      }
      const urlUnique = count(allSaved, (tab) => tab.url === anchor.url) === 1
      const titleUnique =
        count(allSaved, (tab) => identity(tab) === identity(anchor)) === 1
      if (!urlUnique && !titleUnique) {
        continue
      }
      const urls = allCurrent.filter((tab) => tabUrl(tab) === anchor.url)
      const matches =
        urlUnique && urls.length === 1
          ? urls
          : titleUnique
          ? urls.filter((tab) => (tab.title || '') === anchor.title)
          : []
      if (matches.length === 1) {
        if (matches[0].windowId !== current[0].windowId) {
          return false
        }
        anchorFound = true
      }
    }
    if (anchorFound) {
      return true
    }
    const currentCohort = current.map((tab) => ({
      url: tabUrl(tab),
      title: tab.title || ''
    }))
    if (!this.sameLayout(savedRows, currentCohort)) {
      return false
    }
    const sourceWindows = this.state.batches.flatMap((batch) => batch.windows)
    const sameLayouts = sourceWindows.filter((window) =>
      this.sameLayout(activeRows(window), currentCohort)
    )
    if (
      sameLayouts.length > 1 &&
      (!this.sameCohort(savedRows, currentCohort) ||
        sourceWindows.filter((window) =>
          this.sameCohort(activeRows(window), currentCohort)
        ).length !== 1)
    ) {
      return false
    }
    // A smaller batch must not capture a still-partial, larger cohort.
    return !this.state.batches.some((batch) =>
      batch.windows.some((other, index) => {
        const bound = this.state.windowBindings[`${batch.id}:${index}`]
        const otherRows = activeRows(other)
        if (
          other === saved ||
          otherRows.length <= current.length ||
          (bound !== undefined && bound !== current[0].windowId)
        ) {
          return false
        }
        let row = 0
        for (const tab of otherRows) {
          if (
            row < currentCohort.length &&
            tab.url === currentCohort[row].url
          ) {
            row += 1
          }
        }
        return row === currentCohort.length
      })
    )
  }
}
