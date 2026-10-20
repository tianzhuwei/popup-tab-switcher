import assert from "assert";
import { TabRelations } from "./tab-relations";

function tab(
  id: number,
  openerTabId?: number,
  url = `https://example.com/page/${id}`
): chrome.tabs.Tab {
  return {
    id,
    openerTabId,
    url,
    title: `Page ${id}`,
    windowId: 1,
    active: false,
    incognito: false,
  } as chrome.tabs.Tab;
}

const start = 1_000_000;

describe("session tab relationships", () => {
  it("distinguishes ancestors, descendants, siblings and shared-ancestor branches", () => {
    const relations = new TabRelations();
    relations.restore(undefined, [
      tab(4, 2),
      tab(3, 2),
      tab(2, 1),
      tab(1),
      tab(5, 4),
    ]);
    const feature = (current: number, candidate: number) =>
      relations.getFeatures(current, candidate, start);
    assert.strictEqual(feature(3, 2).relationshipToCurrent, "parent");
    assert.strictEqual(feature(3, 1).relationshipToCurrent, "ancestor");
    assert.strictEqual(feature(1, 2).relationshipToCurrent, "child");
    assert.strictEqual(feature(1, 3).relationshipToCurrent, "descendant");
    assert.strictEqual(feature(3, 4).relationshipToCurrent, "sibling");
    assert.strictEqual(feature(3, 4).openerDistance, 2);
    assert.strictEqual(feature(3, 5).relationshipToCurrent, "related");
    assert.strictEqual(feature(3, 5).openerDistance, 3);
  });

  it("does not invent an opener for manually created tabs", () => {
    const relations = new TabRelations();
    relations.restore(undefined, [tab(1), tab(2)]);
    relations.recordVisit(tab(1), start);
    relations.recordVisit(tab(2), start + 1000);
    const feature = relations.getFeatures(1, 2, start + 1000);
    assert.strictEqual(feature.relationshipToCurrent, "unknown");
    assert.strictEqual(feature.openerDistance, null);
    assert.strictEqual(feature.transitionsFromCurrentTab, 1);
  });

  it("records separate visit and bidirectional switch counts for same-domain pages", () => {
    const relations = new TabRelations();
    relations.recordVisit(tab(1), start);
    relations.recordVisit(tab(2, 1), start + 1000);
    relations.recordVisit(tab(1), start + 2000);
    relations.recordVisit(tab(2, 1), start + 3000);
    relations.recordVisit(tab(2, 1), start + 4000);
    const feature = relations.getFeatures(1, 2, start + 63_000);
    assert.strictEqual(feature.tabVisits, 2);
    assert.strictEqual(feature.transitionsFromCurrentTab, 2);
    assert.strictEqual(feature.transitionsToCurrentTab, 1);
    assert.strictEqual(feature.minutesSinceTabVisit, 1);
    assert.strictEqual(
      relations.getFeatures(2, 1, start + 63_000).tabVisits,
      2
    );
  });

  it("retains original ancestry after the parent closes or Chrome changes the opener", () => {
    const relations = new TabRelations();
    relations.restore(undefined, [tab(1), tab(2, 1), tab(3, 2)]);
    relations.close(2);
    relations.update(tab(3, 1));
    assert.strictEqual(
      relations.getFeatures(3, 1).relationshipToCurrent,
      "ancestor"
    );
    assert.strictEqual(relations.getFeatures(3, 1).openerDistance, 2);
  });

  it("restores closed intermediates and counts without duplicating an active visit", () => {
    const relations = new TabRelations();
    relations.restore(undefined, [tab(1), tab(2, 1), tab(3, 2)]);
    relations.recordVisit(tab(1), start);
    relations.recordVisit(tab(3, 2), start + 1000);
    relations.close(2);
    const restored = new TabRelations();
    restored.restore(JSON.parse(JSON.stringify(relations.serialize())), [
      tab(1),
      { ...tab(3), active: true },
    ]);
    restored.recordVisit(tab(3), start + 2000);
    const feature = restored.getFeatures(1, 3, start + 2000);
    assert.strictEqual(feature.relationshipToCurrent, "descendant");
    assert.strictEqual(feature.openerDistance, 2);
    assert.strictEqual(feature.tabVisits, 1);
    assert.strictEqual(feature.transitionsFromCurrentTab, 1);
  });

  it("resets page-specific counts on navigation while retaining the tab's origin", () => {
    const relations = new TabRelations();
    relations.recordVisit(tab(1), start);
    relations.recordVisit(tab(2, 1), start + 1000);
    const navigated = tab(2, undefined, "https://example.com/a-different-page");
    relations.update(navigated);
    let feature = relations.getFeatures(1, 2, start + 2000);
    assert.strictEqual(feature.relationshipToCurrent, "child");
    assert.strictEqual(feature.tabVisits, 0);
    assert.strictEqual(feature.minutesSinceTabVisit, null);
    assert.strictEqual(feature.transitionsFromCurrentTab, 0);
    relations.recordVisit(navigated, start + 2000);
    feature = relations.getFeatures(1, 2, start + 2000);
    assert.strictEqual(feature.tabVisits, 1);
    assert.strictEqual(feature.transitionsFromCurrentTab, 0);
  });

  it("does not bridge switch counts across private or browser pages", () => {
    for (const privateTab of [
      tab(9, undefined, "chrome://settings"),
      tab(9, undefined, "http://localhost:3000"),
      { ...tab(9), incognito: true },
    ]) {
      const relations = new TabRelations();
      relations.recordVisit(tab(1), start);
      relations.recordVisit(privateTab, start + 1000);
      relations.recordVisit(tab(2), start + 2000);
      assert.strictEqual(
        relations.getFeatures(1, 2, start + 2000).transitionsFromCurrentTab,
        0
      );
      assert.ok(!relations.serialize().tabs.some((node) => node.id === 9));
    }
  });

  it("removes links and counts when a tracked tab navigates to an ineligible page", () => {
    const relations = new TabRelations();
    relations.recordVisit(tab(1), start);
    relations.recordVisit(tab(2, 1), start + 1000);
    relations.update(tab(1, undefined, "http://localhost:3000"));
    assert.strictEqual(
      relations.getFeatures(1, 2).relationshipToCurrent,
      "unknown"
    );
    assert.strictEqual(
      relations.getFeatures(1, 2).transitionsFromCurrentTab,
      0
    );
  });

  it("transfers lineage and counts when Chrome replaces a tab ID", () => {
    const relations = new TabRelations();
    relations.recordVisit(tab(1), start);
    relations.recordVisit(tab(2, 1), start + 1000);
    relations.update(tab(3, 2));
    relations.replace(2, { ...tab(2), id: 20 });
    assert.strictEqual(
      relations.getFeatures(1, 20, start + 2000).transitionsFromCurrentTab,
      1
    );
    assert.strictEqual(
      relations.getFeatures(20, 3).relationshipToCurrent,
      "child"
    );
    assert.ok(!relations.serialize().tabs.some((node) => node.id === 2));
  });

  it("decays tab visits and switches with a two-week half-life", () => {
    const relations = new TabRelations();
    relations.recordVisit(tab(1), start);
    relations.recordVisit(tab(2), start);
    const feature = relations.getFeatures(1, 2, start + 14 * 24 * 60 * 60_000);
    assert.strictEqual(feature.tabVisits, 0.5);
    assert.strictEqual(feature.transitionsFromCurrentTab, 0.5);
  });

  it("rejects cyclic and malformed persisted relationships", () => {
    const relations = new TabRelations();
    const state = {
      version: 1,
      revision: 1,
      tabs: [
        { id: 1, url: tab(1).url, visits: 0, openerTabId: 2 },
        { id: 2, url: tab(2).url, visits: 0, openerTabId: 1 },
        { id: 3, url: "file:///private", visits: 100 },
        { id: 4, url: tab(4).url, visits: -1 },
        null,
      ],
      transitions: [{ from: 1, to: 2, count: -1, updatedAt: start }],
    };
    relations.restore(state, [tab(1), tab(2)]);
    const restored = relations.serialize();
    assert.strictEqual(restored.tabs.length, 2);
    assert.strictEqual(
      restored.tabs.filter((node) => node.openerTabId !== undefined).length,
      1
    );
    assert.strictEqual(restored.transitions.length, 0);
  });

  it("bounds session memory and clears all relationships and statistics", () => {
    const relations = new TabRelations();
    for (let i = 1; i <= 510; i++) relations.recordVisit(tab(i), start + i);
    assert.ok(relations.serialize().tabs.length <= 500);
    for (let from = 11; from < 51; from++) {
      for (let to = 51; to < 91; to++) {
        relations.recordVisit(tab(from), start + 1000);
        relations.recordVisit(tab(to), start + 1000);
      }
    }
    assert.strictEqual(relations.serialize().transitions.length, 1000);
    relations.clear();
    assert.strictEqual(relations.serialize().tabs.length, 0);
    assert.strictEqual(relations.serialize().transitions.length, 0);
    assert.strictEqual(relations.getFeatures(1, 2).openerDistance, null);
  });
});
