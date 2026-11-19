# Family Circle: Product Requirements Document

**Status:** v1.0 (implemented) · **Stack:** Node.js 22.5+ (built-in `node:http`, `node:sqlite`, `node:crypto`), vanilla JS front end, no third-party dependencies

---

## 1. Overview

Family Circle is a small, private, Facebook-style social app for one family and their plush toys and pets. Family members post messages, photos and videos, reply, vote in polls, like posts, and tag each other. Plush and pet "members" are first-class accounts that humans can speak and vote as.

It is self-hosted, runs on a home computer or small server, and stores everything locally (SQLite plus an uploads folder).

## 2. Goals and non-goals

### Goals
- A fun, familiar social feed that is completely private to the household.
- Let kids and adults "give a voice" to plushies and pets (post, reply, vote as them).
- Zero-cost, zero-maintenance hosting: one command to run, no external services.
- Safe by default: hashed passwords, private media, no public sign-up.

### Non-goals (v1)
- Public or federated networking, or sign-up by strangers.
- Direct messaging, notifications, push, or email.
- Mobile native apps (the web UI is responsive instead).
- Scale beyond 50 accounts.
- Video transcoding or image resizing.

## 3. Users and roles

| Role | Description | Can log in? |
|---|---|---|
| **Administrator** | Manages accounts only. Never sees family content. Invisible to the family. Seeded as `admin` / `password`. | Yes |
| **Family member (human)** | Regular user. Posts, replies, votes, likes, tags, adds members, can act as non-humans. | Yes |
| **Plush / Pet (non-human)** | A character account with no password. Exists to be acted as. | No |

Key rule: **administrator accounts are for administration only.** They have no feed, cannot post/reply/vote/like, cannot act as others, and are hidden from the family's member list and tag picker.

Target scale: fewer than 50 accounts in total (hard cap of 50).

## 4. Functional requirements

### 4.1 Authentication and sessions
- FR-1 Login with username and password. Usernames are case-insensitive and unique.
- FR-2 Passwords are stored only as salted scrypt hashes; plush and pet accounts store none.
- FR-3 Plush and pet accounts cannot log in directly under any circumstances.
- FR-4 Session is an HttpOnly, SameSite=Lax cookie backed by a `sessions` table (14-day expiry). Logout deletes the server session.
- FR-5 Login throttling: 8 failed attempts per username and IP in 5 minutes returns a "try again later" error.
- FR-6 Default account `admin` / `password` is seeded only when the user table is empty. A warning banner shows while the admin still uses the default password.
- FR-7 Users can change their own password (current password required). Admins can reset any human's password; this signs the target out everywhere else.
- FR-8 All state-changing API calls require the `X-Requested-With: fetch` header (CSRF defence in depth).

### 4.2 Members
- FR-9 Any family member can add a new member of type **human** (username, display name, password of at least 6 characters), **plush**, or **pet** (no password).
- FR-10 Optional bio and profile picture, set when adding or later via Edit / "My photo".
- FR-11 Any human can edit themselves and any plush or pet. Only an admin can edit other humans.
- FR-12 Only an admin can remove a member. Removal deletes that member's posts, replies, votes, likes, tags and uploaded files, after a confirmation. Admins cannot remove themselves or the last admin.
- FR-13 Admins can create further administrator accounts (management-only). There must always be at least one admin.
- FR-14 Total accounts are capped at 50.
- FR-15 The family's member list never includes administrators.

### 4.3 Act as (assume identity)
- FR-16 A logged-in human can switch to any plush or pet via the "Act as" menu, and switch back at any time.
- FR-17 While acting, posts, replies, likes and votes appear from the plush or pet. The UI shows a banner and the composer reads "Posting as <name>".
- FR-18 Content created while acting appears simply as from the plush or pet, with no "via" label. The server still records the real human on every post, comment, vote and event, which is used for edit and delete permission.
- FR-19 Acting state is stored server-side in the session; a client cannot choose an arbitrary author id. A human cannot act as another human.

### 4.4 Posts
- FR-20 Create a post with text (up to 5,000 characters), up to 10 photos or videos, optional tags, and an optional poll. A post needs at least text, media or a poll.
- FR-21 The feed shows all posts newest first, 20 at a time with "Load older posts". It can be filtered by author through the sidebar.
- FR-22 Edit a post's text and tags, and remove attached media. Edited posts show "edited". Polls cannot be changed after posting.
- FR-23 Delete a post, which removes its comments, tags, poll, votes, likes and media files.
- FR-24 Edit and delete are allowed for the human who actually posted it, and for the human the post appears from. Admins have no content access at all, so they cannot edit or delete posts either.
- FR-25 Images open in a lightbox. Videos play inline with seeking.

### 4.5 Comments and replies
- FR-26 Comment on any post (up to 2,000 characters), with optional tags.
- FR-27 Reply to a comment. Threads are one level deep; a reply to a reply attaches to the same parent.
- FR-28 Edit and delete comments under the same permission rule as posts. Deleting a comment deletes its replies.

### 4.6 Votes, polls and likes
- FR-29 A post may have one poll with a question and 2 to 8 options.
- FR-30 Each member (including each plush and pet) has at most one vote per poll. Voting again changes the vote; clicking the chosen option again retracts it.
- FR-31 Poll results show counts, a bar, and the names of voters per option. The vote records both the voter and the human who cast it.
- FR-32 Members can like and unlike a post (as themselves or as the character they are acting as).

### 4.7 Tagging
- FR-33 Posts and comments can tag any non-admin member (human, plush or pet), shown as "with @Name".
- FR-34 Tags are editable after posting.

### 4.8 Media
- FR-35 Allowed types: jpg, jpeg, png, gif, webp, mp4, m4v, webm, mov, ogv. Everything else is rejected.
- FR-36 Maximum file size is 200 MB. Files are stored under random server-generated names.
- FR-37 Media is only served to logged-in users, and videos support HTTP range requests.
- FR-38 Uploaded files that are never attached are tied to their uploader and cannot be attached to someone else's content.

### 4.9 Calendar, birthdays and events
- FR-41 A Calendar tab next to the Feed shows a month grid (previous, next, Today), a "Coming up (next 60 days)" list, and a panel for the selected day.
- FR-42 Each member (human, plush or pet) can have an optional birthday, set when adding or editing a member. Birthdays appear on the calendar automatically every year, with the age ("turns N"). A 29 February birthday shows on 28 February in non-leap years. Birthdays must be valid past dates.
- FR-43 Any family member can add an event: title (required), date (required), optional time (otherwise all-day), place and notes. Events can repeat every year.
- FR-44 While acting as a plush or pet, events are added as them. The human who created an event, or the member it appears from, can edit or delete it; others cannot.
- FR-45 Calendar queries are limited to 400 days at a time. Admin accounts cannot read or change the calendar.

### 4.10 Administrator console
- FR-39 An admin sees only an "Administrator console": member list, add, edit, reset password, remove, and change own password.
- FR-40 Admin accounts receive 403 on all post, comment, poll and act-as endpoints.

## 5. Data model (SQLite)

| Table | Purpose | Key fields |
|---|---|---|
| `users` | All accounts | id, username (unique, NOCASE), display_name, kind (human/plush/pet), is_admin, password_hash, password_salt (null for non-humans), bio, avatar, created_by |
| `sessions` | Login sessions | token, user_id, acting_as_id, expires_at |
| `posts` | Feed posts | author_id (shown), posted_by_id (real human), body, created_at, updated_at |
| `comments` | Comments and replies | post_id, parent_id, author_id, posted_by_id, body |
| `media` | Uploaded files | filename, original_name, mime, kind (image/video), uploader_id, post_id |
| `tags` | Tagged members | post_id or comment_id, user_id |
| `polls` | One poll per post | post_id (unique), question |
| `poll_options` | Poll choices | poll_id, label |
| `poll_votes` | Votes | PK (poll_id, voter_id), option_id, cast_by_id |
| `likes` | Post likes | PK (post_id, user_id) |
| `events` | Calendar events | title, notes, location, event_date, event_time (null = all-day), yearly, author_id, posted_by_id |

`users.birthday` (YYYY-MM-DD, optional) drives the automatic birthday entries.

Foreign keys are enforced, with cascading deletes so removing a post or member leaves no orphans.

## 6. API summary

All JSON over HTTP. Authentication is by session cookie.

- Auth: `POST /api/login`, `POST /api/logout`, `GET /api/me`, `POST /api/act-as`
- Members: `GET /api/users`, `POST /api/users`, `GET|PUT|DELETE /api/users/:id`, `POST /api/users/:id/password`
- Upload: `POST /api/upload?name=file.ext` (raw body, one file per request)
- Posts: `GET /api/posts?before=&author=`, `POST /api/posts`, `GET|PUT|DELETE /api/posts/:id`, `POST /api/posts/:id/like`
- Comments: `POST /api/posts/:id/comments`, `PUT|DELETE /api/comments/:id`
- Votes: `POST|DELETE /api/polls/:id/vote`
- Calendar: `GET /api/calendar?from=&to=` (events plus birthdays in range), `POST /api/events`, `PUT|DELETE /api/events/:id`
- Media: `GET /media/:file` (login required)

## 7. Non-functional requirements

- **Security:** scrypt with per-user salt and constant-time compare; HttpOnly cookie; all user text rendered with `textContent` (no HTML injection); path-traversal-safe static serving; extension allowlist for uploads; CSRF header requirement; login throttling; uniform timing for unknown usernames.
- **Privacy:** no third-party scripts, fonts, analytics or network calls; all data stays on the host. Media requires login.
- **Performance:** feed paginated at 20; sized for under 50 users and a few thousand posts on SQLite (WAL mode).
- **Reliability:** all multi-row writes are transactional; deleting content also deletes its files.
- **Usability:** responsive layout, light and dark mode via system preference, keyboard submit (Enter) for comments.
- **Portability:** runs on Windows, macOS and Linux with Node 22.5 or newer. Configurable with `PORT` and `HOST` environment variables.
- **Operations:** state lives in `data/` (`family.db` plus `uploads/`). Backup is copying that folder; reset is deleting it.

## 8. Success criteria

1. A new family can be set up in under 5 minutes: log in as admin, change the password, add one human, and that human adds the rest.
2. A human can post, vote and reply as a plush or pet with one click on the "Act as" menu, and the real author stays visible.
3. No plush or pet account can be logged into, and no admin can see family content.
4. The automated smoke test (`test/smoke.js`, 66 checks) passes on a fresh database.

## 9. Known limitations and future ideas

- Single-process server, plain HTTP. For access outside the home, put it behind a reverse proxy with HTTPS (the cookie is not marked `Secure`).
- No password recovery by email: an admin resets passwords.
- Votes can be changed but polls cannot be edited after posting.
- Uploaded images are not resized, and a large video library will use disk quickly.
- The UI offers no way to convert an admin into a family account or the reverse (remove and re-add instead).
- Events have no invitees or reminders, and only support "every year" repeats (no weekly or monthly).
- Future ideas: event reminders, invitees and RSVPs, weekly and monthly repeats, notifications for tags and replies, per-post privacy, reactions beyond like, albums, search, scheduled backups, installable PWA.
