# SkipBlock

A stripped-down, personal SponsorBlock client for YouTube. No segment bar, no
category icons, no SponsorBlock popup — just silent skipping and a small
toast when it happens.

## What it does

- **Sponsor segments** — skipped automatically.
- **Non-music sections** — skipped automatically (relevant on music videos).
- **Intros** — play by default, can be set to skip.
- **Interaction reminders** ("like and subscribe") — play by default, can be
  set to skip.
- **Highlight jump** — off by default; when enabled, jumps straight to the
  video's SponsorBlock-marked highlight as soon as it loads.
- **Toast** — a small bottom-of-screen notice ("Skipped sponsor segment")
  whenever something is skipped. Can be turned off in the popup.

All segment data comes from the public [SponsorBlock](https://sponsor.ajay.app)
API — the same crowd-sourced database ReVanced uses. This extension doesn't
submit or vote on segments, it only reads them.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Open any YouTube video — click the extension icon to adjust which
   categories get skipped.

## Files

- `manifest.json` — extension config (Manifest V3).
- `background.js` — the only part that talks to the SponsorBlock API.
- `content.js` — watches the video and seeks past enabled segments.
- `toast.css` — styling for the skip notice.
- `popup.html` / `popup.css` / `popup.js` — the settings panel.

## Notes

- Settings sync via `chrome.storage.sync`, so they follow you across
  Chrome profiles signed into the same account.
- If a video has no submitted segments, nothing happens — SkipBlock never
  invents skip points.
