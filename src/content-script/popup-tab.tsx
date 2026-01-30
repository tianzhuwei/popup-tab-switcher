import {Show} from 'solid-js/web'
import {createEffect} from 'solid-js'
import {TabIcon, PinIcon} from './icons'

interface IProps {
  isSelected: boolean
  isTimeoutShown: boolean
  isLast: boolean
  isFirst: boolean
  isPinned: boolean
  tab: chrome.tabs.Tab
  onClick: () => void
  onTogglePin: () => void
  textScrollSpeed: number
  textScrollDelay: number
}

export function PopupTab(props: IProps) {
  let tabElement: HTMLDivElement
  let tabTextElement: HTMLDivElement
  let tabTextContentElement: HTMLElement

  createEffect(() => {
    if (props.isSelected) {
      scrollLongTextOfSelectedTab()
      tabElement.focus()
    } else {
      tabTextContentElement.getAnimations().forEach((animation) => animation.cancel())
    }
  })

  function handlePinClick(e: MouseEvent) {
    e.stopPropagation()
    props.onTogglePin()
  }

  return (
    <div
      ref={tabElement!}
      tabindex="-1"
      class="tab"
      classList={{
        tab_selected: props.isSelected,
        tab_pinned: props.isPinned,
      }}
      onClick={props.onClick}
    >
      <Show when={props.isTimeoutShown}>
        <div class="tab__timeoutIndicator" />
      </Show>
      <TabIcon url={props.tab.url} />
      <div ref={tabTextElement!} class="tab__text">
        <span class="tab__textContent" ref={tabTextContentElement!}>
          {props.tab.title}
        </span>
      </div>
      <button
        class="tab__pinButton"
        classList={{
          tab__pinButton_pinned: props.isPinned,
        }}
        onClick={handlePinClick}
        title={props.isPinned ? 'Unpin tab' : 'Pin tab'}
      >
        <PinIcon isPinned={props.isPinned} />
      </button>
    </div>
  )

  function scrollLongTextOfSelectedTab() {
    const horizontalPadding = 10
    const fullTextWidthWithoutOnePadding = tabTextContentElement.scrollWidth - horizontalPadding
    const textOverflow = fullTextWidthWithoutOnePadding - tabTextElement.clientWidth
    const pixelsPerSecond = 90 * props.textScrollSpeed
    if (textOverflow > 0) {
      const hiddenTextWidthWithPadding = textOverflow + horizontalPadding
      const scrollTimeMs = (hiddenTextWidthWithPadding / pixelsPerSecond) * 1000
      const durationMs = scrollTimeMs + 2 * props.textScrollDelay
      const startDelayOffset = props.textScrollDelay / durationMs
      const endDelayOffset = 1 - startDelayOffset
      tabTextContentElement.animate(
        [
          {
            transform: 'initial',
            offset: 0,
          },
          {
            transform: 'initial',
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
          direction: 'normal',
          iterations: Infinity,
        }
      )
    }
  }
}
