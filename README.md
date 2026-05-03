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
| `make up` | Starts all containers in the background |
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

**Frontend** — React 18 (Vite), with Raylib compiled to WebAssembly via Emscripten. React handles all UI (menus, routing, HUD). The game runs inside a `<canvas>` element rendered by React. The canvas resolution is calculated from the actual viewport size at load time, and a debounced resize listener reloads the page to recalculate it. Changes to React components do not require recompilation. Changes to `main.c` require `make re`.

**Backend** — Node.js with Express. Handles the game loop, physics, WebSocket connections, and all REST endpoints under `/api/*`. Nodemon reloads the server automatically on file save.

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
│   ├── package.json
│   └── src/
│       └── index.js            ← Game loop + WebSocket + Express routes
│
└── database/
    └── init.sql                ← PostgreSQL schema
```

---

## Database Schema

<!-- TODO: tables, relationships, key fields -->

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

**AI usage:** AI tools were used to support documentation drafting, code review,
and breaking down technical problems into smaller steps. All suggestions were
critically reviewed and discussed within the team before being applied.
