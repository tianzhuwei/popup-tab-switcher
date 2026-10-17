import {getSettings, ISettingsService} from './utils/settings'
import TabRegistry from './utils/tab-registry'
import {checkTab, ITab} from './utils/check-tab'
import {TabRegistryFactory} from './utils/tab-registry-factory'
import {log} from './utils/logger'

interface ISavedRegistryState {
  tabs: ITab[]
  pinnedTabIds: number[]
  isSameSession: boolean
}

export class ServiceFactory {
  private static settingsCache: ISettingsService | undefined

  private static registryCache: TabRegistry | undefined

  private static registryInitialization: Promise<TabRegistry> | undefined

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
        getSavedRegistryState(),
      ]).then(async ([settings, openTabs, savedState]) => {
        const {tabs: savedTabs, pinnedTabIds, isSameSession} = savedState
        const registry = TabRegistryFactory.create({
          numberOfTabsToShow: settings.numberOfTabsToShow,
          openTabs,
          savedTabs,
          pinnedTabIds,
          isSameSession,
          onTabsUpdate: saveTabs,
          onPinnedUpdate: savePinnedTabIds,
        })
        // Save both sides of the remapping before marking this browser session.
        // Storage write failures must not prevent using the in-memory registry.
        try {
          await chrome.storage.local.set({
            tabs: registry.getTabs(),
            pinnedTabIds: registry.getPinnedTabIds(),
          })
          await chrome.storage.session?.set({tabRegistryInitialized: true})
        } catch (error) {
          log('[Registry persistence failed]', error)
        }
        ServiceFactory.registryCache = registry
        log(`[Registry initialized]`, {
          openTabs,
          savedTabs,
          pinnedTabIds,
          registryTitles: registry.titles(),
        })
        return registry
      }).finally(() => {
        ServiceFactory.registryInitialization = undefined
      })
    }
    return ServiceFactory.registryInitialization
  }
}

async function getSavedRegistryState(): Promise<ISavedRegistryState> {
  const [saved, session] = await Promise.all([
    chrome.storage.local.get(['tabs', 'pinnedTabIds']),
    chrome.storage.session?.get('tabRegistryInitialized'),
  ])
  return {
    tabs: saved.tabs || [],
    pinnedTabIds: saved.pinnedTabIds || [],
    isSameSession: session?.tabRegistryInitialized === true,
  }
}

function saveTabs(tabs: ITab[]): void {
  chrome.storage.local.set({tabs})
}

function savePinnedTabIds(pinnedTabIds: number[]): void {
  chrome.storage.local.set({pinnedTabIds})
}

async function getOpenTabs(): Promise<ITab[]> {
  const windows = await chrome.windows.getAll({populate: true})
  return windows.flatMap((w) => w.tabs || []).map(checkTab)
}
