import { ITab } from "../../utils/check-tab";

// Keep candidate selection, model context and promotion rules in this module.
const MAX_CANDIDATES = 20;
// Domain statistics lose half their weight every two weeks.
const USAGE_HALF_LIFE = 14 * 24 * 60 * 60_000;
const PRIVATE_PAGE = { title: "Private or browser page", domain: "private" };

export interface IDomainUsage {
  visits: number;
  lastVisit: number;
  from: Record<string, number>;
}

export interface IRankingInput {
  recentTabs: ITab[]; // Most recently used first, already filtered by window scope.
  visibleTabs: ITab[];
  pinnedTabIds: number[];
  activeTabId?: number;
  previousTabId?: number;
  scope: string;
}

export interface IRankingPlan {
  key: string;
  signature: string;
  candidates: ITab[];
  criteria: Record<string, string>;
  state: unknown;
}

/** The registry surface needed to build ranking input. */
export interface IRankingRegistry {
  getTabs(): ITab[];
  getTabsToShow(filter?: (tab: ITab) => boolean): ITab[];
  getPinnedTabIds(): number[];
}

/**
 * Builds the same input for popup snapshots and background prefetching, so
 * both produce identical plan keys and signatures and share cached results.
 */
export function createRankingInput(
  registry: IRankingRegistry,
  isShowingTabsFromAllWindows: boolean,
  windowId?: number
): IRankingInput {
  const isInScope = (tab: ITab) =>
    isShowingTabsFromAllWindows || tab.windowId === windowId;
  const recentTabs = registry.getTabs().filter(isInScope).reverse();
  return {
    recentTabs,
    visibleTabs: registry.getTabsToShow(isInScope),
    pinnedTabIds: registry.getPinnedTabIds(),
    activeTabId: recentTabs[0]?.id,
    previousTabId: recentTabs[1]?.id,
    scope: isShowingTabsFromAllWindows ? "all" : String(windowId),
  };
}

export function getPublicTabMetadata(tab: chrome.tabs.Tab) {
  if (tab.incognito) return;
  try {
    const url = new URL(tab.url || tab.pendingUrl || "");
    const domain = url.hostname.toLowerCase();
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !domain.includes(".") ||
      domain.includes(":") ||
      /^[\d.]+$/.test(domain) ||
      /\.(?:localhost|local|internal|lan|corp|test|invalid)$/.test(domain)
    )
      return;
    return { title: (tab.title || domain).slice(0, 180), domain };
  } catch {
    return;
  }
}

/** Applies exponential decay so stale habits fade instead of dominating. */
export function decayCount(count: number, since: number, now: number): number {
  const elapsed = Math.max(0, now - since);
  return count * Math.pow(0.5, elapsed / USAGE_HALF_LIFE);
}

export function createRankingPlan(
  input: IRankingInput,
  usage: Map<string, IDomainUsage>,
  now = Date.now()
): IRankingPlan | undefined {
  const current = input.recentTabs.find((tab) => tab.id === input.activeTabId);
  if (!current) return;
  // Private current pages are summarized so ranking still works from them.
  const currentPage = getPublicTabMetadata(current) || PRIVATE_PAGE;
  const getVisits = (history?: IDomainUsage) =>
    history ? decayCount(history.visits, history.lastVisit, now) : 0;
  const getTransitions = (history?: IDomainUsage) =>
    history && currentPage !== PRIVATE_PAGE
      ? decayCount(
          history.from[currentPage.domain] || 0,
          history.lastVisit,
          now
        )
      : 0;
  const candidates = input.recentTabs
    .map((tab, index) => {
      const page = getPublicTabMetadata(tab);
      const history = page && usage.get(page.domain);
      return {
        tab,
        page,
        score:
          1 / (index + 1) +
          Math.log1p(getVisits(history)) * 0.1 +
          Math.log1p(getTransitions(history)) * 0.2,
      };
    })
    .filter(({ tab, page }) => page && tab.id !== current.id)
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_CANDIDATES)
    .map(({ tab }) => tab);
  if (!candidates.length) return;
  const criteria: Record<string, string> = {};
  const candidateState = candidates.map((tab) => {
    const page = getPublicTabMetadata(tab)!;
    const history = usage.get(page.domain);
    const id = `tab_${tab.id}`;
    criteria[id] = `${page.title} (${page.domain})`;
    return {
      id,
      ...page,
      recentRank: input.recentTabs.findIndex((item) => item.id === tab.id),
      minutesSinceDomainVisit: history
        ? Math.round(Math.max(0, now - history.lastVisit) / 60_000)
        : null,
      domainVisits: Math.round(getVisits(history) * 10) / 10,
      transitionsFromCurrentDomain:
        Math.round(getTransitions(history) * 10) / 10,
    };
  });
  const time = new Date(now);
  return {
    key: `${input.scope}:${current.id}`,
    // Titles change constantly (unread counters, timers, media). Keying the
    // cache on tab identity and domains avoids re-requesting for each change.
    signature: JSON.stringify([
      current.id,
      currentPage.domain,
      input.pinnedTabIds,
      candidates.map((tab) => [tab.id, getPublicTabMetadata(tab)!.domain]),
      input.recentTabs.map((tab) => tab.id),
    ]),
    candidates,
    criteria,
    state: {
      current: currentPage,
      localTime: { hour: time.getHours(), weekday: time.getDay() },
      recentVisits: input.recentTabs
        .map(getPublicTabMetadata)
        .filter(Boolean)
        .slice(0, 6),
      candidates: candidateState,
    },
  };
}

/**
 * Sorts predicted candidates by probability, breaking ties by visit order.
 * Pinned tabs, the current and previous tabs, and tabs without predictions
 * keep their original positions.
 */
export function applyRanking(
  input: IRankingInput,
  probabilities: Record<string, number>
): ITab[] {
  const protectedIds = new Set([
    ...input.pinnedTabIds,
    input.activeTabId,
    input.previousTabId,
  ]);
  const getProbability = (tab: ITab) => probabilities[`tab_${tab.id}`];
  const slots: number[] = [];
  input.visibleTabs.forEach((tab, index) => {
    if (!protectedIds.has(tab.id) && typeof getProbability(tab) === "number") {
      slots.push(index);
    }
  });
  if (!slots.length) return input.visibleTabs;
  // Include candidates beyond the visible limit, starting in visit order.
  const ordered = input.recentTabs
    .filter(
      (tab) =>
        !protectedIds.has(tab.id) && typeof getProbability(tab) === "number"
    )
    // Stable sorting preserves visit order for equal probabilities, including zero.
    .sort((left, right) => getProbability(right) - getProbability(left));
  const result = input.visibleTabs.slice();
  slots.forEach((slot, index) => {
    result[slot] = ordered[index];
  });
  return result;
}
