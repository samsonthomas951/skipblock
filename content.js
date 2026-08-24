// SkipBlock content script.
// Runs on youtube.com, watches the active <video>, and handles whichever
// SponsorBlock segment categories the user has enabled — either by
// auto-skipping them, or by showing a "Skip ..." button like YouTube's own
// native skip-intro/skip-ad buttons. Also draws colored segments on the
// player's seek bar, like SponsorBlock's preview bar.

(() => {
  // Same glyph YouTube uses for its own "Next video" control — reused here
  // as a small leading icon on the skip button and toast so they read as
  // part of the native player chrome instead of a bolted-on extension UI.
  // `fill="currentColor"` (swapped in for the original hardcoded "white")
  // lets each usage pick up its own CSS `color`.
  const NEXT_ICON_SVG =
    '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none">' +
    '<path d="M20 20C20.26 20 20.51 19.89 20.70 19.70C20.89 19.51 21 19.26 21 19V5C21 4.73 20.89 4.48 20.70 4.29C20.51 4.10 20.26 4 20 4C19.73 4 19.48 4.10 19.29 4.29C19.10 4.48 19 4.73 19 5V19C19 19.26 19.10 19.51 19.29 19.70C19.48 19.89 19.73 20 20 20ZM5.04 19.77L18 12L5.04 4.22C4.84 4.10 4.60 4.03 4.36 4.03C4.12 4.03 3.89 4.09 3.68 4.21C3.47 4.32 3.30 4.49 3.18 4.70C3.06 4.91 2.99 5.14 3 5.38V18.61C2.99 18.85 3.06 19.08 3.18 19.29C3.30 19.50 3.47 19.67 3.68 19.79C3.89 19.90 4.12 19.96 4.36 19.96C4.60 19.96 4.84 19.89 5.04 19.77Z" fill="currentColor"></path>' +
    "</svg>";

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
  let positionObserver = null;

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

  // ---------- native chrome geometry ----------
  //
  // Both the toast and the skip button are appended straight onto the
  // player (not into .ytp-chrome-bottom itself) so they keep working
  // even when YouTube's own controls auto-hide. Their position is then
  // read live off the real control bar / progress bar on every show,
  // resize, and fullscreen change — so "under the progress bar,
  // centered" and "just above the controls" hold true whether the
  // player is a small windowed embed or fullscreen, with no separate
  // fullscreen-specific logic needed.

  function findPlayer() {
    return document.querySelector("#movie_player, .html5-video-player");
  }

  function findChromeBottom() {
    const player = findPlayer();
    return player ? player.querySelector(".ytp-chrome-bottom") : null;
  }

  function watchForReposition() {
    const player = findPlayer();
    if (!player) return;
    if (positionObserver) positionObserver.disconnect();
    positionObserver = new ResizeObserver(() => {
      positionToast();
      positionButton();
    });
    positionObserver.observe(player);
  }

  // Registered once — fires on entering/exiting fullscreen (and theater
  // mode, which YouTube implements as a resize the ResizeObserver above
  // already catches).
  document.addEventListener("fullscreenchange", () => {
    positionToast();
    positionButton();
  });

  // ---------- toast ----------

  function ensureToastEl() {
    const player = findPlayer();
    if (!player) return null;
    if (toastEl && player.contains(toastEl)) return toastEl;
    toastEl = document.createElement("div");
    toastEl.id = "skipblock-toast";
    toastEl.innerHTML =
      '<span class="skipblock-icon">' + NEXT_ICON_SVG + "</span>" +
      '<span class="skipblock-toast-text"></span>';
    player.appendChild(toastEl);
    return toastEl;
  }

  // Centers the toast horizontally over the player and pins its top edge
  // to the bottom edge of the real progress bar — i.e. the same row
  // YouTube's own chapter-title pill lives in — regardless of player size.
  function positionToast() {
    if (!toastEl) return;
    const player = findPlayer();
    const bar = findProgressBarContainer();
    if (!player || !bar) return;
    const playerRect = player.getBoundingClientRect();
    const barRect = bar.getBoundingClientRect();
    toastEl.style.top = `${barRect.bottom - playerRect.top}px`;
  }

  function showToast(text) {
    if (!settings.showToast) return;
    const el = ensureToastEl();
    if (!el) return;
    el.querySelector(".skipblock-toast-text").textContent = text;
    positionToast();
    el.classList.remove("skipblock-toast-visible");
    void el.offsetWidth;
    el.classList.add("skipblock-toast-visible");
    clearTimeout(toastHideTimer);
    toastHideTimer = setTimeout(() => {
      el.classList.remove("skipblock-toast-visible");
    }, 2200);
  }

  // ---------- skip button (Skip Intro / Skip Promo / ...) ----------

  function ensureButtonEl() {
    if (buttonEl && document.documentElement.contains(buttonEl)) return buttonEl;
    buttonEl = document.createElement("button");
    buttonEl.id = "skipblock-skip-button";
    buttonEl.type = "button";
    buttonEl.innerHTML =
      '<span class="skipblock-icon">' + NEXT_ICON_SVG + "</span>" +
      '<span class="skipblock-skip-button-text"></span>';
    const player = findPlayer();
    (player || document.documentElement).appendChild(buttonEl);
    return buttonEl;
  }

  // Pins the button's bottom edge just above the real control bar's
  // current top edge, so it sits "in place" whether that bar is the
  // tall fullscreen chrome or the short windowed one.
  function positionButton() {
    if (!buttonEl) return;
    const player = findPlayer();
    const chromeBottom = findChromeBottom();
    if (!player || !chromeBottom) return;
    const playerRect = player.getBoundingClientRect();
    const chromeRect = chromeBottom.getBoundingClientRect();
    buttonEl.style.bottom = `${playerRect.bottom - chromeRect.top + 8}px`;
  }

  function showSkipButton(seg) {
    activeButtonSegment = seg;
    const meta = CATEGORY_META[seg.category];
    const el = ensureButtonEl();
    el.querySelector(".skipblock-skip-button-text").textContent = meta.skipLabel || "Skip";
    positionButton();
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
    watchForReposition();
  }

  function detachVideo() {
    if (video) {
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("loadedmetadata", renderBar);
    }
    video = null;
    hideSkipButton();
    if (playerObserver) playerObserver.disconnect();
    if (positionObserver) positionObserver.disconnect();
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
