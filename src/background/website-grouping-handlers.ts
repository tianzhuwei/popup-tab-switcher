import { IHandlers, Message } from "../utils/messages";
import { IWebsiteGroupingResult } from "../utils/website-grouping";
import { log } from "../utils/logger";
import {
  getWebsiteGroupingState,
  groupWebsiteTabs,
  undoWebsiteGrouping,
} from "./website-grouping";

export const websiteGroupingHandlers: Partial<IHandlers> = {
  [Message.GetWebsiteGroupingState]: async (_message, sender) => {
    const windowId = getOwnerWindowId(sender);
    if (windowId === undefined) return { canUndo: false };
    try {
      return await getWebsiteGroupingState(windowId);
    } catch (error) {
      log("[Website grouping state unavailable]", error);
      return { canUndo: false };
    }
  },
  [Message.GroupTabsByWebsite]: (_message, sender) =>
    runWebsiteGrouping(sender, false),
  [Message.UndoWebsiteGrouping]: (_message, sender) =>
    runWebsiteGrouping(sender, true),
};

function getOwnerWindowId(sender: chrome.runtime.MessageSender) {
  if (
    sender.id !== chrome.runtime.id ||
    sender.frameId !== 0 ||
    sender.tab?.id === undefined ||
    sender.tab.windowId < 0
  )
    return;
  return sender.tab.windowId;
}

async function runWebsiteGrouping(
  sender: chrome.runtime.MessageSender,
  undo: boolean
): Promise<IWebsiteGroupingResult> {
  const windowId = getOwnerWindowId(sender);
  if (windowId === undefined)
    return {
      status: "error",
      canUndo: false,
      groupCount: 0,
      error: "Open the switcher in the window you want to organize.",
    };
  try {
    // Messaging carries the click's user gesture into the worker. Request before
    // any asynchronous reads; an already granted permission does not prompt.
    const granted = await chrome.permissions.request({
      permissions: ["tabGroups"],
    });
    if (!granted)
      return { status: "permission-denied", canUndo: false, groupCount: 0 };

    const owner = await chrome.tabs.get(sender.tab!.id!);
    if (owner.windowId !== windowId)
      throw new Error("The tab moved to another window. Please try again.");
    return undo
      ? await undoWebsiteGrouping(windowId)
      : await groupWebsiteTabs(windowId);
  } catch (error) {
    log("[Website grouping failed]", error);
    const state = await getWebsiteGroupingState(windowId).catch(() => ({
      canUndo: false,
    }));
    return {
      status: "error",
      ...state,
      groupCount: 0,
      error:
        error instanceof Error ? error.message : "Unable to organize tabs.",
    };
  }
}
