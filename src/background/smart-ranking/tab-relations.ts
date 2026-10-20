import {
  decayCount,
  getPublicTabMetadata,
  IRankingTabFeatures,
} from "./policy";

const MAX_TABS = 500;
const MAX_TRANSITIONS = 1000;

interface IRelatedTab {
  id: number;
  // Used locally to reset visit statistics on navigation; never sent to the model.
  url: string;
  openerTabId?: number;
  visits: number;
  lastVisit?: number;
  closed: boolean;
}

interface ITabTransition {
  from: number;
  to: number;
  count: number;
  updatedAt: number;
}

export interface ITabRelationsState {
  version: 1;
  revision: number;
  tabs: IRelatedTab[];
  transitions: ITabTransition[];
  lastActiveId?: number;
}

/** Session-only tab lineage and page-specific usage within each tab. */
export class TabRelations {
  revision = 0;
  private tabs = new Map<number, IRelatedTab>();
  private transitions = new Map<string, ITabTransition>();
  private lastActiveId: number | undefined;

  restore(value: unknown, openTabs: chrome.tabs.Tab[]): void {
    this.clear();
    const state = value as Partial<ITabRelationsState> | undefined;
    if (state?.version === 1 && Array.isArray(state.tabs)) {
      this.revision = validId(state.revision) ? state.revision : 0;
      for (const tab of state.tabs.slice(-MAX_TABS)) {
        if (
          !tab ||
          !validId(tab.id) ||
          typeof tab.url !== "string" ||
          !getPublicTabMetadata({ url: tab.url }) ||
          !validCount(tab.visits) ||
          (tab.lastVisit !== undefined && !validTime(tab.lastVisit))
        )
          continue;
        this.tabs.set(tab.id, {
          id: tab.id,
          url: tab.url,
          visits: tab.visits,
          lastVisit: tab.lastVisit,
          closed: true,
        });
      }
      // Add links only after all nodes exist, rejecting malformed cycles.
      for (const tab of state.tabs.slice(-MAX_TABS)) {
        if (tab && validId(tab.openerTabId))
          this.setOpener(tab.id, tab.openerTabId, true);
      }
      if (Array.isArray(state.transitions)) {
        for (const edge of state.transitions.slice(-MAX_TRANSITIONS)) {
          if (
            edge &&
            this.tabs.has(edge.from) &&
            this.tabs.has(edge.to) &&
            edge.from !== edge.to &&
            validCount(edge.count) &&
            validTime(edge.updatedAt)
          )
            this.transitions.set(edgeKey(edge.from, edge.to), { ...edge });
        }
      }
      if (validId(state.lastActiveId)) this.lastActiveId = state.lastActiveId;
    }
    // Parents can occur later than children in the browser's tab order.
    for (const tab of openTabs) this.update(tab);
    for (const tab of openTabs) this.captureOpener(tab);
    if (
      !openTabs.some(
        (tab) =>
          tab.id === this.lastActiveId &&
          tab.active &&
          getPublicTabMetadata(tab)
      )
    )
      this.lastActiveId = undefined;
  }

  serialize(): ITabRelationsState {
    return {
      version: 1,
      revision: this.revision,
      tabs: Array.from(this.tabs.values(), (tab) => ({ ...tab })),
      transitions: Array.from(this.transitions.values(), (edge) => ({
        ...edge,
      })),
      lastActiveId: this.lastActiveId,
    };
  }

  clear(): void {
    this.tabs.clear();
    this.transitions.clear();
    this.lastActiveId = undefined;
    this.revision += 1;
  }

  /** Do not bridge actual switches through private, local or browser pages. */
  breakVisitChain(): void {
    this.lastActiveId = undefined;
  }

  update(tab: chrome.tabs.Tab): void {
    if (!validId(tab.id)) return;
    if (!getPublicTabMetadata(tab)) {
      this.forget(tab.id);
      return;
    }
    const url = tab.url || tab.pendingUrl!;
    let node = this.tabs.get(tab.id);
    if (!node) {
      node = { id: tab.id, url, visits: 0, closed: false };
      this.tabs.set(tab.id, node);
      this.revision += 1;
    } else if (node.url !== url) {
      node.url = url;
      node.visits = 0;
      node.lastVisit = undefined;
      this.removeTransitions(tab.id);
      if (this.lastActiveId === tab.id) this.lastActiveId = undefined;
      this.revision += 1;
    }
    node.closed = false;
    this.captureOpener(tab);
    this.trim();
  }

  recordVisit(tab: chrome.tabs.Tab, now = Date.now()): void {
    this.update(tab);
    const node = tab.id === undefined ? undefined : this.tabs.get(tab.id);
    if (!node) {
      this.breakVisitChain();
      return;
    }
    if (this.lastActiveId === node.id) return;
    if (this.lastActiveId !== undefined && this.tabs.has(this.lastActiveId)) {
      const key = edgeKey(this.lastActiveId, node.id);
      const edge = this.transitions.get(key);
      this.transitions.delete(key);
      this.transitions.set(key, {
        from: this.lastActiveId,
        to: node.id,
        count: Math.min(
          10000,
          (edge ? decayCount(edge.count, edge.updatedAt, now) : 0) + 1
        ),
        updatedAt: now,
      });
    }
    node.visits = Math.min(
      10000,
      (node.lastVisit === undefined
        ? 0
        : decayCount(node.visits, node.lastVisit, now)) + 1
    );
    node.lastVisit = now;
    this.lastActiveId = node.id;
    this.revision += 1;
    this.trim();
  }

  close(tabId: number): void {
    const node = this.tabs.get(tabId);
    if (!node || node.closed) return;
    // Retain ancestry through closed intermediates for their surviving children.
    node.closed = true;
    if (this.lastActiveId === tabId) this.lastActiveId = undefined;
    this.revision += 1;
  }

  replace(removedId: number, tab: chrome.tabs.Tab): void {
    if (!validId(tab.id) || !getPublicTabMetadata(tab)) {
      this.forget(removedId);
      return;
    }
    const old = this.tabs.get(removedId);
    if (old) {
      this.tabs.delete(removedId);
      this.tabs.set(tab.id, { ...old, id: tab.id });
      for (const node of this.tabs.values()) {
        if (node.openerTabId === removedId) node.openerTabId = tab.id;
      }
      const edges = Array.from(this.transitions.values());
      this.transitions.clear();
      for (const edge of edges) {
        if (edge.from === removedId) edge.from = tab.id;
        if (edge.to === removedId) edge.to = tab.id;
        if (edge.from !== edge.to)
          this.transitions.set(edgeKey(edge.from, edge.to), edge);
      }
      if (this.lastActiveId === removedId) this.lastActiveId = tab.id;
      this.revision += 1;
    }
    this.update(tab);
  }

  getFeatures(
    currentId: number,
    candidateId: number,
    now = Date.now()
  ): IRankingTabFeatures {
    const candidate = this.tabs.get(candidateId);
    const currentPath = this.ancestors(currentId);
    const candidatePath = this.ancestors(candidateId);
    let relationship: IRankingTabFeatures["relationshipToCurrent"] = "unknown";
    let distance: number | null = null;
    for (let from = 0; from < currentPath.length; from++) {
      const to = candidatePath.indexOf(currentPath[from]);
      if (to === -1) continue;
      distance = from + to;
      relationship =
        to === 0
          ? from === 1
            ? "parent"
            : "ancestor"
          : from === 0
          ? to === 1
            ? "child"
            : "descendant"
          : from === 1 && to === 1
          ? "sibling"
          : "related";
      break;
    }
    const count = (from: number, to: number) => {
      const edge = this.transitions.get(edgeKey(from, to));
      return edge ? roundCount(decayCount(edge.count, edge.updatedAt, now)) : 0;
    };
    return {
      relationshipToCurrent: relationship,
      openerDistance: distance,
      tabVisits:
        candidate?.lastVisit === undefined
          ? 0
          : roundCount(decayCount(candidate.visits, candidate.lastVisit, now)),
      minutesSinceTabVisit:
        candidate?.lastVisit === undefined
          ? null
          : Math.round(Math.max(0, now - candidate.lastVisit) / 60_000),
      transitionsFromCurrentTab: count(currentId, candidateId),
      transitionsToCurrentTab: count(candidateId, currentId),
    };
  }

  private captureOpener(tab: chrome.tabs.Tab): void {
    if (tab.id !== undefined && validId(tab.openerTabId))
      this.setOpener(tab.id, tab.openerTabId);
  }

  private setOpener(tabId: number, openerId: number, restoring = false): void {
    const node = this.tabs.get(tabId);
    const parent = this.tabs.get(openerId);
    if (
      !node ||
      node.openerTabId !== undefined ||
      !parent ||
      (!restoring && parent.closed) ||
      this.ancestors(openerId).includes(tabId)
    )
      return;
    node.openerTabId = openerId;
    this.revision += 1;
  }

  private ancestors(tabId: number): number[] {
    const path: number[] = [];
    let id: number | undefined = tabId;
    while (id !== undefined && this.tabs.has(id) && !path.includes(id)) {
      path.push(id);
      id = this.tabs.get(id)!.openerTabId;
    }
    return path;
  }

  private removeTransitions(tabId: number): void {
    for (const [key, edge] of this.transitions) {
      if (edge.from === tabId || edge.to === tabId)
        this.transitions.delete(key);
    }
  }

  private forget(tabId: number): void {
    if (!this.tabs.delete(tabId)) return;
    for (const node of this.tabs.values()) {
      if (node.openerTabId === tabId) node.openerTabId = undefined;
    }
    this.removeTransitions(tabId);
    if (this.lastActiveId === tabId) this.lastActiveId = undefined;
    this.revision += 1;
  }

  private trim(): void {
    while (this.tabs.size > MAX_TABS) {
      const nodes = Array.from(this.tabs.values());
      const oldest = (tabs: IRelatedTab[]) =>
        tabs.sort((a, b) => (a.lastVisit || 0) - (b.lastVisit || 0))[0];
      const removable = nodes.filter((tab) => tab.id !== this.lastActiveId);
      this.forget(
        oldest(removable.filter((tab) => tab.closed))?.id ??
          oldest(removable).id
      );
    }
    while (this.transitions.size > MAX_TRANSITIONS)
      this.transitions.delete(this.transitions.keys().next().value!);
  }
}

function validId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validCount(value: unknown): value is number {
  return validTime(value) && value <= 10000;
}

function edgeKey(from: number, to: number): string {
  return `${from}:${to}`;
}

function roundCount(value: number): number {
  return Math.round(value * 10) / 10;
}
