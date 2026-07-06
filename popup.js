// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const NOMINAL = {
  "16:10": 16 / 10,
  "16:9": 16 / 9,
  "18:9": 18 / 9,
  "21:9": 21 / 9,
  "32:9": 32 / 9,
};

// A short list used to label a raw aspect ratio (e.g. 2.389 -> "21:9").
const LABELS = [
  ["32:9", 32 / 9],
  ["21:9", 21 / 9],
  ["18:9", 18 / 9],
  ["16:9", 16 / 9],
  ["16:10", 16 / 10],
  ["3:2", 3 / 2],
  ["4:3", 4 / 3],
  ["5:4", 5 / 4],
  ["1:1", 1],
];

function ratioLabel(ar) {
  let best = LABELS[0];
  let diff = Infinity;
  for (const entry of LABELS) {
    const d = Math.abs(entry[1] - ar);
    if (d < diff) {
      diff = d;
      best = entry;
    }
  }
  // Close to a common ratio → show its name, otherwise a decimal.
  return Math.abs(best[1] - ar) / ar < 0.04
    ? best[0]
    : Math.round(ar * 100) / 100 + ":1";
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

document.querySelectorAll(".tabs button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document
      .querySelectorAll(".tabs button")
      .forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".panel").forEach((p) => {
      p.classList.toggle("active", p.id === btn.dataset.panel);
    });
    if (btn.dataset.panel === "panel-media") refreshDetection();
  });
});

// ---------------------------------------------------------------------------
// Zoom tab  (browser page zoom)
// ---------------------------------------------------------------------------

const DEFAULT_ZOOM = 1.5;
const zoomToggle = document.getElementById("zoomToggle");
const zoomControls = document.getElementById("zoomControls");
const zoomStatus = document.getElementById("zoomStatus");
const zoomSlider = document.getElementById("zoomSlider");
const zoomValue = document.getElementById("zoomValue");
const zoomPresetButtons = [
  ...document.querySelectorAll("#zoomPresets button"),
];

let zoomEnabled = true;

function renderZoomPercent(percent) {
  zoomValue.textContent = percent + "%";
  zoomPresetButtons.forEach((b) =>
    b.classList.toggle("active", Number(b.dataset.zoom) === percent)
  );
  // Drive the neon slider fill to match the value.
  const min = Number(zoomSlider.min);
  const max = Number(zoomSlider.max);
  zoomSlider.style.setProperty(
    "--fill",
    ((percent - min) / (max - min)) * 100 + "%"
  );
}

// Re-trigger the glow pulse on the big number.
function kickValue() {
  zoomValue.classList.remove("kick");
  void zoomValue.offsetWidth; // force reflow so the animation restarts
  zoomValue.classList.add("kick");
}

function renderZoomEnabled() {
  zoomToggle.checked = zoomEnabled;
  zoomControls.classList.toggle("disabled", !zoomEnabled);
  zoomStatus.textContent = zoomEnabled
    ? "Applied to every site."
    : "Off — sites use normal zoom.";
}

async function zoomCurrentTab(factor) {
  const tab = await getCurrentTab();
  if (tab) {
    try {
      await chrome.tabs.setZoom(tab.id, factor);
    } catch (e) {
      /* internal pages can't be zoomed */
    }
  }
}

async function setZoomLevel(percent) {
  renderZoomPercent(percent);
  await chrome.storage.sync.set({ zoomLevel: percent / 100 });
  if (zoomEnabled) await zoomCurrentTab(percent / 100);
}

async function setZoomEnabled(value) {
  zoomEnabled = value;
  renderZoomEnabled();
  await chrome.storage.sync.set({ enabled: zoomEnabled });
  await zoomCurrentTab(zoomEnabled ? Number(zoomSlider.value) / 100 : 1.0);
}

zoomToggle.addEventListener("change", () => setZoomEnabled(zoomToggle.checked));
zoomSlider.addEventListener("input", () =>
  setZoomLevel(Number(zoomSlider.value))
);
zoomPresetButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    zoomSlider.value = btn.dataset.zoom;
    setZoomLevel(Number(btn.dataset.zoom));
    kickValue();
  });
});

// ---------------------------------------------------------------------------
// Media tab  (video crop-to-fill)
// ---------------------------------------------------------------------------

const mediaToggle = document.getElementById("mediaToggle");
const mediaControls = document.getElementById("mediaControls");
const mediaStatus = document.getElementById("mediaStatus");
const monitorArEl = document.getElementById("monitorAr");
const videoArEl = document.getElementById("videoAr");
const mediaZoomEl = document.getElementById("mediaZoom");
const zoomDownBtn = document.getElementById("zoomDown");
const zoomUpBtn = document.getElementById("zoomUp");
const mediaPresetButtons = [
  ...document.querySelectorAll("#mediaPresets button"),
];

// crop sub-tab elements
const cropSlider = document.getElementById("cropSlider");
const topCutVal = document.getElementById("topCutVal");
const botCutVal = document.getElementById("botCutVal");
const cutTopEl = document.getElementById("cutTop");
const cutBottomEl = document.getElementById("cutBottom");
const alignPresetButtons = [
  ...document.querySelectorAll("#alignPresets button"),
];

const monitorArValue = screen.width / screen.height;
let media = { enabled: false, target: "auto", adjust: 1, cropTop: 25 };
let detectedVideoAr = null;

function mediaTargetAr() {
  if (media.target === "auto") return monitorArValue;
  return NOMINAL[media.target] || monitorArValue;
}

// Total crop scale (matches what content.js applies).
function coverScale(vAr) {
  if (media.target === "native") return 1; // no crop — show provider's aspect
  const t = mediaTargetAr();
  return Math.max(t / vAr, vAr / t);
}

function effectiveZoom() {
  if (!detectedVideoAr) return media.adjust;
  return coverScale(detectedVideoAr) * media.adjust;
}

function renderMedia() {
  mediaToggle.checked = media.enabled;
  mediaControls.classList.toggle("disabled", !media.enabled);
  mediaStatus.textContent = media.enabled
    ? "Crop fullscreen video."
    : "Off — video not cropped.";

  monitorArEl.textContent = ratioLabel(monitorArValue);
  videoArEl.textContent = detectedVideoAr
    ? ratioLabel(detectedVideoAr)
    : "Not detected";
  mediaZoomEl.textContent = "x" + effectiveZoom().toFixed(2);

  mediaPresetButtons.forEach((b) =>
    b.classList.toggle("active", b.dataset.target === media.target)
  );
}

async function saveMedia() {
  await chrome.storage.sync.set({
    mediaEnabled: media.enabled,
    mediaTarget: media.target,
    mediaAdjust: media.adjust,
    mediaCropTop: media.cropTop,
  });
}

// ---- crop alignment (how the top/bottom trim is split) ----

// media.cropTop = % of the cropped area removed from the TOP.
function renderCrop() {
  const top = media.cropTop;
  const bottom = 100 - top;
  topCutVal.textContent = top + "%";
  botCutVal.textContent = bottom + "%";
  cropSlider.value = top;
  cropSlider.style.setProperty("--fill", top + "%");

  // Preview: split an illustrative "cropped band" between top and bottom so the
  // user sees which slice survives. (Actual trim amount depends on the video.)
  const BAND = 42; // % of the frame shown as cropped, for illustration only
  cutTopEl.style.flexBasis = (BAND * top) / 100 + "%";
  cutBottomEl.style.flexBasis = (BAND * bottom) / 100 + "%";

  alignPresetButtons.forEach((b) =>
    b.classList.toggle("active", Number(b.dataset.top) === top)
  );
}

function setCropTop(value) {
  media.cropTop = clamp(Math.round(value), 0, 100);
  renderCrop();
  saveMedia();
}

cropSlider.addEventListener("input", () => setCropTop(Number(cropSlider.value)));
alignPresetButtons.forEach((btn) => {
  btn.addEventListener("click", () => setCropTop(Number(btn.dataset.top)));
});

// Media sub-tabs (RATIO / CROP).
document.querySelectorAll(".subtabs button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document
      .querySelectorAll(".subtabs button")
      .forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".subpanel").forEach((p) => {
      p.classList.toggle("active", p.id === btn.dataset.sub);
    });
  });
});

// Ask the active tab's content script what video it sees.
function refreshDetection() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab) return;
    chrome.tabs.sendMessage(
      tab.id,
      { type: "demonzoom:getMediaStatus" },
      (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.videoAr) {
          detectedVideoAr = null;
        } else {
          detectedVideoAr = resp.videoAr;
        }
        renderMedia();
      }
    );
  });
}

mediaToggle.addEventListener("change", () => {
  media.enabled = mediaToggle.checked;
  renderMedia();
  saveMedia();
});

function stepZoom(delta) {
  if (detectedVideoAr) {
    // Step the displayed (total) zoom by `delta`, then back out the adjust.
    const cover = coverScale(detectedVideoAr);
    const nextZoom = effectiveZoom() + delta;
    media.adjust = clamp(nextZoom / cover, 0.5, 4);
  } else {
    media.adjust = clamp(media.adjust + delta, 0.5, 4);
  }
  renderMedia();
  saveMedia();
}

zoomDownBtn.addEventListener("click", () => stepZoom(-0.05));
zoomUpBtn.addEventListener("click", () => stepZoom(0.05));

mediaPresetButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    media.target = btn.dataset.target;
    renderMedia();
    saveMedia();
  });
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

(async () => {
  const s = await chrome.storage.sync.get({
    enabled: true,
    zoomLevel: DEFAULT_ZOOM,
    mediaEnabled: false,
    mediaTarget: "auto",
    mediaAdjust: 1,
    mediaCropTop: 25,
  });

  // zoom
  zoomEnabled = s.enabled;
  const percent = Math.round(s.zoomLevel * 100);
  zoomSlider.value = percent;
  renderZoomPercent(percent);
  renderZoomEnabled();
  kickValue();

  // media
  media = {
    enabled: s.mediaEnabled,
    target: s.mediaTarget,
    adjust: s.mediaAdjust,
    cropTop: s.mediaCropTop,
  };
  renderMedia();
  renderCrop();
  refreshDetection();
})();

// Keep the detected video ratio fresh while the popup is open (a video may
// start playing or load its metadata a moment after opening).
const detectionTimer = setInterval(refreshDetection, 1200);
window.addEventListener("unload", () => clearInterval(detectionTimer));
