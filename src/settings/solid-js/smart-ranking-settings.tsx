import { createSignal, onCleanup, onMount } from "solid-js";
import { Show } from "solid-js/web";
import styles from "./settings.module.scss";
import rankingStyles from "./smart-ranking-settings.module.scss";
import { MSwitch } from "./components/m-switch";
import {
  getSmartRankingSettings,
  setSmartRankingConfig,
  testSmartRankingConfig,
} from "../../utils/messages";
import {
  defaultSmartRankingConfig,
  defaultSmartRankingProviders,
  getRankingPermissionOrigin,
  ISmartRankingConfig,
  ISmartRankingSettings,
  ISmartRankingTestResult,
  normalizeSmartRankingProviders,
  RankingProvider,
} from "../../utils/smart-ranking";

interface IProps {
  active: boolean;
}

export function SmartRankingSettings(props: IProps) {
  const [config, setConfig] = createSignal<ISmartRankingConfig>({
    ...defaultSmartRankingConfig,
  });
  const [providers, setProviders] = createSignal<
    ISmartRankingSettings["providers"]
  >(
    normalizeSmartRankingProviders(
      defaultSmartRankingProviders,
      defaultSmartRankingConfig
    )
  );
  const [status, setStatus] = createSignal("Loading settings…");
  const [pending, setPending] = createSignal(true);
  const [pendingAction, setPendingAction] = createSignal<
    "load" | "test" | "save"
  >("load");
  const [testResult, setTestResult] = createSignal<ISmartRankingTestResult>();
  const [error, setError] = createSignal("");
  let dirty = false;
  let statusPending = false;
  let disposed = false;
  let settingsRevision = 0;
  let operationId = 0;
  let statusTimer: ReturnType<typeof setInterval> | undefined;

  onMount(() => {
    chrome.storage.onChanged.addListener(onStorageChanged);
    statusTimer = setInterval(() => void refreshStatus(), 3000);
    void loadSettings();
  });
  onCleanup(() => {
    disposed = true;
    if (statusTimer !== undefined) clearInterval(statusTimer);
    chrome.storage.onChanged.removeListener(onStorageChanged);
  });

  return (
    <div class={rankingStyles.settings}>
      <div class={`${styles.settings__row} ${rankingStyles.toggleRow}`}>
        <label for="smartRankingEnabled" class={styles.settings__label}>
          <i class={styles.iconInLabel}>sort</i>
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
            const provider = event.currentTarget.value as RankingProvider;
            updateConfig({
              provider,
              ...providers()[provider],
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
        When enabled, public tab titles, domains, local time and usage
        statistics are sent to the selected provider. Screenshots and full URLs
        are not sent. The API Key is stored locally. Changes apply after Save.
        Test sends a small sample request without saving or enabling smart
        ranking.
      </p>
      <div class={rankingStyles.actions}>
        <span class={rankingStyles.status} role="status" aria-live="polite">
          {pending()
            ? pendingAction() === "test"
              ? "Testing…"
              : pendingAction() === "save"
              ? "Saving…"
              : "Loading…"
            : testResult()
            ? `${testResult()!.ok ? "Test passed" : "Test failed"}: ${
                testResult()!.message
              }${
                testResult()!.elapsedMs !== undefined
                  ? ` (${testResult()!.elapsedMs} ms)`
                  : ""
              }`
            : status()}
        </span>
        <span class={rankingStyles.buttons}>
          <button
            type="button"
            class={rankingStyles.save}
            disabled={pending()}
            on:click={() => startAction("test")}
          >
            Test
          </button>
          <button
            type="button"
            class={rankingStyles.save}
            disabled={pending()}
            on:click={() => startAction("save")}
          >
            Save
          </button>
        </span>
      </div>
      <Show when={error()}>
        <p class={rankingStyles.error} role="alert">
          {error()}
        </p>
      </Show>
    </div>
  );

  function updateConfig(change: Partial<ISmartRankingConfig>) {
    dirty = true;
    settingsRevision++;
    const next = { ...config(), ...change };
    setConfig(next);
    setProviders((previous) => ({
      ...previous,
      [next.provider]: { endpoint: next.endpoint, apiKey: next.apiKey },
    }));
    setTestResult(undefined);
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
    setProviders(
      normalizeSmartRankingProviders(settings.providers, settings.config)
    );
    setTestResult(undefined);
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
    if (
      !props.active ||
      pending() ||
      dirty ||
      testResult() ||
      statusPending ||
      disposed
    )
      return;
    statusPending = true;
    const revision = settingsRevision;
    try {
      const settings: ISmartRankingSettings | undefined =
        await chrome.runtime.sendMessage(getSmartRankingSettings());
      if (
        !props.active ||
        pending() ||
        dirty ||
        testResult() ||
        disposed ||
        revision !== settingsRevision
      )
        return;
      if (!settings?.status) {
        throw new Error("No smart ranking status response.");
      }
      applyStatus(settings.status);
    } catch (reason) {
      if (
        props.active &&
        !pending() &&
        !dirty &&
        !testResult() &&
        !disposed &&
        revision === settingsRevision
      ) {
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
    if (
      areaName !== "local" ||
      (!changes.smartRankingConfig && !changes.smartRankingProviders) ||
      pending() ||
      dirty ||
      testResult()
    )
      return;
    void loadSettings();
  }

  async function loadSettings() {
    const operation = ++operationId;
    const revision = ++settingsRevision;
    setPendingAction("load");
    setPending(true);
    try {
      const settings = await chrome.runtime.sendMessage(
        getSmartRankingSettings()
      );
      if (isCurrentOperation(operation, revision)) applySettings(settings);
    } catch (reason) {
      if (isCurrentOperation(operation, revision)) {
        setError(`Could not load smart ranking: ${String(reason)}`);
        setStatus("Settings unavailable");
      }
    } finally {
      if (!disposed && operation === operationId) setPending(false);
    }
  }

  function startAction(action: "test" | "save") {
    if (pending()) return;
    const next = {
      ...config(),
      endpoint: config().endpoint.trim(),
      apiKey: config().apiKey.trim(),
    };
    const profiles = normalizeSmartRankingProviders(providers(), next);
    setError("");
    setTestResult(undefined);
    let permissionOrigin: string;
    if (action === "test" || next.enabled) {
      try {
        permissionOrigin = getRankingPermissionOrigin(next);
        if (!next.apiKey) throw new Error("Enter an API Key first.");
      } catch (reason) {
        reportActionError(action, String(reason));
        return;
      }
    }
    const operation = ++operationId;
    const revision = ++settingsRevision;
    setPendingAction(action);
    setPending(true);
    if (action === "save" && !next.enabled) {
      void performAction(action, next, profiles, operation, revision);
      return;
    }
    try {
      // Keep either permission request inside its native button click.
      chrome.permissions.request(
        { origins: [permissionOrigin!] },
        (granted) => {
          const permissionError = chrome.runtime.lastError;
          if (!isCurrentOperation(operation, revision)) return;
          if (permissionError || !granted) {
            reportActionError(
              action,
              permissionError?.message || "Provider access was not granted."
            );
            setPending(false);
            return;
          }
          void performAction(action, next, profiles, operation, revision);
        }
      );
    } catch (reason) {
      if (isCurrentOperation(operation, revision)) {
        reportActionError(
          action,
          `Could not request provider access: ${String(reason)}`
        );
        setPending(false);
      }
    }
  }

  async function performAction(
    action: "test" | "save",
    next: ISmartRankingConfig,
    profiles: ISmartRankingSettings["providers"],
    operation: number,
    revision: number
  ) {
    try {
      if (action === "test") {
        const result: ISmartRankingTestResult =
          await chrome.runtime.sendMessage(testSmartRankingConfig(next));
        if (!isCurrentOperation(operation, revision)) return;
        if (!result || typeof result.ok !== "boolean") {
          throw new Error(
            "No connection test response. Reload the extension and try again."
          );
        }
        setTestResult(result);
      } else {
        const settings = await chrome.runtime.sendMessage(
          setSmartRankingConfig(next, profiles)
        );
        if (!isCurrentOperation(operation, revision)) return;
        if (!settings?.config || !settings.status) {
          throw new Error(
            "No settings response. Reload the extension and try again."
          );
        }
        if (settings.status.state === "error") {
          applyStatus(settings.status);
        } else {
          applySettings(settings);
        }
      }
    } catch (reason) {
      if (isCurrentOperation(operation, revision)) {
        reportActionError(
          action,
          `Could not ${
            action === "test" ? "test connection" : "save smart ranking"
          }: ${String(reason)}`
        );
      }
    } finally {
      if (!disposed && operation === operationId) setPending(false);
    }
  }

  function isCurrentOperation(operation: number, revision: number) {
    return (
      !disposed && operation === operationId && revision === settingsRevision
    );
  }

  function reportActionError(action: "test" | "save", message: string) {
    if (action === "test") {
      setTestResult({ ok: false, message });
      setError("");
    } else {
      setError(message);
    }
  }
}
