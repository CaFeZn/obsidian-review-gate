export function isNativeViewMounted(containerEl: HTMLElement): boolean {
  const ownerWindow = containerEl.ownerDocument.defaultView;
  return containerEl.isConnected && ownerWindow !== null && !ownerWindow.closed;
}
