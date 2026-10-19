import {createStore} from 'solid-js/store'
import {ISettings} from '../../utils/settings'

export interface IStoreSettingsService {
  update(settings: Partial<ISettings>): Promise<void>
  reset(): Promise<void>
  getSettingsObject(): Promise<ISettings>
}

interface ISettingsStoreProps {
  areShortcutsEnabled: boolean
  isShortcutsBannerVisible: boolean
  initialSettings: ISettings
  settingsService: IStoreSettingsService
}

export interface ISettingsStore {
  restoreDefaultSettings: () => Promise<void>
  setKeyboardShortcutsEnabled: (enabled: boolean) => void
  setShortcutsBannerVisible: (visible: boolean) => void
  setSettingsOptions: (options: Partial<ISettings>) => void
  store: ISettingsStoreObject
}

export interface ISettingsStoreObject {
  settings: ISettings
  isKeyboardShortcutsEnabled: boolean
  isShortcutsBannerVisible: boolean
}

export function createSettingsStore({
  settingsService,
  initialSettings,
  areShortcutsEnabled,
  isShortcutsBannerVisible
}: ISettingsStoreProps): ISettingsStore {
  const [store, setStore] = createStore<ISettingsStoreObject>({
    settings: initialSettings, // Store can work only with plain objects.
    isKeyboardShortcutsEnabled: areShortcutsEnabled,
    isShortcutsBannerVisible
  })
  let settingsQueue = Promise.resolve()
  let settingsRevision = 0

  return {
    restoreDefaultSettings,
    setKeyboardShortcutsEnabled,
    setShortcutsBannerVisible,
    setSettingsOptions,
    store
  }

  function setKeyboardShortcutsEnabled(enabled: boolean) {
    setStore({isKeyboardShortcutsEnabled: enabled})
  }

  function setShortcutsBannerVisible(visible: boolean) {
    setStore({isShortcutsBannerVisible: visible})
  }

  function setSettingsOptions(options: Partial<ISettings>) {
    enqueueSettingsChange(() => settingsService.update(options))
  }

  function restoreDefaultSettings() {
    return enqueueSettingsChange(() => settingsService.reset())
  }

  function enqueueSettingsChange(change: () => Promise<void>): Promise<void> {
    const revision = ++settingsRevision
    const next = settingsQueue.then(async () => {
      await change()
      if (revision !== settingsRevision) return
      const settings = await settingsService.getSettingsObject()
      if (revision === settingsRevision) setStore('settings', settings)
    })
    settingsQueue = next.catch(() => {})
    return next
  }
}
