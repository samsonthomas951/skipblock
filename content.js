// SkipBlock content script.
// Runs on youtube.com, watches the active <video>, and handles whichever
// SponsorBlock segment categories the user has enabled — either by
// auto-skipping them, or by showing a "Skip ..." button like YouTube's own
// native skip-intro/skip-ad buttons. Also draws colored segments on the
// player's seek bar, like SponsorBlock's preview bar.

(() => {
  // Colors match SponsorBlock's own defaults so the bar looks familiar.
  const CATEGORY_META = {
    sponsor: { label: "sponsor segment", skipLabel: "Skip Sponsor", color: "#00d400", settingKey: "sponsorMode" },
    intro: { label: "intro", skipLabel: "Skip Intro", color: "#00ffff", settingKey: "introMode" },
    selfpromo: { label: "promotion", skipLabel: "Skip Promo", color: "#ffff00", settingKey: "selfpromoMode" },
    interaction: { label: "interaction reminder", skipLabel: "Skip", color: "#cc00ff", settingKey: "interactionMode" },
    music_offtopic: { label: "non-music section", skipLabel: "Skip", color: "#ff9900", settingKey: "musicOfftopicMode" },
    poi_highlight: { label: "highlight", color: "#ff1684" },
  };

  // Mode for each skippable category is one of: "off", "button", "autoskip".
  const DEFAULT_SETTINGS = {
    sponsorMode: "autoskip",
    musicOfftopicMode: "autoskip",
    introMode: "button",
    selfpromoMode: "button",
    interactionMode: "button",
    highlight: false,
    showToast: true,
    showBar: true,
  };

  let settings = { ...DEFAULT_SETTINGS };
  let segments = [];
  let currentVideoID = null;
  let video = null;
  let jumpedToHighlight = false;
  let videoObserver = null;
  let playerObserver = null;
  let toastEl = null;
  let toastHideTimer = null;
  let barEl = null;
  let barContainer = null;
  let buttonEl = null;
  let activeButtonSegment = null;

  function getMode(category) {
    const key = CATEGORY_META[category]?.settingKey;
    return key ? settings[key] || "off" : "off";
  }

  function getVideoIdFromUrl() {
    return new URLSearchParams(location.search).get("v");
  }

  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(DEFAULT_SETTINGS, (items) => resolve(items));
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    for (const key of Object.keys(changes)) {
      if (key in settings) settings[key] = changes[key].newValue;
    }
    renderBar();
  });

  function fetchSegments(videoID) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "getSegments", videoID }, (res) => {
        if (chrome.runtime.lastError || !res || !res.ok) {
          resolve([]);
          return;
        }
        resolve(Array.isArray(res.data) ? res.data : []);
      });
    });
  }

  // ---------- toast ----------

  function ensureToastEl() {
    if (toastEl && document.documentElement.contains(toastEl)) return toastEl;
    toastEl = document.createElement("div");
    toastEl.id = "skipblock-toast";
    document.documentElement.appendChild(toastEl);
    return toastEl;
  }

  function showToast(text) {
    if (!settings.showToast) return;
    const el = ensureToastEl();
    el.textContent = text;
    el.classList.remove("skipblock-toast-visible");
    // force reflow so the animation restarts if a toast is already showing
    void el.offsetWidth;
    el.classList.add("skipblock-toast-visible");
    clearTimeout(toastHideTimer);
    toastHideTimer = setTimeout(() => {
      el.classList.remove("skipblock-toast-visible");
    }, 2200);
  }

  // ---------- skip button (Skip Intro / Skip Promo / ...) ----------

  function findPlayer() {
    return document.querySelector("#movie_player, .html5-video-player");
  }

  function ensureButtonEl() {
    if (buttonEl && document.documentElement.contains(buttonEl)) return buttonEl;
    buttonEl = document.createElement("button");
    buttonEl.id = "skipblock-skip-button";
    buttonEl.type = "button";
    const player = findPlayer();
    (player || document.documentElement).appendChild(buttonEl);
    return buttonEl;
  }

  function showSkipButton(seg) {
    activeButtonSegment = seg;
    const meta = CATEGORY_META[seg.category];
    const el = ensureButtonEl();
    el.textContent = meta.skipLabel || "Skip";
    el.onclick = (e) => {
      e.stopPropagation();
      skipSegment(seg, true);
    };
    el.classList.add("skipblock-skip-button-visible");
  }

  function hideSkipButton() {
    activeButtonSegment = null;
    if (buttonEl) buttonEl.classList.remove("skipblock-skip-button-visible");
  }

  function skipSegment(seg, manual) {
    if (!video) return;
    const [, end] = seg.segment;
    video.currentTime = end;
    const meta = CATEGORY_META[seg.category];
    showToast(`Skipped ${meta.label}`);
    if (manual) hideSkipButton();
  }

  // ---------- colored segment bar ----------

  function findProgressBarContainer() {
    return document.querySelector(".ytp-progress-bar-container");
  }

  function ensureBarEl() {
    const container = findProgressBarContainer();
    if (!container) return null;
    if (barEl && barContainer === container && container.contains(barEl)) return barEl;
    barEl = document.createElement("div");
    barEl.id = "skipblock-bar";
    container.appendChild(barEl);
    barContainer = container;
    return barEl;
  }

  function renderBar() {
    const el = ensureBarEl();
    if (!el) return;
    el.innerHTML = "";
    if (!settings.showBar || !video || !video.duration || segments.length === 0) return;

    const duration = video.duration;
    for (const seg of segments) {
      const meta = CATEGORY_META[seg.category];
      if (!meta) continue;

      if (seg.actionType === "poi" || seg.category === "poi_highlight") {
        const t = seg.segment[0];
        const marker = document.createElement("div");
        marker.className = "skipblock-bar-poi";
        marker.style.left = `${(t / duration) * 100}%`;
        marker.style.background = meta.color;
        el.appendChild(marker);
        continue;
      }

      if (seg.actionType !== "skip") continue;
      if (getMode(seg.category) === "off") continue;

      const [start, end] = seg.segment;
      const chunk = document.createElement("div");
      chunk.className = "skipblock-bar-segment";
      chunk.style.left = `${(start / duration) * 100}%`;
      chunk.style.width = `${Math.max(0, ((end - start) / duration) * 100)}%`;
      chunk.style.background = meta.color;
      el.appendChild(chunk);
    }
  }

  // ---------- video wiring ----------

  function onTimeUpdate() {
    if (!video || segments.length === 0) return;
    const t = video.currentTime;

    // If the segment we're showing a button for has ended (or we've seeked
    // away from it), clear the button.
    if (activeButtonSegment) {
      const [s, e] = activeButtonSegment.segment;
      if (t < s || t >= e) hideSkipButton();
    }

    for (const seg of segments) {
      if (seg.actionType !== "skip") continue;
      const mode = getMode(seg.category);
      if (mode === "off") continue;

      const [start, end] = seg.segment;
      if (t >= start && t < end - 0.05) {
        if (mode === "autoskip") {
          skipSegment(seg, false);
          break;
        }
        if (mode === "button" && activeButtonSegment !== seg) {
          showSkipButton(seg);
        }
        break;
      }
    }
  }

  function maybeJumpToHighlight() {
    if (!settings.highlight || jumpedToHighlight || !video) return;
    const poi = segments.find((s) => s.category === "poi_highlight");
    if (poi) {
      jumpedToHighlight = true;
      video.currentTime = poi.segment[0];
      showToast("Jumped to highlight");
    }
  }

  function attachVideo(v) {
    video = v;
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("loadedmetadata", renderBar);
    if (video.readyState >= 1) {
      maybeJumpToHighlight();
      renderBar();
    } else {
      video.addEventListener("loadedmetadata", maybeJumpToHighlight, { once: true });
    }
    watchPlayerForBarReattach();
  }

  function detachVideo() {
    if (video) {
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("loadedmetadata", renderBar);
    }
    video = null;
    hideSkipButton();
    if (playerObserver) playerObserver.disconnect();
  }

  // YouTube occasionally rebuilds the progress bar (e.g. switching in/out of
  // theater mode or an ad playing). Watch for that and redraw our bar.
  function watchPlayerForBarReattach() {
    const player = findPlayer();
    if (!player) return;
    if (playerObserver) playerObserver.disconnect();
    playerObserver = new MutationObserver(() => {
      const container = findProgressBarContainer();
      if (container && (!barEl || !container.contains(barEl))) {
        renderBar();
      }
    });
    playerObserver.observe(player, { childList: true, subtree: true });
  }

  function findVideo() {
    return document.querySelector("video");
  }

  function waitForVideo(timeoutMs = 8000) {
    return new Promise((resolve) => {
      const existing = findVideo();
      if (existing) {
        resolve(existing);
        return;
      }
      if (videoObserver) videoObserver.disconnect();
      videoObserver = new MutationObserver(() => {
        const v = findVideo();
        if (v) {
          videoObserver.disconnect();
          resolve(v);
        }
      });
      videoObserver.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => {
        if (videoObserver) videoObserver.disconnect();
        resolve(findVideo());
      }, timeoutMs);
    });
  }

  async function setupForCurrentVideo() {
    const id = getVideoIdFromUrl();
    if (!id) return;

    currentVideoID = id;
    jumpedToHighlight = false;
    segments = [];
    detachVideo();

    const [loadedSettings, fetchedSegments, v] = await Promise.all([
      loadSettings(),
      fetchSegments(id),
      waitForVideo(),
    ]);

    // Bail if the user navigated away again while this was in flight.
    if (getVideoIdFromUrl() !== id) return;

    settings = loadedSettings;
    segments = fetchedSegments;
    if (v) attachVideo(v);
    renderBar();
  }

  // YouTube is a single-page app; it fires this event on in-app navigation.
  document.addEventListener("yt-navigate-finish", () => {
    const id = getVideoIdFromUrl();
    if (id && id !== currentVideoID) setupForCurrentVideo();
  });

  // Fallback in case yt-navigate-finish isn't available for some reason.
  let lastHref = location.href;
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    const id = getVideoIdFromUrl();
    if (id && id !== currentVideoID) setupForCurrentVideo();
  }, 1000);

  if (getVideoIdFromUrl()) setupForCurrentVideo();
})();
