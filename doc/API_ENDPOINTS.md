# API Reference — Enuma Fighter

**Base URL:** `https://localhost:8443`

All REST endpoints are under `/api`. All requests and responses use JSON (`Content-Type: application/json`).

**Auth:** session cookie (`sid`) set on login/register. Pass `credentials: 'include'` in every fetch. Endpoints marked *(auth)* return `401` if missing or expired.

**Error format:**
```json
{ "error": "Description of the problem" }
```

**Testing with curl:** always use `-k` (self-signed cert). Save/send the session cookie with `-c`/`-b`:
```bash
curl -k -c cookies.txt -X POST https://localhost:8443/api/register \
  -H "Content-Type: application/json" \
  -d '{"username":"test","email":"test@test.com","password":"12345678"}'

curl -k -b cookies.txt https://localhost:8443/api/me
```

---

## Git conventions

**Branch naming:** `feat/<feature>-<yourlogin>`
```
feat/leaderboard-aprenafe
feat/login-isegura
feat/profile-mmarinov
feat/ai-opponent-vberdugo
```

```bash
git checkout main && git pull
git checkout -b feat/login-isegura
```

**Commit prefixes:** `feat` `fix` `style` `refactor` `chore`
```
feat: add login form with error handling
fix: handle 401 on expired session
```

**PRs:** push to your branch, open PR toward `main`, one reviewer required. No direct commits to `main`.

---

# aprenafe

## Files
**Backend:** `game/achievements.js` `game/stats.js` `social/chat.js` `social/notifications.js`
**Frontend:** `Achievements.jsx` `Chat.jsx` `Leaderboard.jsx` `Notifications.jsx`

---

## Backend

### Achievements — `game/achievements.js`

```
GET /api/achievements   (auth)
```

Returns the authenticated user's unlocked achievements. Granting happens automatically via `checkAndGrantAchievements` in `index.js` at match end — no manual call needed.

Achievements in DB: `first_win` (first victory), `veteran` (10 victories).

```bash
curl -k -b cookies.txt https://localhost:8443/api/achievements
```

Response (200):
```json
{
  "achievements": [
    { "id": 1, "key": "first_win", "name": "Primera victoria", "description": "Gana tu primera partida", "earned_at": "2025-03-01T10:00:00.000Z" }
  ]
}
```

---

### Stats — `game/stats.js`

No public endpoint. Handles `win_streak` and `best_streak` logic. `wins`/`losses` are updated by `index.js`; this file owns streak tracking.

`user_stats` columns: `wins` `losses` `xp` `level` `win_streak` `best_streak`

---

### Chat — `social/chat.js`

```
GET   /api/chat/:userId         (auth)  → conversation history
POST  /api/chat/:userId         (auth)  → send a message
PATCH /api/chat/:userId/read    (auth)  → mark messages as read
```

#### `GET /api/chat/:userId` *(auth)*

Returns all messages between the authenticated user and `userId`, ordered by `sent_at` ascending.

```bash
curl -k -b cookies.txt https://localhost:8443/api/chat/55
```

Response (200):
```json
{
  "messages": [
    {
      "id": 1,
      "sender_id": 42,
      "receiver_id": 55,
      "content": "gg!",
      "is_read": true,
      "sent_at": "2025-03-01T10:00:00.000Z"
    }
  ]
}
```

Errors: `401` no session · `404` user not found

```js
useEffect(() => {
  fetch(`/api/chat/${userId}`, { credentials: 'include' })
    .then(r => r.json())
    .then(data => setMessages(data.messages));
}, [userId]);
```

---

#### `POST /api/chat/:userId` *(auth)*

Sends a message to `userId`.

```bash
curl -k -b cookies.txt -X POST https://localhost:8443/api/chat/55 \
  -H "Content-Type: application/json" \
  -d '{"content":"gg!"}'
```

Body: `{ "content": "gg!" }`

Response (201):
```json
{
  "message": {
    "id": 2,
    "sender_id": 42,
    "receiver_id": 55,
    "content": "gg!",
    "is_read": false,
    "sent_at": "2025-03-01T10:01:00.000Z"
  }
}
```

Errors: `400` empty or too long content · `403` user is blocked · `404` user not found

```js
await fetch(`/api/chat/${userId}`, {
  method: 'POST', credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ content }),
});
```

---

#### `PATCH /api/chat/:userId/read` *(auth)*

Marks all messages received from `userId` as read.

```bash
curl -k -b cookies.txt -X PATCH https://localhost:8443/api/chat/55/read
```

Response (200): `{ "ok": true, "updated": 3 }`

Errors: `401` no session · `404` user not found

---

### Notifications — `social/notifications.js`

```
GET   /api/notifications         (auth)  → list notifications
PATCH /api/notifications/:id     (auth)  → mark one as read
PATCH /api/notifications/read    (auth)  → mark all as read
```

#### `GET /api/notifications` *(auth)*

Returns all notifications for the authenticated user, most recent first.

```bash
curl -k -b cookies.txt https://localhost:8443/api/notifications
```

Response (200):
```json
{
  "notifications": [
    {
      "id": 5,
      "type": "friend_request",
      "payload": { "from_user_id": 88, "username": "player3" },
      "is_read": false,
      "created_at": "2025-03-01T09:00:00.000Z"
    }
  ],
  "unread_count": 1
}
```

Notification types: `friend_request` · `match_invite` · `player_eliminated` · `match_end` · `tournament_end`

```js
useEffect(() => {
  fetch('/api/notifications', { credentials: 'include' })
    .then(r => r.json())
    .then(data => {
      setNotifications(data.notifications);
      setUnreadCount(data.unread_count);
    });
}, []);
```

---

#### `PATCH /api/notifications/:id` *(auth)*

Marks a single notification as read.

```bash
curl -k -b cookies.txt -X PATCH https://localhost:8443/api/notifications/5
```

Response (200): `{ "ok": true }`

Errors: `403` notification does not belong to this user · `404` not found

---

#### `PATCH /api/notifications/read` *(auth)*

Marks all notifications for the authenticated user as read.

```bash
curl -k -b cookies.txt -X PATCH https://localhost:8443/api/notifications/read
```

Response (200): `{ "ok": true, "updated": 4 }`

---

WebSocket events that trigger notifications:
```json
{ "type": "player_eliminated", "clientId": 2 }
```
```json
{ "type": "match_end", "winner": 1, "loser": 2, "matchId": 11, "mode": "brawl" }
```
```json
{ "type": "tournament_end", "tournamentId": 7, "champion": 1, "championDbId": 42 }
```

---

## Frontend

### Leaderboard — `Leaderboard.jsx`

Endpoint defined by vberdugo, not aprenafe.

```
GET /api/leaderboard
```

No auth required. Returns top 10 players by wins and XP.

```bash
curl -k https://localhost:8443/api/leaderboard
```

Response:
```json
{
  "leaderboard": [
    { "username": "player1", "avatar_url": null, "wins": 15, "losses": 3, "xp": 1700, "level": 5 }
  ]
}
```

```js
useEffect(() => {
  fetch('/api/leaderboard')
    .then(r => r.json())
    .then(data => setLeaderboard(data.leaderboard));
}, []);
```

---

### Notifications — `Notifications.jsx`

Combines REST (persisted notifications on load) with WebSocket (live events):

```js
useEffect(() => {
  // Load persisted notifications on mount
  fetch('/api/notifications', { credentials: 'include' })
    .then(r => r.json())
    .then(data => {
      setNotifications(data.notifications);
      setUnreadCount(data.unread_count);
    });

  // Live events via WebSocket
  const ws = new WebSocket('wss://localhost:8443/ws');
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (['player_eliminated', 'match_end', 'tournament_end'].includes(data.type)) {
      setNotifications(prev => [data, ...prev]);
      setUnreadCount(prev => prev + 1);
    }
  };
  return () => ws.close();
}, []);
```

Mark a notification as read:
```js
await fetch(`/api/notifications/${id}`, {
  method: 'PATCH', credentials: 'include',
});
```

---

### Achievements — `Achievements.jsx`

```js
useEffect(() => {
  fetch('/api/achievements', { credentials: 'include' })
    .then(r => r.json())
    .then(data => setAchievements(data.achievements));
}, []);
```

---

### Chat — `Chat.jsx`

Load conversation history, send messages, and mark as read on open:

```js
useEffect(() => {
  fetch(`/api/chat/${userId}`, { credentials: 'include' })
    .then(r => r.json())
    .then(data => setMessages(data.messages));

  // Mark received messages as read
  fetch(`/api/chat/${userId}/read`, {
    method: 'PATCH', credentials: 'include',
  });
}, [userId]);

const sendMessage = async (content) => {
  const res = await fetch(`/api/chat/${userId}`, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  const { message } = await res.json();
  setMessages(prev => [...prev, message]);
};
```

---

# isegura-

## Files
**Backend/Infra:** `nginx/Dockerfile` `nginx/nginx.conf` `.env.example`
**Frontend:** `Login.jsx` `Register.jsx` `Tournament.jsx` `Privacy.jsx` `Terms.jsx`

---

## Backend / Infra

### nginx + HTTPS

Self-signed cert is generated automatically on container start. nginx handles TLS and proxies to `:3000` (backend) and `:80` (frontend). No API endpoints here.

### Environment variables — `.env.example`

All env vars documented with safe defaults. `make` creates `.env` from this file automatically if it doesn't exist.

---

## Frontend

### Login — `Login.jsx`

Calls `POST /api/login` defined by vberdugo in `auth.js`.

```
POST /api/login
```

```json
{ "email": "user@example.com", "password": "password123" }
```

Response (200):
```json
{ "user": { "id": 42, "username": "username", "email": "user@example.com", "avatar_url": null, "role": "user" } }
```

Errors: `400` missing fields · `401` wrong credentials

```bash
curl -k -c cookies.txt -X POST https://localhost:8443/api/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"12345678"}'
```

```js
const res = await fetch('/api/login', {
  method: 'POST', credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password }),
});
if (!res.ok) { const { error } = await res.json(); }
```

---

### Register — `Register.jsx`

Calls `POST /api/register` defined by vberdugo. Also logs the user in automatically.

```
POST /api/register
```

```json
{ "username": "username", "email": "user@example.com", "password": "password123" }
```

Response (201): same shape as login.

Errors: `400` missing field or password < 8 chars · `409` username or email taken

```bash
curl -k -c cookies.txt -X POST https://localhost:8443/api/register \
  -H "Content-Type: application/json" \
  -d '{"username":"test","email":"test@test.com","password":"12345678"}'
```

---

### Tournament UI — `Tournament.jsx`

Calls tournament endpoints defined by vberdugo.

```
GET  /api/tournament/:id   (auth)
POST /api/tournament       (auth)
```

`GET /api/tournament/7` response:
```json
{
  "tournament": { "id": 7, "name": "Tournament #7", "status": "ongoing" },
  "participants": [{ "user_id": 42, "eliminated": false, "username": "player1", "avatar_url": null }],
  "matches": [{ "round": 1, "match_id": 11, "winner_id": 42, "player1_id": 42, "player2_id": 55, "score1": 3, "score2": 1 }]
}
```

`POST /api/tournament` body: `{ "clientIds": [1, 2, 3, 4] }` → `{ "tournamentId": 7 }`

WebSocket events:
```json
{ "type": "match_start", "mode": "tournament", "sessionId": "3", "tournamentId": 7, "round": 1 }
```
```json
{ "type": "tournament_end", "tournamentId": 7, "champion": 1, "championDbId": 42 }
```

---

### Privacy & Terms — `Privacy.jsx`, `Terms.jsx`

Static pages, no API calls.

> ⚠️ **The evaluator checks for a visible footer link to both pages on every page. Missing link = project rejected.**

---

# mmarinov

## Files
**Backend:** `social/friends.js` `social/profile.js`
**Frontend:** `Friends.jsx` `Game.jsx` `Home.jsx` `Notifications.jsx` `Profile.jsx`

---

## Backend

### Profile — `social/profile.js`

#### `GET /api/profile/:userId` *(auth)*

Returns public profile, stats, and last 10 matches.

```bash
curl -k -b cookies.txt https://localhost:8443/api/profile/42
```

Response (200):
```json
{
  "user": {
    "id": 42, "username": "player1",
    "avatar_url": "/avatars/default.png",
    "is_online": true, "created_at": "2025-01-01T12:00:00.000Z"
  },
  "stats": {
    "wins": 15, "losses": 3, "draws": 1,
    "win_streak": 4, "best_streak": 7, "xp": 1700, "level": 5
  },
  "recent_matches": [
    {
      "match_id": 11, "opponent_id": 55, "opponent_username": "player2",
      "score_self": 3, "score_opponent": 1,
      "winner_id": 42, "played_at": "2025-01-02T10:00:00.000Z", "duration_s": 124
    }
  ]
}
```

Errors: `401` no session · `404` user not found

---

#### `PATCH /api/profile` *(auth)*

Updates the authenticated user's profile. Only provided fields are applied.

```bash
curl -k -b cookies.txt -X PATCH https://localhost:8443/api/profile \
  -H "Content-Type: application/json" \
  -d '{"username":"new_name"}'
```

Body (all optional):
```json
{ "username": "new_name", "avatar_url": "/avatars/custom.png" }
```

Response (200):
```json
{ "user": { "id": 42, "username": "new_name", "email": "user@example.com", "avatar_url": "/avatars/custom.png" } }
```

Errors: `400` empty or too long username · `409` username taken

```js
const res = await fetch('/api/profile', {
  method: 'PATCH', credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username, avatar_url }),
});
```

---

#### `GET /api/profile/export` *(auth)* — GDPR

Downloads all personal data as JSON. Response has `Content-Disposition: attachment`.

```bash
curl -k -b cookies.txt https://localhost:8443/api/profile/export -o my_data.json
```

Response (200):
```json
{
  "exported_at": "2025-06-01T10:00:00.000Z",
  "user": { "id": 42, "username": "player1", "email": "user@example.com", "created_at": "..." },
  "stats": { "wins": 15, "losses": 3, "xp": 1700, "level": 5 },
  "matches": [],
  "achievements": [],
  "messages_sent": [],
  "messages_received": []
}
```

---

#### `DELETE /api/profile` *(auth)* — GDPR

Permanently deletes the account and all associated data (cascade). Requires explicit confirmation.

```bash
curl -k -b cookies.txt -X DELETE https://localhost:8443/api/profile \
  -H "Content-Type: application/json" \
  -d '{"confirm":"DELETE_MY_ACCOUNT"}'
```

Body:
```json
{ "confirm": "DELETE_MY_ACCOUNT" }
```

Response (200): `{ "ok": true }`

Errors: `400` missing confirm or wrong value · `401` no session

```js
const res = await fetch('/api/profile', {
  method: 'DELETE', credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ confirm: 'DELETE_MY_ACCOUNT' }),
});
if (res.ok) { /* redirect to login */ }
```

---

### Friends — `social/friends.js`

#### `GET /api/friends` *(auth)*

Returns the authenticated user's accepted friends with online status.

```bash
curl -k -b cookies.txt https://localhost:8443/api/friends
```

Response (200):
```json
{
  "friends": [
    { "friendship_id": 7, "user_id": 55, "username": "player2", "avatar_url": null, "is_online": true, "since": "2025-02-10T08:00:00.000Z" }
  ]
}
```

```js
useEffect(() => {
  fetch('/api/friends', { credentials: 'include' })
    .then(r => r.json())
    .then(data => setFriends(data.friends));
}, []);
```

---

#### `GET /api/friends/requests` *(auth)*

Returns incoming pending friend requests.

```bash
curl -k -b cookies.txt https://localhost:8443/api/friends/requests
```

Response (200):
```json
{
  "requests": [
    { "friendship_id": 12, "from_user_id": 88, "username": "player3", "avatar_url": null, "sent_at": "2025-03-01T09:00:00.000Z" }
  ]
}
```

---

#### `POST /api/friends/request` *(auth)*

Sends a friend request.

```bash
curl -k -b cookies.txt -X POST https://localhost:8443/api/friends/request \
  -H "Content-Type: application/json" \
  -d '{"user_id":55}'
```

Body: `{ "user_id": 55 }`

Response (201): `{ "friendship_id": 7 }`

Errors: `400` missing or self · `404` user not found · `409` request or friendship already exists

```js
await fetch('/api/friends/request', {
  method: 'POST', credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ user_id: targetUserId }),
});
```

---

#### `PATCH /api/friends/:friendshipId` *(auth)*

Accepts or rejects a pending friend request.

```bash
curl -k -b cookies.txt -X PATCH https://localhost:8443/api/friends/12 \
  -H "Content-Type: application/json" \
  -d '{"action":"accept"}'
```

Body: `{ "action": "accept" }` or `{ "action": "reject" }`

Response (200): `{ "ok": true }`

Errors: `400` invalid action · `403` request not addressed to this user · `404` not found

---

#### `DELETE /api/friends/:friendshipId` *(auth)*

Removes a friend. Pass `"block": true` to block instead (sets `status: "blocked"`, prevents future requests).

```bash
# Remove
curl -k -b cookies.txt -X DELETE https://localhost:8443/api/friends/7

# Block
curl -k -b cookies.txt -X DELETE https://localhost:8443/api/friends/7 \
  -H "Content-Type: application/json" \
  -d '{"block":true}'
```

Response (200): `{ "ok": true }`

Errors: `403` friendship doesn't belong to this user · `404` not found

---

## Frontend

### Current user — `Home.jsx`, `Profile.jsx`, `Friends.jsx`

`GET /api/me` is defined by vberdugo and used across most pages to identify the logged-in user. Use `user.user_id` when referencing DB records.

```bash
curl -k -b cookies.txt https://localhost:8443/api/me
```

Response:
```json
{ "user": { "user_id": 42, "username": "player1", "email": "user@example.com", "avatar_url": null, "role": "user" } }
```

```js
useEffect(() => {
  fetch('/api/me', { credentials: 'include' })
    .then(r => r.ok ? r.json() : null)
    .then(data => data && setUser(data.user));
}, []);
```

---

### Home — `Home.jsx`

```
GET /api/sessions
GET /api/players
```

`/api/sessions` response:
```json
{
  "sessions": [
    { "sessionId": "3", "mode": "brawl", "playerIds": [1, 2, 3], "startedAt": "2025-01-01T12:00:00.000Z", "spectators": 1 }
  ],
  "lobbySpectators": 0,
  "totalSpectators": 1
}
```

Modes: `brawl` `1v1` `tournament`. `tournamentId` and `round` are present (and non-null) for tournament sessions.

`/api/players` response:
```json
{ "players": [{ "clientId": 1, "dbUserId": 42, "inSession": true }], "spectatorCount": 2 }
```

---

### Game — `Game.jsx`

Opens the WebSocket at `wss://localhost:8443/ws` and keeps it alive. Game state is handled by `ws-client.js`, which writes to `window._gameState` — no manual state processing needed here.

First message from server after connecting:
```json
{ "type": "init", "clientId": 1, "config": { "attackRange": 0.525, "attackRangeY": 0.5, "dashAttackRange": 1.65 } }
```

Save `clientId` and handle reconnection:
```js
sessionStorage.setItem('clientId', data.clientId);

// On page reload
const saved = sessionStorage.getItem('clientId');
ws.send(JSON.stringify(saved
  ? { type: 'rejoin', clientId: Number(saved) }
  : { type: 'join' }
));
```

Clear `clientId` when this event arrives:
```json
{ "type": "match_finished", "sessionId": "3" }
```

---

### Profile — `Profile.jsx`

Load own profile using `user_id` from `/api/me`:
```js
useEffect(() => {
  fetch('/api/me', { credentials: 'include' })
    .then(r => r.json())
    .then(({ user }) =>
      fetch(`/api/profile/${user.user_id}`, { credentials: 'include' })
        .then(r => r.json())
        .then(setProfile)
    );
}, []);
```

---

### Friends — `Friends.jsx`

Load friends and pending requests together:
```js
useEffect(() => {
  Promise.all([
    fetch('/api/friends',          { credentials: 'include' }).then(r => r.json()),
    fetch('/api/friends/requests', { credentials: 'include' }).then(r => r.json()),
  ]).then(([{ friends }, { requests }]) => {
    setFriends(friends);
    setRequests(requests);
  });
}, []);
```

---

### Notifications — `Notifications.jsx`

Combines REST (load persisted notifications on mount) with WebSocket (live events). See aprenafe's backend section for endpoint details and WebSocket event shapes.

```js
useEffect(() => {
  fetch('/api/notifications', { credentials: 'include' })
    .then(r => r.json())
    .then(data => {
      setNotifications(data.notifications);
      setUnreadCount(data.unread_count);
    });
}, []);
```

---

# vberdugo

## Files
**Backend:** `auth.js` `index.js` `ws/handler.js` `game/session.js` `game/physics.js` `game/ai.js`
**Frontend/Bridge:** `ws-client.js` `main.c` Dockerfiles

---

## Backend

### Auth — `auth.js`, `index.js`

```
POST /api/register   → 201, creates session automatically
POST /api/login      → 200
GET  /api/me         → (auth) returns user from session cookie
POST /api/logout     → (auth) invalidates cookie, sets is_online = FALSE
```

`/api/logout` response: `{ "ok": true }`

```bash
curl -k -b cookies.txt -X POST https://localhost:8443/api/logout
```

---

### Sessions & players — `game/session.js`, `index.js`

Consumed by mmarinov from `Home.jsx`. See Home section above for response shapes.

```
GET /api/sessions
GET /api/players
```

---

### Duel — `index.js` *(auth)*

Starts a 1v1 between two connected players.

```
POST /api/duel   (auth)
```

Body: `{ "clientId1": 1, "clientId2": 2 }`

Response (200): `{ "sessionId": "3" }`

Errors: `400` missing IDs or same player · `404` player not connected

```bash
curl -k -b cookies.txt -X POST https://localhost:8443/api/duel \
  -H "Content-Type: application/json" \
  -d '{"clientId1":1,"clientId2":2}'
```

---

### Spectators — `index.js` *(auth)*

```
GET /api/spectators/:sessionId   (auth)
```

```bash
curl -k -b cookies.txt https://localhost:8443/api/spectators/3
```

Response:
```json
{
  "spectators": [
    { "id": 1, "user_id": 42, "username": "player1", "avatar_url": null, "mode": "voluntary", "joined_at": "2025-01-01T12:00:00.000Z", "left_at": null }
  ]
}
```

`mode`: `"voluntary"` (chose to watch) or `"overflow"` (redirected because server was full). `left_at` is `null` while still connected.

---

### Tournaments — `game/session.js`, `index.js`

Consumed by isegura- from `Tournament.jsx`. See Tournament UI section above for request/response.

```
GET  /api/tournament/:id   (auth)
POST /api/tournament       (auth)
```

---

### Dev endpoints — local only

No auth required. Not for production.

```
POST /api/dev/duel        → { "sessions": ["5", "6"] }
POST /api/dev/tournament  → { "tournamentId": 8 }
```

```bash
curl -k -X POST https://localhost:8443/api/dev/duel
curl -k -X POST https://localhost:8443/api/dev/tournament
```

---

## WebSocket — `ws/handler.js`

### Character selection

Client sends:
```json
{ "type": "char_select", "charId": "eld", "stageId": 0 }
```

Server broadcasts to all:
```json
{
  "type": "char_select_ack", "charId": "eld", "selectorClient": 1, "stageId": 0,
  "players": {
    "0": { "clientId": 1, "charId": "eld", "texCfg": "...", "texSets": "...", "animBase": "..." },
    "1": { "clientId": 2, "charId": "hil", "texCfg": "...", "texSets": "...", "animBase": "..." }
  }
}
```

Once 2+ players select a character, `tryAutoMatch()` starts the match automatically.

Character stats:

| charId | Name    | Speed | Dash | Knockback | Range |
|--------|---------|-------|------|-----------|-------|
| eld    | Eldwin  | 4.5   | 13.0 | 16.0      | 0.55  |
| hil    | Hilda   | 5.5   | 15.0 | 12.0      | 0.50  |
| qui    | Quimbur | 3.8   | 11.0 | 18.0      | 0.60  |
| gab    | Gabriel | 6.0   | 16.0 | 11.0      | 0.48  |

---

### Player input

Sent every frame:
```json
{ "type": "input", "moveX": 1, "jump": false, "attack": false, "dash": false, "dashDir": 1, "crouch": false, "block": false, "dashAttack": false }
```

`jump`, `attack`, `dash`, `dashAttack` are single-frame pulses (true only on press). `crouch` and `block` stay true while held.

---

### Game state — 60 Hz

```json
{
  "type": "state", "frameId": 3421,
  "players": {
    "1": {
      "id": 1, "charId": "eld", "x": -1.234, "y": 0.0, "rotation": 0,
      "animation": "walk", "onGround": true, "stocks": 3,
      "respawning": false, "crouching": false, "hitId": 0,
      "jumpId": 0, "voltage": 24.5, "voltageMaxed": false, "blocking": false
    }
  }
}
```

`rotation`: `0` = facing right, `Math.PI` = facing left. `hitId` and `jumpId` increment on each hit/jump — use to trigger one-shot animations.

---

### Hitstop — `physics.js`

Broadcast when a hit connects:
```json
{ "type": "hitstop", "tier": "heavy", "frames": 18, "attackerId": 1, "targetId": 2 }
```

| tier   | frames | attacker voltage |
|--------|--------|------------------|
| micro  | 3      | < 30             |
| light  | 6–10   | 30–79            |
| medium | 10–15  | 80–149           |
| heavy  | 15–22  | 150–199          |
| ultra  | 22     | 200 (max)        |

---

### Spectator mode

Client enters spectator mode voluntarily:
```json
{ "type": "watch", "sessionId": "3" }
```

`sessionId` can be omitted to resume last watched session. Server replies:
```json
{ "type": "spectator_mode", "clientId": 5, "mode": "voluntary", "watchingSession": "3", "activeSessions": [] }
```

When the watched session changes:
```json
{ "type": "spectator_session_changed", "watchingSession": null }
```

Request an immediate state snapshot:
```json
{ "type": "spectator_ping" }
```

---

### Disconnect / reconnect

When a player drops mid-session, all others receive:
```json
{ "type": "player_disconnected", "clientId": 2, "graceMs": 8000 }
```

If they reconnect within 8 s:
```json
{ "type": "player_reconnected", "clientId": 2 }
```

Otherwise the server broadcasts `player_eliminated` as normal.

---

## Frontend / Bridge — `ws-client.js`

Bridge between the WebSocket and Raylib/WASM. Writes game state to `window._gameState` at 60 Hz for `main.c` to read. The connection is opened by mmarinov from `Game.jsx`.