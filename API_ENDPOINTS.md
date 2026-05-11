# API Reference — Enuma Fighter

## Overview

**Base URL:** `https://localhost:8443`

All REST endpoints are under `/api`. All requests and responses use JSON (`Content-Type: application/json`).

**Authentication:** session cookie (`sid`) set automatically on login and register. Pass `credentials: 'include'` in every fetch call. Endpoints marked *(login required)* return `401` if the cookie is missing or expired.

**Error format:**
```json
{ "error": "Description of the problem" }
```

**Testing with curl:** always use `-k` (self-signed cert). Use `-c cookies.txt` to save the session cookie and `-b cookies.txt` to send it:
```bash
# Register / login first — saves the cookie
curl -k -c cookies.txt -X POST https://localhost:8443/api/register \
  -H "Content-Type: application/json" \
  -d '{"username":"test","email":"test@test.com","password":"12345678"}'

# Then use the cookie for protected endpoints
curl -k -b cookies.txt https://localhost:8443/api/me
```

---

## Git conventions

### Branch naming

One branch per feature, following this format:

```
feat/<feature>-<yourlogin>
```

Examples:
```
feat/leaderboard-aprenafe
feat/login-isegura
feat/profile-mmarinov
feat/ai-opponent-vberdugo
```

Starting a branch from main:
```bash
git checkout main
git pull
git checkout -b feat/login-isegura
```

### Commit messages

The message describes what the change does, starting with a type prefix:

```
feat: add login form with error handling
fix: handle 401 response on expired session
style: adjust bracket layout for small screens
refactor: extract fetch helper to utils.js
chore: add notifications.js to express routes
```

Available types: `feat`, `fix`, `style`, `refactor`, `chore`.

### Pull requests

```bash
git push origin feat/login-isegura
```

PRs go toward `main`. At least one other team member reviews before merging. Direct commits to `main` are avoided.

---

# aprenafe

## Files

### Backend
`game/achievements.js` `game/stats.js` `social/chat.js` `social/notifications.js`

### Frontend
`Achievements.jsx` `Chat.jsx` `Leaderboard.jsx` `Notifications.jsx`

---

## Backend

### Achievements — `game/achievements.js`

This file is where the achievements endpoint lives. The endpoint returns the unlocked achievements for the authenticated user.

```
GET /api/achievements   (login required)
```

```bash
curl -k -b cookies.txt https://localhost:8443/api/achievements
```

Achievement granting happens automatically on the backend side whenever a match ends. The function `checkAndGrantAchievements` in `index.js` is already wired into the victory flow — it does not need to be called manually from here.

Achievements currently in the database:
- `first_win` — first victory
- `veteran` — 10 victories

Additional checks can be added in `achievements.js` following the same pattern. If profile data is needed that overlaps with mmarinov's work, coordinating with him is a good idea.

---

### Stats — `game/stats.js`

This file handles streak tracking and match duration. It does not necessarily expose a public endpoint — it is mostly internal logic.

The `user_stats` table already exists with these columns:
`wins`, `losses`, `xp`, `level`, `win_streak`, `best_streak`.

`wins` and `losses` are updated by `index.js` when a match resolves. `stats.js` is responsible for `win_streak`, `best_streak`, and any other tracking logic that fits here.

---

### Chat — `social/chat.js`

Endpoints not yet defined — to be documented here by aprenafe.

---

### Notifications — `social/notifications.js`

REST endpoints not yet defined — to be documented here by aprenafe.

WebSocket events useful for triggering notifications:

Player eliminated:
```json
{ "type": "player_eliminated", "clientId": 2 }
```

Match ended:
```json
{
  "type":    "match_end",
  "winner":  1,
  "loser":   2,
  "matchId": 11,
  "mode":    "brawl"
}
```

---

## Frontend

### Leaderboard — `Leaderboard.jsx`

This endpoint already exists — it is not defined in aprenafe's files.

```
GET /api/leaderboard
```

```bash
curl -k https://localhost:8443/api/leaderboard
```

No login required. Returns the top 10 players ranked by wins and XP.

Response:
```json
{
  "leaderboard": [
    {
      "username":   "player1",
      "avatar_url": null,
      "wins":       15,
      "losses":     3,
      "xp":         1700,
      "level":      5
    }
  ]
}
```

Example fetch in React:
```js
useEffect(() => {
  fetch('/api/leaderboard')
    .then(r => r.json())
    .then(data => setLeaderboard(data.leaderboard));
}, []);
```

---

### Notifications — `Notifications.jsx`

The component listens to WebSocket events and triggers the corresponding notification:

```json
{ "type": "player_eliminated", "clientId": 2 }
```

```json
{
  "type":    "match_end",
  "winner":  1,
  "loser":   2,
  "matchId": 11,
  "mode":    "brawl"
}
```

Example WebSocket listener in React:
```js
useEffect(() => {
  const ws = new WebSocket('wss://localhost:8443/ws');
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'player_eliminated' || data.type === 'match_end') {
      setNotifications(prev => [...prev, data]);
    }
  };
  return () => ws.close();
}, []);
```

---

### Achievements — `Achievements.jsx`

Calls the endpoint defined in `game/achievements.js`.

Example fetch in React:
```js
useEffect(() => {
  fetch('/api/achievements', { credentials: 'include' })
    .then(r => r.json())
    .then(data => setAchievements(data.achievements));
}, []);
```

---

### Chat — `Chat.jsx`

Endpoints not yet defined — see `social/chat.js`.

Example fetch in React:
```js
useEffect(() => {
  fetch('/api/chat/:userId', { credentials: 'include' })
    .then(r => r.json())
    .then(data => setMessages(data.messages));
}, []);
```

---

# isegura-

## Files

### Backend / Infra
`nginx/Dockerfile` `nginx/nginx.conf` `.env.example`

### Frontend
`Login.jsx` `Register.jsx` `Tournament.jsx` `Privacy.jsx` `Terms.jsx`

---

## Backend / Infra

### nginx + HTTPS — `nginx/Dockerfile`, `nginx/nginx.conf`

A self-signed certificate is generated automatically when the container starts. nginx handles TLS termination and proxies traffic to `:3000` (backend) and `:80` (static frontend). No API endpoints are defined here — this is the network layer.

---

### Environment variables — `.env.example`

All environment variables are documented here with safe default values. If `.env` does not exist, `make` creates it from this file automatically.

---

## Frontend

### Login — `Login.jsx`

The login form. Calls the following endpoint, which is defined by vberdugo in `auth.js`.

```
POST /api/login
```

Request body:
```json
{
  "email":    "user@example.com",
  "password": "password123"
}
```

Response on success (200):
```json
{
  "user": {
    "id":         42,
    "username":   "username",
    "email":      "user@example.com",
    "avatar_url": null,
    "role":       "user"
  }
}
```

The session cookie is saved automatically by the browser — no extra handling needed.

Example fetch:
```js
const res = await fetch('/api/login', {
  method:      'POST',
  credentials: 'include',
  headers:     { 'Content-Type': 'application/json' },
  body:        JSON.stringify({ email, password }),
});

if (!res.ok) {
  const { error } = await res.json();
  // show error to the user
}
```

Possible error responses:
- 400 — missing email or password
- 401 — wrong credentials

```bash
curl -k -c cookies.txt -X POST https://localhost:8443/api/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"12345678"}'
```

---

### Register — `Register.jsx`

The registration form. Calls the following endpoint, which is defined by vberdugo in `auth.js`.

```
POST /api/register
```

Request body:
```json
{
  "username": "username",
  "email":    "user@example.com",
  "password": "password123"
}
```

Response on success (201):
```json
{
  "user": {
    "id":         42,
    "username":   "username",
    "email":      "user@example.com",
    "avatar_url": null,
    "role":       "user"
  }
}
```

Registration also logs the user in automatically — the cookie is set in the same response.

Example fetch in React:
```js
const res = await fetch('/api/register', {
  method:      'POST',
  credentials: 'include',
  headers:     { 'Content-Type': 'application/json' },
  body:        JSON.stringify({ username, email, password }),
});

if (!res.ok) {
  const { error } = await res.json();
  // show error to the user
}
```

Possible error responses:
- 400 — missing field or password shorter than 8 characters
- 409 — username or email already taken

```bash
curl -k -c cookies.txt -X POST https://localhost:8443/api/register \
  -H "Content-Type: application/json" \
  -d '{"username":"test","email":"test@test.com","password":"12345678"}'
```

---

### Tournament UI — `Tournament.jsx`

The bracket view. Consumes the following endpoints, which are defined by vberdugo.

Fetching tournament data:
```
GET /api/tournament/:id   (login required)
```

Example: `GET /api/tournament/7`

Response:
```json
{
  "tournament": {
    "id":     7,
    "name":   "Tournament #7",
    "status": "ongoing"
  },
  "participants": [
    {
      "user_id":    42,
      "eliminated": false,
      "username":   "player1",
      "avatar_url": null
    }
  ],
  "matches": [
    {
      "round":      1,
      "match_id":   11,
      "winner_id":  42,
      "player1_id": 42,
      "player2_id": 55,
      "score1":     3,
      "score2":     1
    }
  ]
}
```

Each entry in `matches` is one bout. `round` indicates which round it belongs to. `winner_id` shows who advanced.

```bash
curl -k -b cookies.txt https://localhost:8443/api/tournament/7
```

Creating a tournament:
```
POST /api/tournament   (login required)
```

```json
{ "clientIds": [1, 2, 3, 4] }
```

Response:
```json
{ "tournamentId": 7 }
```

```bash
curl -k -b cookies.txt -X POST https://localhost:8443/api/tournament \
  -H "Content-Type: application/json" \
  -d '{"clientIds":[1,2,3,4]}'
```

WebSocket events related to tournaments:

Match starting:
```json
{
  "type":         "match_start",
  "mode":         "tournament",
  "sessionId":    "3",
  "tournamentId": 7,
  "round":        1
}
```

Tournament ending:
```json
{
  "type":         "tournament_end",
  "tournamentId": 7,
  "champion":     1,
  "championDbId": 42
}
```

---

### Privacy and Terms — `Privacy.jsx`, `Terms.jsx`

Static pages with no API calls.

> **Note:** The evaluator checks for a visible link to both pages in the footer across all pages of the app. If the link is missing, the project is rejected.

---

# mmarinov

## Files

### Backend
`social/friends.js` `social/profile.js`

### Frontend
`Friends.jsx` `Game.jsx` `Home.jsx` `Notifications.jsx` `Profile.jsx`

---

## Backend

### Friends — `social/friends.js`

Endpoints not yet defined — to be documented here by mmarinov.

Available tables:
- `friendships` — columns: `user_id`, `friend_id`, `status` (pending, accepted, blocked)
- `users` — columns: `id`, `username`, `email`, `avatar_url`, `is_online`

---

### Profile — `social/profile.js`

Endpoints not yet defined — to be documented here by mmarinov.

Available tables:
- `users` — columns: `id`, `username`, `email`, `avatar_url`, `is_online`
- `user_stats` — columns: `wins`, `losses`, `xp`, `level`
- `matches` — full history with `player1_id`, `player2_id`, `winner_id`

**GDPR:** This file also covers two GDPR endpoints: export all personal data as JSON, and permanently delete the account with cascade. Both require login and explicit confirmation.

---

## Frontend

### Who is logged in — `Home.jsx`, `Profile.jsx`, `Friends.jsx`

This endpoint is defined by vberdugo and is useful across most pages.

```
GET /api/me   (login required)
```

Response:
```json
{
  "user": {
    "user_id":    42,
    "username":   "player1",
    "email":      "user@example.com",
    "avatar_url": null,
    "role":       "user"
  }
}
```

Example placement in React:
```js
useEffect(() => {
  fetch('/api/me', { credentials: 'include' })
    .then(r => r.ok ? r.json() : null)
    .then(data => data && setUser(data.user));
}, []);
```

The field to use when linking the user to their data in the database is `user.user_id`.

```bash
curl -k -b cookies.txt https://localhost:8443/api/me
```

---

### Active sessions and online players — `Home.jsx`

These endpoints are defined by vberdugo.

```
GET /api/sessions
```

Response:
```json
{
  "sessions": [
    {
      "sessionId":  "3",
      "mode":       "brawl",
      "playerIds":  [1, 2, 3],
      "startedAt":  "2025-01-01T12:00:00.000Z",
      "spectators": 1
    }
  ],
  "lobbySpectators": 0,
  "totalSpectators": 1
}
```

Possible modes: `brawl`, `1v1`, `tournament`.

```bash
curl -k https://localhost:8443/api/sessions
```

```
GET /api/players
```

Response:
```json
{
  "players": [
    { "clientId": 1, "dbUserId": 42, "inSession": true }
  ],
  "spectatorCount": 2
}
```

```bash
curl -k https://localhost:8443/api/players
```

---

### Game connection — `Game.jsx`

This component opens the WebSocket connection and keeps it alive. The game state is processed by `ws-client.js`, which writes it to `window._gameState` for Raylib to read — no manual state processing is needed here.

Connection: `wss://localhost:8443/ws`

First message received from the server after connecting:
```json
{
  "type":     "init",
  "clientId": 1,
  "config": {
    "attackRange":     0.525,
    "attackRangeY":    0.5,
    "dashAttackRange": 1.65
  }
}
```

Saving the clientId after receiving it:
```js
sessionStorage.setItem('clientId', data.clientId);
```

Reconnection after a page reload:
```js
const saved = sessionStorage.getItem('clientId');
if (saved) {
  ws.send(JSON.stringify({ type: 'rejoin', clientId: Number(saved) }));
} else {
  ws.send(JSON.stringify({ type: 'join' }));
}
```

The clientId is cleared from sessionStorage when this message arrives:
```json
{ "type": "match_finished", "sessionId": "3" }
```

Game state received 60 times per second (handled by `ws-client.js`):
```json
{
  "type":    "state",
  "frameId": 3421,
  "players": {
    "1": {
      "id":           1,
      "charId":       "eld",
      "x":            -1.234,
      "y":            0.0,
      "rotation":     0,
      "animation":    "walk",
      "onGround":     true,
      "stocks":       3,
      "respawning":   false,
      "crouching":    false,
      "hitId":        0,
      "jumpId":       0,
      "voltage":      24.5,
      "voltageMaxed": false,
      "blocking":     false
    }
  }
}
```

`rotation` is `0` when facing right, `Math.PI` when facing left. `hitId` and `jumpId` increment each time a hit or jump occurs — useful for triggering one-shot animations client-side.

---

### Friends — `Friends.jsx`

Endpoints not yet defined — see `social/friends.js`.

---

### Profile — `Profile.jsx`

Endpoints not yet defined — see `social/profile.js`.

---

### Notifications — `Notifications.jsx`

REST endpoints not yet defined — see `social/notifications.js`. WebSocket events that trigger notifications are documented in aprenafe's backend section above.

---

# vberdugo

## Files

### Backend
`auth.js` `index.js` `ws/handler.js` `game/session.js` `game/physics.js` `game/ai.js`

### Frontend / Bridge
`ws-client.js` `main.c` Dockerfiles

---

## Backend

### Auth — `auth.js`, `index.js`

These endpoints are defined and exposed here. isegura- consumes them from the login and register forms. mmarinov consumes `/api/me` across several pages.

```
POST /api/register   — hashes password with bcrypt, creates session automatically (201)
POST /api/login      — verifies hash, creates session (200)
GET  /api/me         — returns the user from the active session cookie (login required)
POST /api/logout     — invalidates the session cookie (login required)
```

`POST /api/logout` clears the session cookie and sets `is_online = FALSE` for the user.

Response (200):
```json
{ "ok": true }
```

```bash
curl -k -b cookies.txt -X POST https://localhost:8443/api/logout
```

---

### Sessions and players — `game/session.js`, `index.js`

These endpoints are consumed by mmarinov from `Home.jsx`.

```
GET /api/sessions   — list of active matches
GET /api/players    — list of connected players
```

Updated `/api/sessions` response (includes `tournamentId` and `round`):
```json
{
  "sessions": [
    {
      "sessionId":    "3",
      "mode":         "tournament",
      "tournamentId": 7,
      "round":        1,
      "playerIds":    [1, 2, 3],
      "startedAt":    "2025-01-01T12:00:00.000Z",
      "spectators":   1
    }
  ],
  "lobbySpectators": 0,
  "totalSpectators": 1
}
```

`tournamentId` and `round` are `null` for non-tournament sessions (e.g. `brawl` or `1v1`).

---

### Duel — `index.js`

Starts a 1v1 session between two specific connected players. Login required.

```
POST /api/duel   (login required)
```

Request body:
```json
{ "clientId1": 1, "clientId2": 2 }
```

Response (200):
```json
{ "sessionId": "3" }
```

Possible error responses:
- 400 — missing clientIds or both are the same
- 404 — one or both players are not currently connected

```bash
curl -k -b cookies.txt -X POST https://localhost:8443/api/duel \
  -H "Content-Type: application/json" \
  -d '{"clientId1":1,"clientId2":2}'
```

---

### Spectators — `index.js`

Returns the spectator history for a session. Login required.

```
GET /api/spectators/:sessionId   (login required)
```

Example: `GET /api/spectators/3`

Response:
```json
{
  "spectators": [
    {
      "id":         1,
      "user_id":    42,
      "username":   "player1",
      "avatar_url": null,
      "mode":       "voluntary",
      "joined_at":  "2025-01-01T12:00:00.000Z",
      "left_at":    null
    }
  ]
}
```

`mode` is either `"voluntary"` (user chose to watch) or `"overflow"` (assigned as spectator because the server was full). `left_at` is `null` while the spectator is still connected.

```bash
curl -k -b cookies.txt https://localhost:8443/api/spectators/3
```

---

### Tournaments — `game/session.js`, `index.js`

These endpoints are consumed by isegura- from `Tournament.jsx`.

```
GET  /api/tournament/:id   (login required) — tournament data, participants, matches
POST /api/tournament       (login required) — creates a tournament with { "clientIds": [...] }
```

---

### Dev endpoints — local only

No login required. These are not meant to reach production.

```
POST /api/dev/duel        — pairs all free players into 1v1 duels
POST /api/dev/tournament  — creates a tournament with all free players
```

Responses:
```json
{ "sessions": ["5", "6"] }
{ "tournamentId": 8 }
```

```bash
curl -k -X POST https://localhost:8443/api/dev/duel
curl -k -X POST https://localhost:8443/api/dev/tournament
```

---

## WebSocket — `ws/handler.js`

### Character selection

Received from the client:
```json
{ "type": "char_select", "charId": "eld", "stageId": 0 }
```

Broadcast to all connected clients:
```json
{
  "type":           "char_select_ack",
  "charId":         "eld",
  "selectorClient": 1,
  "stageId":        0,
  "players": {
    "0": { "clientId": 1, "charId": "eld", "texCfg": "...", "texSets": "...", "animBase": "..." },
    "1": { "clientId": 2, "charId": "hil", "texCfg": "...", "texSets": "...", "animBase": "..." }
  }
}
```

Once 2 or more players have selected a character, `tryAutoMatch()` starts the match automatically.

Available characters and their stats:

| charId | Name    | Speed | Dash  | Knockback | Range |
|--------|---------|-------|-------|-----------|-------|
| eld    | Eldwin  | 4.5   | 13.0  | 16.0      | 0.55  |
| hil    | Hilda   | 5.5   | 15.0  | 12.0      | 0.50  |
| qui    | Quimbur | 3.8   | 11.0  | 18.0      | 0.60  |
| gab    | Gabriel | 6.0   | 16.0  | 11.0      | 0.48  |

---

### Player input

Received from the client every frame:
```json
{
  "type":       "input",
  "moveX":      1,
  "jump":       false,
  "attack":     false,
  "dash":       false,
  "dashDir":    1,
  "crouch":     false,
  "block":      false,
  "dashAttack": false
}
```

`jump`, `attack`, `dash`, and `dashAttack` are single-frame events — they are `true` only on the frame the button is pressed, not while held. `crouch` and `block` stay `true` for as long as the user holds them.

---

### Hitstop — `physics.js`

Broadcast to all players in the session when a hit connects:
```json
{
  "type":       "hitstop",
  "tier":       "heavy",
  "frames":     18,
  "attackerId": 1,
  "targetId":   2
}
```

Tier is determined by the attacker's voltage at the moment of the hit:

| tier   | frames | attacker voltage |
|--------|--------|------------------|
| micro  | 3      | below 30         |
| light  | 6–10   | 30 to 79         |
| medium | 10–15  | 80 to 149        |
| heavy  | 15–22  | 150 to 199       |
| ultra  | 22     | 200 (maximum)    |

---

### Spectator mode

A client becomes a spectator either automatically (server is full) or voluntarily by sending a `watch` message.

Sent by client to enter spectator mode for a specific session:
```json
{ "type": "watch", "sessionId": "3" }
```

`sessionId` can be omitted to watch whichever session the user last watched. The server replies with `spectator_mode`:
```json
{
  "type":           "spectator_mode",
  "clientId":       5,
  "mode":           "voluntary",
  "watchingSession": "3",
  "activeSessions": []
}
```

`mode` is `"voluntary"` (user chose to watch) or `"overflow"` (assigned because server was full). `activeSessions` is the same structure as `GET /api/sessions`.

When the spectator's watched session changes (e.g. a session ends):
```json
{ "type": "spectator_session_changed", "watchingSession": null }
```

`watchingSession` is `null` if the session ended and there is no replacement.

Sent by client to request a state snapshot without waiting for the next tick:
```json
{ "type": "spectator_ping" }
```

The server replies immediately with a `state` message.

---

### Player disconnect and reconnect

When a player disconnects while a session is active, the server gives them 8 seconds to reconnect before eliminating them. All other players in the session receive:
```json
{
  "type":     "player_disconnected",
  "clientId": 2,
  "graceMs":  8000
}
```

If the player reconnects within the grace period, the timer is cancelled and the session receives:
```json
{ "type": "player_reconnected", "clientId": 2 }
```

If they do not reconnect in time, the server broadcasts `player_eliminated` as normal.

---

## Frontend / Bridge

### `ws-client.js`

Bridge between the WebSocket connection and Raylib/WASM. Writes the game state to `window._gameState` at 60 Hz so `main.c` can read it. The connection itself is opened by mmarinov from `Game.jsx`.
