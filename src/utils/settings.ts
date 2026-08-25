type LocalStorageArea = chrome.storage.LocalStorageArea;

export type ThemeMode = "auto" | "light" | "dark";

export interface ISettings {
  textScrollDelay: number;
  textScrollSpeed: number;
  numberOfTabsToShow: number;
  themeMode: ThemeMode;
  popupWidth: number;
  tabHeight: number;
  fontSize: number;
  iconSize: number;
  opacity: number;
  isSwitchingToPreviouslyUsedTab: boolean;
  isStayingOpen: boolean;
  isHoverSelectingTab: boolean;
  isShowingTabsFromAllWindows: boolean;
}

export const defaultSettings: ISettings = {
  textScrollDelay: 1000,
  textScrollSpeed: 1,
  numberOfTabsToShow: 7,
  themeMode: "auto",
  popupWidth: 420,
  tabHeight: 40,
  fontSize: 16,
  iconSize: 24,
  opacity: 100,
  isSwitchingToPreviouslyUsedTab: true,
  isStayingOpen: false,
  isHoverSelectingTab: false,
  isShowingTabsFromAllWindows: true,
};

/**
 * Migrates the legacy `isDarkTheme` boolean to the new `themeMode` field.
 * Manual dark/light choices are preserved; the default becomes "auto".
 */
function migrateThemeMode(settings: ISettings): void {
  const legacy = settings as Partial<ISettings> & { isDarkTheme?: boolean };
  if (typeof legacy.isDarkTheme === "boolean") {
    settings.themeMode = legacy.isDarkTheme ? "dark" : "light";
    delete legacy.isDarkTheme;
  }
}

export interface ISettingsService extends ISettings {
  update(settings: Partial<ISettings>): Promise<void>;
  reset(): Promise<void>;
  getSettingsObject(): ISettings;
}

export async function getSettings(
  storage: LocalStorageArea
): Promise<ISettingsService> {
  const { settings: stored } = await storage.get("settings");
  const merged: ISettings = {
    ...defaultSettings,
    ...stored,
  };
  migrateThemeMode(merged);
  return {
    ...merged,
    async update(this: ISettingsService, newSettings: Partial<ISettings>) {
      Object.assign(this, newSettings);
      await storage.set({ settings: this.getSettingsObject() });
    },
    async reset() {
      Object.assign(this, defaultSettings);
      await storage.set({ settings: defaultSettings });
    },
    getSettingsObject(this: ISettingsService): ISettings {
      return {
        textScrollDelay: this.textScrollDelay,
        textScrollSpeed: this.textScrollSpeed,
        numberOfTabsToShow: this.numberOfTabsToShow,
        themeMode: this.themeMode,
        popupWidth: this.popupWidth,
        tabHeight: this.tabHeight,
        fontSize: this.fontSize,
        iconSize: this.iconSize,
        opacity: this.opacity,
        isSwitchingToPreviouslyUsedTab: this.isSwitchingToPreviouslyUsedTab,
        isStayingOpen: this.isStayingOpen,
        isHoverSelectingTab: this.isHoverSelectingTab,
        isShowingTabsFromAllWindows: this.isShowingTabsFromAllWindows,
      };
    },
  };
}
