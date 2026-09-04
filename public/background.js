// By default, Chrome's side panel API treats manifest.json's side_panel
// as one global panel shared by the whole window — open it on any tab and
// it follows you to every other tab, unlike a real per-tab inspector.
// Keeping it disabled everywhere except the specific tab it was opened on
// (below) is what makes it behave like DevTools instead: open here, gone
// when you switch away, back when you switch back.
async function disablePanelGlobally() {
  await chrome.sidePanel.setOptions({ enabled: false }).catch(() => {});
}
chrome.runtime.onInstalled.addListener(disablePanelGlobally);
chrome.runtime.onStartup.addListener(disablePanelGlobally);

// openPanelOnActionClick would open that same shared/global panel, so the
// toolbar icon is handled by hand instead: enable + open it for only the
// tab that was actually clicked.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  await chrome.sidePanel.setOptions({
    tabId: tab.id,
    path: 'sidepanel.html',
    enabled: true,
  });
  await chrome.sidePanel.open({ tabId: tab.id });
});

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
