import { createEffect, createMemo, onCleanup } from "solid-js";
import { TabIcon, PinIcon, CloseIcon } from "./icons";

interface IProps {
  isSelected: boolean;
  isActive: boolean;
  isReducedMotion: boolean;
  isLast: boolean;
  isFirst: boolean;
  isPinned: boolean;
  tab: chrome.tabs.Tab;
  onClick: () => void;
  onHover: () => void;
  onTogglePin: () => void;
  onClose: () => void;
  textScrollSpeed: number;
  textScrollDelay: number;
}

export function PopupTab(props: IProps) {
  let tabElement: HTMLDivElement;
  let tabTextElement: HTMLDivElement;
  let tabTextContentElement: HTMLElement;
  const domain = createMemo(() =>
    getTabDomain(props.tab.url || props.tab.pendingUrl)
  );

  createEffect(() => {
    const isSelected = props.isSelected;
    const isActive = props.isActive;
    const isReducedMotion = props.isReducedMotion;
    cancelTextAnimation();
    if (isSelected && isActive) {
      if (!isReducedMotion) {
        scrollLongTextOfSelectedTab();
      }
      tabElement.focus();
    }
  });

  onCleanup(cancelTextAnimation);

  function handlePinClick(e: MouseEvent) {
    e.stopPropagation();
    props.onTogglePin();
  }

  function handleCloseClick(e: MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    props.onClose();
  }

  return (
    <div
      ref={tabElement!}
      tabindex="-1"
      class="tab"
      data-tab-id={props.tab.id}
      classList={{
        tab_selected: props.isSelected,
        tab_pinned: props.isPinned,
      }}
      onClick={props.onClick}
      onMouseEnter={props.onHover}
      onMouseMove={props.onHover}
    >
      <button
        type="button"
        class="tab__closeButton"
        onClick={handleCloseClick}
        title="Close tab"
      >
        <CloseIcon />
      </button>
      <TabIcon url={props.tab.url} title={props.tab.title} />
      <div class="tab__details">
        <div ref={tabTextElement!} class="tab__text">
          <span class="tab__textContent" ref={tabTextContentElement!}>
            {props.tab.title}
          </span>
        </div>
        <div class="tab__domain" title={domain()}>
          {domain()}
        </div>
      </div>
      <button
        type="button"
        class="tab__pinButton"
        classList={{
          tab__pinButton_pinned: props.isPinned,
        }}
        onClick={handlePinClick}
        title={props.isPinned ? "Unpin tab" : "Pin tab"}
      >
        <PinIcon isPinned={props.isPinned} />
      </button>
    </div>
  );

  function cancelTextAnimation() {
    tabTextContentElement
      .getAnimations()
      .forEach((animation) => animation.cancel());
  }

  function scrollLongTextOfSelectedTab() {
    const textOverflow =
      tabTextContentElement.scrollWidth - tabTextElement.clientWidth;
    const pixelsPerSecond = 90 * props.textScrollSpeed;
    if (textOverflow > 0 && pixelsPerSecond > 0) {
      const hiddenTextWidthWithPadding = textOverflow;
      const scrollTimeMs =
        (hiddenTextWidthWithPadding / pixelsPerSecond) * 1000;
      const durationMs = scrollTimeMs + 2 * props.textScrollDelay;
      const startDelayOffset = props.textScrollDelay / durationMs;
      const endDelayOffset = 1 - startDelayOffset;
      tabTextContentElement.animate(
        [
          {
            transform: "initial",
            offset: 0,
          },
          {
            transform: "initial",
            offset: startDelayOffset,
          },
          {
            transform: `translateX(-${hiddenTextWidthWithPadding}px)`,
            offset: endDelayOffset,
          },
          {
            transform: `translateX(-${hiddenTextWidthWithPadding}px)`,
            offset: 1,
          },
        ],
        {
          duration: durationMs,
          direction: "normal",
          iterations: Infinity,
        }
      );
    }
  }
}

function getTabDomain(url?: string): string {
  if (!url) {
    return "";
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.hostname.replace(/^www\./, "");
    }
    if (parsed.protocol === "file:") {
      return "Local file";
    }
    if (parsed.protocol === "chrome-extension:") {
      return "Extension";
    }
    return parsed.host
      ? `${parsed.protocol}//${parsed.host}`
      : parsed.protocol.replace(/:$/, "");
  } catch {
    return "";
  }
}
