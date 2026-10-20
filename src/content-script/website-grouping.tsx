import { Show } from "solid-js/web";
import { createEffect, createSignal, on, onCleanup } from "solid-js";
import {
  getWebsiteGroupingState,
  groupTabsByWebsite,
  sendMessageAndGetResponse,
  undoWebsiteGrouping,
} from "../utils/messages";
import { IWebsiteGroupingResult } from "../utils/website-grouping";

interface IProps {
  isOpen: boolean;
  onBusyChange: (busy: boolean) => void;
}

export function WebsiteGrouping(props: IProps) {
  const [canUndo, setCanUndo] = createSignal(false);
  const [isBusy, setIsBusy] = createSignal(false);
  const [feedback, setFeedback] = createSignal("");
  let isDisposed = false;
  let requestRevision = 0;

  createEffect(
    on(
      () => props.isOpen,
      (isOpen) => {
        const revision = ++requestRevision;
        if (!isOpen) return;
        void sendMessageAndGetResponse(getWebsiteGroupingState())
          .then((state) => {
            if (!isDisposed && revision === requestRevision)
              setCanUndo(state?.canUndo || false);
          })
          .catch(() => {});
      }
    )
  );

  onCleanup(() => {
    isDisposed = true;
    if (isBusy()) props.onBusyChange(false);
  });

  return (
    <>
      <button
        type="button"
        class="card__actionButton card__groupButton"
        title={
          feedback()
            ? `Group tabs by website. ${feedback()}`
            : "Group tabs by website"
        }
        aria-label="Group tabs by website"
        aria-busy={isBusy()}
        disabled={isBusy() || !props.isOpen}
        onClick={() => runAction(false)}
      >
        <svg
          class="card__actionIcon"
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.35"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <rect x="1.75" y="3" width="12.5" height="10" rx="2" />
          <path d="M5 6V10M8 6V10M11 6V10" />
        </svg>
      </button>
      <Show when={canUndo()}>
        <button
          type="button"
          class="card__actionButton card__groupButton"
          title="Undo last website grouping"
          aria-label="Undo last website grouping"
          disabled={isBusy() || !props.isOpen}
          onClick={() => runAction(true)}
        >
          <svg
            class="card__actionIcon"
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M5.5 3.5L2.5 6.5L5.5 9.5M3 6.5H9A3.5 3.5 0 0 1 9 13H7" />
          </svg>
        </button>
      </Show>
      <span class="card__actionStatus" role="status">
        {feedback()}
      </span>
    </>
  );

  async function runAction(undo: boolean) {
    if (isBusy() || !props.isOpen) return;
    ++requestRevision;
    setIsBusy(true);
    setFeedback("");
    props.onBusyChange(true);
    try {
      const result = await sendMessageAndGetResponse(
        undo ? undoWebsiteGrouping() : groupTabsByWebsite()
      );
      if (isDisposed) return;
      if (!result)
        throw new Error("The extension is unavailable. Reopen the switcher.");
      setCanUndo(result.canUndo);
      setFeedback(getFeedback(result));
    } catch (error) {
      if (!isDisposed)
        setFeedback(
          error instanceof Error ? error.message : "Unable to organize tabs."
        );
    } finally {
      if (!isDisposed) {
        setIsBusy(false);
        props.onBusyChange(false);
      }
    }
  }
}

function getFeedback(result: IWebsiteGroupingResult) {
  switch (result.status) {
    case "grouped":
      return `Created ${result.groupCount} website groups. Undo is available.`;
    case "undone":
      return "Website grouping undone.";
    case "nothing-to-group":
      return "No website has two ungrouped, unpinned tabs in this window.";
    case "nothing-to-undo":
      return "No unchanged website groups to undo.";
    case "permission-denied":
      return "Tab group permission was not granted. Click to try again.";
    case "busy":
      return "This window is already being organized. Please try again.";
    case "error":
      return result.error || "Unable to organize tabs. Please try again.";
  }
}
