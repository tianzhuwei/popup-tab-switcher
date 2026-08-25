import {renderSettingsPage} from './solid-js/settings'
import {Port} from '../utils/constants'
import {IStoreSettingsService} from './solid-js/settings-store'
import {demoSettings, getSettings, sendMessageAndGetResponse, setSettings} from '../utils/messages'

document.addEventListener('DOMContentLoaded', () => {
  // The connection is necessary for tracking settings popup closing (https://stackoverflow.com/q/15798516/3167855)
  chrome.runtime.connect({name: Port.POPUP_SCRIPT})
  sendMessageAndGetResponse(demoSettings())
  const settingsService: IStoreSettingsService = {
    async update(settings): Promise<void> {
      await sendMessageAndGetResponse(setSettings(settings))
      await sendMessageAndGetResponse(demoSettings())
    },
    async reset() {
      await sendMessageAndGetResponse(setSettings())
      await sendMessageAndGetResponse(demoSettings())
    },
    async getSettingsObject() {
      return chrome.runtime.sendMessage(getSettings())
    },
  }
  renderSettingsPage(settingsService)
})
