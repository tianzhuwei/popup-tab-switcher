import assert from "assert";
import { ITab } from "../../utils/check-tab";
import { parseRankingResponse } from "./model-client";
import {
  applyRanking,
  createRankingInput,
  createRankingPlan,
  decayCount,
  IRankingInput,
} from "./policy";

function tab(id: number, url: string, title = `Tab ${id}`): ITab {
  return { id, url, title, windowId: 1, incognito: false } as ITab;
}

function input(tabs: ITab[], pinnedTabIds: number[] = []): IRankingInput {
  return {
    recentTabs: tabs,
    visibleTabs: tabs,
    pinnedTabIds,
    activeTabId: tabs[0]?.id,
    previousTabId: tabs[1]?.id,
    scope: "all",
  };
}

const ids = (tabs: ITab[]) => tabs.map((item) => item.id);

describe("smart ranking policy", () => {
  describe("applyRanking", () => {
    it("keeps private tabs without predictions in their original slots", () => {
      const tabs = [
        tab(1, "https://a.com"),
        tab(2, "https://b.com"),
        tab(3, "http://localhost:3000"),
        tab(4, "https://c.com"),
        tab(5, "https://d.com"),
      ];
      const result = applyRanking(input(tabs), {
        tab_4: 0.2,
        tab_5: 0.8,
      });
      assert.deepStrictEqual(ids(result), [1, 2, 3, 5, 4]);
    });

    it("does not reorder when no candidate is clearly likely", () => {
      const tabs = [
        tab(1, "https://a.com"),
        tab(2, "https://b.com"),
        tab(3, "https://c.com"),
        tab(4, "https://d.com"),
        tab(5, "https://e.com"),
      ];
      const result = applyRanking(input(tabs), {
        tab_3: 0.1,
        tab_4: 0.12,
        tab_5: 0.14,
      });
      assert.deepStrictEqual(ids(result), [1, 2, 3, 4, 5]);
    });

    it("promotes only likely tabs and keeps the rest in visit order", () => {
      const tabs = [
        tab(1, "https://a.com"),
        tab(2, "https://b.com"),
        tab(3, "https://c.com"),
        tab(4, "https://d.com"),
        tab(5, "https://e.com"),
      ];
      const result = applyRanking(input(tabs), {
        tab_3: 0.05,
        tab_4: 0.1,
        tab_5: 0.6,
      });
      assert.deepStrictEqual(ids(result), [1, 2, 5, 3, 4]);
    });

    it("leaves pinned tabs in place", () => {
      const tabs = [
        tab(9, "https://pinned.com"),
        tab(1, "https://a.com"),
        tab(2, "https://b.com"),
        tab(3, "https://c.com"),
        tab(4, "https://d.com"),
      ];
      const value = { ...input(tabs, [9]), activeTabId: 1, previousTabId: 2 };
      const result = applyRanking(value, {
        tab_9: 0.9,
        tab_3: 0.2,
        tab_4: 0.7,
      });
      assert.deepStrictEqual(ids(result), [9, 1, 2, 4, 3]);
    });

    it("can bring a likely hidden tab into the visible rows", () => {
      const tabs = [
        tab(1, "https://a.com"),
        tab(2, "https://b.com"),
        tab(3, "https://c.com"),
        tab(4, "https://d.com"),
      ];
      const value = { ...input(tabs), visibleTabs: tabs.slice(0, 3) };
      const result = applyRanking(value, { tab_3: 0.1, tab_4: 0.9 });
      assert.deepStrictEqual(ids(result), [1, 2, 4]);
    });
  });

  describe("createRankingPlan", () => {
    it("keeps the signature stable when only titles change", () => {
      const tabs = [tab(1, "https://a.com"), tab(2, "https://b.com", "Inbox")];
      const before = createRankingPlan(input(tabs), new Map(), 0)!;
      tabs[1] = tab(2, "https://b.com", "(3) Inbox");
      const after = createRankingPlan(input(tabs), new Map(), 0)!;
      assert.strictEqual(before.signature, after.signature);
    });

    it("still plans when the current page is private", () => {
      const tabs = [tab(1, "http://localhost:3000"), tab(2, "https://b.com")];
      const plan = createRankingPlan(input(tabs), new Map(), 0);
      assert.deepStrictEqual(Object.keys(plan!.criteria), ["tab_2"]);
    });
  });

  it("decays usage counts with a two-week half-life", () => {
    const twoWeeks = 14 * 24 * 60 * 60_000;
    assert.strictEqual(decayCount(8, 0, twoWeeks), 4);
  });

  it("builds identical popup and prefetch input from the registry", () => {
    const tabs = [tab(1, "https://a.com"), tab(2, "https://b.com")];
    const registry = {
      getTabs: () => tabs.slice(),
      getTabsToShow: () => tabs.slice().reverse(),
      getPinnedTabIds: () => [],
    };
    const value = createRankingInput(registry, true, 1);
    assert.strictEqual(value.activeTabId, 2);
    assert.strictEqual(value.previousTabId, 1);
  });
});

describe("parseRankingResponse", () => {
  const response = (probabilities: Record<string, unknown>) => ({
    answers: {
      next_tab: {
        type: "choice",
        choice: "tab_1",
        confidence: 0.7,
        probabilities,
      },
    },
  });

  it("fills omitted candidates with zero and renormalizes", () => {
    const result = parseRankingResponse(response({ tab_1: 0.6, tab_2: 0.38 }), [
      "tab_1",
      "tab_2",
      "tab_3",
    ]);
    assert.strictEqual(result.probabilities.tab_3, 0);
    const sum = Object.values(result.probabilities).reduce((a, b) => a + b);
    assert.ok(Math.abs(sum - 1) < 1e-9);
  });

  it("ignores unknown keys", () => {
    const result = parseRankingResponse(
      response({ tab_1: 0.5, tab_2: 0.5, other: 0.1 }),
      ["tab_1", "tab_2"]
    );
    assert.deepStrictEqual(Object.keys(result.probabilities), [
      "tab_1",
      "tab_2",
    ]);
  });

  it("rejects far-off totals and invalid values", () => {
    assert.throws(() =>
      parseRankingResponse(response({ tab_1: 0.3 }), ["tab_1", "tab_2"])
    );
    assert.throws(() =>
      parseRankingResponse(response({ tab_1: "high" }), ["tab_1"])
    );
  });
});
