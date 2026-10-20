interface IPoint {
  x: number;
  y: number;
}

interface IOptions {
  element: HTMLElement;
  zoomFactor: () => number;
  isMotionEnabled: () => boolean;
  isProtected: (tabId: number) => boolean;
  onCloseStart: () => void;
}

export function createTabCloseLayout(options: IOptions) {
  let position: { left: number; top: number } | undefined;
  let relay: (IPoint & { nextTabId?: number }) | undefined;
  let generation = 0;
  let scrollFrame: number | undefined;
  const animations = new Set<Animation>();
  const ghosts = new Set<HTMLElement>();
  const rowClipping = new Map<HTMLElement, string>();

  return {
    close,
    applyPosition,
    blocksClick,
    onPointerMove,
    clearRelay,
    cancelMotion,
    reset,
    isHolding: () => relay !== undefined,
    isAdjustingScroll: () => scrollFrame !== undefined,
  };

  function close(tabId: number, event: MouseEvent, remove: () => void) {
    if (blocksClick(event)) return;
    const card =
      options.element.shadowRoot?.querySelector<HTMLElement>(".card");
    const viewport = card?.querySelector<HTMLElement>(".card__tabs");
    const rows = Array.from(
      viewport?.querySelectorAll<HTMLElement>(".tab") || []
    );
    const rowIndex = rows.findIndex(
      (row) => Number(row.dataset.tabId) === tabId
    );
    const row = rows[rowIndex];
    const button = row?.querySelector<HTMLElement>(".tab__closeButton");
    if (!card || !viewport || !button || event.detail === 0) {
      generation += 1;
      clearRelay();
      cancelMotion();
      remove();
      return;
    }

    const isProtected = options.isProtected(tabId);
    const nextRow = [rows[rowIndex - 1], rows[rowIndex + 1]].find(
      (peer) =>
        peer && options.isProtected(Number(peer.dataset.tabId)) === isProtected
    );
    const nextTabId = nextRow ? Number(nextRow.dataset.tabId) : undefined;
    const buttonRect = button.getBoundingClientRect();
    const anchorY = buttonRect.top + buttonRect.height / 2;
    const cardRect = card.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const viewportRect = viewport.getBoundingClientRect();
    const scrollTop = viewport.scrollTop;
    const shapes = options.isMotionEnabled()
      ? Array.from(
          viewport.querySelectorAll<HTMLElement>(
            ".tab__favicon, .tab__details, .tab__pinButton, .card__sectionSurface"
          )
        )
      : [];
    const before = new Map<HTMLElement, DOMRect>();
    for (const shape of shapes) {
      const rect = shape.getBoundingClientRect();
      if (
        shape.classList.contains("card__sectionSurface") ||
        (rect.bottom >= viewportRect.top - rowRect.height &&
          rect.top <= viewportRect.bottom + rowRect.height)
      ) {
        before.set(shape, rect);
      }
    }
    const ghost = options.isMotionEnabled() ? createGhost(row) : undefined;
    cancelMotion();
    position = { left: cardRect.left, top: cardRect.top };
    relay = { x: event.clientX, y: event.clientY };
    const request = ++generation;
    options.onCloseStart();
    remove();

    // Let keyed rows settle before measuring the next real close hit box.
    queueMicrotask(() => {
      if (request !== generation || !card.isConnected) return;
      applyPosition();
      viewport.scrollTop = scrollTop;
      const nextButton = nextRow?.isConnected
        ? nextRow.querySelector<HTMLElement>(".tab__closeButton")
        : undefined;
      if (nextButton && position) {
        const rect = nextButton.getBoundingClientRect();
        position.top += anchorY - rect.top - rect.height / 2;
        applyPosition();
        const aligned = nextButton.getBoundingClientRect();
        // Near a screen edge, scrolling can provide the remaining alignment.
        viewport.scrollTop += aligned.top + aligned.height / 2 - anchorY;
        const finalRect = nextButton.getBoundingClientRect();
        const visibleRect = viewport.getBoundingClientRect();
        if (
          relay &&
          contains(finalRect, relay) &&
          contains(visibleRect, relay)
        ) {
          relay.nextTabId = nextTabId;
        }
      }
      if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame);
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = undefined;
      });
      if (!options.isMotionEnabled()) return;
      for (const [shape, previous] of before) {
        if (!shape.isConnected) continue;
        const rect = shape.getBoundingClientRect();
        if (!rect.height) continue;
        const deltaY = previous.top - rect.top;
        const scaleY = shape.classList.contains("card__sectionSurface")
          ? previous.height / rect.height
          : 1;
        if (Math.abs(deltaY) < 0.1 && Math.abs(scaleY - 1) < 0.001) continue;
        const parent = shape.parentElement;
        if (parent?.classList.contains("tab") && !rowClipping.has(parent)) {
          rowClipping.set(parent, parent.style.overflow);
          parent.style.overflow = "visible";
        }
        // Animate contents and surfaces, never the live close buttons.
        animate(
          shape,
          [
            {
              transformOrigin: "top center",
              transform: `translateY(${deltaY}px) scaleY(${scaleY})`,
            },
            { transformOrigin: "top center", transform: "none" },
          ],
          160
        );
      }
      if (ghost) {
        Object.assign(ghost.style, {
          position: "absolute",
          left: `${rowRect.left}px`,
          top: `${rowRect.top}px`,
          width: `${rowRect.width}px`,
          height: `${rowRect.height}px`,
          margin: "0",
          pointerEvents: "none",
          clipPath: `inset(${Math.max(
            0,
            viewportRect.top - rowRect.top
          )}px 0 ${Math.max(0, rowRect.bottom - viewportRect.bottom)}px)`,
        });
        card.parentElement?.append(ghost);
        ghosts.add(ghost);
        animate(
          ghost,
          [
            { opacity: 1, transform: "scale(1)" },
            { opacity: 0, transform: "scale(0.97)" },
          ],
          90,
          () => {
            ghost.remove();
            ghosts.delete(ghost);
          }
        );
      }
    });
  }

  function applyPosition() {
    if (!position) return false;
    const card =
      options.element.shadowRoot?.querySelector<HTMLElement>(".card");
    if (!card) return false;
    const margin = 20 / options.zoomFactor();
    position.left = Math.max(
      margin,
      Math.min(position.left, window.innerWidth - card.offsetWidth - margin)
    );
    position.top = Math.max(
      margin,
      Math.min(position.top, window.innerHeight - card.offsetHeight - margin)
    );
    card.style.position = "absolute";
    card.style.left = `${position.left}px`;
    card.style.top = `${position.top}px`;
    return true;
  }

  function blocksClick(event: MouseEvent) {
    if (!relay || event.detail === 0) return false;
    if (hasMoved(event.clientX, event.clientY)) {
      clearRelay();
      return false;
    }
    return !event
      .composedPath()
      .some(
        (target) =>
          target instanceof HTMLElement &&
          target.classList.contains("tab__closeButton") &&
          relay?.nextTabId !== undefined &&
          Number(target.parentElement?.dataset.tabId) === relay.nextTabId
      );
  }

  function onPointerMove(event: PointerEvent) {
    if (hasMoved(event.clientX, event.clientY)) clearRelay();
  }

  function hasMoved(x: number, y: number) {
    return (
      relay && Math.hypot(x - relay.x, y - relay.y) >= 6 / options.zoomFactor()
    );
  }

  function contains(rect: DOMRect, point: IPoint) {
    return (
      point.x >= rect.left &&
      point.x <= rect.right &&
      point.y >= rect.top &&
      point.y <= rect.bottom
    );
  }

  function clearRelay() {
    relay = undefined;
  }

  function createGhost(row: HTMLElement) {
    const ghost = row.cloneNode(true) as HTMLElement;
    ghost.removeAttribute("data-tab-id");
    ghost.removeAttribute("tabindex");
    ghost.classList.remove("tab_selected", "tab_groupStart");
    ghost.setAttribute("aria-hidden", "true");
    ghost.setAttribute("inert", "");
    const style = window.getComputedStyle(row);
    // The inert copy lives outside the clipping card, but keeps its theme.
    for (const property of Array.from(style)) {
      if (property.startsWith("--")) {
        ghost.style.setProperty(property, style.getPropertyValue(property));
      }
    }
    ghost.style.color = style.color;
    ghost.style.font = style.font;
    ghost.querySelectorAll<HTMLElement>("button").forEach((button) => {
      button.style.visibility = "hidden";
    });
    return ghost;
  }

  function animate(
    target: HTMLElement,
    keyframes: Keyframe[],
    duration: number,
    onFinish?: () => void
  ) {
    const animation = target.animate(keyframes, {
      duration,
      easing: "cubic-bezier(0.2, 0.7, 0.2, 1)",
    });
    animations.add(animation);
    animation.onfinish = () => {
      animations.delete(animation);
      onFinish?.();
      if (!animations.size) restoreClipping();
    };
  }

  function restoreClipping() {
    for (const [row, overflow] of rowClipping) {
      if (overflow) row.style.overflow = overflow;
      else row.style.removeProperty("overflow");
    }
    rowClipping.clear();
  }

  function cancelMotion() {
    for (const animation of animations) {
      animation.onfinish = null;
      animation.cancel();
    }
    animations.clear();
    ghosts.forEach((ghost) => ghost.remove());
    ghosts.clear();
    restoreClipping();
  }

  function reset() {
    generation += 1;
    position = undefined;
    clearRelay();
    cancelMotion();
    if (scrollFrame !== undefined) {
      cancelAnimationFrame(scrollFrame);
      scrollFrame = undefined;
    }
  }
}
