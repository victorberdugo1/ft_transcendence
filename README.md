# ft_transcendence

*This project has been created as part of the 42 curriculum by vberdugo, , , .*

---

## Description

<!-- TODO: brief description of the project -->

Key features:
- Web-based brawler game ("Enuma Fighter") built with Raylib compiled to WebAssembly
- Real-time multiplayer via WebSocket (60 Hz authoritative server loop)
- React frontend + Express backend + PostgreSQL database
- Fully containerized with Docker

---

## Instructions

### Prerequisites

- Docker and Docker Compose
- GNU Make
- Web browser (latest stable version, e.g., Chrome, Firefox, Safari, Edge)

### Setup and run

```bash
make setup      # Creates .env from .env.example — edit it before continuing
make            # First time only: ~15 min (compiles Raylib → WASM, then starts everything)
```

Open https://localhost:8443 in your browser and accept the self-signed certificate.

### Make commands

| Command | Description |
|---|---|
| `make setup` | Copies `.env.example` to `.env` if it doesn't exist |
| `make wasm` | Builds the frontend (C→WASM) and starts all containers |
| `make up` | Starts all containers — reloads any changes to `.js` files without rebuild |
| `make dev` | Starts with logs in the terminal (Ctrl+C to stop) |
| `make build` | Builds all images without starting |
| `make re` | Stops, rebuilds WASM, and starts again |
| `make logs` | Streams logs from all services |
| `make logs-<service>` | Streams logs from a specific service (e.g. `make logs-backend`) |
| `make shell-<service>` | Opens a shell inside a container (e.g. `make shell-backend`) |
| `make down` | Stops all containers |
| `make clean` | Stops everything and removes all images and volumes (full reset) |

---

## Technical Stack

**Frontend** — React 18 (Vite), with Raylib compiled to WebAssembly via Emscripten. React handles all UI (menus, routing, HUD). The game runs inside a `<canvas>` element rendered by React. The canvas resolution is calculated from the actual viewport size at load time, and a debounced resize listener reloads the page to recalculate it. Changes to React components do not require recompilation. Changes to `main.c` require `make wasm`. Changes to `ws-client.js` or any file under `frontend/js/` and `backend/src/` are served live via Docker volume mounts — `make up` is enough.

**Backend** — Node.js with Express. Runs the authoritative game loop at 60 Hz, handling physics, WebSocket connections, and all REST endpoints under `/api/*`. Authentication uses `bcrypt` (password hashing, 10 rounds) and opaque session tokens stored in PostgreSQL. Nodemon reloads the server automatically on file save.

**Database** — PostgreSQL. Schema defined in `database/init.sql`, applied on first volume creation. To reset: `make clean && make wasm`.

**Proxy** — nginx terminates TLS and routes `/` to the frontend nginx, `/api/*` and `/ws` to the backend.

**Containerization** — Docker Compose orchestrates all four services (nginx, frontend, backend, database). A single `make wasm` command builds and starts everything.

---

## Architecture

```
BROWSER
  │
  ▼
nginx :443 (HTTPS/TLS termination)
  ├── /          → frontend nginx :80 (serves React static build)
  ├── /api/*     → backend :3000 (Express REST API)
  └── /ws        → backend :3000 (WebSocket)
                      │
                      ▼
                  PostgreSQL
```

The backend is the source of truth. React mounts the UI and the game canvas. The WASM module only renders and forwards inputs.

```
Backend (Express)             Frontend (React + Raylib WASM)
  game loop (60 Hz)             React renders the canvas
  physics calculation ──WS──▶   ws-client.js receives state
  sends state         ◀──WS──   sends keyboard input
```

The frontend Dockerfile has three build stages: Emscripten compiles `main.c` to WASM, Vite builds the React app, and a final nginx image serves all static files.

---

## Project Structure

```
.
├── docker-compose.yml
├── .env.example                ← Copy to .env and fill in
├── Makefile
│
├── nginx/
│   ├── Dockerfile              ← Generates self-signed HTTPS cert
│   └── nginx.conf              ← Routes: /, /api/, /ws
│
├── frontend/
│   ├── Dockerfile              ← Stage 1: C→WASM / Stage 2: React build / Stage 3: nginx
│   ├── app/                    ← React application (Vite)
│   │   ├── index.html
│   │   ├── package.json
│   │   ├── vite.config.js
│   │   └── src/
│   │       ├── main.jsx        ← React entry point
│   │       └── App.jsx         ← Root component — canvas lives here
│   ├── game/src/
│   │   └── main.c              ← Raylib game code (requires make re after changes)
│   └── js/
│       └── ws-client.js        ← WebSocket ↔ WASM bridge
│
├── backend/
│   ├── Dockerfile
│   ├── package.json            ← bcrypt, pg, express, ws
│   └── src/
│       └── index.js            ← Game loop + WebSocket + Express routes + Auth
│
└── database/
    ├── init.sql                ← PostgreSQL schema
    └── erd.svg                 ← Entity-Relationship Diagram
```

---

## Database Schema

Full ERD with all relationships:

![Database ERD](./database/erd.svg)

| Table | Purpose | Key columns |
|---|---|---|
| `users` | User accounts | `id` PK, `username`, `email`, `password_hash` (bcrypt), `avatar_url`, `is_online`, `role`, `totp_secret`, `totp_enabled`, `created_at` |
| `sessions` | Session tokens (auth) | `token` PK, `user_id` FK, `expires_at` (7 days) |
| `user_stats` | Game statistics | `user_id` PK, `wins`, `losses`, `draws`, `win_streak`, `best_streak`, `xp`, `level` |
| `friendships` | Friends system | `id` PK, `user_id` FK, `friend_id` FK, `status` (`pending`/`accepted`/`blocked`), `updated_at` |
| `messages` | Direct chat | `id` PK, `sender_id` FK, `receiver_id` FK, `content`, `is_read`, `sent_at` |
| `matches` | Match history | `id` PK, `player1_id` FK, `player2_id` FK, `winner_id` FK, `score1`, `score2`, `game_type`, `played_at`, `ended_at`, `duration_s` |
| `tournaments` | Tournaments | `id` PK, `name`, `status` (`open`/`ongoing`/`finished`), `created_by` FK, `created_at` |
| `tournament_players` | Tournament participants | `(tournament_id, user_id)` composite PK, `eliminated` |
| `tournament_matches` | Tournament rounds | `id` PK, `tournament_id` FK, `match_id` FK, `round`, `match_order` |
| `achievements` | Achievement catalogue | `id` PK, `key`, `name`, `description` |
| `user_achievements` | Unlocked achievements | `(user_id, achievement_id)` composite PK, `earned_at` |
| `notifications` | In-app notifications | `id` PK, `user_id` FK, `type`, `payload` (JSONB), `is_read`, `created_at` |
| `spectators` | Spectator sessions | `id` PK, `user_id` FK, `session_id`, `tournament_id` FK, `mode` (`overflow`/`voluntary`), `joined_at`, `left_at` |

**Key relationships:** `users` is the central table — `sessions`, `user_stats`, `friendships`, `messages`, `matches`, `notifications`, `user_achievements`, and `spectators` all reference it. Tournaments are composed of `tournaments` → `tournament_players` (who participates) and `tournament_matches` (which matches belong to each round). The `spectators` table tracks both overflow connections (slot limit reached) and voluntary viewers who choose to watch a live match.

---

## Auth API

Four ready-to-use endpoints. Sessions are stored in the `sessions` table and delivered via an `HttpOnly` cookie named `sid`.

| Method | Route | Auth required | Description |
|---|---|---|---|
| POST | `/api/register` | No | Creates user + starts session |
| POST | `/api/login` | No | Validates password + starts session |
| POST | `/api/logout` | Yes | Deletes session + marks user offline |
| GET | `/api/me` | Yes | Returns the current user object |

**Register / Login body:**
```json
{ "username": "alice", "email": "alice@example.com", "password": "min8chars" }
```

**Response (success):**
```json
{ "user": { "id": 1, "username": "alice", "email": "...", "avatar_url": "...", "role": "user" } }
```

---

## Game Modes API

Two additional endpoints manage matches and tournaments. Both require authentication.

| Method | Route | Auth required | Description |
|---|---|---|---|
| POST | `/api/duel` | Yes | Starts a 1v1 match between two connected clients |
| POST | `/api/tournament` | Yes | Creates and starts a tournament bracket |
| GET | `/api/tournament/:id` | Yes | Returns bracket status, participants, and round results |
| GET | `/api/leaderboard` | No | Returns the top 10 players by wins |
| GET | `/api/sessions` | No | Lists all active game sessions (used by the spectator lobby) |
| GET | `/api/spectators/:sessionId` | Yes | Returns the history of who watched a given session |

**Duel body:**
```json
{ "clientId1": 1, "clientId2": 2 }
```

**Tournament body:**
```json
{ "clientIds": [1, 2, 3, 4] }
```
Accepts 2, 4, or 8 players. The bracket is single-elimination with randomised seeding.

---

## Spectator Mode

The server supports up to **8 simultaneous active players**. Any connection beyond that is automatically placed in spectator mode. Users can also voluntarily choose to watch a live match from the lobby.

**How it works:**

- Connections #9+ receive a `spectator_mode` WebSocket message instead of `init`. Their input frames are received but silently discarded by the server.
- Voluntary spectators send `{ type: "watch", sessionId: "3" }` at connect time (or any time during the session to switch the viewed match).
- All spectators continue receiving `state` broadcast at 60 Hz, filtered to the players in their watched session. Spectators watching `null` (lobby mode) receive the full state of all active players.
- Match lifecycle events (`match_start`, `match_end`, `player_eliminated`, tournament events) are forwarded to spectators of the relevant session.

**Client API** (exposed on `window` by `ws-client.js`):

```js
// Switch to watching a specific session (or null for lobby overview)
watchSession('3');
watchSession(null);

// Fetch the live session list via REST (no WebSocket needed)
const { sessions, totalSpectators } = await fetchActiveSessions();
```

**Spectator session log** — every spectator connection is persisted in the `spectators` table with `joined_at` and `left_at`, enabling post-match analytics and moderation.

---

## Game Controls

| Key | Action |
|---|---|
| `A` / `←` | Move left |
| `D` / `→` | Move right |
| `W` / `↑` | Jump (up to 2 jumps) |
| `S` / `↓` | Crouch |
| `Space` or `G` (tap) | Attack / Dash-attack (within 180 ms after a dash) |
| `Space` or `G` (hold) | Block |
| Double-tap `A`/`D` | Dash |
| `U` | Toggle debug overlay |

---

## Features

<!-- TODO: feature — team member responsible -->

---

## Modules

<!-- TODO: module name — Major/Minor — justification — who implemented it -->

---

## Team Information

| Login | Role | Responsibilities |
|---|---|---|
| vberdugo | | |
| | | |
| | | |
| | | |

---

## Project Management

<!-- TODO: tools used, meeting cadence, communication channel -->

---

## Individual Contributions

<!-- TODO: per-person breakdown of features built, challenges faced, how solved -->

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

**AI usage:** AI tools were used to support documentation drafting, code review,
and breaking down technical problems into smaller steps. All suggestions were
critically reviewed and discussed within the team before being applied.