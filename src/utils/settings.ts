type LocalStorageArea = chrome.storage.LocalStorageArea;

export type ThemeMode = "auto" | "light" | "dark";
export type PopupPosition = "center" | "mouse";

export interface ISettings {
  textScrollDelay: number;
  textScrollSpeed: number;
  numberOfTabsToShow: number;
  themeMode: ThemeMode;
  isVisualEffectsEnabled: boolean;
  isTabPreviewEnabled: boolean;
  popupWidth: number;
  popupPosition: PopupPosition;
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
  isVisualEffectsEnabled: false,
  isTabPreviewEnabled: false,
  popupWidth: 420,
  popupPosition: "center",
  tabHeight: 46,
  fontSize: 16,
  iconSize: 24,
  opacity: 100,
  isSwitchingToPreviouslyUsedTab: true,
  isStayingOpen: false,
  isHoverSelectingTab: false,
  isShowingTabsFromAllWindows: true,
};

export function getMinimumTabHeight(
  settings: Pick<ISettings, "fontSize" | "iconSize">
): number {
  return Math.ceil(
    Math.max(46, settings.fontSize * 1.8 + 12, settings.iconSize + 16)
  );
}

function normalizeSettings(settings: ISettings): void {
  function normalizeNumber(
    key:
      | "textScrollDelay"
      | "textScrollSpeed"
      | "numberOfTabsToShow"
      | "popupWidth"
      | "tabHeight"
      | "fontSize"
      | "iconSize"
      | "opacity",
    min: number,
    max = 10000,
    integer = false
  ) {
    const value = Number.isFinite(settings[key])
      ? settings[key]
      : defaultSettings[key];
    settings[key] = Math.min(
      max,
      Math.max(min, integer ? Math.round(value) : value)
    );
  }

  normalizeNumber("textScrollDelay", 0);
  normalizeNumber("textScrollSpeed", 0, 100);
  normalizeNumber("numberOfTabsToShow", 0, 10000, true);
  normalizeNumber("popupWidth", 200);
  normalizeNumber("fontSize", 8);
  normalizeNumber("iconSize", 8);
  normalizeNumber("opacity", 0, 100);
  const minimumTabHeight = getMinimumTabHeight(settings);
  normalizeNumber(
    "tabHeight",
    minimumTabHeight,
    Math.max(10000, minimumTabHeight)
  );
  if (settings.popupPosition !== "mouse") {
    settings.popupPosition = "center";
  }
  settings.isTabPreviewEnabled = settings.isTabPreviewEnabled === true;
}

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
  const beforeNormalization = { ...merged };
  normalizeSettings(merged);
  if (
    Object.keys(merged).some(
      (key) =>
        merged[key as keyof ISettings] !==
        beforeNormalization[key as keyof ISettings]
    )
  ) {
    await storage.set({ settings: merged });
  }
  return {
    ...merged,
    async update(this: ISettingsService, newSettings: Partial<ISettings>) {
      Object.assign(this, newSettings);
      normalizeSettings(this);
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
        isVisualEffectsEnabled: this.isVisualEffectsEnabled,
        isTabPreviewEnabled: this.isTabPreviewEnabled,
        popupWidth: this.popupWidth,
        popupPosition: this.popupPosition,
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
