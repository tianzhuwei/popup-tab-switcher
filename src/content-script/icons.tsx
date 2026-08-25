import { createMemo, createSignal } from "solid-js";
import { Show } from "solid-js/web";

function getFaviconUrl(url: string) {
  const faviconUrl = new URL(
    `chrome-extension://${chrome.runtime.id}/_favicon/`
  );
  faviconUrl.searchParams.set("pageUrl", url);
  faviconUrl.searchParams.set("size", "64");
  return faviconUrl.href;
}

export function TabCornerIcon(props: { type: "top" | "bottom" }) {
  const tabCornerType =
    props.type === "top" ? "tab__cornerIcon_top" : "tab__cornerIcon_bottom";
  return (
    <svg
      class={`tab__cornerIcon ${tabCornerType}`}
      viewBox="0 0 8 8"
      preserveAspectRatio="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M0 0C0 4.41828 3.58172 8 8 8H0V0Z" />
    </svg>
  );
}

export function TabIcon(props: { url: string | undefined; title?: string }) {
  const [hasError, setHasError] = createSignal(false);
  const url = createMemo(() => {
    if (!props.url) {
      return "";
    }
    return getFaviconUrl(props.url);
  });
  const showFallback = createMemo(() => !url() || hasError());
  return (
    <>
      <Show when={!showFallback()}>
        <img
          src={url()}
          class="tab__icon"
          onError={() => setHasError(true)}
          alt=""
        />
      </Show>
      <Show when={showFallback()}>
        <LetterIcon title={props.title} url={props.url} />
      </Show>
    </>
  );
}

/**
 * Renders a colored tile with the first letter of the site (hostname or
 * title). Used when the tab has no favicon or the favicon fails to load.
 */
function LetterIcon(props: { title?: string; url?: string }) {
  const letter = createMemo(() => {
    const source = hostname(props.url) || props.title || "";
    const ch = source.trim().charAt(0);
    return ch ? ch.toUpperCase() : "?";
  });
  const color = createMemo(() => colorForKey(hostname(props.url) || letter()));
  return (
    <span
      class="tab__icon tab__icon_letter"
      style={{ "background-color": color() }}
      aria-hidden="true"
    >
      {letter()}
    </span>
  );
}

function hostname(url?: string): string {
  if (!url) {
    return "";
  }
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// A small palette of pleasant, readable tile colors.
const LETTER_COLORS = [
  "#ef5350",
  "#ec407a",
  "#ab47bc",
  "#7e57c2",
  "#5c6bc0",
  "#42a5f5",
  "#26a69a",
  "#66bb6a",
  "#9ccc65",
  "#ffa726",
  "#8d6e63",
  "#78909c",
];

function colorForKey(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return LETTER_COLORS[Math.abs(hash) % LETTER_COLORS.length];
}

export function PinIcon(props: { isPinned: boolean }) {
  return (
    <svg
      class="tab__pinIcon"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M16 4V10L18 11.5V13H12.5V20L12 22L11.5 20V13H6V11.5L8 10V4H7V2H17V4H16ZM14 10V4H10V10L8.5 11H15.5L14 10Z"
        fill="currentColor"
        fill-opacity={props.isPinned ? 1 : 0.5}
      />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg
      class="tab__closeIcon"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M19 6.41L17.59 5L12 10.59L6.41 5L5 6.41L10.59 12L5 17.59L6.41 19L12 13.41L17.59 19L19 17.59L13.41 12L19 6.41Z"
        fill="currentColor"
      />
    </svg>
  );
}
