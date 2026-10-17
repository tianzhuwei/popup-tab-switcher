export async function isBrowserFocused(): Promise<boolean> {
  const lastFocused = await chrome.windows.getLastFocused()
  return lastFocused.focused
}
