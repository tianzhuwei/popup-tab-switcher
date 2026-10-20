import { createEffect, onCleanup, onMount } from "solid-js";

interface IProps {
  isActive: boolean;
  isMotionEnabled: boolean;
  selectedTabId: number | undefined;
  selectedTabIndex: number;
  protectedTabCount: number;
  tabOrder: string;
  zoomFactor: number;
}

interface IPosition {
  tabId: number;
  index: number;
  top: number;
  height: number;
  isProtected: boolean;
  tabOrder: string;
  zoomFactor: number;
}

export function PopupSelection(props: IProps) {
  let highlight: HTMLDivElement;
  let animation: Animation | undefined;
  let frame: number | undefined;
  let observer: ResizeObserver | undefined;
  let previous: IPosition | undefined;
  let generation = 0;
  let isDisposed = false;

  createEffect(() => {
    props.selectedTabId;
    props.selectedTabIndex;
    props.protectedTabCount;
    props.tabOrder;
    props.zoomFactor;
    if (!props.isActive || !props.isMotionEnabled) {
      reset();
      return;
    }
    scheduleUpdate();
  });

  onMount(() => {
    const list = highlight.parentElement;
    if (list) {
      observer = new ResizeObserver(scheduleUpdate);
      observer.observe(list);
    }
  });

  onCleanup(() => {
    isDisposed = true;
    observer?.disconnect();
    reset();
  });

  return <div ref={highlight!} class="card__selection" aria-hidden="true" />;

  function cancelAnimation() {
    if (animation) {
      animation.onfinish = null;
      animation.cancel();
      animation = undefined;
    }
  }

  function reset() {
    generation += 1;
    if (frame !== undefined) {
      cancelAnimationFrame(frame);
      frame = undefined;
    }
    cancelAnimation();
    highlight?.parentElement?.classList.remove("card__tabList_selectionActive");
    previous = undefined;
  }

  function scheduleUpdate() {
    const request = ++generation;
    // Let keyed rows and their existing reorder animations settle into the DOM.
    queueMicrotask(() => {
      if (isDisposed || request !== generation) return;
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = undefined;
        update(request);
      });
    });
  }

  function update(request: number) {
    if (isDisposed || request !== generation) return;
    if (!props.isActive || !props.isMotionEnabled) {
      reset();
      return;
    }
    const list = highlight.parentElement;
    const row = list?.querySelector<HTMLElement>(".tab_selected");
    if (!list || !row || props.selectedTabId === undefined) {
      reset();
      return;
    }
    const next: IPosition = {
      tabId: props.selectedTabId,
      index: props.selectedTabIndex,
      top: row.offsetTop,
      height: row.offsetHeight,
      isProtected: props.selectedTabIndex < props.protectedTabCount,
      tabOrder: props.tabOrder,
      zoomFactor: props.zoomFactor,
    };
    const rowAnimations = row.getAnimations().filter((item) => {
      const effect = item.effect;
      return (
        (item.playState === "running" || item.pending) &&
        effect instanceof KeyframeEffect &&
        effect
          .getKeyframes()
          .some((keyframe) => keyframe.transform !== undefined)
      );
    });
    if (rowAnimations.length) {
      // A row's own background follows its pin/ranking FLIP without drifting.
      list.classList.remove("card__tabList_selectionActive");
      cancelAnimation();
      previous = next;
      void Promise.allSettled(rowAnimations.map((item) => item.finished)).then(
        () => {
          if (!isDisposed && request === generation) scheduleUpdate();
        }
      );
      return;
    }
    const wasVisible = list.classList.contains("card__tabList_selectionActive");
    if (
      wasVisible &&
      previous?.tabId === next.tabId &&
      previous.top === next.top &&
      previous.height === next.height &&
      previous.tabOrder === next.tabOrder &&
      previous.zoomFactor === next.zoomFactor
    ) {
      return;
    }
    const shouldAnimate =
      wasVisible &&
      previous !== undefined &&
      previous.tabId !== next.tabId &&
      previous.tabOrder === next.tabOrder &&
      previous.height === next.height &&
      previous.zoomFactor === next.zoomFactor;
    const crossedGroup =
      previous !== undefined &&
      (previous.isProtected !== next.isProtected ||
        Math.abs(previous.index - next.index) > 2);
    const start = shouldAnimate
      ? window.getComputedStyle(highlight)
      : undefined;
    const startTransform = start?.transform;
    const startOpacity = start?.opacity;
    cancelAnimation();
    const transform = `translateY(${next.top}px)`;
    highlight.style.transform = transform;
    list.classList.add("card__tabList_selectionActive");
    if (shouldAnimate) {
      const nextAnimation = highlight.animate(
        [
          crossedGroup
            ? {
                transform: `translateY(${next.top + 5 / props.zoomFactor}px)`,
                opacity: 0.2,
              }
            : { transform: startTransform, opacity: startOpacity },
          { transform, opacity: 1 },
        ],
        {
          duration: 130,
          easing: crossedGroup
            ? "cubic-bezier(0.2, 0.8, 0.2, 1)"
            : "cubic-bezier(0.2, 0.75, 0.25, 1.16)",
        }
      );
      animation = nextAnimation;
      nextAnimation.onfinish = () => {
        if (animation === nextAnimation) animation = undefined;
      };
    }
    previous = next;
  }
}
