// Opens the side panel when the toolbar icon is clicked.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});

// The panel holds a port open while it's alive. When it closes — by our own
// Close button, the browser's X, or navigating away — the port disconnects
// and we turn inspect mode off everywhere, so the page doesn't stay stuck
// in crosshair mode with a panel that's no longer there.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'pointer-panel') return;
  port.onDisconnect.addListener(() => {
    chrome.tabs.query({ url: ['http://localhost/*', 'http://127.0.0.1/*'] }, (tabs) => {
      for (const tab of tabs) {
        if (!tab.id) continue;
        chrome.tabs.sendMessage(tab.id, { type: 'PTR_SET_ACTIVE', on: false }, () => {
          void chrome.runtime.lastError; // tab may have no content script
        });
      }
    });
  });
});
