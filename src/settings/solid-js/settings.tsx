import { render } from "solid-js/web";
import styles from "./settings.module.scss";
import {
  createSettingsStore,
  ISettingsStore,
  IStoreSettingsService,
} from "./settings-store";
import { SettingsForm } from "./settings-form";
import areShortcutsSet from "../../utils/are-shortcuts-set";

interface ISettingsProps {
  settingsStore: ISettingsStore;
}

export function Settings(props: ISettingsProps) {
  const {
    store,
    setKeyboardShortcutsEnabled,
    setShortcutsBannerVisible,
    setSettingsOptions,
    restoreDefaultSettings,
  } = props.settingsStore;
  return (
    <div
      class={`${styles.settings} mdc-typography`}
      classList={{ [styles.settings_dark]: store.settings.isDarkTheme }}
      data-test="settings"
    >
      <SettingsForm
        store={store}
        setKeyboardShortcutsEnabled={setKeyboardShortcutsEnabled}
        setShortcutsBannerVisible={setShortcutsBannerVisible}
        setSettingsOptions={setSettingsOptions}
        restoreDefaultSettings={restoreDefaultSettings}
      />
    </div>
  );
}

export async function renderSettingsPage(
  settingsService: IStoreSettingsService
) {
  const [initialSettings, areShortcutsEnabled, shortcutsBannerSeen] =
    await Promise.all([
      settingsService.getSettingsObject(),
      areShortcutsSet(),
      getShortcutsBannerSeen(),
    ]);
  const isShortcutsBannerVisible = !areShortcutsEnabled && !shortcutsBannerSeen;
  if (isShortcutsBannerVisible) {
    chrome.storage.local.set({ shortcutsBannerSeen: true });
  }
  const settingsStore = await createSettingsStore({
    settingsService,
    initialSettings,
    areShortcutsEnabled,
    isShortcutsBannerVisible,
  });
  render(() => <Settings settingsStore={settingsStore} />, document.body);
}

async function getShortcutsBannerSeen(): Promise<boolean> {
  const { shortcutsBannerSeen } = await chrome.storage.local.get(
    "shortcutsBannerSeen"
  );
  return Boolean(shortcutsBannerSeen);
}
