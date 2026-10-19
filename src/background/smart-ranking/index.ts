import { ServiceFactory } from "../../service-factory";
import {
  defaultSmartRankingConfig,
  defaultSmartRankingProviders,
  getRankingPermissionOrigin,
  ISmartRankingConfig,
  ISmartRankingSettings,
  ISmartRankingStatus,
  isValidRankingProbabilitySum,
  normalizeSmartRankingConfig,
  normalizeSmartRankingProviders,
} from "../../utils/smart-ranking";
import { requestTabRanking } from "./model-client";
import {
  applyRanking,
  createRankingPlan,
  getPublicTabMetadata,
  IDomainUsage,
  IRankingInput,
} from "./policy";

const CONFIG_KEY = "smartRankingConfig";
const PROVIDERS_KEY = "smartRankingProviders";
const HISTORY_KEY = "smartRankingHistory";
const CACHE_KEY = "smartRankingCache";
const REQUEST_INTERVAL = 10_000;
const CACHE_DURATION = 5 * 60_000;
const MAX_CACHE_ENTRIES = 8;
const MAX_DOMAINS = 100;

interface ICachedRanking {
  provider: ISmartRankingConfig["provider"];
  endpoint: string;
  signature: string;
  probabilities: Record<string, number>;
  confidence: number;
  createdAt: number;
}

let config = { ...defaultSmartRankingConfig };
let providers = normalizeSmartRankingProviders(undefined, config);
let status: ISmartRankingStatus = {
  state: "off",
  message: "Smart ranking is off.",
};
let initialization: Promise<void> | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let controller: AbortController | undefined;
let refreshing = false;
let revision = 0;
let lastRequest = 0;
let retryAfter = 0;
let lastObserved: { id: number; domain: string } | undefined;
let saveQueue = Promise.resolve();
const usage = new Map<string, IDomainUsage>();
const cache = new Map<string, ICachedRanking>();

export function initSmartRanking(): void {
  void initialize();
  chrome.tabs.onActivated.addListener(() => scheduleSmartRanking());
  chrome.windows.onFocusChanged.addListener(() => scheduleSmartRanking());
  chrome.tabs.onUpdated.addListener((_id, change) => {
    if (
      change.title !== undefined ||
      change.url ||
      change.status === "complete"
    )
      scheduleSmartRanking();
  });
  chrome.tabs.onRemoved.addListener(() => scheduleSmartRanking());
  chrome.permissions.onRemoved.addListener(() => {
    revision += 1;
    controller?.abort();
    cache.clear();
    persistCache();
    scheduleSmartRanking();
  });
  scheduleSmartRanking();
}

function initialize(): Promise<void> {
  if (!initialization) {
    initialization = (async () => {
      // Credentials are available to extension pages and the worker, not injected scripts.
      await chrome.storage.local.setAccessLevel({
        accessLevel: "TRUSTED_CONTEXTS",
      });
      const saved = await chrome.storage.local.get([
        CONFIG_KEY,
        PROVIDERS_KEY,
        HISTORY_KEY,
      ]);
      // Replace only the former default, preserving credentials and custom endpoints.
      const legacyEndpoint =
        "https://dashscope.aliyuncs.com/compatible-mode/v1/systemone";
      const endpoint = defaultSmartRankingProviders.bailian.endpoint;
      const migrated: Record<string, unknown> = {};
      if (
        saved[CONFIG_KEY]?.provider === "bailian" &&
        saved[CONFIG_KEY]?.endpoint === legacyEndpoint
      ) {
        saved[CONFIG_KEY] = { ...saved[CONFIG_KEY], endpoint };
        migrated[CONFIG_KEY] = saved[CONFIG_KEY];
      }
      if (saved[PROVIDERS_KEY]?.bailian?.endpoint === legacyEndpoint) {
        saved[PROVIDERS_KEY] = {
          ...saved[PROVIDERS_KEY],
          bailian: { ...saved[PROVIDERS_KEY].bailian, endpoint },
        };
        migrated[PROVIDERS_KEY] = saved[PROVIDERS_KEY];
      }
      if (Object.keys(migrated).length) {
        await chrome.storage.local.set(migrated);
      }
      config = normalizeSmartRankingConfig(saved[CONFIG_KEY]);
      providers = normalizeSmartRankingProviders(saved[PROVIDERS_KEY], config);
      if (Array.isArray(saved[HISTORY_KEY])) {
        for (const entry of saved[HISTORY_KEY].slice(0, MAX_DOMAINS)) {
          if (
            Array.isArray(entry) &&
            typeof entry[0] === "string" &&
            entry[0].length <= 253 &&
            Number.isFinite(entry[1]?.visits) &&
            entry[1].visits >= 0 &&
            entry[1].visits <= 10000 &&
            Number.isFinite(entry[1]?.lastVisit) &&
            entry[1]?.from &&
            typeof entry[1].from === "object"
          ) {
            const from: Record<string, number> = {};
            for (const [domain, count] of Object.entries(entry[1].from).slice(
              0,
              MAX_DOMAINS
            )) {
              if (
                domain.includes(".") &&
                typeof count === "number" &&
                Number.isFinite(count) &&
                count >= 0 &&
                count <= 10000
              )
                from[domain] = count;
            }
            usage.set(entry[0], {
              visits: entry[1].visits,
              lastVisit: entry[1].lastVisit,
              from,
            });
          }
        }
      }
      const session = await chrome.storage.session.get(CACHE_KEY);
      if (Array.isArray(session[CACHE_KEY])) {
        for (const entry of session[CACHE_KEY].slice(-MAX_CACHE_ENTRIES)) {
          if (!Array.isArray(entry)) continue;
          const [key, value] = entry;
          if (
            typeof key === "string" &&
            value &&
            value.provider === config.provider &&
            value.endpoint === config.endpoint &&
            typeof value.signature === "string" &&
            value.createdAt <= Date.now() &&
            Date.now() - value.createdAt < CACHE_DURATION &&
            Number.isFinite(value.confidence) &&
            value.confidence >= 0 &&
            value.confidence <= 1 &&
            value.probabilities &&
            typeof value.probabilities === "object" &&
            Object.keys(value.probabilities).length >= 2 &&
            Object.keys(value.probabilities).length <= 255 &&
            Object.prototype.hasOwnProperty.call(
              value.probabilities,
              "other"
            ) &&
            Object.entries(value.probabilities).every(
              ([id, probability]) =>
                /^(?:tab_\d+|other)$/.test(id) &&
                typeof probability === "number" &&
                Number.isFinite(probability) &&
                probability >= 0 &&
                probability <= 1
            ) &&
            isValidRankingProbabilitySum(value.probabilities, config.provider)
          )
            cache.set(key, value);
        }
      }
      status = config.enabled
        ? {
            state: "waiting",
            message: "Waiting for a prediction for the active tab.",
          }
        : { state: "off", message: "Smart ranking is off." };
    })().catch(() => {
      status = {
        state: "error",
        message: "Could not load smart ranking settings.",
      };
    });
  }
  return initialization;
}

export async function getSmartRankingSettings(): Promise<ISmartRankingSettings> {
  await initialize();
  return {
    config: { ...config },
    providers: normalizeSmartRankingProviders(providers, config),
    status: { ...status },
  };
}

export async function saveSmartRankingConfig(
  value: unknown,
  providerValues?: unknown
): Promise<ISmartRankingSettings> {
  await initialize();
  try {
    const next = normalizeSmartRankingConfig(value);
    const nextProviders = normalizeSmartRankingProviders(
      providerValues,
      next,
      providers
    );
    if (next.enabled) {
      const origin = getRankingPermissionOrigin(next);
      if (!next.apiKey)
        throw new Error("Enter an API Key before enabling smart ranking.");
      if (!(await chrome.permissions.contains({ origins: [origin] })))
        throw new Error("Grant access to the selected provider before saving.");
    }
    await chrome.storage.local.set({
      [CONFIG_KEY]: next,
      [PROVIDERS_KEY]: nextProviders,
    });
    config = next;
    providers = nextProviders;
    revision += 1;
    controller?.abort();
    clearTimeout(timer);
    cache.clear();
    lastObserved = undefined;
    retryAfter = 0;
    lastRequest = 0;
    persistCache();
    if (!next.enabled) {
      usage.clear();
      persistHistory();
    }
    status = next.enabled
      ? {
          state: "waiting",
          message: "Saved. Predictions are prepared in the background.",
        }
      : { state: "off", message: "Saved. Smart ranking is off." };
    scheduleSmartRanking();
  } catch (error) {
    status = {
      state: "error",
      message:
        error instanceof Error
          ? error.message
          : "Could not save smart ranking.",
    };
  }
  return getSmartRankingSettings();
}

export async function resetSmartRanking(): Promise<void> {
  await saveSmartRankingConfig(
    defaultSmartRankingConfig,
    defaultSmartRankingProviders
  );
}

/** Reading the cache never waits for a model or pushes changes into an open popup. */
export async function getSmartRankingSnapshot(input: IRankingInput) {
  await initialize();
  const fallback = {
    tabs: input.visibleTabs,
    tabProbabilities: {} as Record<string, number>,
  };
  if (!config.enabled) return fallback;
  const plan = createRankingPlan(input, usage);
  if (!plan) return fallback;
  const prediction = cache.get(plan.key);
  if (
    !prediction ||
    prediction.signature !== plan.signature ||
    Date.now() - prediction.createdAt >= CACHE_DURATION
  ) {
    scheduleSmartRanking();
    return fallback;
  }
  const tabs = applyRanking(
    input,
    prediction.probabilities,
    prediction.confidence
  );
  const tabProbabilities: Record<string, number> = {};
  for (const tab of tabs) {
    const probability = prediction.probabilities[`tab_${tab.id}`];
    if (
      typeof probability === "number" &&
      Number.isFinite(probability) &&
      probability >= 0 &&
      probability <= 1
    )
      tabProbabilities[String(tab.id)] = probability;
  }
  return { tabs, tabProbabilities };
}

export function scheduleSmartRanking(): void {
  clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    void refreshRanking();
  }, 700);
}

async function refreshRanking(): Promise<void> {
  await initialize();
  if (!config.enabled || refreshing) return;
  refreshing = true;
  const requestedRevision = revision;
  const requestConfig = { ...config };
  try {
    const origin = getRankingPermissionOrigin(requestConfig);
    const granted = await chrome.permissions.contains({ origins: [origin] });
    if (requestedRevision !== revision) return;
    if (!requestConfig.apiKey || !granted) {
      cache.clear();
      persistCache();
      status = {
        state: "unconfigured",
        message:
          "Save an API Key and grant provider access to enable predictions.",
      };
      return;
    }
    const [settings, registry, activeTabs] = await Promise.all([
      ServiceFactory.getSettings(),
      ServiceFactory.getTabRegistry(),
      chrome.tabs.query({ active: true, lastFocusedWindow: true }),
    ]);
    if (requestedRevision !== revision) return;
    const active = activeTabs[0];
    const page = active && getPublicTabMetadata(active);
    if (!active || active.id === undefined || !page) return;
    recordVisit(active.id, page.domain);
    const isInScope = (tab: chrome.tabs.Tab) =>
      settings.isShowingTabsFromAllWindows || tab.windowId === active.windowId;
    const recentTabs = registry.getTabs().filter(isInScope).reverse();
    const input: IRankingInput = {
      recentTabs,
      visibleTabs: registry.getTabsToShow(isInScope),
      pinnedTabIds: registry.getPinnedTabIds(),
      activeTabId: active.id,
      previousTabId: recentTabs.find((tab) => tab.id !== active.id)?.id,
      scope: settings.isShowingTabsFromAllWindows
        ? "all"
        : String(active.windowId),
    };
    const plan = createRankingPlan(input, usage);
    if (!plan) return;
    const previous = cache.get(plan.key);
    if (
      previous?.signature === plan.signature &&
      Date.now() - previous.createdAt < CACHE_DURATION
    )
      return;
    const wait =
      Math.max(lastRequest + REQUEST_INTERVAL, retryAfter) - Date.now();
    if (wait > 0) {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void refreshRanking();
      }, wait);
      return;
    }
    const requestController = new AbortController();
    controller = requestController;
    const timeout = setTimeout(() => requestController.abort(), 8000);
    lastRequest = Date.now();
    status = {
      state: "waiting",
      message: "Preparing predictions in the background…",
    };
    try {
      const result = await requestTabRanking(
        requestConfig,
        plan.state,
        plan.criteria,
        requestController.signal
      );
      if (requestedRevision !== revision || !config.enabled) return;
      cache.delete(plan.key);
      cache.set(plan.key, {
        provider: requestConfig.provider,
        endpoint: requestConfig.endpoint,
        signature: plan.signature,
        ...result,
        createdAt: Date.now(),
      });
      while (cache.size > MAX_CACHE_ENTRIES)
        cache.delete(cache.keys().next().value!);
      persistCache();
      status = {
        state: "ready",
        message: "Prediction ready. Applies the next time the popup opens.",
        updatedAt: Date.now(),
      };
    } catch (error) {
      if (requestedRevision !== revision) return;
      retryAfter = Date.now() + 60_000;
      status = {
        state: "error",
        message:
          error instanceof Error
            ? error.message
            : "Smart ranking is unavailable. Visit order is preserved.",
      };
    } finally {
      clearTimeout(timeout);
      controller = undefined;
      if (config.enabled) scheduleSmartRanking();
    }
  } catch {
    if (requestedRevision !== revision) return;
    status = {
      state: "error",
      message: "Could not prepare smart ranking. Visit order is preserved.",
    };
  } finally {
    refreshing = false;
    if (requestedRevision !== revision && config.enabled)
      scheduleSmartRanking();
  }
}

function recordVisit(tabId: number, domain: string): void {
  if (lastObserved?.id === tabId && lastObserved.domain === domain) return;
  const history = usage.get(domain) || { visits: 0, lastVisit: 0, from: {} };
  history.visits = Math.min(10000, history.visits + 1);
  history.lastVisit = Date.now();
  if (lastObserved && lastObserved.id !== tabId) {
    history.from[lastObserved.domain] = Math.min(
      10000,
      (history.from[lastObserved.domain] || 0) + 1
    );
    const domains = Object.keys(history.from);
    if (domains.length > MAX_DOMAINS) delete history.from[domains[0]];
  }
  usage.delete(domain);
  usage.set(domain, history);
  lastObserved = { id: tabId, domain };
  while (usage.size > MAX_DOMAINS) usage.delete(usage.keys().next().value!);
  persistHistory();
}

function persistHistory(): void {
  const history = JSON.parse(JSON.stringify(Array.from(usage)));
  saveQueue = saveQueue
    .then(() => chrome.storage.local.set({ [HISTORY_KEY]: history }))
    .catch(() => {});
}

function persistCache(): void {
  const predictions = Array.from(cache);
  saveQueue = saveQueue
    .then(() => chrome.storage.session.set({ [CACHE_KEY]: predictions }))
    .catch(() => {});
}
