interface IProps {
  id: string
  isOn: boolean
  onToggle: () => void
  toggleOnClick?: boolean
  disabled?: boolean
}

export function MSwitch(props: IProps) {
  return (
    <div class="mdc-switch" classList={{'mdc-switch--checked': props.isOn}}>
      <div class="mdc-switch__track" />
      <div class="mdc-switch__thumb-underlay">
        <div class="mdc-switch__thumb">
          <input
            type="checkbox"
            id={props.id}
            name={props.id}
            class="mdc-switch__native-control"
            role="switch"
            onChange={() => {
              if (!props.toggleOnClick) props.onToggle()
            }}
            on:click={() => {
              if (props.toggleOnClick) props.onToggle()
            }}
            checked={props.isOn}
            disabled={props.disabled}
          />
        </div>
      </div>
    </div>
  )
}
