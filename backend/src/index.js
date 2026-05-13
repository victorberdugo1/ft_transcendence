'use strict';

const http      = require('http');
const WebSocket = require('ws');
const express   = require('express');

const db = require('./db');  // eslint-disable-line no-unused-vars  (keeps pool alive)

const { loadSession, requireAuth, register, login, logout, me } = require('./auth');
const { setupWebSocket } = require('./ws/handler');

// Social routes
const friends       = require('./social/friends');
const chat          = require('./social/chat');
const profile       = require('./social/profile');
const notifications = require('./social/notifications');

// Game-related query routes
const gameSession = require('./game/session');

// ─── Express app ──────────────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ noServer: true });

app.use(express.json());
app.use(loadSession);

// ─── Auth routes ──────────────────────────────────────────────────────────────

app.post('/api/register', register);
app.post('/api/login',    login);
app.post('/api/logout',   requireAuth, logout);
app.get('/api/me',        requireAuth, me);

// ─── Profile routes ───────────────────────────────────────────────────────────

app.get('/api/users/:id',              profile.getProfile);
app.put('/api/profile',                requireAuth, profile.updateProfile);
app.get('/api/users/:id/stats',        profile.getUserStats);
app.get('/api/users/:id/history',      profile.getMatchHistory);
app.get('/api/users/:id/achievements', profile.getUserAchievements);
app.get('/api/profile/export',         requireAuth, profile.exportData);
app.delete('/api/profile',             requireAuth, profile.deleteAccount);

// ─── Friends routes ───────────────────────────────────────────────────────────

app.get('/api/friends',          requireAuth, friends.listFriends);
app.get('/api/friends/requests', requireAuth, friends.listPendingRequests);
app.post('/api/friends/:id',     requireAuth, friends.sendRequest);
app.put('/api/friends/:id',      requireAuth, friends.acceptRequest);
app.delete('/api/friends/:id',   requireAuth, friends.removeFriend);

// ─── Chat routes ──────────────────────────────────────────────────────────────

app.get('/api/messages/unread',       requireAuth, chat.unreadCounts);
app.get('/api/messages/:userId',      requireAuth, chat.getConversation);
app.post('/api/messages/:userId',     requireAuth, chat.sendMessage);
app.put('/api/messages/:userId/read', requireAuth, chat.markRead);

// ─── Notifications routes ─────────────────────────────────────────────────────

app.get('/api/notifications',          requireAuth, notifications.listNotifications);
app.patch('/api/notifications/read',   requireAuth, notifications.markAllRead);
app.patch('/api/notifications/:id',    requireAuth, notifications.markOneRead);

// ─── Leaderboard ──────────────────────────────────────────────────────────────

app.get('/api/leaderboard', async (req, res) => {
    try {
        const { rows } = await db.query(
            `SELECT u.username, u.avatar_url, s.wins, s.losses, s.xp, s.level
             FROM user_stats s
             JOIN users u ON u.id = s.user_id
             ORDER BY s.wins DESC, s.xp DESC
             LIMIT 10`
        );
        res.json({ leaderboard: rows });
    } catch (err) {
        res.status(500).json({ error: 'Internal error' });
    }
});

// ─── Game session routes ──────────────────────────────────────────────────────

app.get('/api/players', (req, res) => {
    const { players, spectators, playerSession } = gameSession;
    const list = Object.values(players).map(p => ({
        clientId:  p.id,
        dbUserId:  p.dbUserId ?? null,
        inSession: playerSession.has(p.id),
    }));
    res.json({ players: list, spectatorCount: Object.keys(spectators).length });
});

app.get('/api/sessions', (req, res) => {
    const { spectators, listActiveSessions } = gameSession;
    const lobbySpectators = Object.values(spectators).filter(s => s.watchingSession === null).length;
    res.json({
        sessions:        listActiveSessions(),
        lobbySpectators,
        totalSpectators: Object.keys(spectators).length,
    });
});

app.post('/api/duel', requireAuth, (req, res) => {
    const { players, playerSession, startDuel } = gameSession;
    const { clientId1, clientId2 } = req.body ?? {};
    if (!clientId1 || !clientId2 || clientId1 === clientId2)
        return res.status(400).json({ error: 'Two distinct clientIds are required' });
    if (!players[clientId1] || !players[clientId2])
        return res.status(404).json({ error: 'One or both players are not connected' });
    const session = startDuel(clientId1, clientId2);
    res.json({ sessionId: session.id });
});

app.post('/api/tournament', requireAuth, async (req, res) => {
    const { players, startTournament } = gameSession;
    const { clientIds } = req.body ?? {};
    if (!Array.isArray(clientIds) || clientIds.length < 2)
        return res.status(400).json({ error: 'At least 2 players are required' });
    for (const cid of clientIds) {
        if (!players[cid]) return res.status(404).json({ error: `Player ${cid} is not connected` });
    }
    try {
        const tournamentId = await startTournament(clientIds, req.user.user_id);
        res.json({ tournamentId });
    } catch (err) {
        console.error('[API] tournament error:', err.message);
        res.status(500).json({ error: 'Internal error creating tournament' });
    }
});

app.get('/api/tournament/:id', requireAuth, async (req, res) => {
    const id = parseInt(req.params.id);
    try {
        const { rows: tournament } = await db.query('SELECT * FROM tournaments WHERE id = $1', [id]);
        if (!tournament.length) return res.status(404).json({ error: 'Tournament not found' });
        const { rows: participants } = await db.query(
            `SELECT tp.user_id, tp.eliminated, u.username, u.avatar_url
             FROM tournament_players tp JOIN users u ON u.id = tp.user_id
             WHERE tp.tournament_id = $1`, [id]
        );
        const { rows: tMatches } = await db.query(
            `SELECT tm.round, tm.match_id, m.winner_id, m.score1, m.score2, m.player1_id, m.player2_id
             FROM tournament_matches tm JOIN matches m ON m.id = tm.match_id
             WHERE tm.tournament_id = $1 ORDER BY tm.round, tm.id`, [id]
        );
        res.json({ tournament: tournament[0], participants, matches: tMatches });
    } catch (err) {
        console.error('[API] tournament fetch error:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

app.get('/api/spectators/:sessionId', requireAuth, async (req, res) => {
    const { sessionId } = req.params;
    try {
        const { rows } = await db.query(
            `SELECT sp.id, sp.user_id, u.username, u.avatar_url, sp.mode, sp.joined_at, sp.left_at
             FROM spectators sp LEFT JOIN users u ON u.id = sp.user_id
             WHERE sp.session_id = $1 ORDER BY sp.joined_at`,
            [sessionId]
        );
        res.json({ spectators: rows });
    } catch (err) {
        res.status(500).json({ error: 'Internal error' });
    }
});

// ─── Dev-only endpoints ───────────────────────────────────────────────────────

app.post('/api/dev/duel', (req, res) => {
    const { players, playerSession, startDuel } = gameSession;
    const free = Object.values(players).filter(p => !playerSession.has(p.id)).map(p => p.id);
    if (free.length < 2)
        return res.status(400).json({ error: 'Need at least 2 players not already in a session' });
    const sessions = [];
    for (let i = 0; i + 1 < free.length; i += 2) sessions.push(startDuel(free[i], free[i + 1]).id);
    res.json({ sessions });
});

app.post('/api/dev/tournament', async (req, res) => {
    const { players, startTournament } = gameSession;
    const free = Object.values(players).filter(p => !playerSession.has(p.id)).map(p => p.id);
    if (free.length < 2)
        return res.status(400).json({ error: 'Need at least 2 players not already in a session' });
    try {
        const tournamentId = await startTournament(free, req.user?.user_id ?? null);
        res.json({ tournamentId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── WebSocket ────────────────────────────────────────────────────────────────

setupWebSocket(server, wss);

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] Listening on port ${PORT}`);
});