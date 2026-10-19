import {getSettings, ISettingsService} from './utils/settings'
import TabRegistry from './utils/tab-registry'
import {checkTab, ITab} from './utils/check-tab'
import {TabRegistryFactory} from './utils/tab-registry-factory'
import {IPinRecoveryState, PinRecovery} from './utils/pin-recovery'
import {log} from './utils/logger'

export class ServiceFactory {
  private static settingsCache: ISettingsService | undefined

  private static registryCache: TabRegistry | undefined

  private static registryInitialization: Promise<TabRegistry> | undefined

  private static pinRecovery: PinRecovery | undefined

  private static refreshTimeout: ReturnType<typeof setTimeout> | undefined

  private static refreshRevision = 0

  private static saveRequested = false

  private static saving: Promise<void> | undefined

  static async getSettings(reload = false): Promise<ISettingsService> {
    if (!reload && ServiceFactory.settingsCache) {
      return ServiceFactory.settingsCache
    }
    const settings = await getSettings(chrome.storage.local)
    ServiceFactory.settingsCache = settings
    log(`[Settings initialized]`, settings)
    return settings
  }

  static async getTabRegistry(): Promise<TabRegistry> {
    if (ServiceFactory.registryCache) {
      return ServiceFactory.registryCache
    }
    if (!ServiceFactory.registryInitialization) {
      ServiceFactory.registryInitialization = Promise.all([
        ServiceFactory.getSettings(),
        getOpenTabs(),
        chrome.storage.local.get(['tabs', 'pinnedTabIds', 'pinRecovery']),
        getSessionInfo()
      ])
        .then(([settings, openTabs, saved, session]) => {
          const savedTabs: ITab[] = saved.tabs || []
          const savedPins: number[] = saved.pinnedTabIds || []
          const savedRecovery: IPinRecoveryState | undefined = saved.pinRecovery
          const recovery = new PinRecovery(
            savedRecovery,
            savedTabs,
            savedPins,
            session.id,
            session.legacySameSession
          )
          const openIds = new Set(openTabs.map((tab) => tab.id))
          const pins = recovery.isSameSession()
            ? savedPins.filter((id) => openIds.has(id))
            : []
          const registry = TabRegistryFactory.create({
            numberOfTabsToShow: settings.numberOfTabsToShow,
            openTabs,
            savedTabs,
            pinnedTabIds: pins,
            onTabsUpdate: () => ServiceFactory.saveRegistry(),
            onPinnedUpdate: () => ServiceFactory.saveRegistry()
          })
          ServiceFactory.pinRecovery = recovery
          ServiceFactory.registryCache = registry
          registry.restorePins(recovery.recover(openTabs, pins))
          ServiceFactory.saveRegistry()
          log(`[Registry initialized]`, {registryTitles: registry.titles()})
          return registry
        })
        .finally(() => {
          ServiceFactory.registryInitialization = undefined
        })
    }
    return ServiceFactory.registryInitialization
  }

  /** Layout reads are coalesced; this does not delay commands or initial opening. */
  static scheduleRegistryRefresh(): void {
    ServiceFactory.refreshRevision += 1
    if (ServiceFactory.refreshTimeout !== undefined)
      clearTimeout(ServiceFactory.refreshTimeout)
    ServiceFactory.refreshTimeout = setTimeout(() => {
      ServiceFactory.refreshTimeout = undefined
      ServiceFactory.refreshRegistry().catch((error) =>
        log('[Registry refresh failed]', error)
      )
    }, 250)
  }

  static cancelPinRecovery(tabId: number, closing = false): void {
    const tab = ServiceFactory.registryCache
      ?.getTabs()
      .find((item) => item.id === tabId)
    if (tab) {
      ServiceFactory.pinRecovery?.cancel(
        tab,
        ServiceFactory.registryCache!.getTabs(),
        closing
      )
      ServiceFactory.saveRegistry()
    }
    ServiceFactory.scheduleRegistryRefresh()
  }

  static async replaceTab(addedId: number, removedId: number): Promise<void> {
    ServiceFactory.refreshRevision += 1
    const registry = await ServiceFactory.getTabRegistry()
    const tab = checkTab(await chrome.tabs.get(addedId))
    ServiceFactory.pinRecovery?.replace(removedId, addedId)
    registry.replaceTab(removedId, tab)
    ServiceFactory.scheduleRegistryRefresh()
  }

  private static async refreshRegistry(): Promise<void> {
    const registry = await ServiceFactory.getTabRegistry()
    const revision = ServiceFactory.refreshRevision
    const tabs = await getOpenTabs()
    if (revision !== ServiceFactory.refreshRevision) {
      return
    }
    registry.refreshTabs(tabs)
    const availableIds = new Set(registry.getTabs().map((tab) => tab.id))
    const recovered =
      ServiceFactory.pinRecovery?.recover(
        tabs,
        registry.getPinnedTabIds(),
        availableIds
      ) || []
    registry.restorePins(recovered)
    ServiceFactory.saveRegistry()
  }

  /** Every write captures the latest live state and pending cohorts together. */
  private static saveRegistry(): void {
    ServiceFactory.saveRequested = true
    if (ServiceFactory.saving) {
      return
    }
    ServiceFactory.saving = Promise.resolve()
      .then(async () => {
        while (ServiceFactory.saveRequested) {
          ServiceFactory.saveRequested = false
          const registry = ServiceFactory.registryCache
          const recovery = ServiceFactory.pinRecovery
          if (!registry || !recovery) {
            continue
          }
          try {
            await chrome.storage.local.set({
              tabs: registry.getTabs(),
              pinnedTabIds: registry.getPinnedTabIds(),
              pinRecovery: JSON.parse(
                JSON.stringify(recovery.state)
              ) as IPinRecoveryState
            })
          } catch (error) {
            log('[Registry persistence failed]', error)
          }
        }
      })
      .finally(() => {
        ServiceFactory.saving = undefined
        if (ServiceFactory.saveRequested) {
          ServiceFactory.saveRegistry()
        }
      })
  }
}

async function getSessionInfo(): Promise<{
  id: string
  legacySameSession: boolean
}> {
  const fallback = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  try {
    const saved = await chrome.storage.session?.get([
      'tabRegistrySessionId',
      'tabRegistryInitialized'
    ])
    if (typeof saved?.tabRegistrySessionId === 'string') {
      return {
        id: saved.tabRegistrySessionId,
        legacySameSession: saved.tabRegistryInitialized === true
      }
    }
    await chrome.storage.session?.set({tabRegistrySessionId: fallback})
    return {
      id: fallback,
      legacySameSession: saved?.tabRegistryInitialized === true
    }
  } catch (error) {
    log('[Registry session storage unavailable]', error)
  }
  return {id: fallback, legacySameSession: false}
}

async function getOpenTabs(): Promise<ITab[]> {
  const windows = await chrome.windows.getAll({populate: true})
  return windows.flatMap((window) => window.tabs || []).map(checkTab)
}
