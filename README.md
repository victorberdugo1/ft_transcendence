*This project has been created as part of the 42 curriculum by mmarinovf, aprenafe, isegura-, vberdugo.*

---

# Enuma Fighter — ft_transcendence

A real-time multiplayer brawler game built as a web application. Up to 8 players connect simultaneously and fight in live matches. The game supports 1v1 duels, multi-player free-for-all sessions, and structured tournaments with an elimination bracket. Spectators can watch any ongoing match in real time. A full social layer — friends, chat, notifications, profiles — runs alongside the game.

**Key features:**
- Web-based brawler ("Enuma Fighter") built with Raylib compiled to WebAssembly
- Real-time multiplayer via WebSocket — 60 Hz authoritative server loop
- 4 playable characters with distinct stats and move sets
- Tournament system with single-elimination bracket
- Spectator mode (overflow + voluntary)
- Friends system, direct chat, and in-app notifications
- Achievements, XP/level progression, and leaderboard
- React frontend + Express backend + PostgreSQL database
- Fully containerized with Docker — single command to run

---

## Instructions

### Prerequisites

- Docker and Docker Compose
- GNU Make
- Latest stable Google Chrome (or Firefox / Safari / Edge)

### Setup and run

```bash
make
```

That's it. On first run this takes ~15 minutes (compiles Raylib → WASM, builds all images, starts all containers).

If `.env` does not exist, `make` creates it automatically from `.env.example` — which contains working default values for the database and backend. No manual setup required.

Open **https://localhost:8443** in your browser and accept the self-signed certificate.

> To use custom database credentials or ports, copy `.env.example` to `.env`, edit it, and then run `make`.

### Make commands

| Command | Description |
|---|---|
| `make` | First-time setup + full build + start (single command) |
| `make wasm` | Recompiles `main.c` → WASM only, then restarts — use after C changes |
| `make up` | Starts all containers without rebuilding — use after JS/React changes |
| `make dev` | Starts with logs in the terminal (Ctrl+C to stop) |
| `make build` | Builds all images without starting |
| `make re` | Stops + recompiles WASM + restarts |
| `make logs` | Streams logs from all services |
| `make logs-<service>` | Streams logs from a specific service (e.g. `make logs-backend`) |
| `make shell-<service>` | Opens a shell inside a container (e.g. `make shell-backend`) |
| `make down` | Stops all containers |
| `make clean` | Stops everything, removes all images and volumes (full reset) |

> Changes to `main.c` → `make wasm`. Changes to React components, `ws-client.js`, or any file under `backend/src/` → `make up` is enough (live via Docker volume mounts).

---

## Technical Stack

| Layer | Technology | Why |
|---|---|---|
| Frontend framework | React 18 (Vite) | Component model, fast HMR, ecosystem |
| Game engine | Raylib compiled to WebAssembly via Emscripten | Proven 2D engine, runs in-browser with no plugins |
| Backend framework | Express (Node.js) | Lightweight, easy WebSocket integration, large ecosystem |
| Database | PostgreSQL | Relational schema, strong consistency, `pg` driver |
| Real-time | WebSocket (`ws` library) | Full-duplex, low latency, native browser support |
| Proxy / TLS | nginx | TLS termination, static file serving, reverse proxy |
| Containerization | Docker Compose | Single-command deployment, reproducible environment |
| Auth | bcrypt + opaque session tokens | Secure password hashing, stateless-friendly sessions |

---

## Architecture

```
BROWSER
  │
  ▼
nginx :443  (HTTPS / TLS termination)
  ├── /          → frontend nginx :80  (React static build + WASM assets)
  ├── /api/*     → backend :3000       (Express REST API)
  └── /ws        → backend :3000       (WebSocket — 60 Hz game loop)
                        │
                        ▼
                   PostgreSQL :5432
```

```
Backend (Express + Node.js)          Frontend (React + Raylib WASM)
  authoritative game loop (60 Hz)      React renders all UI + canvas
  physics, collisions, voltage  ──WS──▶  ws-client.js receives state
  broadcasts state snapshot     ◀──WS──  sends keyboard input frames
```

---

## Project Structure

```
.
├── docker-compose.yml
├── .env.example
├── Makefile
├── nginx/
│   ├── Dockerfile              ← Generates self-signed HTTPS cert
│   └── nginx.conf
├── frontend/
│   ├── Dockerfile              ← Stage 1: C→WASM / Stage 2: React / Stage 3: nginx
│   ├── app/src/
│   │   ├── main.jsx
│   │   └── App.jsx
│   ├── game/src/main.c         ← Raylib game (recompile with make re)
│   └── js/ws-client.js         ← WebSocket ↔ WASM bridge
├── backend/
│   ├── src/
│   │   ├── index.js            ← Game loop + WS + REST routes + Auth
│   │   ├── game/               ← Physics, session management, constants
│   │   ├── social/             ← Friends, chat, profile, notifications
│   │   └── ws/handler.js
│   └── package.json
└── database/
    ├── init.sql
    └── erd.svg
```

---

## Database Schema

![ERD](./database/erd.svg)

| Table | Purpose |
|---|---|
| `users` | Accounts — username, email, bcrypt hash, avatar, role, 2FA fields |
| `sessions` | Auth tokens — opaque token, user FK, expiry (7 days) |
| `user_stats` | Game stats — wins, losses, xp, level, win_streak, best_streak |
| `friendships` | Friend graph — status: pending / accepted / blocked |
| `messages` | Direct chat — sender, receiver, content, read flag |
| `matches` | Match history — players, scores, winner, duration, game type |
| `tournaments` | Tournament metadata — name, status, creator |
| `tournament_players` | Who participates in each tournament |
| `tournament_matches` | Which matches belong to each round |
| `achievements` | Achievement catalogue — key, name, description |
| `user_achievements` | Unlocked achievements per user — earned_at |
| `notifications` | In-app notifications — type, JSONB payload, read flag |
| `spectators` | Spectator log — session watched, mode, joined_at, left_at |

---

## Modules

| Module | Category | Type | Points | Owner |
|---|---|---|---|---|
| Use a framework (React + Express) | Web | Major | 2 | All |
| Real-time features via WebSocket | Web | Major | 2 | vberdugo |
| Allow users to interact (chat + friends + profile) | Web | Major | 2 | isegura- ??|
| Web-based game (Enuma Fighter) | Gaming | Major | 2 | vberdugo |
| Remote players | Gaming | Major | 2 | vberdugo |
| Multiplayer 3+ players | Gaming | Major | 2 | vberdugo |
| Game customization (characters + abilities) | Gaming | Minor | 1 | vberdugo |
| Tournament system | Gaming | Minor | 1 | mmarinovf |
| Spectator mode | Gaming | Minor | 1 | vberdugo |
| Gamification (achievements + XP + leaderboard) | Gaming | Minor | 1 | aprenafe ??|
| Game statistics and match history | User Management | Minor | 1 | aprenafe ??|
| GDPR compliance | Data and Analytics | Minor | 1 | ?? isegura- ?? |
| Multiple browser support | Accessibility | Minor | 1 | ?? aprenafe ?? |
| GDPR compliance | Data and Analytics | Minor | 1 | ?? isegura- ?? |
| Multiple browser support | Accessibility | Minor | 1 | ?? aprenafe ?? |

**Total: 19 points**

---

## Features

| Feature | Description | Owner |
|---|---|---|
| Authoritative game loop | 60 Hz server-side physics, collision, voltage system | vberdugo |
| WebSocket multiplayer | Up to 8 simultaneous players, reconnection logic | vberdugo |
| 4 playable characters | Eldwin, Hilda, Quimbur, Gabriel — distinct stats per character | vberdugo |
| Spectator mode | Overflow + voluntary, 60 Hz state broadcast to spectators | vberdugo |
| 1v1 duel | Instant matchmaking between two connected players | vberdugo |
| Multiplayer free-for-all | 3–8 players in the same session | vberdugo |
| Tournament bracket | Single-elimination, randomised seeding, round advancement | mmarinovf |
| Tournament UI | Bracket visualisation, match history, round status | mmarinovf |
| HTTPS / TLS | Self-signed cert via nginx, all browser connections encrypted | mmarinovf |
| Form validation (frontend) | Input validation on all forms — register, login, chat, profile | mmarinovf |
| Friends system | Send / accept / block requests, online status | isegura- ?? |
| Direct chat | Real-time messages between users, read receipts | isegura- ??|
| In-app notifications | Friend requests, match invites — JSONB payload, read flag | isegura- ??|
| User profile | Avatar upload, stats display, match history view | isegura- ??|
| Privacy Policy + Terms of Service | Accessible from footer, relevant content | isegura- ?? |
| Achievements | 8+ unlockable achievements with in-game detection | aprenafe ??|
| XP and level system | XP per win, level calculated from XP curve | aprenafe ??|
| Win streak tracking | Current streak + best streak, stored in user_stats | aprenafe ??|
| Match history | Per-user list of past matches with scores and duration | aprenafe ??|
| Leaderboard | Top 10 by wins, real-time polling every 30 s | aprenafe ??|

---

## Team Information

| Login | Role | Responsibilities |
|---|---|---|
| vberdugo | Developer | Game engine, WebSocket, physics, sessions, matchmaking, spectators |
| aprenafe ??? | Developer | Achievements, gamification, stats, match history, leaderboard UI |
| isegura- ??? | Developer | Social module — friends, chat, notifications, profile, Privacy Policy / ToS |
| mmarinovf | Developer | Tournament system, tournament UI, HTTPS, form validation |

---

## Project Management

- **Methodology:** task-based — features broken down into independent units before starting
- **Task tracking:** GitHub Issues, one issue per feature, assigned to the responsible developer
- **Branches:** `feat/<feature>-<login>` per feature, PR reviewed by at least one other member before merge
- **Meetings:** weekly sync to review progress and resolve blockers
- **Communication:** Discord — one channel per module, one channel for general coordination
- **Contracts:** `CONTRACTS.md` at the root defines function signatures, DB column ownership, WS events, and REST endpoints agreed between modules

---

## Individual Contributions

### vberdugo
- Game engine, WebSocket server, authoritative physics loop (60 Hz)
- Session management, matchmaking, reconnection logic, spectator routing
- 4 playable characters with distinct stats, voltage system, hitstop, combo detection
- Remote players, multiplayer 3+ support
<!-- TODO: challenges faced and how you solved them -->

### aprenafe ???
<!-- TODO: fill in once implemented -->
- `game/achievements.js` — achievement detection and granting
- `game/stats.js` — win streak, best streak, match duration
- Leaderboard page and Achievements page (React)
- Match history endpoint and UI
<!-- TODO: challenges faced and how you solved them -->

### isegura- ???
<!-- TODO: fill in once implemented -->
- Friends system — send / accept / block, online status
- Direct chat — real-time messages, read receipts
- Notification system — JSONB payload, real-time delivery
- User profile pages — avatar upload, stats, match history
- Privacy Policy and Terms of Service pages
<!-- TODO: challenges faced and how you solved them -->

### mmarinovf
<!-- TODO: fill in once implemented -->
- Tournament module — bracket API, round advancement, champion resolution
- Tournament UI — bracket visualisation, round status, match results
- HTTPS / TLS — nginx configuration, self-signed certificate
- Frontend form validation across all user-facing forms
- `.env.example` setup
<!-- TODO: challenges faced and how you solved them -->

---

## Resources

- [Raylib documentation](https://www.raylib.com/)
- [Emscripten documentation](https://emscripten.org/docs/)
- [React documentation](https://react.dev/)
- [Express documentation](https://expressjs.com/)
- [PostgreSQL documentation](https://www.postgresql.org/docs/)
- [WebSocket API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API)
- [bcrypt (npm)](https://www.npmjs.com/package/bcrypt)
- [node-postgres (pg)](https://node-postgres.com/)

**AI usage:** AI tools were used to support documentation drafting, architecture discussion, code review, and breaking down technical problems into smaller steps. All suggestions were critically reviewed and tested by the team before being applied. No AI-generated code was merged without full understanding by the responsible developer.