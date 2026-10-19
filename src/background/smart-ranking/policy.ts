import { ITab } from "../../utils/check-tab";

// Keep candidate selection, model context and promotion rules in this module.
const MAX_CANDIDATES = 20;

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

export function createRankingPlan(
  input: IRankingInput,
  usage: Map<string, IDomainUsage>
): IRankingPlan | undefined {
  const current = input.recentTabs.find((tab) => tab.id === input.activeTabId);
  const currentPage = current && getPublicTabMetadata(current);
  if (!current || !currentPage) return;
  const candidates = input.recentTabs
    .map((tab, index) => {
      const page = getPublicTabMetadata(tab);
      const history = page && usage.get(page.domain);
      return {
        tab,
        page,
        score:
          1 / (index + 1) +
          Math.log1p(history?.visits || 0) * 0.1 +
          Math.log1p(history?.from[currentPage.domain] || 0) * 0.2,
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
      domainVisits: history?.visits || 0,
      transitionsFromCurrentDomain: history?.from[currentPage.domain] || 0,
    };
  });
  return {
    key: `${input.scope}:${current.id}`,
    signature: JSON.stringify([
      current.id,
      current.url,
      currentPage,
      input.pinnedTabIds,
      candidates.map((tab) => [tab.id, tab.url, tab.title]),
      input.recentTabs.map((tab) => tab.id),
    ]),
    candidates,
    criteria,
    state: {
      current: currentPage,
      recentVisits: input.recentTabs
        .map(getPublicTabMetadata)
        .filter(Boolean)
        .slice(0, 6),
      candidates: candidateState,
    },
  };
}

export function applyRanking(
  input: IRankingInput,
  probabilities: Record<string, number>
): ITab[] {
  const protectedIds = new Set([
    ...input.pinnedTabIds,
    input.activeTabId,
    input.previousTabId,
  ]);
  const candidates = input.recentTabs
    .filter(
      (tab) =>
        !protectedIds.has(tab.id) &&
        typeof probabilities[`tab_${tab.id}`] === "number"
    )
    // Stable sorting preserves visit order when probabilities are equal, including zero.
    .sort(
      (left, right) =>
        probabilities[`tab_${right.id}`] - probabilities[`tab_${left.id}`]
    );
  if (!candidates.length) return input.visibleTabs;
  const candidateIds = new Set(candidates.map((tab) => tab.id));
  const ordinaryTabs = [
    ...candidates,
    ...input.visibleTabs.filter(
      (tab) => !protectedIds.has(tab.id) && !candidateIds.has(tab.id)
    ),
  ];
  // Leave pins and both navigation anchors in their original positions.
  return input.visibleTabs.map((tab) =>
    protectedIds.has(tab.id) ? tab : ordinaryTabs.shift()!
  );
}
