# Family Circle — Architecture

Family Circle is a single-process Node.js app: a plain `http` server, an embedded SQLite database (`node:sqlite`), files on local disk, and a vanilla-JS single-page frontend. There are no third-party dependencies and no build step.

## 1. System context

```mermaid
flowchart LR
    U["Family member<br/>(browser)"] -->|"HTTP (LAN / localhost)"| S["Node.js process<br/>server.js"]
    S --> DB[("SQLite<br/>data/family.db")]
    S --> FS[("Uploads<br/>data/uploads/")]
```

## 2. Components

```mermaid
flowchart TB
    subgraph Browser
        HTML["index.html"]
        APP["app.js<br/>(vanilla SPA)"]
        CSS["style.css"]
        HTML --- APP
        HTML --- CSS
    end

    subgraph Server["Node.js process"]
        direction TB
        HTTP["http.createServer<br/>(security headers, error handler)"]
        API["api()<br/>method + path routing"]
        STATIC["Static file handler<br/>(public/, extension whitelist)"]
        MEDIA["Media handler<br/>(/media/*, session required)"]
        UP["Upload parser<br/>(streamed, 200 MB cap)"]
        SESS["Session / cookie helpers"]

        subgraph lib
            AUTH["lib/auth.js<br/>scrypt hash / verify"]
            THR["lib/throttle.js<br/>login throttle"]
            SERVE["lib/serve.js<br/>serveFile + Range"]
        end

        HTTP --> API
        HTTP --> STATIC
        HTTP --> MEDIA
        API --> SESS
        API --> AUTH
        API --> THR
        API --> UP
        STATIC --> SERVE
        MEDIA --> SERVE
    end

    DB[("SQLite<br/>family.db (WAL)")]
    FS[("data/uploads/")]

    APP -->|"fetch JSON<br/>X-Requested-With: fetch"| HTTP
    APP -->|"img / video src"| HTTP
    HTTP -->|"GET /"| STATIC
    API --> DB
    SESS --> DB
    UP --> FS
    SERVE --> FS
```

## 3. Request routing

```mermaid
flowchart TD
    R["Incoming request"] --> H["Set headers<br/>Referrer-Policy, X-Frame-Options"]
    H --> P{"Path?"}
    P -->|"/api/*"| C{"Non-GET without<br/>X-Requested-With: fetch?"}
    C -->|yes| F403["403 Forbidden"]
    C -->|no| A["api(): match route<br/>→ JSON response"]
    P -->|"/media/*"| M{"Valid session?"}
    M -->|no| F401["401"]
    M -->|yes| MV{"Name matches<br/>32-hex + whitelisted ext?"}
    MV -->|no| F404a["404"]
    MV -->|yes| SF1["serveFile (Range)<br/>from data/uploads"]
    P -->|"other"| ST{"Inside public/ and<br/>allowed extension?"}
    ST -->|no| F404b["404"]
    ST -->|yes| SF2["serveFile<br/>from public/"]
    A -.->|"HttpError / exception"| E["JSON error {error}"]
```

## 4. Authentication and "act as"

```mermaid
sequenceDiagram
    autonumber
    participant B as Browser
    participant S as server.js
    participant T as throttle
    participant A as auth (scrypt)
    participant D as SQLite

    B->>S: POST /api/login {username, password}
    S->>T: blocked(ip, user)?
    T-->>S: no
    S->>T: fail(ip, user) (counted before hashing)
    S->>D: SELECT user
    S->>A: verifyPassword / dummyVerify
    A-->>S: ok
    S->>T: succeed(ip, user)
    S->>D: INSERT session (token, user_id, expires_at)
    S-->>B: Set-Cookie sid (HttpOnly, SameSite=Lax)

    B->>S: POST /api/act-as {userId: plush}
    S->>D: UPDATE sessions SET acting_as_id
    B->>S: POST /api/posts
    S->>D: INSERT post (author_id = plush,<br/>posted_by_id = real human)
```

`author_id` is who the content *appears* from; `posted_by_id` / `cast_by_id` is the real human and is what permission checks (edit, delete) rely on.

## 5. Data model

```mermaid
erDiagram
    users ||--o{ sessions : "has"
    users ||--o{ posts : "author_id / posted_by_id"
    users ||--o{ comments : "author_id / posted_by_id"
    users ||--o{ likes : "user_id"
    users ||--o{ tags : "tagged"
    users ||--o{ media : "uploader_id"
    users ||--o{ events : "author_id / posted_by_id"
    users ||--o{ poll_votes : "voter_id / cast_by_id"
    users |o--o{ users : "created_by"

    posts ||--o{ comments : "post_id"
    comments |o--o{ comments : "parent_id (1 level)"
    posts ||--o{ media : "post_id"
    posts ||--o{ likes : "post_id"
    posts ||--o{ tags : "post_id"
    comments ||--o{ tags : "comment_id"
    posts ||--o| polls : "post_id (unique)"
    polls ||--o{ poll_options : "poll_id"
    polls ||--o{ poll_votes : "poll_id"
    poll_options ||--o{ poll_votes : "option_id"

    users {
        int id PK
        text username UK
        text display_name
        text kind "human | plush | pet"
        int is_admin
        text password_hash "NULL for plush/pet"
        text password_salt
        text birthday "YYYY-MM-DD"
        text avatar
    }
    sessions {
        text token PK
        int user_id FK
        int acting_as_id FK
        int expires_at
    }
    posts {
        int id PK
        int author_id FK
        int posted_by_id FK
        text body
    }
    comments {
        int id PK
        int post_id FK
        int parent_id FK
        int author_id FK
        int posted_by_id FK
    }
    media {
        int id PK
        text filename UK
        text kind "image | video"
        int uploader_id FK
        int post_id FK
    }
    tags {
        int id PK
        int post_id FK "xor comment_id"
        int comment_id FK
        int user_id FK
    }
    polls {
        int id PK
        int post_id FK
        text question
    }
    poll_options {
        int id PK
        int poll_id FK
        text label
    }
    poll_votes {
        int poll_id PK
        int voter_id PK
        int option_id FK
        int cast_by_id FK
    }
    likes {
        int post_id PK
        int user_id PK
    }
    events {
        int id PK
        text title
        text event_date
        text event_time "NULL = all-day"
        int yearly
        int author_id FK
        int posted_by_id FK
    }
```

All foreign keys use `ON DELETE CASCADE` (or `SET NULL` for `users.created_by` and `sessions.acting_as_id`), so removing a member or post cleans up dependent rows. Uploaded files on disk are not part of the schema; they are referenced by `media.filename` and `users.avatar`.

## 6. Media upload and playback

```mermaid
sequenceDiagram
    autonumber
    participant B as Browser
    participant S as server.js
    participant FS as data/uploads
    participant D as SQLite

    B->>S: POST /api/upload (streamed body)
    S->>S: enforce 200 MB cap, whitelist type
    S->>FS: write random 32-hex filename
    S->>D: INSERT media (post_id NULL)
    S-->>B: media record
    B->>S: POST /api/posts {body, media, poll, tags}
    S->>D: INSERT post, attach media, tags, poll
    B->>S: GET /media/<hex>.mp4 (Range)
    S->>S: session check
    S->>FS: createReadStream(start, end)
    S-->>B: 206 Partial Content
```

## 7. Test architecture

```mermaid
flowchart LR
    NPM["npm test"] --> BUGS["node --test<br/>test/bugs.test.js"]
    NPM --> SMOKE["test/run-smoke.js<br/>→ smoke.js"]
    BUGS --> H["test/helpers.js<br/>startServer()"]
    SMOKE --> H
    H -->|"spawn server.js<br/>random PORT, temp DATA_DIR"| SRV["Real server"]
    H -->|"HTTP via fetch"| SRV
```

## Design principles

- **Zero dependencies, zero build:** Node built-ins only; the frontend is served as-is.
- **Private by default:** every API call except login needs a session; media is session-gated. Administrator accounts manage members only and are blocked from feed, post, comment, poll, calendar and act-as routes.
- **Single writer, embedded DB:** SQLite in WAL mode is sufficient for a family-sized workload.
- **Streaming I/O:** uploads and media are streamed with `pipeline()` so large videos don't buffer in memory or leak handles.
