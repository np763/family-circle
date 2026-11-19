# Family Circle — 60s Demo Video Script

**Format:** MP4, 1920×1080 (HD), 30 fps, 60.0 s, H.264 + AAC
**Audio:** minimal ambient BGM (slow C–Am–F–G synth pad + sparse pluck, low volume, fades in/out) + UI sound effects. **No voice-over.** Meaning is carried by short on-screen captions.
**Output:** `demo/family-circle-demo.mp4`

## How it's made
A clean copy of the app runs on port 3111 with a fresh database (the real `data/` is untouched). It is seeded with **Dad** and **Mum** (humans), **Biscuit** (pet), two calendar events, birthdays, and one post from Mum. A scripted browser (Playwright, Chromium, 1920×1080 with 1.3× page zoom) drives the UI and records the screen, with an injected cursor, click ripples, captions and title/end cards. BGM and SFX are synthesised in Node (`demo/make.js`) from the logged event timestamps and muxed with ffmpeg.
Regenerate: `cd demo && node record.js && node make.js`

## Scene breakdown

| # | Time | On screen | Caption | Sound effect |
|---|------|-----------|---------|--------------|
| 1 | 0:00–0:04 | Title card: 🧸 **Family Circle** — "A private place for the family, the plushies and the pets." | — | Soft chime, BGM fades in |
| 2 | 0:04–0:07 | Log in as **admin** → **Administrator console** (members list; admins manage accounts only, never see family content). | Admin console: manage members & passwords | Key ticks, whoosh |
| 3 | 0:07–0:13 | Add plush member **Mr. Bun** with a **birthday** (type, username, display name, date) → "Member added". | (same caption) | Pops, key ticks |
| 4 | 0:13–0:17 | **Log out**, log in as family member **Dad** → feed with Feed / Calendar tabs. | — | Whoosh x2 |
| 5 | 0:17–0:23 | Composer: type post, attach photo (`picnic.png`), **🏷️ Tag** Mr. Bun and Mum, **Post**. | Share posts with photos & @tags | Typing ticks, blip, pops, ding |
| 6 | 0:23–0:29 | **📊 Poll** "Where shall we go?" — The beach / The zoo; post; vote **The zoo**. | Run polls — everyone votes | Pop, ding, sweep |
| 7 | 0:29–0:34 | **Like**, comment "The zoo gets my vote! 🦁", threaded **Reply** "Mine too!". | Likes, comments & replies | Heart, blips |
| 8 | 0:34–0:46 | **📅 Calendar** tab: month grid with birthdays 🎂 (incl. Mr. Bun, Mum, Biscuit) and events, "Coming up" strip; click a day → **+ Add event** "Family picnic 🧺", 10:00, Central Park → **Save**. | Shared family calendar: events & birthdays | Whoosh, pops, ding |
| 9 | 0:46–0:55 | Back to **Feed**; **Act as** → 🧸 Mr. Bun; banner "You are acting as Mr. Bun"; posts "Carrots are for sharing 🥕"; **Switch back to me**. | Act as a plushie or pet | Shimmer, ding |
| 10 | 0:55–1:00 | End card: 🧸 **Family Circle** — "No dependencies. Just Node 22.5+." `npm start` | — | Closing chime, BGM fades out |

## Changes since the previous version
- **Added the Calendar scene** (scene 8): birthdays appear automatically, and an event is added live.
- **Reflected the new admin model:** the admin account is now management-only (no feed, posts, votes or calendar), so the demo starts in the Administrator console, adds a member, then logs in as the human **Dad** for the family features.
- Members scene now sets a birthday, which feeds the calendar.
- Posting/poll/comment scenes were shortened to make room; the "filter by member" scene was dropped.
- Dropped: video upload and the remaining admin actions (remove member, reset password), to fit 60 s.

## Deliverables
- `script.md` (this file)
- `demo/family-circle-demo.mp4` — final video
- `demo/record.js`, `demo/make.js` — regeneration scripts (`demo/out/` holds intermediates: raw recording, audio.wav, event log)
