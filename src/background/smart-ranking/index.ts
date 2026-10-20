import { ServiceFactory } from "../../service-factory";
import { ITab } from "../../utils/check-tab";
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
import { TabRelations } from "./tab-relations";
import { RankingRequestError, requestTabRanking } from "./model-client";
import {
  applyRanking,
  createRankingInput,
  createRankingPlan,
  decayCount,
  getPublicTabMetadata,
  IDomainUsage,
  IRankingInput,
  IRankingPlan,
} from "./policy";

const CONFIG_KEY = "smartRankingConfig";
const PROVIDERS_KEY = "smartRankingProviders";
const HISTORY_KEY = "smartRankingHistory";
const CACHE_KEY = "smartRankingCache";
const TAB_RELATIONS_KEY = "smartRankingTabRelations";
const USAGE_COUNTER_KEY = "smartRankingDailyUsage";
const REQUEST_INTERVAL = 10_000;
const CACHE_DURATION = 10 * 60_000;
// Background prefetching waits for the user to settle on a page.
const PREFETCH_DWELL = 1500;
// An open popup waits this long for a late ranking update; the initial list
// appears immediately and the request continues warming the cache afterward.
const POPUP_WAIT = 2000;
const REQUEST_TIMEOUT = 8000;
const RETRY_DELAY = 60_000;
const MAX_RATE_LIMIT_DELAY = 30 * 60_000;
// Prefetches stop at this daily count, leaving room for explicit popup misses.
const DAILY_PREFETCH_LIMIT = 300;
const DAILY_REQUEST_LIMIT = 500;
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

interface IRankingSnapshot {
  tabs: ITab[];
  tabProbabilities: Record<string, number>;
}

interface IRankingFlight {
  revision: number;
  key: string;
  signature: string;
  priority: boolean;
  preempted: boolean;
  controller: AbortController;
  promise: Promise<ICachedRanking | undefined>;
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
let flight: IRankingFlight | undefined;
let refreshing = false;
let revision = 0;
let lastRequest = 0;
let retryAfter = 0;
let rateLimitDelay = RETRY_DELAY;
// Auth/config failures pause requests until the configuration changes.
let pausedRevision: number | undefined;
let dailyUsage = { day: "", count: 0 };
let lastObserved: { id: number; domain: string } | undefined;
let saveQueue = Promise.resolve();
let observationQueue = Promise.resolve();
const relations = new TabRelations();
const usage = new Map<string, IDomainUsage>();
const cache = new Map<string, ICachedRanking>();

export function initSmartRanking(): void {
  void initialize();
  chrome.tabs.onCreated.addListener((tab) => {
    queueObservation(() => relations.update(tab));
    scheduleSmartRanking();
  });
  chrome.tabs.onActivated.addListener(({ tabId }) => {
    queueObservation(() => observeTab(tabId, true));
    scheduleSmartRanking();
  });
  chrome.windows.onFocusChanged.addListener(() => {
    queueObservation(observeActiveTab);
    scheduleSmartRanking();
  });
  // Title-only changes do not affect cached plans, so they are ignored.
  chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (change.url || change.status === "complete") {
      queueObservation(async () => {
        relations.update(tab);
        if (tab.active) await observeTab(tabId);
      });
      scheduleSmartRanking();
    }
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    queueObservation(() => relations.close(tabId));
    scheduleSmartRanking();
  });
  chrome.tabs.onReplaced.addListener((addedId, removedId) => {
    queueObservation(async () => {
      const tab = await chrome.tabs.get(addedId);
      relations.replace(removedId, tab);
      if (tab.active) await observeTab(addedId);
    });
    scheduleSmartRanking();
  });
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
        USAGE_COUNTER_KEY,
      ]);
      const counter = saved[USAGE_COUNTER_KEY];
      if (
        typeof counter?.day === "string" &&
        Number.isInteger(counter.count) &&
        counter.count >= 0
      )
        dailyUsage = { day: counter.day, count: counter.count };
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
      const session = await chrome.storage.session.get([
        CACHE_KEY,
        TAB_RELATIONS_KEY,
      ]);
      if (config.enabled) {
        relations.restore(
          session[TAB_RELATIONS_KEY],
          await chrome.tabs.query({})
        );
        persistRelations();
      } else {
        await chrome.storage.session.remove(TAB_RELATIONS_KEY);
      }
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
            Object.keys(value.probabilities).length >= 1 &&
            Object.keys(value.probabilities).length <= 255 &&
            Object.entries(value.probabilities).every(
              ([id, probability]) =>
                /^tab_\d+$/.test(id) &&
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
    await observationQueue;
    config = next;
    providers = nextProviders;
    revision += 1;
    controller?.abort();
    if (timer !== undefined) clearTimeout(timer);
    cache.clear();
    lastObserved = undefined;
    retryAfter = 0;
    rateLimitDelay = RETRY_DELAY;
    pausedRevision = undefined;
    lastRequest = 0;
    persistCache();
    if (!next.enabled) {
      usage.clear();
      persistHistory();
      relations.clear();
      persistRelations();
    } else {
      queueObservation(async () => {
        relations.restore(relations.serialize(), await chrome.tabs.query({}));
        await observeActiveTab();
      });
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
  await observationQueue;
  const fallback = {
    tabs: input.visibleTabs,
    tabProbabilities: {} as Record<string, number>,
    pending: false,
  };
  if (!config.enabled) return fallback;
  const plan = createRankingPlan(input, usage, Date.now(), relations);
  if (!plan) return fallback;
  const prediction = getCachedPrediction(plan);
  if (!prediction) {
    scheduleSmartRanking();
    return { ...fallback, pending: true };
  }
  return { ...createSnapshot(input, prediction), pending: false };
}

/** An explicit popup miss requests this opening's plan without the background delay. */
export async function requestSmartRankingSnapshot(
  input: IRankingInput
): Promise<IRankingSnapshot | undefined> {
  await initialize();
  await observationQueue;
  if (!config.enabled) return;
  const requestedRevision = revision;
  const plan = createRankingPlan(input, usage, Date.now(), relations);
  if (!plan) return;
  let waitTimer: ReturnType<typeof setTimeout> | undefined;
  const prediction = await Promise.race([
    requestPrediction(plan, true, requestedRevision),
    new Promise<undefined>((resolve) => {
      waitTimer = setTimeout(() => resolve(undefined), POPUP_WAIT);
    }),
  ]);
  if (waitTimer !== undefined) clearTimeout(waitTimer);
  if (!prediction || requestedRevision !== revision || !config.enabled) return;
  return createSnapshot(input, prediction);
}

function createSnapshot(
  input: IRankingInput,
  prediction: ICachedRanking
): IRankingSnapshot {
  const tabs = applyRanking(input, prediction.probabilities);
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

function getCachedPrediction(plan: IRankingPlan): ICachedRanking | undefined {
  const prediction = cache.get(plan.key);
  if (
    prediction?.provider === config.provider &&
    prediction.endpoint === config.endpoint &&
    prediction.signature === plan.signature &&
    Date.now() - prediction.createdAt < CACHE_DURATION
  )
    return prediction;
}

export function scheduleSmartRanking(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    void refreshRanking();
  }, PREFETCH_DWELL);
}

async function refreshRanking(): Promise<void> {
  await initialize();
  await observationQueue;
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
    if (!active || active.id === undefined) return;
    const input = createRankingInput(
      registry,
      settings.isShowingTabsFromAllWindows,
      active.windowId
    );
    // The registry normally catches up within the dwell; skip a stale view.
    if (input.activeTabId !== active.id) return;
    const plan = createRankingPlan(input, usage, Date.now(), relations);
    if (!plan) return;
    await requestPrediction(plan, false, requestedRevision);
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

async function requestPrediction(
  plan: IRankingPlan,
  priority: boolean,
  requestedRevision: number
): Promise<ICachedRanking | undefined> {
  while (config.enabled && requestedRevision === revision) {
    const previous = getCachedPrediction(plan);
    if (previous) return previous;
    const current = flight;
    if (current) {
      if (
        current.revision === requestedRevision &&
        current.key === plan.key &&
        current.signature === plan.signature &&
        !current.preempted
      ) {
        if (priority) current.priority = true;
        return current.promise;
      }
      if (!priority) return;
      if (!current.priority && !current.preempted) {
        current.preempted = true;
        current.controller.abort();
      }
      // Wait for cancellation/settlement before sending another model request.
      await current.promise;
      continue;
    }
    if (pausedRevision === requestedRevision) return;
    resetDailyUsageIfNeeded();
    if (
      dailyUsage.count >=
      (priority ? DAILY_REQUEST_LIMIT : DAILY_PREFETCH_LIMIT)
    ) {
      status = {
        state: "waiting",
        message: `Daily request limit reached (${dailyUsage.count} today). Visit order is used until tomorrow.`,
      };
      return;
    }
    const wait =
      Math.max(priority ? 0 : lastRequest + REQUEST_INTERVAL, retryAfter) -
      Date.now();
    if (wait > 0) {
      if (!priority) {
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = undefined;
          void refreshRanking();
        }, wait);
      }
      return;
    }
    const next: IRankingFlight = {
      revision: requestedRevision,
      key: plan.key,
      signature: plan.signature,
      priority,
      preempted: false,
      controller: new AbortController(),
      promise: Promise.resolve(undefined),
    };
    flight = next;
    controller = next.controller;
    const requestConfig = { ...config };
    next.promise = Promise.resolve()
      .then(() => runPrediction(next, requestConfig, plan))
      .finally(() => {
        if (flight === next) flight = undefined;
        if (controller === next.controller) controller = undefined;
        if (config.enabled) scheduleSmartRanking();
      });
    return next.promise;
  }
}

async function runPrediction(
  request: IRankingFlight,
  requestConfig: ISmartRankingConfig,
  plan: IRankingPlan
): Promise<ICachedRanking | undefined> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const origin = getRankingPermissionOrigin(requestConfig);
    const granted = await chrome.permissions.contains({ origins: [origin] });
    if (request.revision !== revision || request.preempted || !config.enabled)
      return;
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
    timeout = setTimeout(() => request.controller.abort(), REQUEST_TIMEOUT);
    lastRequest = Date.now();
    countRequest();
    status = {
      state: "waiting",
      message: "Preparing predictions…",
    };
    const result = await requestTabRanking(
      requestConfig,
      plan.state,
      plan.criteria,
      request.controller.signal
    );
    if (request.revision !== revision || request.preempted || !config.enabled)
      return;
    const prediction: ICachedRanking = {
      provider: requestConfig.provider,
      endpoint: requestConfig.endpoint,
      signature: plan.signature,
      ...result,
      createdAt: Date.now(),
    };
    cache.delete(plan.key);
    cache.set(plan.key, prediction);
    while (cache.size > MAX_CACHE_ENTRIES)
      cache.delete(cache.keys().next().value!);
    persistCache();
    rateLimitDelay = RETRY_DELAY;
    status = {
      state: "ready",
      message: `Prediction ready. ${dailyUsage.count} requests today.`,
      updatedAt: Date.now(),
    };
    return prediction;
  } catch (error) {
    if (request.revision !== revision || request.preempted) return;
    handleRequestError(error, request.revision);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function handleRequestError(error: unknown, requestRevision: number): void {
  const kind = error instanceof RankingRequestError ? error.kind : "server";
  const message =
    error instanceof Error
      ? error.message
      : "Smart ranking is unavailable. Visit order is preserved.";
  if (kind === "auth" || kind === "config") {
    // Retrying cannot succeed; wait for the user to update the settings.
    pausedRevision = requestRevision;
    status = {
      state: "error",
      message: `${message} Requests are paused until settings change.`,
    };
    return;
  }
  if (kind === "rate") {
    retryAfter = Date.now() + rateLimitDelay;
    rateLimitDelay = Math.min(rateLimitDelay * 2, MAX_RATE_LIMIT_DELAY);
  } else {
    // Timeouts surface as cancellation and back off like network failures.
    retryAfter = Date.now() + RETRY_DELAY;
  }
  status = { state: "error", message };
}

function getDay(): string {
  const now = new Date();
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
}

function resetDailyUsageIfNeeded(): void {
  const day = getDay();
  if (dailyUsage.day !== day) dailyUsage = { day, count: 0 };
}

function countRequest(): void {
  resetDailyUsageIfNeeded();
  dailyUsage.count += 1;
  const snapshot = { ...dailyUsage };
  saveQueue = saveQueue
    .then(() => chrome.storage.local.set({ [USAGE_COUNTER_KEY]: snapshot }))
    .catch(() => {});
}

/** Records visits as they happen, independent of model scheduling. */
async function observeTab(
  tabId: number,
  activationEvent = false
): Promise<void> {
  await initialize();
  if (!config.enabled) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!activationEvent && !tab.active) return;
    const window = await chrome.windows.get(tab.windowId);
    if (!window.focused) return;
    relations.recordVisit(tab);
    const page = getPublicTabMetadata(tab);
    if (page) recordVisit(tabId, page.domain);
    else lastObserved = undefined;
  } catch {
    // The tab or window may have closed meanwhile.
  }
}

async function observeActiveTab(): Promise<void> {
  try {
    const [active] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (active?.id !== undefined) await observeTab(active.id);
  } catch {
    // Ignore transient window state.
  }
}

function recordVisit(tabId: number, domain: string): void {
  if (lastObserved?.id === tabId && lastObserved.domain === domain) return;
  const history = usage.get(domain) || { visits: 0, lastVisit: 0, from: {} };
  const now = Date.now();
  // Rebase every counter before advancing their shared decay timestamp.
  history.visits = Math.min(
    10000,
    decayCount(history.visits, history.lastVisit, now) + 1
  );
  for (const source of Object.keys(history.from)) {
    history.from[source] = decayCount(
      history.from[source],
      history.lastVisit,
      now
    );
  }
  history.lastVisit = now;
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

/** Serialize browser events so activation and navigation observations keep their order. */
function queueObservation(action: () => void | Promise<void>): void {
  observationQueue = observationQueue
    .then(async () => {
      await initialize();
      if (!config.enabled) return;
      await action();
      persistRelations();
    })
    .catch(() => {});
}

function persistRelations(): void {
  const snapshot = config.enabled ? relations.serialize() : undefined;
  saveQueue = saveQueue
    .then(() =>
      snapshot
        ? chrome.storage.session.set({ [TAB_RELATIONS_KEY]: snapshot })
        : chrome.storage.session.remove(TAB_RELATIONS_KEY)
    )
    .catch(() => {});
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
