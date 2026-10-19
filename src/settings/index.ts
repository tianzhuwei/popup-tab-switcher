import {renderSettingsPage} from './solid-js/settings'
import {Port} from '../utils/constants'
import {IStoreSettingsService} from './solid-js/settings-store'
import {
  demoSettings,
  getSettings,
  sendMessageAndGetResponse,
  setSettings
} from '../utils/messages'

document.addEventListener('DOMContentLoaded', () => {
  // The connection is necessary for tracking settings popup closing (https://stackoverflow.com/q/15798516/3167855)
  chrome.runtime.connect({name: Port.POPUP_SCRIPT})
  refreshPreview()
  const settingsService: IStoreSettingsService = {
    async update(settings): Promise<void> {
      await sendMessageAndGetResponse(setSettings(settings))
    },
    async reset() {
      await sendMessageAndGetResponse(setSettings())
    },
    async getSettingsObject() {
      return chrome.runtime.sendMessage(getSettings())
    },
    preview: refreshPreview
  }
  renderSettingsPage(settingsService)
})

function refreshPreview() {
  void chrome.runtime.sendMessage(demoSettings()).catch(error => {
    console.warn('Could not refresh the settings preview', error)
  })
}
