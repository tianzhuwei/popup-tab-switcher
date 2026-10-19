import "solid-js";

// Enables typed native (non-delegated) listeners such as `on:click`.
declare module "solid-js" {
  namespace JSX {
    interface CustomEvents {
      click: MouseEvent;
    }
  }
}
