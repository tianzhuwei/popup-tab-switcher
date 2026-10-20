import { For, render, Show } from "solid-js/web";
import {
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";
import styles from "./popup.scss";
import {
  contentScriptStarted,
  contentScriptStopped,
  closeTabPreview,
  createTab,
  getSmartRankingUpdate,
  handleMessage,
  Message,
  sendMessageAndGetResponse,
  switchTab,
} from "../utils/messages";
import { log } from "../utils/logger";
import { createPopupStore } from "./popup-store";
import { PopupTab } from "./popup-tab";
import { PopupSelection } from "./popup-selection";
import { TabPreview } from "./tab-preview";
import uuid from "../utils/uuid";
import { SelectionAndFocus } from "./selection-and-focus";
import { createThemeMode } from "../utils/use-theme-mode";
import { getMinimumTabHeight } from "../utils/settings";

type ITab = chrome.tabs.Tab;

interface IProps {
  element: HTMLElement;
}

interface IRankingOpening {
  id: string;
  startedAt: number;
  locked: boolean;
  updateRequested: boolean;
  updateApplied: boolean;
  ignoreLayoutScroll: boolean;
}

function Popup({ element }: IProps) {
  const {
    store,
    syncStoreWithBackground,
    applyRankingUpdate,
    openPopup,
    closePopup: closeStorePopup,
    selectNextTab,
    selectTabIndex,
    togglePin,
    isPinned,
    isProtected,
    removeTab,
  } = createPopupStore();
  const protectedTabCount = createMemo(
    () => store.tabs.filter((tab) => isProtected(tab.id)).length
  );
  const tabOrder = createMemo(() => store.tabs.map((tab) => tab.id).join(","));
  // Settings previews stay open when focus moves back to the settings panel.
  let isSettingsDemo = false;
  // Resolves the effective theme (auto follows the OS, or a manual choice).
  const isDark = createThemeMode(() => store.settings.themeMode);
  const [isVisible, setIsVisible] = createSignal(false);
  const [previewHoveredTabId, setPreviewHoveredTabId] = createSignal<number>();
  const [previewFocusedTabId, setPreviewFocusedTabId] = createSignal<number>();
  const [previewSessionRevision, setPreviewSessionRevision] = createSignal(0);
  const isManualPreviewEnabled = () =>
    store.settings.isTabPreviewEnabled &&
    !store.settings.isTabPreviewAutoEnabled;
  const previewTab = () => {
    if (store.settings.isTabPreviewAutoEnabled) {
      return store.tabs[store.selectedTabIndex];
    }
    const tabId = previewHoveredTabId() ?? previewFocusedTabId();
    return tabId !== undefined && store.tabPreviewIds.includes(tabId)
      ? store.tabs.find((tab) => tab.id === tabId)
      : undefined;
  };
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const [isReducedMotion, setIsReducedMotion] = createSignal(
    reducedMotion.matches
  );
  const isMotionEnabled = () =>
    store.settings.isVisualEffectsEnabled && !isReducedMotion();
  let popupAnimation: Animation | undefined;
  let popupTransition = 0;
  let closeWithoutAnimation = false;
  let isDisposed = false;
  let popupRequestGeneration = 0;
  let pendingPopupRequests = Promise.resolve();
  let rankingOpening: IRankingOpening | undefined;
  let rankingAnimationFrame: number | undefined;
  let rankingOpeningFrame: number | undefined;
  const rankingAnimations = new Set<Animation>();
  let isRankingHoverSuppressed = false;
  let lastPointerPosition: { x: number; y: number } | undefined;
  // Stores the last active element before the popup was opened.
  const selectionAndFocus = new SelectionAndFocus();
  let cleanUpListeners = () => {};

  // Mouse hover state tracking
  let isMouseOverCard = false;
  let mouseIdleTimeout: number | undefined;
  const MOUSE_IDLE_DURATION = 3000;
  let suppressAutoCloseUntil = 0;
  let prevTabRects: Map<number, DOMRect> | null = null;
  let mousePosition: { x: number; y: number } | undefined;
  let popupAnchor: { x: number; y: number } | undefined;
  let cardPosition: { left: number; top: number } | undefined;
  let isHoverSelectionReady = true;

  function snapshotTabPositions() {
    if (!isMotionEnabled()) {
      return;
    }
    const tabElements = element.shadowRoot?.querySelectorAll(".tab");
    const nextMap = new Map<number, DOMRect>();
    tabElements?.forEach((el) => {
      const id = Number((el as HTMLElement).dataset.tabId);
      if (Number.isFinite(id)) {
        nextMap.set(id, el.getBoundingClientRect());
      }
    });
    prevTabRects = nextMap;
  }

  onMount(() => {
    log(`[start switcher]`);
    cleanUpListeners = setUpListeners();
    reducedMotion.addEventListener("change", onMotionPreferenceChange);
    chrome.runtime.sendMessage(contentScriptStarted());
  });

  onCleanup(() => {
    log(`[stop switcher]`);
    isDisposed = true;
    popupRequestGeneration += 1;
    pendingPopupRequests = Promise.resolve();
    rankingOpening = undefined;
    cancelRankingMotion();
    cancelRankingOpeningFrame();
    popupTransition += 1;
    cancelPopupAnimation();
    cancelRowAnimations();
    reducedMotion.removeEventListener("change", onMotionPreferenceChange);
    cleanUpListeners();
    clearMouseIdleTimeout();
    selectionAndFocus.apply();
    chrome.runtime.sendMessage(contentScriptStopped());
  });

  createEffect(() => {
    store.tabs;
    if (!prevTabRects) {
      return;
    }
    const cardElement = element.shadowRoot?.querySelector(".card");
    if (!cardElement || !isMotionEnabled()) {
      prevTabRects = null;
      return;
    }
    const tabs = Array.from(cardElement.querySelectorAll<HTMLElement>(".tab"));
    tabs.forEach((tabEl) => {
      const idAttr = tabEl.dataset.tabId;
      if (!idAttr) {
        return;
      }
      const tabId = Number(idAttr);
      const prevRect = prevTabRects?.get(tabId);
      if (!prevRect) {
        return;
      }
      const newRect = tabEl.getBoundingClientRect();
      const deltaY = prevRect.top - newRect.top;
      if (deltaY === 0) {
        return;
      }
      tabEl.getAnimations().forEach((animation) => animation.cancel());
      tabEl.animate(
        [
          { transform: `translateY(${deltaY}px)` },
          { transform: "translateY(0)" },
        ],
        {
          duration: 180,
          easing: "ease-out",
        }
      );
    });
    prevTabRects = null;
  });

  createEffect(on(() => store.isOpen, updateOverlayVisibility));

  createEffect(
    on(
      () => [
        store.isOpen,
        store.settings.isTabPreviewEnabled,
        store.settings.isTabPreviewAutoEnabled,
      ],
      resetManualPreview
    )
  );

  createEffect(() => {
    if (store.isOpen) {
      updateOverlayAppearance();
    }
  });

  createEffect(
    on(isMotionEnabled, (enabled) => {
      if (!enabled) {
        cancelPopupAnimation();
        cancelRowAnimations();
        if (!store.isOpen) {
          hideOverlay();
        }
      }
    })
  );

  createEffect(
    on(isReducedMotion, (reduced) => {
      if (reduced) cancelRankingMotion();
    })
  );

  return (
    <>
      <style>{styles}</style>
      <Show when={isVisible()}>
        <div
          class="overlay"
          style={{ "pointer-events": store.isOpen ? "auto" : "none" }}
        >
          <div
            class="card"
            classList={{
              card_dark: isDark(),
              card_enhanced: store.settings.isVisualEffectsEnabled,
            }}
            onMouseEnter={onMouseEnterCard}
            onMouseLeave={onMouseLeaveCard}
            onMouseMove={onMouseMoveOnCard}
          >
            <div class="card__tabs">
              <div
                class="card__tabList"
                style={{
                  "--protected-count": String(protectedTabCount()),
                  "--candidate-count": String(
                    store.tabs.length - protectedTabCount()
                  ),
                }}
              >
                <Show when={protectedTabCount() > 0}>
                  <div
                    class="card__sectionSurface card__sectionSurface_fixed"
                    aria-hidden="true"
                  />
                </Show>
                <Show when={store.tabs.length > protectedTabCount()}>
                  <div
                    class="card__sectionSurface card__sectionSurface_candidates"
                    classList={{
                      card__sectionSurface_afterFixed: protectedTabCount() > 0,
                    }}
                    aria-hidden="true"
                  />
                </Show>
                <Show when={store.tabs.length > 0}>
                  <PopupSelection
                    isActive={store.isOpen}
                    isMotionEnabled={isMotionEnabled()}
                    selectedTabId={store.tabs[store.selectedTabIndex]?.id}
                    selectedTabIndex={store.selectedTabIndex}
                    protectedTabCount={protectedTabCount()}
                    tabOrder={tabOrder()}
                    zoomFactor={store.zoomFactor}
                  />
                </Show>
                <For each={store.tabs}>
                  {(tab, index) => (
                    <PopupTab
                      tab={tab}
                      isSelected={index() === store.selectedTabIndex}
                      isActive={store.isOpen}
                      isReducedMotion={isReducedMotion()}
                      isPinned={isPinned(tab.id!)}
                      isGroupStart={
                        protectedTabCount() > 0 &&
                        index() === protectedTabCount()
                      }
                      probability={
                        isProtected(tab.id)
                          ? undefined
                          : store.tabProbabilities[String(tab.id)]
                      }
                      hasPreview={
                        isManualPreviewEnabled() &&
                        tab.id !== undefined &&
                        store.tabPreviewIds.includes(tab.id)
                      }
                      onPreviewHover={(hovered) => {
                        if (hovered && !isRankingHoverSuppressed) {
                          setPreviewHoveredTabId(tab.id);
                        } else if (previewHoveredTabId() === tab.id) {
                          setPreviewHoveredTabId(undefined);
                        }
                      }}
                      onPreviewFocus={(focused) => {
                        if (focused) {
                          setPreviewFocusedTabId(tab.id);
                        } else if (previewFocusedTabId() === tab.id) {
                          setPreviewFocusedTabId(undefined);
                        }
                      }}
                      onTogglePin={() => {
                        suppressAutoClose();
                        snapshotTabPositions();
                        togglePin(tab.id!);
                      }}
                      onHover={() => {
                        if (
                          store.settings.isHoverSelectingTab &&
                          isHoverSelectionReady &&
                          !isRankingHoverSuppressed
                        ) {
                          selectTabIndex(index());
                        }
                      }}
                      onClose={() => {
                        if (tab.id !== undefined) {
                          suppressAutoClose();
                          removeTab(tab.id);
                        }
                      }}
                      onClick={() => {
                        switchTo(tab);
                      }}
                      textScrollSpeed={store.settings.textScrollSpeed}
                      textScrollDelay={store.settings.textScrollDelay}
                    />
                  )}
                </For>
              </div>
            </div>
            <div class="card__footer">
              <button
                type="button"
                class="card__newTabButton"
                title="New tab"
                aria-label="New tab"
                onClick={openNewTab}
              >
                <svg
                  class="card__newTabIcon"
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M8 3V13M3 8H13"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                  />
                </svg>
              </button>
            </div>
          </div>
          <Show when={store.isOpen && store.settings.isTabPreviewEnabled}>
            <TabPreview
              element={element}
              tab={previewTab()}
              zoomFactor={store.zoomFactor}
              isDark={isDark()}
              isEnhanced={store.settings.isVisualEffectsEnabled}
              isAnimated={isMotionEnabled()}
              sessionRevision={previewSessionRevision()}
            />
          </Show>
        </div>
      </Show>
    </>
  );

  // NOTE:
  //  Placing functions after the return statement divides the code in two distinct parts:
  //  - Synchronous part that creates the component.
  //  - Asynchronous part that handles changes during the component lifecycle.
  //  By placing the structure and sync logic of at the start and all
  //  minor details like event handlers at the end we achieve better clarity.

  function setStylePropertiesThatDependOnPageZoom() {
    /*
     NOTE:
     The popup tries to look the same independent of a page zoom level.
     Unfortunately there is no way of getting zoom level reliably (https://stackoverflow.com/questions/1713771/how-to-detect-page-zoom-level-in-all-modern-browsers).
     - Using outerWidth/innerWidth will give wrong results if a side bar is open (eg. dev tools,
       menu in FF).
     - The usage of 'vw' unit has the same flaws as outerWidth/innerWidth approach.
     - The window.devicePixelRatio (DPR) changes on zoom but you can't rely on it on high DPI devices
       because there is no way of getting base DPR that corresponds to zoom 100% (https://www.w3.org/community/respimg/2013/04/06/devicenormalpixelratio-proposal-for-zoom-independent-devicepixelratio-for-hd-retina-games/).

     Currently extension specific API browser.tabs.getZoom() is used to get tab zoom factor.
     Restrictions:
     - The minimal font size on large zoom levels can't be rewritten.
    */
    const { fontSize, numberOfTabsToShow, tabHeight, popupWidth, iconSize } =
      store.settings;
    const zoomFactor = store.zoomFactor;
    const rowHeight = Math.max(tabHeight, getMinimumTabHeight(store.settings));
    const visibleTabCount =
      numberOfTabsToShow > 0
        ? numberOfTabsToShow
        : Math.max(store.tabs.length, 1);
    const footerHeight = 36;
    // Group padding adds 8px; a second group adds its padding and an 8px gap.
    const groupSpacing = store.tabs.length
      ? 8 +
        (protectedTabCount() > 0 && protectedTabCount() < store.tabs.length
          ? 16
          : 0)
      : 0;
    const maxPopupHeight =
      visibleTabCount * rowHeight + footerHeight + 18 + groupSpacing;
    const popupBorderRadius = 16;
    const tabHorizontalPadding = 12;
    element.style.setProperty("--popup-unit", `${1 / zoomFactor}px`);
    element.style.setProperty(
      "--popup-footer-height",
      `${footerHeight / zoomFactor}px`
    );
    element.style.setProperty("--popup-button-size", `${26 / zoomFactor}px`);
    element.style.setProperty("--popup-width", `${popupWidth / zoomFactor}px`);
    element.style.setProperty(
      "--popup-max-height",
      `${maxPopupHeight / zoomFactor}px`
    );
    element.style.setProperty(
      "--popup-border-radius",
      `${popupBorderRadius / zoomFactor}px`
    );
    element.style.setProperty("--tab-height", `${rowHeight / zoomFactor}px`);
    element.style.setProperty(
      "--tab-horizontal-padding",
      `${tabHorizontalPadding / zoomFactor}px`
    );
    element.style.setProperty("--font-size", `${fontSize / zoomFactor}px`);
    element.style.setProperty("--icon-size", `${iconSize / zoomFactor}px`);
  }

  function showOverlay() {
    element.style.display = "block";
    element.style.pointerEvents = "auto";
    updateOverlayAppearance();
  }

  function updateOverlayAppearance() {
    element.style.setProperty(
      "--popup-opacity",
      `${store.settings.opacity / 100}`
    );
    setStylePropertiesThatDependOnPageZoom();
    const transition = popupTransition;
    queueMicrotask(() => {
      if (!isDisposed && store.isOpen && transition === popupTransition) {
        updatePopupPosition();
      }
    });
  }

  function updatePopupPosition() {
    const card = element.shadowRoot?.querySelector<HTMLElement>(".card");
    if (!card) {
      return;
    }
    if (store.settings.popupPosition !== "mouse" || !popupAnchor) {
      card.style.removeProperty("position");
      card.style.removeProperty("left");
      card.style.removeProperty("top");
      cardPosition = undefined;
      return;
    }
    const margin = 20 / store.zoomFactor;
    const gap = 12 / store.zoomFactor;
    const width = card.offsetWidth;
    const height = card.offsetHeight;
    if (!cardPosition) {
      const selectedTab = card.querySelector<HTMLElement>(".tab_selected");
      const cardRect = card.getBoundingClientRect();
      const selectedRect = selectedTab?.getBoundingClientRect();
      const rowOffset = selectedRect
        ? selectedRect.top - cardRect.top + selectedRect.height / 2
        : height / 2;
      cardPosition = {
        left:
          popupAnchor.x + gap + width <= window.innerWidth - margin
            ? popupAnchor.x + gap
            : popupAnchor.x - gap - width,
        top: popupAnchor.y - rowOffset,
      };
    }
    // Keep this opening's position stable as the selection and pointer move.
    cardPosition.left = Math.max(
      margin,
      Math.min(cardPosition.left, window.innerWidth - width - margin)
    );
    cardPosition.top = Math.max(
      margin,
      Math.min(cardPosition.top, window.innerHeight - height - margin)
    );
    card.style.position = "absolute";
    card.style.left = `${cardPosition.left}px`;
    card.style.top = `${cardPosition.top}px`;
  }

  function updateOverlayVisibility(isOpen: boolean) {
    if (isDisposed) {
      return;
    }
    const transition = ++popupTransition;
    if (isOpen) {
      selectionAndFocus.saveState();
      cancelPopupAnimation();
      closeWithoutAnimation = false;
      popupAnchor =
        store.settings.popupPosition === "mouse" &&
        mousePosition &&
        document.hasFocus() &&
        !document.pointerLockElement &&
        mousePosition.x >= 0 &&
        mousePosition.x < window.innerWidth &&
        mousePosition.y >= 0 &&
        mousePosition.y < window.innerHeight
          ? { ...mousePosition }
          : undefined;
      cardPosition = undefined;
      isHoverSelectionReady = !popupAnchor;
      showOverlay();
      setIsVisible(true);
      // Wait for the card to mount, without replaying entrance on selection changes.
      queueMicrotask(() => {
        if (
          isDisposed ||
          transition !== popupTransition ||
          !store.isOpen ||
          !isMotionEnabled()
        ) {
          return;
        }
        const cardElement =
          element.shadowRoot?.querySelector<HTMLElement>(".card");
        if (!cardElement) {
          return;
        }
        const animation = cardElement.animate(
          [
            {
              opacity: 0,
              transform: `translateY(${10 / store.zoomFactor}px) scale(0.94)`,
              offset: 0,
              easing: "cubic-bezier(0.16, 1, 0.3, 1)",
            },
            {
              opacity: 1,
              transform: `translateY(${-2 / store.zoomFactor}px) scale(1.025)`,
              offset: 0.48,
              easing: "ease-in-out",
            },
            {
              opacity: 1,
              transform: `translateY(${1 / store.zoomFactor}px) scale(0.994)`,
              offset: 0.72,
              easing: "ease-in-out",
            },
            {
              opacity: 1,
              transform: "translateY(0) scale(1.004)",
              offset: 0.88,
              easing: "ease-in-out",
            },
            { opacity: 1, transform: "translateY(0) scale(1)", offset: 1 },
          ],
          { duration: 320, easing: "linear" }
        );
        popupAnimation = animation;
        animation.onfinish = () => {
          if (popupAnimation === animation) {
            popupAnimation = undefined;
          }
        };
      });
      return;
    }

    // Release page interaction and focus as soon as dismissal starts.
    element.style.pointerEvents = "none";
    selectionAndFocus.apply();
    isMouseOverCard = false;
    clearMouseIdleTimeout();
    cancelRowAnimations();
    const cardElement = element.shadowRoot?.querySelector<HTMLElement>(".card");
    const shouldAnimate = isMotionEnabled() && !closeWithoutAnimation;
    closeWithoutAnimation = false;
    if (cardElement && shouldAnimate) {
      const currentStyle = window.getComputedStyle(cardElement);
      const start = {
        opacity: currentStyle.opacity,
        transform: currentStyle.transform,
      };
      cancelPopupAnimation();
      const animation = cardElement.animate(
        [
          start,
          {
            opacity: 0,
            transform: `translateY(${3 / store.zoomFactor}px) scale(0.99)`,
          },
        ],
        { duration: 100, easing: "ease-out", fill: "forwards" }
      );
      popupAnimation = animation;
      animation.onfinish = () => {
        if (!isDisposed && transition === popupTransition) {
          hideOverlay();
        }
      };
    } else {
      hideOverlay();
    }
  }

  function cancelPopupAnimation() {
    if (popupAnimation) {
      popupAnimation.onfinish = null;
      popupAnimation.cancel();
      popupAnimation = undefined;
    }
  }

  function cancelRowAnimations() {
    element.shadowRoot?.querySelectorAll(".tab").forEach((tabElement) => {
      tabElement.getAnimations().forEach((animation) => animation.cancel());
    });
  }

  function cancelRankingMotion() {
    if (rankingAnimationFrame !== undefined) {
      cancelAnimationFrame(rankingAnimationFrame);
      rankingAnimationFrame = undefined;
    }
    for (const animation of rankingAnimations) {
      animation.onfinish = null;
      animation.cancel();
    }
    rankingAnimations.clear();
  }

  function cancelRankingOpeningFrame() {
    if (rankingOpeningFrame !== undefined) {
      cancelAnimationFrame(rankingOpeningFrame);
      rankingOpeningFrame = undefined;
    }
  }

  function ignoreRankingLayoutScroll(opening: IRankingOpening) {
    cancelRankingOpeningFrame();
    opening.ignoreLayoutScroll = true;
    rankingOpeningFrame = requestAnimationFrame(() => {
      rankingOpeningFrame = undefined;
      if (rankingOpening === opening) opening.ignoreLayoutScroll = false;
    });
  }

  function lockRankingOrder() {
    if (!rankingOpening) return;
    rankingOpening.locked = true;
    rankingOpening.ignoreLayoutScroll = false;
    cancelRankingMotion();
    cancelRankingOpeningFrame();
  }

  function requestRankingUpdate(opening: IRankingOpening) {
    if (opening.updateRequested) return;
    opening.updateRequested = true;
    void sendMessageAndGetResponse(getSmartRankingUpdate(opening.id))
      .then((update) => {
        if (
          !update ||
          update.popupId !== opening.id ||
          rankingOpening !== opening ||
          opening.locked ||
          opening.updateApplied ||
          isDisposed ||
          !store.isOpen
        )
          return;
        const previousPositions = new Map<number, number>();
        element.shadowRoot
          ?.querySelectorAll<HTMLElement>(".tab")
          .forEach((tab) => {
            const id = Number(tab.dataset.tabId);
            if (Number.isFinite(id)) previousPositions.set(id, tab.offsetTop);
          });
        isRankingHoverSuppressed = true;
        resetManualPreview();
        ignoreRankingLayoutScroll(opening);
        if (!applyRankingUpdate(update)) {
          isRankingHoverSuppressed = false;
          return;
        }
        opening.updateApplied = true;
        // Existing preview tokens only cover the original rows.
        setPreviewSessionRevision((value) => value + 1);
        if (isReducedMotion()) return;
        rankingAnimationFrame = requestAnimationFrame(() => {
          rankingAnimationFrame = undefined;
          if (
            rankingOpening !== opening ||
            opening.locked ||
            !store.isOpen ||
            isDisposed ||
            isReducedMotion()
          )
            return;
          element.shadowRoot
            ?.querySelectorAll<HTMLElement>(".tab")
            .forEach((tab) => {
              const previous = previousPositions.get(Number(tab.dataset.tabId));
              const deltaY =
                previous !== undefined
                  ? previous - tab.offsetTop
                  : tab.offsetHeight / 2;
              if (Math.abs(deltaY) < 0.5) return;
              const animation = tab.animate(
                [
                  { transform: `translateY(${deltaY}px)` },
                  { transform: "translateY(0)" },
                ],
                { duration: 160, easing: "cubic-bezier(0.2, 0.75, 0.25, 1)" }
              );
              rankingAnimations.add(animation);
              animation.onfinish = () => rankingAnimations.delete(animation);
            });
        });
      })
      .catch((error) => log("[Late smart ranking unavailable]", error));
  }

  function hideOverlay() {
    cancelPopupAnimation();
    setIsVisible(false);
    element.style.display = "none";
  }

  function onMotionPreferenceChange(event: MediaQueryListEvent) {
    setIsReducedMotion(event.matches);
  }

  async function onWindowResize() {
    const generation = popupRequestGeneration;
    const isCurrent = () =>
      !isDisposed && generation === popupRequestGeneration && store.isOpen;
    if (isCurrent()) {
      await syncStoreWithBackground(isCurrent, rankingOpening?.id);
      if (isCurrent()) {
        setStylePropertiesThatDependOnPageZoom();
        updatePopupPosition();
      }
    }
  }

  function closePopup() {
    // Invalidate the whole opening cycle, including requests still waiting to sync.
    popupRequestGeneration += 1;
    pendingPopupRequests = Promise.resolve();
    rankingOpening = undefined;
    cancelRankingMotion();
    cancelRankingOpeningFrame();
    isRankingHoverSuppressed = false;
    isSettingsDemo = false;
    resetManualPreview();
    if (!isDisposed) {
      closeStorePopup();
      chrome.runtime.sendMessage(closeTabPreview());
    }
  }

  function resetManualPreview() {
    setPreviewHoveredTabId(undefined);
    setPreviewFocusedTabId(undefined);
  }

  function requestPopup(increment?: number) {
    const previousOpening = rankingOpening;
    const opening = previousOpening || {
      id: uuid(),
      startedAt: performance.now(),
      locked: false,
      updateRequested: false,
      updateApplied: false,
      ignoreLayoutScroll: false,
    };
    rankingOpening = opening;
    if (!previousOpening) isRankingHoverSuppressed = true;
    if (previousOpening && increment !== undefined) lockRankingOrder();
    const generation = popupRequestGeneration;
    const isCurrent = () =>
      !isDisposed &&
      generation === popupRequestGeneration &&
      rankingOpening === opening;
    // Preserve every repeat in arrival order, rather than replacing earlier requests.
    const request = pendingPopupRequests.then(async () => {
      if (!isCurrent()) {
        return;
      }
      isSettingsDemo = increment === undefined;
      const wasOpen = store.isOpen;
      const model = await syncStoreWithBackground(isCurrent, opening.id);
      if (!model || !isCurrent()) {
        return;
      }
      if (!wasOpen && (!model.rankingPending || increment === undefined)) {
        isRankingHoverSuppressed = false;
      }
      if (increment !== undefined) {
        if (store.isOpen) {
          selectNextTab(increment);
        } else if (
          model.settings.isSwitchingToPreviouslyUsedTab &&
          model.previousTabId !== undefined
        ) {
          const previousTabIndex = store.tabs.findIndex(
            (tab) => tab.id === model.previousTabId
          );
          if (previousTabIndex !== -1) {
            selectTabIndex(previousTabIndex);
          }
        }
      }
      if (!wasOpen) ignoreRankingLayoutScroll(opening);
      openPopup();
      if (!wasOpen && increment !== undefined && model.rankingPending)
        requestRankingUpdate(opening);
    });
    // A failed request must not prevent later shortcuts from being processed.
    pendingPopupRequests = request.catch(() => {});
    return request;
  }

  function switchTo(selectedTab: ITab) {
    chrome.runtime.sendMessage(switchTab(selectedTab));
    closeWithoutAnimation = true;
    closePopup();
  }

  function openNewTab() {
    chrome.runtime.sendMessage(createTab());
    closeWithoutAnimation = true;
    closePopup();
  }

  function setUpListeners() {
    element.addEventListener("click", onOverlayClick, { capture: true });
    window.addEventListener("keyup", onKeyUp, { capture: true });
    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("blur", onWindowBlur, { capture: true });
    window.addEventListener("resize", onWindowResize, { capture: true });
    window.addEventListener("pointermove", onPointerMove, {
      capture: true,
      passive: true,
    });
    window.addEventListener("pointerout", onPointerOut, { capture: true });
    window.addEventListener("pointerdown", onRankingInteraction, {
      capture: true,
      passive: true,
    });
    window.addEventListener("click", onRankingInteraction, {
      capture: true,
      passive: true,
    });
    window.addEventListener("wheel", onRankingInteraction, {
      capture: true,
      passive: true,
    });
    window.addEventListener("scroll", onRankingScroll, {
      capture: true,
      passive: true,
    });
    element.shadowRoot?.addEventListener("scroll", onRankingScroll, {
      capture: true,
      passive: true,
    });
    document.addEventListener("visibilitychange", clearMousePosition);

    const messageListener = handleMessage({
      [Message.DEMO_SETTINGS]: () => requestPopup(),
      [Message.CLOSE_POPUP]: closePopup,
      [Message.SELECT_TAB]: ({ increment }) => requestPopup(increment),
    });
    chrome.runtime.onMessage.addListener(messageListener);

    const disposeFixUnfocusedDocumentInPdfFiles =
      fixUnfocusedDocumentInPdfFiles();

    return () => {
      element.removeEventListener("click", onOverlayClick, { capture: true });
      window.removeEventListener("keyup", onKeyUp, { capture: true });
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("blur", onWindowBlur, { capture: true });
      window.removeEventListener("resize", onWindowResize, { capture: true });
      window.removeEventListener("pointermove", onPointerMove, {
        capture: true,
      });
      window.removeEventListener("pointerout", onPointerOut, { capture: true });
      window.removeEventListener("pointerdown", onRankingInteraction, {
        capture: true,
      });
      window.removeEventListener("click", onRankingInteraction, {
        capture: true,
      });
      window.removeEventListener("wheel", onRankingInteraction, {
        capture: true,
      });
      window.removeEventListener("scroll", onRankingScroll, { capture: true });
      element.shadowRoot?.removeEventListener("scroll", onRankingScroll, {
        capture: true,
      });
      document.removeEventListener("visibilitychange", clearMousePosition);
      chrome.runtime.onMessage.removeListener(messageListener);
      disposeFixUnfocusedDocumentInPdfFiles();
    };
  }

  function onPointerMove(event: PointerEvent) {
    if (!event.isTrusted) {
      return;
    }
    const hasMoved = lastPointerPosition
      ? event.clientX !== lastPointerPosition.x ||
        event.clientY !== lastPointerPosition.y
      : event.movementX !== 0 || event.movementY !== 0;
    lastPointerPosition = { x: event.clientX, y: event.clientY };
    if (hasMoved) {
      onRankingInteraction(event);
      isRankingHoverSuppressed = false;
    }
    mousePosition =
      event.pointerType === "mouse"
        ? { x: event.clientX, y: event.clientY }
        : undefined;
    if (
      store.isOpen &&
      !isHoverSelectionReady &&
      popupAnchor &&
      mousePosition &&
      Math.hypot(
        mousePosition.x - popupAnchor.x,
        mousePosition.y - popupAnchor.y
      ) >=
        2 / store.zoomFactor
    ) {
      isHoverSelectionReady = true;
    }
  }

  function onRankingInteraction(event: Event) {
    if (
      event.isTrusted &&
      rankingOpening &&
      event.timeStamp >= rankingOpening.startedAt
    ) {
      lockRankingOrder();
    }
  }

  function onRankingScroll(event: Event) {
    // Initial focus and row replacement can scroll without a user gesture.
    // Wheel, pointer and key input still lock immediately during this frame.
    if (!rankingOpening?.ignoreLayoutScroll) onRankingInteraction(event);
  }

  function onPointerOut(event: PointerEvent) {
    const nextTarget = event.relatedTarget;
    if (
      !nextTarget ||
      nextTarget instanceof HTMLIFrameElement ||
      nextTarget instanceof HTMLEmbedElement ||
      nextTarget instanceof HTMLObjectElement
    ) {
      clearMousePosition();
    }
  }

  function clearMousePosition() {
    mousePosition = undefined;
  }

  function onOverlayClick(event: MouseEvent) {
    const cardElement = element.shadowRoot?.querySelector(".card");
    if (cardElement && event.composedPath().includes(cardElement)) {
      return;
    }
    if (event.target === element) {
      closePopup();
    }
  }

  function onKeyDown(event: KeyboardEvent) {
    log(`[onKeyDown event]`, event);
    if (isDisposed) {
      return;
    }
    onRankingInteraction(event);
    if (!store.isOpen) {
      if (event.key === "Escape") {
        closePopup();
      }
      return;
    }
    const handlers: { [key: string]: () => void } = {
      Escape: () => closePopup(),
      Enter: () => {
        const selectedTab = store.tabs[store.selectedTabIndex];
        if (selectedTab) {
          switchTo(selectedTab);
        }
      },
      ArrowUp: () => selectNextTab(-1),
      ArrowDown: () => selectNextTab(1),
      Tab: () => selectNextTab(event.shiftKey ? -1 : 1),
    };
    const isPlainSpace =
      event.key === " " &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey;
    const isPreviewButton = event
      .composedPath()
      .some(
        (target) =>
          target instanceof HTMLElement &&
          target.classList.contains("tab__previewButton")
      );
    if (isPreviewButton && (event.key === "Enter" || isPlainSpace)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const handler = handlers[isPlainSpace ? "Enter" : event.key];
    if (handler) {
      handler();
      event.preventDefault();
      event.stopPropagation();
    }
  }

  function onKeyUp(event: KeyboardEvent): void {
    log(`[onKeyUp event]`, event);
    if (!store.isOpen || store.settings.isStayingOpen) {
      return;
    }
    if (Date.now() < suppressAutoCloseUntil) {
      return;
    }
    if (["Alt", "Control", "Meta"].includes(event.key)) {
      const selectedTab = store.tabs[store.selectedTabIndex];
      if (selectedTab) {
        switchTo(selectedTab);
      }
      event.preventDefault();
      event.stopPropagation();
    }
  }

  function onWindowBlur(event: Event): void {
    if (event.target !== window) {
      return;
    }
    clearMousePosition();
    if (isSettingsDemo) {
      return;
    }
    if (Date.now() < suppressAutoCloseUntil) {
      return;
    }
    if (!isMouseOverCard || !store.settings.isStayingOpen) {
      closePopup();
    }
  }

  function onMouseEnterCard() {
    isMouseOverCard = true;
    resetMouseIdleTimeout();
  }

  function onMouseLeaveCard() {
    if (Date.now() < suppressAutoCloseUntil) {
      // Keep mouse state active during suppression to prevent premature closing
      isMouseOverCard = true;
      resetMouseIdleTimeout();
      return;
    }
    isMouseOverCard = false;
    clearMouseIdleTimeout();
    if (store.isOpen && !store.settings.isStayingOpen) {
      closePopup();
    }
  }

  function onMouseMoveOnCard() {
    resetMouseIdleTimeout();
  }

  function resetMouseIdleTimeout() {
    clearMouseIdleTimeout();
    if (isDisposed || !store.isOpen) {
      return;
    }
    mouseIdleTimeout = window.setTimeout(() => {
      if (isMouseOverCard && store.isOpen && !store.settings.isStayingOpen) {
        closePopup();
      }
    }, MOUSE_IDLE_DURATION);
  }

  function clearMouseIdleTimeout() {
    if (mouseIdleTimeout !== undefined) {
      window.clearTimeout(mouseIdleTimeout);
      mouseIdleTimeout = undefined;
    }
  }

  function suppressAutoClose(duration = 3000) {
    suppressAutoCloseUntil = Date.now() + duration;
  }

  /**
   * PDF 页面里 document 可能拿不到焦点。
   * 这里主动把焦点还给 embed，避免快捷键切换时行为异常。
   * More on this:
   * https://stackoverflow.com/questions/58702747/window-events-with-pdf-document-via-chrome/75570258#75570258
   */
  function fixUnfocusedDocumentInPdfFiles(): () => void {
    if (document.contentType !== "application/pdf") {
      return () => {};
    }
    const pdfElement = document.querySelector<HTMLEmbedElement>(
      'embed[type="application/pdf"]'
    );
    restoreFocus();
    pdfElement?.addEventListener("blur", restoreFocus);

    return () => {
      pdfElement?.removeEventListener("blur", restoreFocus);
    };

    function restoreFocus() {
      if (!isDisposed) {
        pdfElement?.focus();
      }
    }
  }
}

class PopupTabSwitcherElement extends HTMLElement {
  shadowRoot: ShadowRoot;

  /**
   * Removes the SolidJS element from the DOM.
   */
  private disposeRoot: () => void;

  /**
   * Stops listening to the disconnection of the element from the DOM.
   */
  private disposeDisconnectionListener: () => void;

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
  }

  /**
   * Fires when the custom element is disconnected from the DOM.
   */
  disconnectedCallback() {
    log("[disconnectedCallback]");
    this.disposeDisconnectionListener();
    this.disposeRoot();
  }

  /**
   * Fires when the custom element is connected to the DOM.
   */
  connectedCallback() {
    this.disposeDisconnectionListener = this.initDisconnectionListener();
    // We can't render instantly in the constructor because the custom element
    // should not have properties before it is created.
    this.disposeRoot = render(() => <Popup element={this} />, this.shadowRoot);
  }

  /**
   * Safety measure that tracks the disconnection of the element from the DOM, even in cases when
   * the `disconnectedCallback` is not called. It happens when the element is removed from the DOM
   * by the external script. The external script is a script that was not injected by the extension.
   * It may be:
   * - a page script that already exists on the page.
   * - another extension. Including the different version of the Popup Tab Switcher extension.
   */
  initDisconnectionListener(): () => void {
    const observer = new MutationObserver((records) => {
      log(`[mutation records]`, records);
      if (!this.parentNode) {
        this.disconnectedCallback();
      }
    });

    observer.observe(document.body, {
      childList: true,
    });

    return () => {
      observer.disconnect();
    };
  }
}

export function initPopupTabSwitcher(): void {
  const id = "popup-tab-switcher";
  const existingEl = document.getElementById(id);
  if (existingEl) {
    existingEl.remove();
  }
  // NOTE:
  // Registered custom element can't use the same name in a subsequent registration
  // using define() method. That is why we need to generate a new name by mixing
  // a random number to it.
  const name = `${id}-${uuid()}`;
  customElements.define(name, PopupTabSwitcherElement);
  const tabSwitcherElement = document.createElement(name);
  tabSwitcherElement.id = id;
  document.body.append(tabSwitcherElement);
}
