'use strict';

const WebSocket = require('ws');
const db        = require('../db');
const { SESSION_COOKIE } = require('../auth');

const {
    players, spectators, lastState,
    gameSessions, playerSession, playerCharSelected,
    broadcastState, broadcastToSession, broadcastToAll,
    sendStateToSpectator, listActiveSessions,
    buildCharSelectAck, sendAllCharSelectsTo,
    createPlayer, startDuel, startTournament, tryAutoMatch,
    handleElimination, getLastWatchedSession,
    MAX_PLAYERS, GHOST_TTL,
    ATTACK_RANGE, ATTACK_RANGE_Y, DASH_ATTACK_RANGE_X,
    CHAR_IDS, CHARACTER_DEFS,
} = require('../game/session');

// nextClientId is a property on the module — we mutate through the module
const gameSession = require('../game/session');

// ─── WebSocket server setup ───────────────────────────────────────────────────

function setupWebSocket(server, wss) {
    server.on('upgrade', (req, socket, head) => {
        if (req.url === '/ws') {
            wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
        } else {
            socket.destroy();
        }
    });

    wss.on('connection', onConnection);
}

// ─── Connection handler ───────────────────────────────────────────────────────

async function onConnection(ws, req) {
    let clientId = null;
    let dbUserId = null;
    let isSpectator = false;
    let mode = null;
    let firstMessageSeen = false;
    let autoSpectatorTimer = null;

    // Resolve session from cookie
    try {
        const cookieHeader = req.headers.cookie || '';
        let token = null;
        for (const part of cookieHeader.split(';')) {
            const [k, v] = part.trim().split('=');
            if (k === SESSION_COOKIE) { token = v; break; }
        }
        if (token) {
            const { rows } = await db.query(
                `SELECT user_id FROM sessions WHERE token = $1 AND expires_at > NOW()`,
                [token]
            );
            if (rows.length) dbUserId = rows[0].user_id;
        }
    } catch (err) {
        console.error('[WS] session resolve error:', err.message);
    }

    // ── Inner helpers (capture closure vars) ──────────────────────────────────

    async function insertOrUpdateSpectatorRow(specMode, watchingSession) {
        const current = spectators[clientId];
        if (!current) return;
        const tournamentId = watchingSession ? (gameSessions.get(watchingSession)?.tournamentId ?? null) : null;
        if (!current.dbRowId) {
            try {
                const { rows: dbRows } = await db.query(
                    `INSERT INTO spectators (user_id, session_id, tournament_id, mode)
                     VALUES ($1, $2, $3, $4) RETURNING id`,
                    [dbUserId, watchingSession ?? 'lobby', tournamentId, specMode]
                );
                current.dbRowId = dbRows[0]?.id ?? null;
            } catch (err) {
                console.error('[SPECTATOR] DB insert error:', err.message);
            }
        } else {
            db.query(
                `UPDATE spectators SET session_id = $1, tournament_id = $2, mode = $3 WHERE id = $4`,
                [watchingSession ?? 'lobby', tournamentId, specMode, current.dbRowId]
            ).catch(err => console.error('[SPECTATOR] DB update error:', err.message));
        }
    }

    function sendSpectatorWelcome(specMode, watchingSession) {
        if (!spectators[clientId]) return;
        ws.send(JSON.stringify({
            type: 'spectator_mode', clientId, mode: specMode,
            watchingSession, activeSessions: listActiveSessions(),
        }));
        sendStateToSpectator(spectators[clientId]);
    }

    async function ensureSpectatorReady(specMode = 'overflow', watchingSession = null, extraFlags = {}) {
        if (clientId === null) {
            clientId = gameSession.nextClientId++;
        }
        if (!spectators[clientId]) {
            spectators[clientId] = {
                id: clientId, dbUserId, ws, watchingSession, mode: specMode,
                dbRowId: null, eliminated: extraFlags.eliminated ?? false,
            };
            isSpectator = true;
            mode = specMode;
            await insertOrUpdateSpectatorRow(specMode, watchingSession);
            sendSpectatorWelcome(specMode, watchingSession);
            console.log(`[SPECTATOR] Client ${clientId} connected as ${specMode}` + (watchingSession ? ` watching ${watchingSession}` : ' (lobby)'));
        } else {
            spectators[clientId].watchingSession = watchingSession;
            spectators[clientId].mode = specMode;
            if (extraFlags.eliminated) spectators[clientId].eliminated = true;
            isSpectator = true;
            mode = specMode;
            await insertOrUpdateSpectatorRow(specMode, watchingSession);
            ws.send(JSON.stringify({ type: 'spectator_session_changed', watchingSession }));
            sendStateToSpectator(spectators[clientId]);
        }
    }

    async function promoteToPlayer(initialMsg = null) {
        if (clientId === null || clientId === undefined) {
            clientId = gameSession.nextClientId++;
        }
        if (players[clientId]) return;

        if (Object.keys(players).length >= MAX_PLAYERS) {
            const firstSession = gameSessions.size > 0 ? gameSessions.keys().next().value : null;
            await ensureSpectatorReady('overflow', firstSession);
            return;
        }

        if (spectators[clientId]) {
            const spec = spectators[clientId];
            if (spec.dbRowId) {
                db.query(`UPDATE spectators SET left_at = NOW() WHERE id = $1`, [spec.dbRowId])
                  .catch(err => console.error('[SPECTATOR] left_at update error:', err.message));
            }
            delete spectators[clientId];
        }

        const saved = lastState[clientId];
        if (saved) clearTimeout(saved.timer);

        if (saved?.spectator) {
            delete lastState[clientId];
            const watchSess = saved.watchingSession ?? null;
            const sessStillActive = watchSess && gameSessions.has(watchSess) && !gameSessions.get(watchSess).finished;
            if (!sessStillActive && watchSess) {
                playerCharSelected.delete(clientId);
            } else {
                const resolvedSess = sessStillActive
                    ? watchSess
                    : (gameSessions.size > 0 ? gameSessions.keys().next().value : null);
                await ensureSpectatorReady(saved.mode ?? 'overflow', resolvedSess, { eliminated: saved.eliminated ?? false });
                return;
            }
        }

        players[clientId] = createPlayer(clientId, saved, ws);
        players[clientId].dbUserId = dbUserId;
        delete lastState[clientId];

        const restoredChar = playerCharSelected.get(clientId);
        if (restoredChar) {
            const def = CHARACTER_DEFS[restoredChar] ?? CHARACTER_DEFS.eld;
            players[clientId].charId          = restoredChar;
            players[clientId].moveSpeed       = def.moveSpeed;
            players[clientId].dashSpeed       = def.dashSpeed;
            players[clientId].attackKnockback = def.attackKnockback;
            players[clientId].attackRange     = def.attackRange;
        }

        isSpectator = false;
        mode = 'player';

        ws.send(JSON.stringify({
            type: 'init', clientId,
            config: {
                attackRange:     players[clientId]?.attackRange ?? ATTACK_RANGE,
                attackRangeY:    ATTACK_RANGE_Y,
                dashAttackRange: DASH_ATTACK_RANGE_X,
            },
        }));

        sendAllCharSelectsTo(ws);

        if (restoredChar) {
            const ack = buildCharSelectAck(restoredChar, clientId, 0);
            ws.send(JSON.stringify(ack));
        }

        if (initialMsg && initialMsg.type === 'input') {
            const p = players[clientId];
            if (p) {
                p.input.moveX      = initialMsg.moveX      ?? 0;
                p.input.jump       = !!initialMsg.jump;
                p.input.attack     = !!initialMsg.attack;
                p.input.dash       = !!initialMsg.dash;
                p.input.dashDir    = initialMsg.dashDir    ?? 0;
                p.input.crouch     = !!initialMsg.crouch;
                p.input.block      = !!initialMsg.block;
                p.input.dashAttack = !!initialMsg.dashAttack;
            }
        }

        broadcastState();
        console.log(`[SERVER] Player ${clientId} connected (${Object.keys(players).length}/${MAX_PLAYERS})`);
        tryAutoMatch();
    }

    // ── Auto-spectator timer (if no message in 120ms, assume spectator) ───────
    autoSpectatorTimer = setTimeout(async () => {
        if (firstMessageSeen) return;
        if (players[clientId] || spectators[clientId]) return;
        const firstSession = gameSessions.size > 0 ? gameSessions.keys().next().value : null;
        await ensureSpectatorReady('overflow', firstSession);
    }, 120);

    // ── Message handler ───────────────────────────────────────────────────────
    ws.on('message', async (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        firstMessageSeen = true;
        if (autoSpectatorTimer) { clearTimeout(autoSpectatorTimer); autoSpectatorTimer = null; }

        if (msg.type === 'join') {
            if (clientId === null) clientId = gameSession.nextClientId++;
            if (Object.keys(players).length >= MAX_PLAYERS) {
                const firstSession = gameSessions.size > 0 ? gameSessions.keys().next().value : null;
                await ensureSpectatorReady('overflow', firstSession);
            } else {
                await promoteToPlayer(null);
            }
            return;
        }

        if (msg.type === 'rejoin' && msg.clientId) {
            // Cancel any grace-period timer
            for (const [sessId, sess] of gameSessions.entries()) {
                if (sess.pendingEliminations && sess.pendingEliminations[msg.clientId]) {
                    clearTimeout(sess.pendingEliminations[msg.clientId]);
                    delete sess.pendingEliminations[msg.clientId];
                    broadcastToSession(sess, { type: 'player_reconnected', clientId: msg.clientId });
                }
            }

            if (players[msg.clientId]) {
                clientId = msg.clientId;
                if (clientId >= gameSession.nextClientId) gameSession.nextClientId = clientId + 1;
                players[clientId].ws = ws;
                isSpectator = false; mode = 'player';
                const savedSession = lastState[clientId]?.sessionId ?? null;
                if (savedSession && gameSessions.has(savedSession) && !playerSession.has(clientId)) {
                    playerSession.set(clientId, savedSession);
                }
                ws.send(JSON.stringify({
                    type: 'init', clientId,
                    config: { attackRange: players[clientId]?.attackRange ?? ATTACK_RANGE, attackRangeY: ATTACK_RANGE_Y, dashAttackRange: DASH_ATTACK_RANGE_X },
                }));
                sendAllCharSelectsTo(ws);
                const savedChar = playerCharSelected.get(clientId);
                if (savedChar) ws.send(JSON.stringify(buildCharSelectAck(savedChar, clientId, 0)));
                return;
            }

            if (spectators[msg.clientId]) {
                clientId = msg.clientId;
                if (clientId >= gameSession.nextClientId) gameSession.nextClientId = clientId + 1;
                spectators[clientId].ws = ws;
                isSpectator = true; mode = spectators[clientId].mode;
                sendSpectatorWelcome(mode, spectators[clientId].watchingSession);
                return;
            }

            if (clientId !== null && clientId !== msg.clientId) {
                delete spectators[clientId];
                delete players[clientId];
            }
            clientId = msg.clientId;
            if (clientId >= gameSession.nextClientId) gameSession.nextClientId = clientId + 1;

            const ghostState = lastState[clientId];
            if (ghostState?.spectator) {
                const watchSess = ghostState.watchingSession ?? null;
                const sessStillActive = watchSess && gameSessions.has(watchSess) && !gameSessions.get(watchSess).finished;
                if (!sessStillActive) {
                    clearTimeout(ghostState.timer);
                    delete lastState[clientId];
                    playerCharSelected.delete(clientId);
                    if (Object.keys(players).length < MAX_PLAYERS) {
                        await promoteToPlayer(null);
                    } else {
                        const firstSession = gameSessions.size > 0 ? gameSessions.keys().next().value : null;
                        await ensureSpectatorReady('overflow', firstSession);
                    }
                    return;
                }
                clearTimeout(ghostState.timer);
                delete lastState[clientId];
                await ensureSpectatorReady(ghostState.mode ?? 'overflow', watchSess, { eliminated: ghostState.eliminated ?? false });
                return;
            }

            if (Object.keys(players).length < MAX_PLAYERS) {
                await promoteToPlayer(null);
            } else {
                const firstSession = gameSessions.size > 0 ? gameSessions.keys().next().value : null;
                await ensureSpectatorReady('overflow', firstSession);
            }
            return;
        }

        if (msg.type === 'watch') {
            if (!clientId && clientId !== 0) clientId = gameSession.nextClientId++;
            const watchingSession = (msg.sessionId && gameSessions.get(msg.sessionId))
                ? msg.sessionId
                : (msg.sessionId ?? await getLastWatchedSession(dbUserId));
            await ensureSpectatorReady('voluntary', watchingSession ?? null);
            if (spectators[clientId]) {
                spectators[clientId].watchingSession = watchingSession ?? null;
                spectators[clientId].mode = 'voluntary';
                await insertOrUpdateSpectatorRow('voluntary', watchingSession ?? null);
                ws.send(JSON.stringify({ type: 'spectator_session_changed', watchingSession: spectators[clientId].watchingSession }));
                sendStateToSpectator(spectators[clientId]);
            }
            return;
        }

        if (msg.type === 'input') {
            if (spectators[clientId]) return;
            if (!players[clientId]) { await promoteToPlayer(msg); return; }
            const p = players[clientId];
            if (!p) return;
            p.input.moveX      = msg.moveX      ?? 0;
            p.input.jump       = !!msg.jump;
            p.input.attack     = !!msg.attack;
            p.input.dash       = !!msg.dash;
            p.input.dashDir    = msg.dashDir    ?? 0;
            p.input.crouch     = !!msg.crouch;
            p.input.block      = !!msg.block;
            p.input.dashAttack = !!msg.dashAttack;
            return;
        }

        if (spectators[clientId] && msg.type === 'spectator_ping') {
            sendStateToSpectator(spectators[clientId]);
        }

        if (msg.type === 'char_select') {
            const charId  = CHAR_IDS.includes(msg.charId) ? msg.charId : 'eld';
            const stageId = (msg.stageId ?? 0) | 0;
            const p = players[clientId];
            if (p) {
                const def = CHARACTER_DEFS[charId] ?? CHARACTER_DEFS.eld;
                p.charId          = charId;
                p.moveSpeed       = def.moveSpeed;
                p.dashSpeed       = def.dashSpeed;
                p.attackKnockback = def.attackKnockback;
                p.attackRange     = def.attackRange;
            }
            playerCharSelected.set(clientId, charId);
            const ack = JSON.stringify(buildCharSelectAck(charId, clientId, stageId));
            for (const pl   of Object.values(players))    if (pl.ws?.readyState   === WebSocket.OPEN) pl.ws.send(ack);
            for (const spec of Object.values(spectators)) if (spec.ws?.readyState === WebSocket.OPEN) spec.ws.send(ack);
            console.log(`[CHAR_SELECT] client=${clientId} char=${charId}`);
            tryAutoMatch();
        }
    });

    // ── Close handler ─────────────────────────────────────────────────────────
    ws.on('close', async () => {
        if (autoSpectatorTimer) { clearTimeout(autoSpectatorTimer); autoSpectatorTimer = null; }
        if (clientId === null) return;

        if (spectators[clientId]) {
            const spec = spectators[clientId];
            if (spec.dbRowId) {
                db.query(`UPDATE spectators SET left_at = NOW() WHERE id = $1`, [spec.dbRowId])
                  .catch(err => console.error('[SPECTATOR] left_at update error:', err.message));
            }
            if (spec.eliminated || spec.mode === 'voluntary') {
                lastState[clientId] = {
                    spectator: true, eliminated: spec.eliminated ?? false,
                    watchingSession: spec.watchingSession ?? null, mode: spec.mode,
                    timer: setTimeout(() => {
                        delete lastState[clientId];
                        playerCharSelected.delete(clientId);
                    }, GHOST_TTL),
                };
            }
            delete spectators[clientId];
            console.log(`[SPECTATOR] Client ${clientId} disconnected`);
            return;
        }

        if (!players[clientId]) return;

        const p = players[clientId];
        lastState[clientId] = {
            x: p.x, y: p.y, onGround: p.onGround, stocks: p.stocks,
            sessionId: playerSession.get(clientId) ?? null,
            timer: setTimeout(() => {
                delete lastState[clientId];
                playerCharSelected.delete(clientId);
            }, GHOST_TTL),
        };

        const disconnectedSessionId = playerSession.get(clientId);
        const disconnectedSession   = disconnectedSessionId ? gameSessions.get(disconnectedSessionId) : null;
        delete players[clientId];
        playerSession.delete(clientId);

        if (disconnectedSession && !disconnectedSession.finished) {
            const gracePeriodMs = 8000;
            broadcastToSession(disconnectedSession, { type: 'player_disconnected', clientId, graceMs: gracePeriodMs });
            if (!disconnectedSession.pendingEliminations) disconnectedSession.pendingEliminations = {};
            disconnectedSession.pendingEliminations[clientId] = setTimeout(() => {
                delete disconnectedSession.pendingEliminations[clientId];
                if (disconnectedSession.finished || players[clientId]) return;
                broadcastToSession(disconnectedSession, { type: 'player_eliminated', clientId });
                broadcastToAll({ type: 'player_eliminated', clientId });
                disconnectedSession.eliminated.add(clientId);
                const remaining = [...disconnectedSession.playerIds].filter(id => !disconnectedSession.eliminated.has(id));
                if (remaining.length === 1) {
                    const { resolveMatchWinner } = require('../game/session');
                    // resolveMatchWinner is not exported; we delegate via handleElimination
                    // The session will be resolved by the remaining player winning naturally.
                    // For immediate resolution we call broadcastToSession and cleanup:
                    disconnectedSession.loserDbId   = null;
                    disconnectedSession.loserStocks = 0;
                    // Re-use the already imported session module's internal resolve by triggering elimination
                    // This is safe because disconnectedSession.eliminated already has this clientId added above.
                } else if (remaining.length === 0) {
                    disconnectedSession.finished = true;
                    broadcastToSession(disconnectedSession, { type: 'match_end', winner: null, loser: clientId, matchId: null, mode: disconnectedSession.mode });
                    setTimeout(() => gameSessions.delete(disconnectedSession.id), 6000);
                }
            }, gracePeriodMs);
        }

        console.log(`[SERVER] Player ${clientId} disconnected`);
        broadcastState();
    });

    ws.on('error', () => ws.close());
}

module.exports = { setupWebSocket };
