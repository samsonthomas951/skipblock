// Background service worker: the only place that talks to the SponsorBlock
// API. Content scripts message this worker rather than fetching directly.

const API_BASE = "https://sponsor.ajay.app/api/skipSegments";

// Categories/action types we ever care about. Fetching all of them up front
// (regardless of which the user currently has enabled) means toggling a
// setting in the popup doesn't require a fresh network round trip.
const CATEGORIES = ["sponsor", "intro", "selfpromo", "interaction", "music_offtopic", "poi_highlight"];
const ACTION_TYPES = ["skip", "poi"];

function buildUrl(videoID) {
  const url = new URL(API_BASE);
  url.searchParams.set("videoID", videoID);
  for (const c of CATEGORIES) url.searchParams.append("category", c);
  for (const a of ACTION_TYPES) url.searchParams.append("actionType", a);
  return url.toString();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "getSegments" || !message.videoID) return false;

  fetch(buildUrl(message.videoID))
    .then(async (res) => {
      if (res.status === 404) return []; // no segments for this video
      if (!res.ok) throw new Error(`SponsorBlock API returned ${res.status}`);
      return res.json();
    })
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: String(err) }));

  return true; // keep the message channel open for the async response
});
