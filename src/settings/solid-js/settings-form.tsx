import { Show, For } from "solid-js/web";
import { createEffect, createSignal, JSX } from "solid-js";
import { ISettingsStoreObject } from "./settings-store";
import { MBanner } from "./components/m-banner/m-banner";
import styles from "./settings.module.scss";
import { MSwitch } from "./components/m-switch";
import {
  getMinimumTabHeight,
  ISettings,
  PopupPosition,
  ThemeMode,
} from "../../utils/settings";
import { MNumberInput } from "./components/m-text-field/m-number-input";
import { SmartRankingSettings } from "./smart-ranking-settings";

interface IProps {
  store: ISettingsStoreObject;
  setKeyboardShortcutsEnabled: (enabled: boolean) => void;
  setShortcutsBannerVisible: (visible: boolean) => void;
  setSettingsOptions: (options: Partial<ISettings>) => Promise<void>;
  restoreDefaultSettings: () => void;
}

interface IThemeOption {
  value: ThemeMode;
  label: string;
  icon: string;
}

type SettingsSection = "behavior" | "smart-ranking" | "appearance" | "advanced";

const themeOptions: IThemeOption[] = [
  { value: "auto", label: "Auto", icon: "brightness_auto" },
  { value: "light", label: "Light", icon: "wb_sunny" },
  { value: "dark", label: "Dark", icon: "nights_stay" },
];

const positionOptions: { value: PopupPosition; label: string; icon: string }[] =
  [
    { value: "center", label: "Center", icon: "filter_center_focus" },
    { value: "mouse", label: "Near mouse", icon: "mouse" },
  ];

/**
 * A collapsible section that groups related settings under a header row.
 */
function Section(props: {
  icon: string;
  title: string;
  isOpen: boolean;
  onToggle: () => void;
  children: JSX.Element;
}) {
  // Keep drafts mounted when another section opens.
  const [hasOpened, setHasOpened] = createSignal(props.isOpen);
  createEffect(() => {
    if (props.isOpen) setHasOpened(true);
  });
  return (
    <div
      class={styles.section}
      classList={{ [styles.section_open]: props.isOpen }}
    >
      <button
        type="button"
        class={styles.section__header}
        onClick={props.onToggle}
        aria-expanded={props.isOpen}
      >
        <i class={styles.iconInLabel}>{props.icon}</i>
        <span class={styles.section__title}>{props.title}</span>
        <i class={`${styles.iconInLabel} ${styles.section__chevron}`}>
          expand_more
        </i>
      </button>
      <Show when={hasOpened()}>
        <div class={styles.section__body} hidden={!props.isOpen}>
          {props.children}
        </div>
      </Show>
    </div>
  );
}

function Row(props: { children: any }) {
  return <div class={styles.settings__row}>{props.children}</div>;
}

export function SettingsForm(props: IProps) {
  const [expandedSection, setExpandedSection] = createSignal<
    SettingsSection | undefined
  >("behavior");
  const [previewPendingValue, setPreviewPendingValue] = createSignal<boolean>();
  const [previewPermissionError, setPreviewPermissionError] = createSignal("");

  return (
    <form>
      <Show
        when={
          !props.store.isKeyboardShortcutsEnabled &&
          props.store.isShortcutsBannerVisible
        }
      >
        <MBanner
          icon="report_problem"
          message="Keyboard shortcuts are not configured. You can set them in Chrome settings."
          actionMessage="Set up shortcuts"
          onAction={() => {
            props.setShortcutsBannerVisible(false);
            chrome.tabs.create({
              active: true,
              url: "chrome://extensions/shortcuts#:~:text=Popup%20Tab%20Switcher",
            });
          }}
          onDismiss={() => {
            props.setShortcutsBannerVisible(false);
            props.setKeyboardShortcutsEnabled(true);
          }}
        />
      </Show>

      {/* Theme */}
      <div
        class={styles.settings__row}
        title="Choose a theme. Auto follows your operating system's light or dark appearance."
      >
        <span class={styles.settings__label}>
          <i class={styles.iconInLabel}>brightness_6</i>
          Theme
        </span>
      </div>
      <div class={`${styles.settings__row} ${styles.settings__row_segmented}`}>
        <div class={styles.segmented}>
          <For each={themeOptions}>
            {(option) => (
              <button
                type="button"
                class={styles.segmented__option}
                classList={{
                  [styles.segmented__option_active]:
                    props.store.settings.themeMode === option.value,
                }}
                title={option.label}
                onClick={() => {
                  props.setSettingsOptions({ themeMode: option.value });
                }}
              >
                <i class={styles.segmented__icon}>{option.icon}</i>
                {option.label}
              </button>
            )}
          </For>
        </div>
      </div>

      {/* Behavior */}
      <Section
        icon="tune"
        title="Behavior"
        isOpen={expandedSection() === "behavior"}
        onToggle={() => toggleSection("behavior")}
      >
        <Row>
          <label
            for="isSwitchingToPreviouslyUsedTab"
            class={styles.settings__label}
          >
            <i class={styles.iconInLabel}>low_priority</i>
            Switch to a previously used tab
          </label>
          <MSwitch
            id="isSwitchingToPreviouslyUsedTab"
            isOn={props.store.settings.isSwitchingToPreviouslyUsedTab}
            onToggle={() => {
              props.setSettingsOptions({
                isSwitchingToPreviouslyUsedTab:
                  !props.store.settings.isSwitchingToPreviouslyUsedTab,
              });
            }}
          />
        </Row>
        <Row>
          <label for="isStayingOpen" class={styles.settings__label}>
            <i class={styles.iconInLabel}>flip_to_front</i>
            Stay open
          </label>
          <MSwitch
            id="isStayingOpen"
            isOn={props.store.settings.isStayingOpen}
            onToggle={() => {
              props.setSettingsOptions({
                isStayingOpen: !props.store.settings.isStayingOpen,
              });
            }}
          />
        </Row>
        <Row>
          <label for="isHoverSelectingTab" class={styles.settings__label}>
            <i class={styles.iconInLabel}>mouse</i>
            Hover selects tab
          </label>
          <MSwitch
            id="isHoverSelectingTab"
            isOn={props.store.settings.isHoverSelectingTab}
            onToggle={() => {
              props.setSettingsOptions({
                isHoverSelectingTab: !props.store.settings.isHoverSelectingTab,
              });
            }}
          />
        </Row>
        <Row>
          <label
            for="isShowingTabsFromAllWindows"
            class={styles.settings__label}
          >
            <i class={styles.iconInLabel}>select_all</i>
            Show tabs from all windows
          </label>
          <MSwitch
            id="isShowingTabsFromAllWindows"
            isOn={props.store.settings.isShowingTabsFromAllWindows}
            onToggle={() => {
              props.setSettingsOptions({
                isShowingTabsFromAllWindows:
                  !props.store.settings.isShowingTabsFromAllWindows,
              });
            }}
          />
        </Row>
      </Section>

      <Section
        icon="sort"
        title="Smart ranking"
        isOpen={expandedSection() === "smart-ranking"}
        onToggle={() => toggleSection("smart-ranking")}
      >
        <SmartRankingSettings active={expandedSection() === "smart-ranking"} />
      </Section>

      {/* Appearance (layout in px) */}
      <Section
        icon="straighten"
        title="Appearance"
        isOpen={expandedSection() === "appearance"}
        onToggle={() => toggleSection("appearance")}
      >
        <Row>
          <label
            for="isTabPreviewEnabled"
            class={styles.settings__label}
            title="Cache tab screenshots for automatic or hover previews. Requires website access."
          >
            <i class={styles.iconInLabel}>image</i>
            Tab previews
          </label>
          <MSwitch
            id="isTabPreviewEnabled"
            isOn={
              previewPendingValue() ?? props.store.settings.isTabPreviewEnabled
            }
            onToggle={toggleTabPreviews}
            toggleOnClick={true}
            disabled={previewPendingValue() !== undefined}
          />
        </Row>
        <Show when={previewPermissionError()}>
          <div class={styles.settings__row} role="alert">
            <span class={styles.settings__label}>
              {previewPermissionError()}
            </span>
          </div>
        </Show>
        <Show when={props.store.settings.isTabPreviewEnabled}>
          <Row>
            <label
              for="isTabPreviewAutoEnabled"
              class={styles.settings__label}
              title="Automatically preview the selected tab. Turn off to preview only when hovering the small image icon; screenshots remain cached."
            >
              <i class={styles.iconInLabel}>image</i>
              Auto previews
            </label>
            <MSwitch
              id="isTabPreviewAutoEnabled"
              isOn={props.store.settings.isTabPreviewAutoEnabled}
              disabled={previewPendingValue() !== undefined}
              onToggle={() => {
                props.setSettingsOptions({
                  isTabPreviewAutoEnabled:
                    !props.store.settings.isTabPreviewAutoEnabled,
                });
              }}
            />
          </Row>
        </Show>
        <Row>
          <label
            for="isVisualEffectsEnabled"
            class={styles.settings__label}
            title="Frosted glass and short animations. Uses more graphics resources while open."
          >
            <i class={styles.iconInLabel}>blur_on</i>
            Visual effects
          </label>
          <MSwitch
            id="isVisualEffectsEnabled"
            isOn={props.store.settings.isVisualEffectsEnabled}
            onToggle={() => {
              props.setSettingsOptions({
                isVisualEffectsEnabled:
                  !props.store.settings.isVisualEffectsEnabled,
              });
            }}
          />
        </Row>
        <Row>
          <span class={styles.settings__label}>
            <i class={styles.iconInLabel}>open_with</i>
            Popup position
          </span>
        </Row>
        <div
          class={`${styles.settings__row} ${styles.settings__row_segmented}`}
        >
          <div class={styles.segmented}>
            <For each={positionOptions}>
              {(option) => (
                <button
                  type="button"
                  class={styles.segmented__option}
                  classList={{
                    [styles.segmented__option_active]:
                      props.store.settings.popupPosition === option.value,
                  }}
                  title={option.label}
                  onClick={() => {
                    props.setSettingsOptions({ popupPosition: option.value });
                  }}
                >
                  <i class={styles.segmented__icon}>{option.icon}</i>
                  {option.label}
                </button>
              )}
            </For>
          </div>
        </div>
        <Row>
          <label for="popupWidth" class={styles.settings__label}>
            <i class={styles.iconInLabel}>border_horizontal</i>
            Popup width
          </label>
          <MNumberInput
            id="popupWidth"
            suffix="px"
            min={200}
            value={props.store.settings.popupWidth}
            onInput={(value) => {
              props.setSettingsOptions({ popupWidth: value });
            }}
          />
        </Row>
        <Row>
          <label for="tabHeight" class={styles.settings__label}>
            <i class={styles.iconInLabel}>format_line_spacing</i>
            Tab height
          </label>
          <MNumberInput
            id="tabHeight"
            suffix="px"
            value={props.store.settings.tabHeight}
            min={getMinimumTabHeight(props.store.settings)}
            max={Math.max(10000, getMinimumTabHeight(props.store.settings))}
            onInput={(value) => {
              props.setSettingsOptions({ tabHeight: value });
            }}
          />
        </Row>
        <Row>
          <label for="numberOfTabsToShow" class={styles.settings__label}>
            <i class={styles.iconInLabel}>format_list_numbered</i>
            Max number of tabs
          </label>
          <MNumberInput
            id="numberOfTabsToShow"
            value={props.store.settings.numberOfTabsToShow}
            integer={true}
            onInput={(value) => {
              props.setSettingsOptions({ numberOfTabsToShow: value });
            }}
          />
        </Row>
        <Row>
          <label for="fontSize" class={styles.settings__label}>
            <i class={styles.iconInLabel}>format_size</i>
            Font size
          </label>
          <MNumberInput
            id="fontSize"
            suffix="px"
            value={props.store.settings.fontSize}
            min={8}
            onInput={(value) => {
              props.setSettingsOptions({ fontSize: value });
            }}
          />
        </Row>
        <Row>
          <label for="iconSize" class={styles.settings__label}>
            <i class={styles.iconInLabel}>crop_original</i>
            Icon size
          </label>
          <MNumberInput
            id="iconSize"
            suffix="px"
            value={props.store.settings.iconSize}
            min={8}
            onInput={(value) => {
              props.setSettingsOptions({ iconSize: value });
            }}
          />
        </Row>
        <Row>
          <label for="opacity" class={styles.settings__label}>
            <i class={styles.iconInLabel}>opacity</i>
            Opacity
          </label>
          <MNumberInput
            id="opacity"
            value={props.store.settings.opacity}
            suffix="%"
            min={0}
            max={100}
            onInput={(value) => {
              props.setSettingsOptions({ opacity: value });
            }}
          />
        </Row>
      </Section>

      {/* Advanced */}
      <Section
        icon="speed"
        title="Advanced"
        isOpen={expandedSection() === "advanced"}
        onToggle={() => toggleSection("advanced")}
      >
        <Row>
          <label for="textScrollDelay" class={styles.settings__label}>
            <i class={styles.iconInLabel}>timer</i>
            Text scroll delay
          </label>
          <MNumberInput
            id="textScrollDelay"
            suffix="ms"
            value={props.store.settings.textScrollDelay}
            onInput={(value) => {
              props.setSettingsOptions({ textScrollDelay: value });
            }}
          />
        </Row>
        <Row>
          <label for="textScrollSpeed" class={styles.settings__label}>
            <i class={styles.iconInLabel}>text_rotation_none</i>
            Text scroll speed
          </label>
          <MNumberInput
            id="textScrollSpeed"
            suffix="%"
            value={Math.round(props.store.settings.textScrollSpeed * 100)}
            onInput={(value) => {
              props.setSettingsOptions({ textScrollSpeed: value / 100 });
            }}
          />
        </Row>
        <button
          type="button"
          class={styles.resetRow}
          title="Restore every setting to its default value"
          onClick={props.restoreDefaultSettings}
        >
          <i class={styles.iconInLabel}>restore</i>
          <span class={styles.resetRow__text}>Reset all to defaults</span>
        </button>
      </Section>
    </form>
  );

  function toggleSection(section: SettingsSection) {
    setExpandedSection((current) =>
      current === section ? undefined : section
    );
  }

  function toggleTabPreviews() {
    if (previewPendingValue() !== undefined) return;
    const enabled = !props.store.settings.isTabPreviewEnabled;
    setPreviewPermissionError("");
    setPreviewPendingValue(enabled);
    if (!enabled) {
      void saveTabPreviews(false);
      return;
    }
    try {
      // Keep the permission request inside the native click event.
      chrome.permissions.request({ origins: ["<all_urls>"] }, (granted) => {
        const error = chrome.runtime.lastError;
        if (error || !granted) {
          setPreviewPermissionError(
            error?.message ||
              "Website access was not granted. Tab previews remain off."
          );
          setPreviewPendingValue(undefined);
          restorePreviewSwitch();
          return;
        }
        void saveTabPreviews(true);
      });
    } catch (error) {
      setPreviewPermissionError(String(error));
      setPreviewPendingValue(undefined);
      restorePreviewSwitch();
    }
  }

  async function saveTabPreviews(enabled: boolean) {
    try {
      await props.setSettingsOptions({ isTabPreviewEnabled: enabled });
      if (props.store.settings.isTabPreviewEnabled !== enabled) {
        setPreviewPermissionError(
          "The tab preview setting was not saved. Please try again."
        );
      }
    } catch (error) {
      setPreviewPermissionError(
        `Could not save tab previews: ${String(error)}`
      );
    } finally {
      setPreviewPendingValue(undefined);
      restorePreviewSwitch();
    }
  }

  function restorePreviewSwitch() {
    const control = document.getElementById("isTabPreviewEnabled");
    if (control instanceof HTMLInputElement) {
      control.checked = props.store.settings.isTabPreviewEnabled;
    }
  }
}
