import { ServiceFactory } from "../service-factory";
import {
  IWebsiteGroupingResult,
  IWebsiteGroupingState,
} from "../utils/website-grouping";

interface ICreatedGroup {
  id?: number;
  tabIds: number[];
  properties?: IGroupProperties;
  undone?: boolean;
}

interface IGroupProperties {
  title: string;
  color: chrome.tabGroups.ColorEnum;
  collapsed: boolean;
}

interface IUndoJournal {
  originalOrder: number[];
  originalGroups: Record<string, number>;
  expectedOrder: number[];
  groups: ICreatedGroup[];
  restoreOrder: boolean;
}

const busyWindows = new Set<number>();
const journals = new Map<number, IUndoJournal>();
const GROUP_COLORS: chrome.tabGroups.ColorEnum[] = [
  "blue",
  "cyan",
  "green",
  "orange",
  "grey",
];

export async function getWebsiteGroupingState(
  windowId: number
): Promise<IWebsiteGroupingState> {
  if (!(await hasPermission())) return { canUndo: false };
  const journal = await loadJournal(windowId);
  if (!journal) return { canUndo: false };
  const tabs = await getWindowTabs(windowId);
  const pins = await getCustomPins();
  const groups = await getUndoableGroups(journal, tabs, pins);
  return {
    canUndo:
      groups.length > 0 ||
      (journal.restoreOrder &&
        journal.groups.some((group) => group.undone) &&
        canRestoreOrder(journal, tabs, pins)),
  };
}

export function groupWebsiteTabs(
  windowId: number
): Promise<IWebsiteGroupingResult> {
  return runAction(windowId, async () => {
    const tabs = await getWindowTabs(windowId);
    const pins = await getCustomPins();
    const websites = new Map<string, number[]>();
    for (const tab of tabs) {
      const website = getWebsite(tab);
      if (!website || !isEligible(tab, pins)) continue;
      const ids = websites.get(website) || [];
      ids.push(tab.id!);
      websites.set(website, ids);
    }
    const candidates = [...websites].filter(([, ids]) => ids.length >= 2);
    if (!candidates.length) return result("nothing-to-group", 0, windowId);

    const previousJournal = await loadJournal(windowId);
    const journal: IUndoJournal = {
      originalOrder: getTabIds(tabs),
      originalGroups: Object.fromEntries(
        tabs.map((tab) => [String(tab.id), tab.groupId])
      ),
      expectedOrder: getTabIds(tabs),
      groups: [],
      restoreOrder: true,
    };
    let groupCount = 0;
    try {
      // Store the plan before Chrome changes anything, then journal every group.
      await saveJournal(windowId, journal);
      for (const [website, candidateIds] of candidates) {
        const currentTabs = await getWindowTabs(windowId);
        const currentPins = await getCustomPins();
        const tabIds = currentTabs
          .filter(
            (tab) =>
              candidateIds.includes(tab.id!) &&
              isEligible(tab, currentPins) &&
              getWebsite(tab) === website
          )
          .map((tab) => tab.id!);
        if (tabIds.length < 2) continue;
        const group: ICreatedGroup = { tabIds };
        journal.groups.push(group);
        await saveJournal(windowId, journal);
        group.id = await chrome.tabs.group({
          tabIds,
          createProperties: { windowId },
        });
        groupCount += 1;
        await saveJournal(windowId, journal);
        const created = await chrome.tabGroups.get(group.id);
        group.properties = getGroupProperties(created);
        journal.expectedOrder = getTabIds(await getWindowTabs(windowId));
        await saveJournal(windowId, journal);
        const updated = await chrome.tabGroups.update(group.id, {
          title: website,
          color: getGroupColor(website),
        });
        group.properties = getGroupProperties(updated);
        await saveJournal(windowId, journal);
      }
    } catch (error) {
      if (!groupCount) {
        try {
          await restorePreviousJournal(windowId, previousJournal);
        } catch {
          // Its in-memory copy still remains available if storage is failing.
        }
      }
      throw error;
    }
    if (!groupCount) await restorePreviousJournal(windowId, previousJournal);
    return result(
      groupCount ? "grouped" : "nothing-to-group",
      groupCount,
      windowId
    );
  });
}

export function undoWebsiteGrouping(
  windowId: number
): Promise<IWebsiteGroupingResult> {
  return runAction(windowId, async () => {
    const journal = await loadJournal(windowId);
    if (!journal) return result("nothing-to-undo", 0, windowId);
    const tabs = await getWindowTabs(windowId);
    const pins = await getCustomPins();
    const groups = await getUndoableGroups(journal, tabs, pins);
    // Manual moves, regrouping, additions, and pinning take priority over undo.
    journal.restoreOrder =
      journal.restoreOrder &&
      groups.length ===
        journal.groups.filter((group) => !group.undone).length &&
      canRestoreOrder(journal, tabs, pins);
    await saveJournal(windowId, journal);
    let groupCount = 0;
    for (const group of groups) {
      const currentTabs = await getWindowTabs(windowId);
      const currentPins = await getCustomPins();
      if (
        !(await isUndoableGroup(group, currentTabs, currentPins)) ||
        !hasUnchangedPlacement(group, journal, currentTabs)
      ) {
        journal.restoreOrder = false;
        await saveJournal(windowId, journal);
        continue;
      }
      await chrome.tabs.ungroup(group.tabIds);
      group.undone = true;
      groupCount += 1;
      await saveJournal(windowId, journal);
    }

    if (journal.restoreOrder) await restoreTabOrder(windowId, journal);
    const state = await getWebsiteGroupingState(windowId);
    if (!state.canUndo) await clearJournal(windowId);
    return {
      status:
        groupCount || journal.groups.some((group) => group.undone)
          ? "undone"
          : "nothing-to-undo",
      groupCount,
      ...state,
    };
  });
}

async function restoreTabOrder(
  windowId: number,
  journal: IUndoJournal
): Promise<void> {
  const restoredIds = new Set(journal.groups.flatMap((group) => group.tabIds));
  for (let index = 0; index < journal.originalOrder.length; index += 1) {
    const id = journal.originalOrder[index];
    if (!restoredIds.has(id)) continue;
    const tabs = await getWindowTabs(windowId);
    if (!canRestoreOrder(journal, tabs, await getCustomPins())) {
      journal.restoreOrder = false;
      await saveJournal(windowId, journal);
      return;
    }
    // Insert before the next untouched anchor. Moving only our tabs keeps every
    // existing group together and preserves the order of all untouched tabs.
    const anchorId = journal.originalOrder
      .slice(index + 1)
      .find((tabId) => !restoredIds.has(tabId));
    const currentIndex = tabs.findIndex((tab) => tab.id === id);
    const anchorIndex = tabs.findIndex((tab) => tab.id === anchorId);
    const targetIndex =
      anchorIndex < 0
        ? tabs.length - 1
        : anchorIndex - (currentIndex < anchorIndex ? 1 : 0);
    if (currentIndex !== targetIndex) {
      await chrome.tabs.move(id, { windowId, index: targetIndex });
      journal.expectedOrder = getTabIds(await getWindowTabs(windowId));
      await saveJournal(windowId, journal);
    }
  }
  journal.restoreOrder = false;
  await saveJournal(windowId, journal);
}

function canRestoreOrder(
  journal: IUndoJournal,
  tabs: chrome.tabs.Tab[],
  pins: Set<number>
): boolean {
  if (!sameIds(getTabIds(tabs), journal.expectedOrder)) return false;
  const createdGroups = new Map(
    journal.groups.flatMap((group) =>
      group.tabIds.map((tabId) => [tabId, group] as const)
    )
  );
  return tabs.every((tab) => {
    const group = createdGroups.get(tab.id!);
    return group
      ? !tab.pinned &&
          !pins.has(tab.id!) &&
          tab.groupId ===
            (group.undone ? chrome.tabGroups.TAB_GROUP_ID_NONE : group.id)
      : tab.groupId === journal.originalGroups[String(tab.id)];
  });
}

async function getUndoableGroups(
  journal: IUndoJournal,
  tabs: chrome.tabs.Tab[],
  pins: Set<number>
): Promise<ICreatedGroup[]> {
  const groups: ICreatedGroup[] = [];
  for (const group of journal.groups) {
    if (
      (await isUndoableGroup(group, tabs, pins)) &&
      hasUnchangedPlacement(group, journal, tabs)
    )
      groups.push(group);
  }
  return groups;
}

function hasUnchangedPlacement(
  group: ICreatedGroup,
  journal: IUndoJournal,
  tabs: chrome.tabs.Tab[]
): boolean {
  const currentIds = getTabIds(tabs);
  const expectedIndex = journal.expectedOrder.indexOf(group.tabIds[0]);
  const currentIndex = currentIds.indexOf(group.tabIds[0]);
  const originalIds = new Set(journal.expectedOrder);
  const remainingIds = new Set(currentIds);
  return sameIds(
    journal.expectedOrder
      .slice(0, expectedIndex)
      .filter((id) => remainingIds.has(id)),
    currentIds.slice(0, currentIndex).filter((id) => originalIds.has(id))
  );
}

async function isUndoableGroup(
  group: ICreatedGroup,
  tabs: chrome.tabs.Tab[],
  pins: Set<number>
): Promise<boolean> {
  if (group.id === undefined || group.undone || !group.properties) return false;
  const members = tabs.filter((tab) => tab.groupId === group.id);
  if (
    !sameIds(getTabIds(members), group.tabIds) ||
    members.some((tab) => tab.pinned || pins.has(tab.id!))
  )
    return false;
  try {
    const current = await chrome.tabGroups.get(group.id);
    const properties = getGroupProperties(current);
    return (
      properties.title === group.properties.title &&
      properties.color === group.properties.color &&
      properties.collapsed === group.properties.collapsed
    );
  } catch {
    return false;
  }
}

async function runAction(
  windowId: number,
  action: () => Promise<IWebsiteGroupingResult>
): Promise<IWebsiteGroupingResult> {
  if (busyWindows.has(windowId))
    return { status: "busy", groupCount: 0, canUndo: false };
  busyWindows.add(windowId);
  try {
    if (!(await hasPermission()))
      return { status: "permission-denied", groupCount: 0, canUndo: false };
    return await action();
  } catch (error) {
    // Keep the journal, including successful steps of a partial operation.
    const journal = journals.get(windowId);
    if (journal) {
      try {
        for (const group of journal.groups) {
          if (group.id !== undefined && !group.undone && !group.properties) {
            group.properties = getGroupProperties(
              await chrome.tabGroups.get(group.id)
            );
          }
        }
        await saveJournal(windowId, journal);
      } catch {
        // Retain the in-memory journal if session storage is temporarily full.
      }
    }
    let canUndo = false;
    try {
      canUndo = (await getWebsiteGroupingState(windowId)).canUndo;
    } catch {
      // Report the original failure, not a secondary state-read failure.
    }
    return {
      status: "error",
      groupCount:
        journal?.groups.filter(
          (group) => group.id !== undefined && !group.undone
        ).length || 0,
      canUndo,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    busyWindows.delete(windowId);
  }
}

async function result(
  status: IWebsiteGroupingResult["status"],
  groupCount: number,
  windowId: number
): Promise<IWebsiteGroupingResult> {
  return { status, groupCount, ...(await getWebsiteGroupingState(windowId)) };
}

function hasPermission(): Promise<boolean> {
  return chrome.permissions.contains({ permissions: ["tabGroups"] });
}

async function getCustomPins(): Promise<Set<number>> {
  return new Set((await ServiceFactory.getTabRegistry()).getPinnedTabIds());
}

function isEligible(tab: chrome.tabs.Tab, pins: Set<number>): boolean {
  return (
    tab.id !== undefined &&
    !tab.pinned &&
    !pins.has(tab.id) &&
    tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE
  );
}

function getWebsite(tab: chrome.tabs.Tab): string | undefined {
  try {
    const url = new URL(tab.pendingUrl || tab.url || "");
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    return url.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return;
  }
}

function getGroupColor(website: string): chrome.tabGroups.ColorEnum {
  let hash = 0;
  for (const character of website)
    hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return GROUP_COLORS[(hash >>> 0) % GROUP_COLORS.length];
}

function getGroupProperties(
  group: chrome.tabGroups.TabGroup
): IGroupProperties {
  return {
    title: group.title || "",
    color: group.color,
    collapsed: group.collapsed,
  };
}

function getTabIds(tabs: chrome.tabs.Tab[]): number[] {
  return tabs.map((tab) => tab.id!);
}

async function getWindowTabs(windowId: number): Promise<chrome.tabs.Tab[]> {
  return (await chrome.tabs.query({ windowId })).sort(
    (first, second) => first.index - second.index
  );
}

function sameIds(first: number[], second: number[]): boolean {
  return (
    first.length === second.length &&
    first.every((id, index) => id === second[index])
  );
}

function getJournalKey(windowId: number): string {
  return `websiteGroupingUndo:${windowId}`;
}

async function loadJournal(
  windowId: number
): Promise<IUndoJournal | undefined> {
  const cached = journals.get(windowId);
  if (cached) return cached;
  const key = getJournalKey(windowId);
  const stored = await chrome.storage.session.get(key);
  const journal = stored[key] as IUndoJournal | undefined;
  if (journal) journals.set(windowId, journal);
  return journal;
}

async function saveJournal(
  windowId: number,
  journal: IUndoJournal
): Promise<void> {
  journals.set(windowId, journal);
  await chrome.storage.session.set({ [getJournalKey(windowId)]: journal });
}

async function clearJournal(windowId: number): Promise<void> {
  await chrome.storage.session.remove(getJournalKey(windowId));
  journals.delete(windowId);
}

async function restorePreviousJournal(
  windowId: number,
  journal: IUndoJournal | undefined
): Promise<void> {
  if (journal) await saveJournal(windowId, journal);
  else {
    journals.delete(windowId);
    await chrome.storage.session.remove(getJournalKey(windowId));
  }
}
