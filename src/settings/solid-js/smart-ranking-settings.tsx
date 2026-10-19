import { createSignal, onCleanup, onMount } from "solid-js";
import { Show } from "solid-js/web";
import styles from "./settings.module.scss";
import rankingStyles from "./smart-ranking-settings.module.scss";
import { MSwitch } from "./components/m-switch";
import {
  getSmartRankingSettings,
  setSmartRankingConfig,
} from "../../utils/messages";
import {
  defaultSmartRankingConfig,
  getRankingPermissionOrigin,
  ISmartRankingConfig,
  ISmartRankingSettings,
} from "../../utils/smart-ranking";

const defaultEndpoints = {
  bailian: defaultSmartRankingConfig.endpoint,
  jev: "https://api.typesafe.ai/v1/systemone",
};

export function SmartRankingSettings() {
  const [config, setConfig] = createSignal<ISmartRankingConfig>({
    ...defaultSmartRankingConfig,
  });
  const [status, setStatus] = createSignal("Loading settings…");
  const [pending, setPending] = createSignal(true);
  const [error, setError] = createSignal("");
  let dirty = false;
  let statusPending = false;
  let disposed = false;
  let settingsRevision = 0;
  let statusTimer: ReturnType<typeof setInterval> | undefined;

  onMount(() => {
    chrome.storage.onChanged.addListener(onStorageChanged);
    statusTimer = setInterval(() => void refreshStatus(), 3000);
    void loadSettings();
  });
  onCleanup(() => {
    disposed = true;
    clearInterval(statusTimer);
    chrome.storage.onChanged.removeListener(onStorageChanged);
  });

  return (
    <>
      <div class={styles.settings__row}>
        <label for="smartRankingEnabled" class={styles.settings__label}>
          <i class={styles.iconInLabel}>auto_awesome</i>
          Smart ranking
        </label>
        <MSwitch
          id="smartRankingEnabled"
          isOn={config().enabled}
          disabled={pending()}
          onToggle={() => updateConfig({ enabled: !config().enabled })}
        />
      </div>
      <div class={rankingStyles.field}>
        <label for="smartRankingProvider">Provider</label>
        <select
          id="smartRankingProvider"
          value={config().provider}
          disabled={pending()}
          onChange={(event) => {
            const provider = event.currentTarget.value as "bailian" | "jev";
            updateConfig({
              provider,
              endpoint: defaultEndpoints[provider],
              apiKey: "",
            });
          }}
        >
          <option value="bailian">Alibaba Cloud Bailian</option>
          <option value="jev">Jev (Typesafe)</option>
        </select>
      </div>
      <div class={rankingStyles.field}>
        <label for="smartRankingEndpoint">System One endpoint</label>
        <input
          id="smartRankingEndpoint"
          type="url"
          value={config().endpoint}
          disabled={pending()}
          spellcheck={false}
          autocomplete="off"
          onInput={(event) =>
            updateConfig({ endpoint: event.currentTarget.value })
          }
        />
      </div>
      <div class={rankingStyles.field}>
        <label for="smartRankingApiKey">API Key</label>
        <input
          id="smartRankingApiKey"
          type="password"
          value={config().apiKey}
          disabled={pending()}
          autocomplete="off"
          spellcheck={false}
          onInput={(event) =>
            updateConfig({ apiKey: event.currentTarget.value })
          }
        />
      </div>
      <p class={rankingStyles.note}>
        When enabled, tab titles, domains and usage statistics are sent to the
        selected provider. Screenshots and full URLs are not sent. The API Key
        is stored locally. Changes apply after Save.
      </p>
      <div class={rankingStyles.actions}>
        <span class={rankingStyles.status} role="status" aria-live="polite">
          {pending() ? "Saving or loading…" : status()}
        </span>
        <button
          type="button"
          class={rankingStyles.save}
          disabled={pending()}
          on:click={saveSettings}
        >
          Save
        </button>
      </div>
      <Show when={error()}>
        <p class={rankingStyles.error} role="alert">
          {error()}
        </p>
      </Show>
    </>
  );

  function updateConfig(change: Partial<ISmartRankingConfig>) {
    dirty = true;
    settingsRevision++;
    setConfig((previous) => ({ ...previous, ...change }));
    setError("");
    setStatus("Unsaved changes");
  }

  function applySettings(settings: ISmartRankingSettings | undefined) {
    if (!settings?.config || !settings.status) {
      throw new Error(
        "No settings response. Reload the extension and try again."
      );
    }
    dirty = false;
    settingsRevision++;
    setConfig(settings.config);
    applyStatus(settings.status);
  }

  function applyStatus(status: ISmartRankingSettings["status"]) {
    setStatus(status.message || status.state);
    setError(
      status.state === "error"
        ? status.message || "Smart ranking is unavailable."
        : ""
    );
  }

  async function refreshStatus() {
    if (pending() || dirty || statusPending || disposed) return;
    statusPending = true;
    const revision = settingsRevision;
    try {
      const settings: ISmartRankingSettings | undefined =
        await chrome.runtime.sendMessage(getSmartRankingSettings());
      if (pending() || dirty || disposed || revision !== settingsRevision)
        return;
      if (!settings?.status) {
        throw new Error("No smart ranking status response.");
      }
      applyStatus(settings.status);
    } catch (reason) {
      if (!pending() && !dirty && !disposed && revision === settingsRevision) {
        setError(`Could not refresh smart ranking status: ${String(reason)}`);
      }
    } finally {
      statusPending = false;
    }
  }

  function onStorageChanged(
    changes: { [key: string]: chrome.storage.StorageChange },
    areaName: string
  ) {
    if (areaName !== "local" || !changes.smartRankingConfig || pending())
      return;
    setPending(true);
    void loadSettings();
  }

  async function loadSettings() {
    try {
      applySettings(
        await chrome.runtime.sendMessage(getSmartRankingSettings())
      );
    } catch (reason) {
      setError(`Could not load smart ranking: ${String(reason)}`);
      setStatus("Settings unavailable");
    } finally {
      setPending(false);
    }
  }

  function saveSettings() {
    if (pending()) return;
    const next = {
      ...config(),
      endpoint: config().endpoint.trim(),
      apiKey: config().apiKey.trim(),
    };
    setError("");
    if (!next.enabled) {
      setPending(true);
      void persistSettings(next);
      return;
    }
    let permissionOrigin: string;
    try {
      permissionOrigin = getRankingPermissionOrigin(next);
      if (!next.apiKey)
        throw new Error("Enter an API Key before enabling smart ranking.");
    } catch (reason) {
      setError(String(reason));
      return;
    }
    setPending(true);
    try {
      // Request access directly from the native Save click, before any await.
      chrome.permissions.request({ origins: [permissionOrigin] }, (granted) => {
        const permissionError = chrome.runtime.lastError;
        if (permissionError || !granted) {
          setError(
            permissionError?.message ||
              "Provider access was not granted. Changes have not been saved."
          );
          setPending(false);
          return;
        }
        void persistSettings(next);
      });
    } catch (reason) {
      setError(`Could not request provider access: ${String(reason)}`);
      setPending(false);
    }
  }

  async function persistSettings(next: ISmartRankingConfig) {
    try {
      applySettings(
        await chrome.runtime.sendMessage(setSmartRankingConfig(next))
      );
    } catch (reason) {
      setError(`Could not save smart ranking: ${String(reason)}`);
    } finally {
      setPending(false);
    }
  }
}
