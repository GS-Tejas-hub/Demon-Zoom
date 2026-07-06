// Demon Zoom — service worker
// Forces every tab to the configured zoom level while enabled.

const DEFAULT_ZOOM = 1.5; // 150%

async function getSettings() {
  return chrome.storage.sync.get({ enabled: true, zoomLevel: DEFAULT_ZOOM });
}

// Apply the configured zoom to a single tab (only while enabled). We set it
// unconditionally rather than checking the current value first: after a reload
// some browsers report the persisted per-origin zoom while actually rendering
// at 100%, so a "skip if already correct" check would wrongly leave the page
// un-zoomed. Setting it every time is a harmless no-op when already correct.
async function applyZoom(tabId) {
  if (typeof tabId !== "number") return;
  try {
    const { enabled, zoomLevel } = await getSettings();
    if (!enabled) return;
    await chrome.tabs.setZoom(tabId, zoomLevel);
  } catch (e) {
    // Tab isn't zoomable or no longer exists — nothing to do.
  }
}

// Bring every open tab into line with the current settings. When enabled,
// that means the chosen zoom; when disabled, it means resetting to 100%.
async function syncAllTabs() {
  try {
    const { enabled, zoomLevel } = await getSettings();
    const target = enabled ? zoomLevel : 1.0;
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      try {
        await chrome.tabs.setZoom(tab.id, target);
      } catch (e) {
        // skip tabs that can't be zoomed
      }
    }
  } catch (e) {
    // ignore
  }
}

// Apply while the page is still loading (reduces the flash of un-zoomed
// content) AND again once it finishes. On "complete" we also re-assert a moment
// later, because some browsers restore their own zoom shortly after the page
// settles (this is what made the zoom vanish on refresh).
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" || changeInfo.status === "complete") {
    applyZoom(tabId);
    if (changeInfo.status === "complete") {
      setTimeout(() => applyZoom(tabId), 600);
    }
  }
});

// Catch tabs that become active without a fresh navigation.
chrome.tabs.onActivated.addListener(({ tabId }) => applyZoom(tabId));

// The real fix for "zoom gone after refresh": whenever a tab's zoom drifts away
// from our target — including when the browser silently resets it on reload —
// snap it straight back. We read the target fresh each time, so changing the
// level from the popup is respected rather than fought, and setting it back to
// the same value is a no-op (so this never loops).
chrome.tabs.onZoomChange.addListener(async (info) => {
  try {
    const { enabled, zoomLevel } = await getSettings();
    if (!enabled) return;
    if (Math.abs(info.newZoomFactor - zoomLevel) > 0.005) {
      await chrome.tabs.setZoom(info.tabId, zoomLevel);
    }
  } catch (e) {
    // tab can't be zoomed / no longer exists — ignore
  }
});

// React instantly when the popup flips the switch or changes the level.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && (changes.enabled || changes.zoomLevel)) {
    syncAllTabs();
  }
});

// After an install/update the content script in already-open tabs is dead, so
// media-crop changes wouldn't reach them until a manual refresh. Re-inject the
// fresh content script into every open http(s) tab so it "just works". The
// script guards against running twice, so this is safe.
async function injectContentIntoOpenTabs() {
  try {
    const tabs = await chrome.tabs.query({
      url: ["http://*/*", "https://*/*"],
    });
    for (const tab of tabs) {
      chrome.scripting
        .executeScript({
          target: { tabId: tab.id, allFrames: true },
          files: ["content.js"],
        })
        .catch(() => {
          // some tabs (e.g. the Web Store) refuse injection — ignore
        });
    }
  } catch (e) {
    // ignore
  }
}

// Re-apply to every open tab when the extension is installed/updated or the
// browser starts, so existing tabs get the settings without a manual reload.
chrome.runtime.onInstalled.addListener(() => {
  syncAllTabs();
  injectContentIntoOpenTabs();
});
chrome.runtime.onStartup.addListener(syncAllTabs);
