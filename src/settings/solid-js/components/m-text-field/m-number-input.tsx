import {createEffect, createSignal, Show} from 'solid-js'
import styles from './m-text-field.module.scss'

interface IProps {
  value: number
  id: string
  onInput: (value: number) => void
  suffix?: string
  min?: number
  max?: number
  integer?: boolean
}

export function MNumberInput(props: IProps) {
  const [draft, setDraft] = createSignal(String(props.value))
  const [isEditing, setEditing] = createSignal(false)
  const min = () => props.min ?? 0
  const max = () => props.max ?? 10000
  let inputElement: HTMLInputElement
  createEffect(() => {
    const value = props.value
    if (!isEditing()) setDraft(String(value))
  })
  return (
    <div class={styles.field}>
      <input
        ref={inputElement!}
        class={props.suffix ? styles.inputWithSuffix : styles.input}
        id={props.id}
        type="number"
        name={props.id}
        min={min()}
        max={max()}
        step={props.integer ? 1 : 'any'}
        value={draft()}
        onFocus={() => setEditing(true)}
        onInput={() => {
          setDraft(inputElement.value)
          const value = inputElement.valueAsNumber
          if (
            Number.isFinite(value) &&
            value >= min() &&
            value <= max() &&
            (!props.integer || Number.isInteger(value))
          )
            props.onInput(value)
        }}
        onBlur={commitDraft}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            inputElement.blur()
          }
        }}
      />
      <Show when={props.suffix}>
        <div class={styles.suffix}>{props.suffix}</div>
      </Show>
      <div class={styles.outline}>
        <div class={styles.outlineLeading}></div>
        <div class={styles.outlineTrailing}></div>
      </div>
    </div>
  )

  function commitDraft() {
    const parsed = inputElement.valueAsNumber
    const value = Number.isFinite(parsed) ? parsed : props.value
    const normalized = Math.min(
      max(),
      Math.max(min(), props.integer ? Math.round(value) : value)
    )
    if (normalized !== props.value) props.onInput(normalized)
    setEditing(false)
    setDraft(String(normalized))
  }
}
