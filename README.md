# Family Circle 🧸 — Developer Guide

A small, private, Facebook-like app for a family and their plushies/pets. It is deliberately **dependency-free**: a single Node process, built-in `node:sqlite`, and a vanilla-JS frontend with no build step.

- **Requires:** Node **>= 22.13** (for `node:sqlite`). Nothing to `npm install`.
- **Product context:** see [`PRD.md`](PRD.md). Review notes: `code-review-report.html`. Demo script: `script.md`.

## Quick start

```bash
npm start            # http://localhost:3000
```

Default login on a fresh database: **admin / password** (change it via the "Password" button in the UI).

```bash
npm test             # regression + smoke tests, uses a throwaway DB
```

### Environment variables

| Variable   | Default        | Purpose                                                    |
|------------|----------------|------------------------------------------------------------|
| `PORT`     | `3000`         | HTTP port                                                  |
| `HOST`     | `127.0.0.1`    | Bind address (use `0.0.0.0` to share on a home network)    |
| `DATA_DIR` | `./data`       | Location of `family.db` and `uploads/` (tests override it) |

## Project layout

```
server.js          HTTP server, SQLite schema, all API routes, static + media serving (~735 lines)
lib/
  auth.js          scrypt password hash/verify (async, constant-time), dummyVerify for timing parity
  serve.js         serveFile(): static/media serving with HTTP Range support (video seeking)
  throttle.js      Failed-login throttle (per ip+username and per ip), self-sweeping
public/
  index.html       Shell page
  app.js           Entire SPA (vanilla JS, ~545 lines)
  style.css        Styles
test/
  bugs.test.js     Regression tests for the P1 bugs from the code review (node:test)
  smoke.js         End-to-end API checks
  run-smoke.js     Runner for smoke.js (starts the server)
  helpers.js       startServer(): spawns the real server on a random port with a temp DATA_DIR
  results-before.txt / results-after.txt   Failing-before / passing-after test runs
data/              Runtime data (git-ignored): family.db (SQLite, WAL) and uploads/
```

## Architecture

- **No framework / router.** `server.js` creates a plain `http.Server`. Requests under `/api/` go to the `api()` function, which matches on `method` + pathname (string compares and regexes such as `/^\/api\/posts\/(\d+)$/`) and returns an object that is serialised as JSON. Throw `HttpError` (helpers `bad()`, `forbid()`, …) to return a non-200 status.
- **Static files** are served from `public/` (extension whitelist `STATIC_TYPES`, path-traversal guarded, `no-cache`).
- **Media** at `/media/<32-hex>.<ext>` is private: requires a valid session, validates the filename shape and extension whitelist (`TYPES`), then streams from `DATA_DIR/uploads` with Range support.
- **Database:** `node:sqlite` `DatabaseSync` with WAL. Schema is created with `CREATE TABLE IF NOT EXISTS` at startup (no migration framework — if you change a table, handle existing DBs manually). Tables: `users`, `sessions`, `posts`, `comments`, `media`, `tags`, `polls`, `poll_options`, `poll_votes`, `likes`, `events`. The admin account is seeded on first run if `users` is empty.
- **Frontend:** one `public/app.js` file talks to the JSON API with `fetch`, rendering by DOM/string building. No bundler, no transpiling — edit and refresh.

### Core domain concepts

- **Members** are either humans (can log in, have a password) or plush/pet members (no password). Max 50 (`MAX_USERS`).
- **Act as:** a logged-in human can post/reply/like/vote *as* a plush/pet. The row is attributed to the plush/pet, but the real human is recorded for permission checks (edit/delete). Keep this in mind whenever you add a write endpoint: check permission against the real human, not just `author_id`.
- **Roles:** admins can remove members, reset passwords, and promote other admins.
- **Calendar:** birthdays are derived from member records each year; `events` rows are family-added (all-day/timed, optionally yearly).

### API overview

All responses are JSON. State-changing requests must send the header `X-Requested-With: fetch` (CSRF guard) in addition to the `sid` session cookie.

| Method & path                          | Purpose                                  |
|----------------------------------------|------------------------------------------|
| `POST /api/login`, `POST /api/logout`  | Session login/logout (throttled)         |
| `GET /api/me`                          | Current session info                     |
| `POST /api/act-as`                     | Switch the acting plush/pet              |
| `GET/POST /api/users`                  | List / add members                       |
| `*/api/users/:id`, `POST …/password`   | Edit/remove member, reset password       |
| `GET /api/calendar`, `POST /api/events`, `*/api/events/:id` | Calendar + events   |
| `POST /api/upload`                     | Upload media (max 200 MB, streamed)      |
| `GET/POST /api/posts`                  | Feed (cursor `before`, 20/page) / create |
| `*/api/posts/:id`, `POST …/like`       | Edit/delete, like                        |
| `POST /api/posts/:id/comments`, `*/api/comments/:id` | Comments (1 level of replies) |
| `*/api/polls/:id/vote`                 | Vote                                     |

(Line references: routes live in `api()` in `server.js`, roughly lines 360–700.)

### Security notes (keep these invariants)

- Passwords: scrypt with per-user salt, constant-time compare; `dummyVerify` equalises timing for unknown usernames.
- Session cookie is `HttpOnly; SameSite=Lax`.
- Login attempts are counted **before** the async hash check so bursts can't slip past the limit (`lib/throttle.js`).
- Uploads and media: size caps, whitelisted types, random filenames, `X-Content-Type-Options: nosniff`, streams use `pipeline()` so client disconnects don't leak file handles.
- Security headers: `Referrer-Policy: same-origin`, `X-Frame-Options: DENY`.

## Testing

```bash
npm test                         # bugs.test.js (node:test) then smoke
node --test test/bugs.test.js    # regression tests only
node test/run-smoke.js           # smoke only
```

Tests spawn the real `server.js` via `test/helpers.js` on a random free port with a temporary `DATA_DIR`, so your local `data/` is never touched. When fixing a bug, add a regression test to `test/bugs.test.js` and a user-flow check to `test/smoke.js` where appropriate.

## Development tips

- **Reset local data:** stop the server and delete `data/` (admin/password is re-seeded). Back up `data/` to keep real content.
- **No hot reload:** restart `node server.js` after server changes; frontend changes only need a browser refresh.
- **Adding an endpoint:** add a branch in `api()` in `server.js`; require a session (`s`), validate input with `bad()`, enforce permissions (including act-as), return a plain object; add tests.
- **Adding a column/table:** edit the schema block near the top of `server.js` and write an `ALTER TABLE` guard for existing databases.
- **Conventions:** CommonJS (`'use strict'`, `require`), no third-party dependencies — please keep it that way unless there's a strong reason.
