# ft_transcendence

*This project has been created as part of the 42 curriculum by vberdugo, , , .*

---

## Description

<!-- TODO: brief description of the project -->

Key features:
- Web-based game built with Raylib compiled to WebAssembly
- Real-time multiplayer via WebSocket
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
make wasm       # First time only: ~15 min (compiles Raylib → WASM, then starts everything)
```

Open https://localhost in browser and accept the self-signed certificate.

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

**Backend** — Node.js with Express. Handles the game loop, physics, WebSocket connections, and all REST endpoints under `/api/*`. Authentication uses `bcrypt` (password hashing, 10 rounds) and opaque session tokens stored in PostgreSQL. Nodemon reloads the server automatically on file save.

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

The backend is the source of truth. React mounts the UI and the game canvas. The WASM module only renders and sends inputs.

```
Backend (Express)             Frontend (React + Raylib WASM)
  game loop                     React renders the canvas
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
| `users` | Cuenta de usuario | `id`, `username`, `email`, `password_hash` (bcrypt), `role`, `is_online` |
| `sessions` | Tokens de sesión (auth) | `token` PK, `user_id` FK, `expires_at` (7 días) |
| `user_stats` | Estadísticas de juego | `user_id` PK, `wins`, `losses`, `xp`, `level` |
| `friendships` | Sistema de amigos | `user_id`, `friend_id`, `status` (`pending`/`accepted`/`blocked`) |
| `messages` | Chat directo | `sender_id`, `receiver_id`, `content`, `is_read` |
| `matches` | Historial de partidas | `player1_id`, `player2_id`, `winner_id`, `score1`, `score2` |
| `tournaments` | Torneos | `name`, `status` (`open`/`ongoing`/`finished`), `created_by` |
| `tournament_players` | Participantes de torneo | `tournament_id`, `user_id`, `eliminated` |
| `tournament_matches` | Partidas de torneo | `tournament_id`, `match_id`, `round` |
| `achievements` | Catálogo de logros | `key`, `name`, `description` |
| `user_achievements` | Logros desbloqueados | `user_id`, `achievement_id`, `earned_at` |
| `notifications` | Notificaciones in-app | `user_id`, `type`, `payload` (JSONB), `is_read` |

**Relaciones principales:** `users` es la tabla central — `sessions`, `user_stats`, `friendships`, `messages`, `matches`, `notifications` y `user_achievements` todas referencian a `users`. Los torneos se componen de `tournaments` → `tournament_players` (quién participa) y `tournament_matches` (qué partidas pertenecen a cada ronda).

---

## Auth API

Four ready-to-use endpoints. Sessions are stored in the `sessions` table and delivered via an `HttpOnly` cookie named `sid`.

| Method | Route | Auth required | Description |
|---|---|---|---|
| POST | `/api/register` | No | Creates user + starts session |
| POST | `/api/login` | No | Validates password + starts session |
| POST | `/api/logout` | Yes | Deletes session + marks offline |
| GET | `/api/me` | Yes | Returns current user object |

**Register / Login body:**
```json
{ "username": "alice", "email": "alice@example.com", "password": "min8chars" }
```

**Response (success):**
```json
{ "user": { "id": 1, "username": "alice", "email": "...", "avatar_url": "...", "role": "user" } }
```

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