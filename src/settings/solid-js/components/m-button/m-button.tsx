import {onCleanup, onMount} from 'solid-js'
import {MDCRipple} from '@material/ripple/index'
import styles from './m-button.module.scss'

interface IProps {
  raised?: boolean
  text: string
  onClick?: () => void
}

export function MButton(props: IProps) {
  let buttonElement: HTMLButtonElement
  let ripple: MDCRipple | undefined
  onMount(() => {
    ripple = MDCRipple.attachTo(buttonElement!)
  })
  onCleanup(() => {
    ripple?.destroy()
  })
  return (
    <button
      ref={buttonElement!}
      class={`mdc-button ${styles.button}`}
      classList={{
        [styles.buttonRaised]: props.raised,
      }}
      onClick={(event) => {
        event.preventDefault()
        props.onClick?.()
      }}
    >
      <i class={styles.icon}></i>
      {props.text}
    </button>
  )
}
