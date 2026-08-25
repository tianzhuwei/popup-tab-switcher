import { render } from "solid-js/web";
import { createEffect } from "solid-js";
import styles from "./settings.module.scss";
import {
  createSettingsStore,
  ISettingsStore,
  IStoreSettingsService,
} from "./settings-store";
import { SettingsForm } from "./settings-form";
import areShortcutsSet from "../../utils/are-shortcuts-set";
import { createThemeMode } from "../../utils/use-theme-mode";

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
  const isDark = createThemeMode(() => store.settings.themeMode);

  // Toggle a class on <html> so the body background (and other root-level
  // theme variables) follow the active theme.
  // Also set body background directly — inline <style> and CSS modules may
  // both lose to the cascade; direct element.style always wins.
  createEffect(() => {
    const dark = isDark();
    document.documentElement.classList.toggle("theme-dark", dark);
    const bg = dark ? "#1a1a1a" : "#f8fafc";
    document.body.style.backgroundColor = bg;
  });

  return (
    <div
      class={`${styles.settings} mdc-typography`}
      classList={{ [styles.settings_dark]: isDark() }}
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
