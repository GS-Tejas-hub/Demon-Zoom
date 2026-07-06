// Demon Zoom — content script
//
// Two jobs:
//   1. Detect each <video>'s aspect ratio (so the popup can display it).
//   2. When a video is fullscreen, crop it to fill the screen with no black
//      bars and no distortion, using a uniform CSS transform.
//
// Runs in every frame ("all_frames") so it also handles players embedded in
// iframes (e.g. streaming sites like 9anime).

(() => {
  const DEFAULTS = {
    mediaEnabled: false,
    mediaTarget: "auto",
    mediaAdjust: 1,
    mediaCropTop: 25, // % of the cropped area removed from the TOP (rest from bottom)
  };
  let settings = { ...DEFAULTS };

  // Nominal aspect ratios offered as presets.
  const NOMINAL = {
    "16:10": 16 / 10,
    "16:9": 16 / 9,
    "18:9": 18 / 9,
    "21:9": 21 / 9,
    "32:9": 32 / 9,
  };

  const managed = new Set(); // videos we've attached observers to

  // ---- geometry ------------------------------------------------------------

  function monitorAr() {
    if (screen && screen.width && screen.height) {
      return screen.width / screen.height;
    }
    return 16 / 9;
  }

  // The aspect ratio we're cropping the video to fill.
  function targetAr() {
    if (settings.mediaTarget === "auto" || !NOMINAL[settings.mediaTarget]) {
      return monitorAr(); // auto = fill the actual monitor
    }
    return NOMINAL[settings.mediaTarget];
  }

  function videoAr(video) {
    if (video.videoWidth && video.videoHeight) {
      return video.videoWidth / video.videoHeight;
    }
    return null;
  }

  // Scale that makes a target-aspect region of the video cover the screen
  // (equivalent to object-fit: cover against the target ratio), times the
  // user's manual fine-tune. Rounded so the value is stable to compare against.
  function cropScale(video) {
    const vAr = videoAr(video);
    if (!vAr) return 1;
    const t = targetAr();
    const cover = Math.max(t / vAr, vAr / t);
    return Math.round(cover * settings.mediaAdjust * 10000) / 10000;
  }

  // ---- fullscreen detection ------------------------------------------------

  function fullscreenEl() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  // True when the video is effectively shown fullscreen: either fullscreen in
  // this document, or inside an iframe the parent page put fullscreen (then the
  // frame fills the whole screen, so innerWidth/Height match the monitor).
  //
  // We additionally require the video to fill (almost) a full axis of the
  // viewport. That keeps two things out: small in-page videos when the browser
  // itself is in F11 fullscreen, and stray thumbnails that happen to sit inside
  // a fullscreened container.
  function isFilling(video) {
    const fs = fullscreenEl();
    const inFullscreen = fs && (fs === video || fs.contains(video));
    const frameFillsScreen =
      Math.abs(window.innerWidth - screen.width) < 2 &&
      Math.abs(window.innerHeight - screen.height) < 2;
    if (!inFullscreen && !frameFillsScreen) return false;

    return (
      video.clientHeight >= window.innerHeight * 0.9 ||
      video.clientWidth >= window.innerWidth * 0.9
    );
  }

  // ---- apply / clear -------------------------------------------------------

  function shouldApply(video) {
    return settings.mediaEnabled && isFilling(video) && videoAr(video) !== null;
  }

  function desiredTransform(video) {
    return `scale(${cropScale(video)})`;
  }

  // Vertical anchor of the crop. transform-origin Y (as a %) equals the fraction
  // of the cropped area taken from the TOP: 0% = trim only the bottom (keep top),
  // 50% = even, 100% = trim only the top (keep bottom).
  function desiredOrigin() {
    const y =
      typeof settings.mediaCropTop === "number" ? settings.mediaCropTop : 25;
    return `50% ${y}%`;
  }

  function apply(video) {
    if (!shouldApply(video)) {
      clear(video);
      return;
    }
    const t = desiredTransform(video);
    const o = desiredOrigin();
    // Only write if something actually differs — avoids feedback loops with the
    // style MutationObserver below.
    if (
      video.style.getPropertyValue("transform") !== t ||
      video.style.getPropertyPriority("transform") !== "important" ||
      video.style.getPropertyValue("transform-origin") !== o
    ) {
      video.style.setProperty("transform", t, "important");
      video.style.setProperty("transform-origin", o, "important");
    }
    video.setAttribute("data-demonzoom", "1");
  }

  function clear(video) {
    if (video.getAttribute("data-demonzoom") === "1") {
      video.style.removeProperty("transform");
      video.style.removeProperty("transform-origin");
      video.removeAttribute("data-demonzoom");
    }
  }

  // ---- observers -----------------------------------------------------------

  const resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) apply(entry.target);
  });

  function manage(video) {
    if (managed.has(video)) return;
    managed.add(video);

    // Intrinsic size becomes known here — recompute.
    video.addEventListener("loadedmetadata", () => apply(video));
    video.addEventListener("emptied", () => apply(video));

    // If the site rewrites the video's inline style and drops our transform,
    // put it back. apply() is a no-op when nothing changed, so this converges.
    const styleObserver = new MutationObserver(() => {
      if (shouldApply(video)) {
        if (
          video.style.getPropertyValue("transform") !== desiredTransform(video) ||
          video.style.getPropertyValue("transform-origin") !== desiredOrigin()
        ) {
          apply(video);
        }
      }
    });
    styleObserver.observe(video, {
      attributes: true,
      attributeFilter: ["style"],
    });

    resizeObserver.observe(video); // box size changes (e.g. entering fullscreen)
    apply(video);
  }

  function scan() {
    document.querySelectorAll("video").forEach(manage);
  }

  function applyAll() {
    for (const video of [...managed]) {
      if (video.isConnected) apply(video);
      else managed.delete(video);
    }
    scan();
  }

  // Catch videos added later by SPAs / dynamic players.
  const domObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === "VIDEO") manage(node);
        else if (node.querySelectorAll) {
          node.querySelectorAll("video").forEach(manage);
        }
      }
    }
  });

  // ---- popup status query --------------------------------------------------

  function largestVideoAr() {
    let best = null;
    let bestArea = 0;
    for (const v of document.querySelectorAll("video")) {
      const ar = videoAr(v);
      if (!ar) continue;
      const area =
        v.clientWidth * v.clientHeight || v.videoWidth * v.videoHeight;
      if (area >= bestArea) {
        bestArea = area;
        best = ar;
      }
    }
    return best;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== "demonzoom:getMediaStatus") return;
    const ar = largestVideoAr();
    // Frames without a video stay silent so the frame that HAS the video is the
    // one that answers the popup.
    if (ar === null) return;
    sendResponse({ videoAr: ar, monitorAr: monitorAr() });
  });

  // ---- boot ----------------------------------------------------------------

  chrome.storage.sync.get(DEFAULTS, (loaded) => {
    settings = { ...DEFAULTS, ...loaded };
    scan();
    domObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    document.addEventListener("fullscreenchange", applyAll, true);
    document.addEventListener("webkitfullscreenchange", applyAll, true);
    window.addEventListener("resize", applyAll);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    let touched = false;
    for (const key of [
      "mediaEnabled",
      "mediaTarget",
      "mediaAdjust",
      "mediaCropTop",
    ]) {
      if (changes[key]) {
        settings[key] = changes[key].newValue;
        touched = true;
      }
    }
    if (touched) applyAll();
  });
})();
