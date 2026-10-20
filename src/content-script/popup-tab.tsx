import { createEffect, createMemo, onCleanup } from "solid-js";
import { Show } from "solid-js/web";
import { TabIcon, PinIcon, CloseIcon, PreviewIcon } from "./icons";

interface IProps {
  isSelected: boolean;
  isActive: boolean;
  isReducedMotion: boolean;
  isPinned: boolean;
  probability?: number;
  hasPreview: boolean;
  tab: chrome.tabs.Tab;
  onClick: () => void;
  onHover: () => void;
  onTogglePin: () => void;
  onClose: () => void;
  onPreviewHover: (isHovered: boolean) => void;
  onPreviewFocus: (isFocused: boolean) => void;
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
  const probabilityLabel = createMemo(() => {
    const probability = props.probability;
    if (
      typeof probability !== "number" ||
      !Number.isFinite(probability) ||
      probability < 0 ||
      probability > 1
    ) {
      return "";
    }
    if (probability > 0 && probability < 0.001) {
      return "<0.1%";
    }
    return `${Number((probability * 100).toFixed(1))}%`;
  });

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

  onCleanup(() => {
    cancelTextAnimation();
    props.onPreviewHover(false);
    props.onPreviewFocus(false);
  });

  createEffect(() => {
    if (!props.hasPreview) {
      props.onPreviewHover(false);
      props.onPreviewFocus(false);
    }
  });

  function handlePinClick(e: MouseEvent) {
    e.stopPropagation();
    props.onTogglePin();
  }

  function handleCloseClick(e: MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    props.onClose();
  }

  function handlePreviewClick(e: MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
  }

  return (
    <div
      ref={tabElement!}
      tabindex="-1"
      class="tab"
      data-tab-id={props.tab.id}
      classList={{
        tab_selected: props.isSelected,
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
      <span class="tab__favicon">
        <TabIcon url={props.tab.url} title={props.tab.title} />
        <Show when={props.hasPreview}>
          <button
            type="button"
            class="tab__previewButton"
            onClick={handlePreviewClick}
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => props.onPreviewHover(true)}
            onMouseLeave={() => props.onPreviewHover(false)}
            onFocus={() => props.onPreviewFocus(true)}
            onBlur={() => props.onPreviewFocus(false)}
            title="Preview tab screenshot"
            aria-label="Preview tab screenshot"
          >
            <PreviewIcon />
          </button>
        </Show>
      </span>
      <div class="tab__details">
        <div ref={tabTextElement!} class="tab__text">
          <span class="tab__textContent" ref={tabTextContentElement!}>
            {props.tab.title}
          </span>
        </div>
        <div class="tab__domain" title={domain()}>
          <span class="tab__domainText">{domain()}</span>
          <Show when={probabilityLabel()}>
            <span
              class="tab__probability"
              title="Model prediction among candidate tabs; not measured accuracy"
            >
              {probabilityLabel()}
            </span>
          </Show>
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
      const scrollTimeMs = (textOverflow / pixelsPerSecond) * 1000;
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
            transform: `translateX(-${textOverflow}px)`,
            offset: endDelayOffset,
          },
          {
            transform: `translateX(-${textOverflow}px)`,
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
