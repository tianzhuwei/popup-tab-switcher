import {onMount} from 'solid-js'
// eslint-disable-next-line import/no-extraneous-dependencies
import {MDCRipple} from '@material/ripple/index'
import styles from './m-button.module.scss'

interface IProps {
  raised?: boolean
  text: string
  onClick?: () => void
}

export function MButton(props: IProps) {
  let buttonElement: HTMLButtonElement
  onMount(() => {
    MDCRipple.attachTo(buttonElement!)
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
