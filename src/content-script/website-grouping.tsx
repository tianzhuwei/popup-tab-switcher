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
  let groupButton: HTMLButtonElement | undefined;
  let undoButton: HTMLButtonElement | undefined;
  let shouldRestoreGroupFocus = false;

  createEffect(
    on(
      () => props.isOpen,
      (isOpen) => {
        const revision = ++requestRevision;
        if (!isOpen) return;
        void sendMessageAndGetResponse(getWebsiteGroupingState())
          .then((state) => {
            if (!isDisposed && revision === requestRevision)
              updateUndoAvailability(state?.canUndo || false);
          })
          .catch(() => {});
      }
    )
  );

  createEffect(() => {
    if (!canUndo() && !isBusy() && props.isOpen && shouldRestoreGroupFocus) {
      shouldRestoreGroupFocus = false;
      groupButton?.focus({ preventScroll: true });
    }
  });

  onCleanup(() => {
    isDisposed = true;
    if (isBusy()) props.onBusyChange(false);
  });

  return (
    <>
      <button
        ref={groupButton}
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
      <span
        class="card__undoSlot"
        classList={{ card__undoSlot_visible: canUndo() }}
        aria-hidden={!canUndo()}
      >
        <button
          ref={undoButton}
          type="button"
          class="card__actionButton card__groupButton"
          title="Undo last website grouping"
          aria-label="Undo last website grouping"
          disabled={!canUndo() || isBusy() || !props.isOpen}
          tabIndex={canUndo() ? 0 : -1}
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
      </span>
      <span class="card__actionStatus" role="status">
        {feedback()}
      </span>
    </>
  );

  function isUndoFocused() {
    return (
      !!undoButton &&
      (undoButton.getRootNode() as Document | ShadowRoot).activeElement ===
        undoButton
    );
  }

  function updateUndoAvailability(available: boolean, wasUndoFocused = false) {
    if (!available && (wasUndoFocused || isUndoFocused()))
      shouldRestoreGroupFocus = true;
    setCanUndo(available);
  }

  async function runAction(undo: boolean) {
    if (isBusy() || !props.isOpen) return;
    const wasUndoFocused = isUndoFocused();
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
      updateUndoAvailability(result.canUndo, wasUndoFocused);
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
