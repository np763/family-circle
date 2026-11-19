# Family Circle 🧸

A small, private, Facebook-like app for a family and their plushies/pets. No dependencies — needs only **Node 22.13+** (uses built-in `node:sqlite`).

```
npm start          # or: node server.js   → http://localhost:3000
```
Default login: **admin / password** (change it from the "Password" button). Env vars: `PORT`, `HOST` (set `HOST=0.0.0.0` to share on your home network).

## Features
- Login (scrypt-hashed, salted passwords; HttpOnly session cookie; login throttling).
- Posts with text, multiple photos and videos, **polls (votes)**, likes and **@tagged members**; edit/delete.
- Comments with one level of threaded replies, tags, edit/delete.
- **Calendar**: birthdays for every member (incl. plush & pets) appear automatically each year; family can add events (all-day or timed, optionally yearly).
- Members: any human can add humans (with password) or plush/pet members (no password). Max 50.
- **Act as**: humans pick a plush/pet from the "Act as" menu and post, reply, like and vote as them (it appears from them; the real human is recorded for permissions).
- Admins can remove members, reset passwords, make other admins.

## Data
`data/family.db` (SQLite) and `data/uploads/`. Tables: `users`, `sessions`, `posts`, `comments`, `media`, `tags`, `polls`, `poll_options`, `poll_votes`, `likes`. Back up the `data/` folder. Delete it to reset (admin/password is re-seeded).

## Test
```
npm test
```
Runs `test/bugs.test.js` (regression tests for the P1 bugs from the code review: media stream crash/leak, removing a member, acting-as permissions, login throttling, Node version) and `test/smoke.js` (end-to-end API checks). Both use a throwaway database and a random port, so your real `data/` folder is never touched. `test/results-before.txt` and `test/results-after.txt` hold the failing-before / passing-after runs.
