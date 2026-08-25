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
  isShortcutsBannerVisible,
}: ISettingsStoreProps): ISettingsStore {
  const [store, setStore] = createStore<ISettingsStoreObject>({
    settings: initialSettings, // Store can work only with plain objects.
    isKeyboardShortcutsEnabled: areShortcutsEnabled,
    isShortcutsBannerVisible,
  })

  return {
    restoreDefaultSettings,
    setKeyboardShortcutsEnabled,
    setShortcutsBannerVisible,
    setSettingsOptions,
    store,
  }

  function setKeyboardShortcutsEnabled(enabled: boolean) {
    setStore({isKeyboardShortcutsEnabled: enabled})
  }

  function setShortcutsBannerVisible(visible: boolean) {
    setStore({isShortcutsBannerVisible: visible})
  }

  function setSettingsOptions(options: Partial<ISettings>) {
    settingsService.update(options).then(() => {
      setStore('settings', options)
    })
  }

  async function restoreDefaultSettings() {
    await settingsService.reset()
    setStore('settings', await settingsService.getSettingsObject())
  }
}
