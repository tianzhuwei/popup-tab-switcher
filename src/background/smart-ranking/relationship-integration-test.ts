import assert from "assert";
import { IRankingInput, IRankingTabFeatures } from "./policy";
import { ITabRelationsState } from "./tab-relations";
import { ITab } from "../../utils/check-tab";
import { defaultSmartRankingConfig } from "../../utils/smart-ranking";

interface IEvent {
  addListener(listener: (...args: unknown[]) => void): void;
  emit(...args: unknown[]): void;
}

interface ICapturedRequest {
  state: { candidates: (IRankingTabFeatures & { id: string })[] };
  questions: { next_tab: { criteria: Record<string, string> } };
}

function event(): IEvent {
  const listeners: ((...args: unknown[]) => void)[] = [];
  return {
    addListener: (listener) => {
      listeners.push(listener);
    },
    emit: (...args) => listeners.forEach((listener) => listener(...args)),
  };
}

function storage(values: Record<string, unknown>) {
  return {
    async get(keys: string | string[]) {
      return Object.fromEntries(
        (Array.isArray(keys) ? keys : [keys]).map((key) => [key, values[key]])
      );
    },
    async set(update: Record<string, unknown>) {
      Object.assign(values, update);
    },
    async remove(key: string) {
      delete values[key];
    },
    async setAccessLevel() {},
  };
}

describe("smart ranking relationship integration", () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  let timers: ReturnType<typeof setTimeout>[];
  let tabs: ITab[];
  let session: Record<string, unknown>;
  let events: Record<string, IEvent>;
  let ranking: typeof import("./index");
  let requests: ICapturedRequest[];

  function reloadWorker() {
    timers.forEach(clearTimeout);
    timers = [];
    events = Object.fromEntries(
      [
        "created",
        "activated",
        "updated",
        "removed",
        "replaced",
        "focus",
        "permissions",
      ].map((name) => [name, event()])
    );
    globalThis.chrome.tabs.onCreated =
      events.created as unknown as typeof chrome.tabs.onCreated;
    globalThis.chrome.tabs.onActivated =
      events.activated as unknown as typeof chrome.tabs.onActivated;
    globalThis.chrome.tabs.onUpdated =
      events.updated as unknown as typeof chrome.tabs.onUpdated;
    globalThis.chrome.tabs.onRemoved =
      events.removed as unknown as typeof chrome.tabs.onRemoved;
    globalThis.chrome.tabs.onReplaced =
      events.replaced as unknown as typeof chrome.tabs.onReplaced;
    globalThis.chrome.windows.onFocusChanged =
      events.focus as unknown as typeof chrome.windows.onFocusChanged;
    globalThis.chrome.permissions.onRemoved =
      events.permissions as unknown as typeof chrome.permissions.onRemoved;
    delete require.cache[require.resolve("./index")];
    ranking = require("./index");
    ranking.initSmartRanking();
  }

  function activate(id: number) {
    tabs.forEach((tab) => {
      tab.active = tab.id === id;
    });
    events.activated.emit({ tabId: id, windowId: 1 });
  }

  function input(): IRankingInput {
    const active = tabs.find((tab) => tab.active)!;
    const recentTabs = [active, ...tabs.filter((tab) => tab !== active)];
    return {
      recentTabs,
      visibleTabs: recentTabs,
      activeTabId: active.id,
      previousTabId: recentTabs[1]?.id,
      pinnedTabIds: [],
      scope: "all",
    };
  }

  async function flush() {
    await ranking.getSmartRankingSnapshot(input());
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  beforeEach(() => {
    timers = [];
    requests = [];
    tabs = [1, 2, 3].map(
      (id) =>
        ({
          id,
          windowId: 1,
          url: `https://example.com/${id}`,
          title: `Page ${id}`,
          active: id === 1,
          incognito: false,
          openerTabId: id === 1 ? undefined : id - 1,
        } as ITab)
    );
    session = {};
    const local = {
      smartRankingConfig: {
        ...defaultSmartRankingConfig,
        enabled: true,
        apiKey: "test-key",
      },
    };
    globalThis.setTimeout = ((
      handler: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      const timer = originalSetTimeout(handler, delay, ...args);
      timers.push(timer);
      return timer;
    }) as typeof setTimeout;
    globalThis.chrome = {
      storage: { local: storage(local), session: storage(session) },
      tabs: {
        get: async (id: number) => ({ ...tabs.find((tab) => tab.id === id)! }),
        query: async (query: { active?: boolean }) =>
          tabs
            .filter((tab) => !query.active || tab.active)
            .map((tab) => ({ ...tab })),
      },
      windows: { get: async () => ({ focused: true }) },
      permissions: { contains: async () => true },
    } as unknown as typeof chrome;
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      requests.push(body);
      const ids = Object.keys(body.questions.next_tab.criteria);
      return {
        ok: true,
        json: async () => ({
          answers: {
            next_tab: {
              type: "choice",
              probabilities: Object.fromEntries(
                ids.map((id) => [id, 1 / ids.length])
              ),
            },
          },
        }),
      } as Response;
    }) as typeof fetch;
    reloadWorker();
  });

  afterEach(() => {
    timers.forEach(clearTimeout);
    globalThis.setTimeout = originalSetTimeout;
    globalThis.fetch = originalFetch;
    globalThis.chrome = originalChrome;
    delete require.cache[require.resolve("./index")];
  });

  it("preserves rapid activation order and sends lineage plus bidirectional switches to the model", async () => {
    activate(1);
    activate(2);
    activate(3);
    activate(2);
    await flush();
    await ranking.requestSmartRankingSnapshot(input());
    const candidates = requests[0].state.candidates;
    const child = candidates.find((candidate) => candidate.id === "tab_3")!;
    assert.strictEqual(child.relationshipToCurrent, "child");
    assert.strictEqual(child.openerDistance, 1);
    assert.strictEqual(child.tabVisits, 1);
    assert.strictEqual(child.transitionsFromCurrentTab, 1);
    assert.strictEqual(child.transitionsToCurrentTab, 1);
    assert.ok(session.smartRankingTabRelations);
  });

  it("records newly opened chains and preserves them through close and replacement events", async () => {
    activate(1);
    activate(3);
    const created = {
      ...tabs[2],
      id: 4,
      url: "https://example.com/4",
      openerTabId: 3,
      active: false,
    };
    tabs.push(created);
    events.created.emit({ ...created });
    activate(4);
    await flush();
    tabs = tabs.filter((tab) => tab.id !== 2);
    events.removed.emit(2);
    tabs = tabs.map((tab) => (tab.id === 3 ? { ...tab, id: 30 } : tab));
    events.replaced.emit(30, 3);
    await flush();
    await ranking.requestSmartRankingSnapshot(input());
    const candidates = requests[0].state.candidates;
    const parent = candidates.find((candidate) => candidate.id === "tab_30")!;
    const ancestor = candidates.find((candidate) => candidate.id === "tab_1")!;
    assert.strictEqual(parent.relationshipToCurrent, "parent");
    assert.strictEqual(ancestor.relationshipToCurrent, "ancestor");
    assert.strictEqual(ancestor.openerDistance, 3);
    assert.ok(!candidates.some((candidate) => candidate.id === "tab_2"));
  });

  it("restores session evidence after worker restart without counting a duplicate activation", async () => {
    activate(1);
    activate(2);
    await flush();
    const visits = (
      session.smartRankingTabRelations as ITabRelationsState
    ).tabs.find((tab) => tab.id === 2)!.visits;
    reloadWorker();
    activate(2);
    await flush();
    assert.strictEqual(
      (session.smartRankingTabRelations as ITabRelationsState).tabs.find(
        (tab) => tab.id === 2
      )!.visits,
      visits
    );
    await ranking.requestSmartRankingSnapshot(input());
    assert.strictEqual(
      requests[0].state.candidates.find(
        (candidate) => candidate.id === "tab_1"
      )!.relationshipToCurrent,
      "parent"
    );
  });

  it("clears evidence when disabled and does not collect switches while off", async () => {
    activate(1);
    activate(2);
    await flush();
    await ranking.saveSmartRankingConfig({
      ...defaultSmartRankingConfig,
      enabled: false,
    });
    activate(3);
    activate(1);
    await flush();
    assert.strictEqual(session.smartRankingTabRelations, undefined);
    await ranking.saveSmartRankingConfig({
      ...defaultSmartRankingConfig,
      enabled: true,
      apiKey: "test-key",
    });
    await flush();
    await ranking.requestSmartRankingSnapshot(input());
    const candidate = requests[0].state.candidates.find(
      (item) => item.id === "tab_2"
    )!;
    assert.strictEqual(candidate.tabVisits, 0);
    assert.strictEqual(candidate.transitionsFromCurrentTab, 0);
    assert.strictEqual(candidate.minutesSinceTabVisit, null);
  });
});
