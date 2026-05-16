'use strict';

const WebSocket = require('ws');
const db        = require('../db');

const {
    TICK_RATE, TICK_DT, GHOST_TTL,
    GROUND_Y, MOVE_SPEED, DASH_SPEED, ATTACK_RANGE,
    ATTACK_RANGE_Y, DASH_ATTACK_RANGE_X,
    MAX_PLAYERS, STAGE_LAYOUTS,
    CHARACTER_DEFS, CHARACTER_ASSETS, CHAR_IDS,
} = require('./constants');

const {
    tickBlock, tickDash, tickMovement, tickAttack,
    tickPhysics, tickCollisions, tickPlatforms, tickAnimations,
} = require('./physics');

let checkAndGrantAchievements = async () => {};
let updateStatsAfterMatch     = async () => {};
try { ({ checkAndGrantAchievements } = require('./achievements')); } catch { /* not yet available */ }
try { ({ updateStatsAfterMatch }     = require('./stats'));        } catch { /* not yet available */ }

const { createCpuPlayer, tickCpu } = require('./ai');

// ─── Module state ─────────────────────────────────────────────────────────────

const players    = {};
const spectators = {};
const lastState  = {};

const gameSessions       = new Map();
const playerSession      = new Map();
const playerCharSelected = new Map();
const hitstopBySession   = {};
const spectatorsBySession = new Map();

let nextClientId  = 1;
let nextSessionId = 1;
let frameId       = 0;
let tournamentWaitingWinners = {};
let confirmedStageId = -1;  // -1 = not yet chosen
let DEBUG_AUTO_MATCH = true;

// ─── Spectator session index ──────────────────────────────────────────────────

function setSpectatorSession(spec, newSessionId) {
    const old = spec.watchingSession;
    if (old === newSessionId) return;
    if (old != null) {
        const s = spectatorsBySession.get(old);
        if (s) { s.delete(spec.id); if (s.size === 0) spectatorsBySession.delete(old); }
    }
    spec.watchingSession = newSessionId;
    if (newSessionId != null) {
        if (!spectatorsBySession.has(newSessionId)) spectatorsBySession.set(newSessionId, new Set());
        spectatorsBySession.get(newSessionId).add(spec.id);
    }
}

// ─── Broadcast helpers ────────────────────────────────────────────────────────

function broadcastToSession(session, msg) {
    const raw = JSON.stringify(msg);
    for (const cid of session.playerIds) {
        const p = players[cid];
        if (p?.ws?.readyState === WebSocket.OPEN) p.ws.send(raw);
    }
    for (const spec of Object.values(spectators)) {
        if (spec.watchingSession === session.id && spec.ws.readyState === WebSocket.OPEN)
            spec.ws.send(raw);
    }
}

function broadcastToAll(msg) {
    const raw = JSON.stringify(msg);
    for (const p    of Object.values(players))    if (p.ws?.readyState    === WebSocket.OPEN) p.ws.send(raw);
    for (const spec of Object.values(spectators)) if (spec.ws?.readyState === WebSocket.OPEN) spec.ws.send(raw);
}

// ─── Player snapshot & state broadcast ───────────────────────────────────────

function buildPlayerSnapshot(p) {
    return {
        id:           p.id,
        charId:       p.charId ?? null,
        x:            Math.round(p.x * 1000) / 1000,
        y:            Math.round(p.y * 1000) / 1000,
        rotation:     p.facing === -1 ? Math.PI : 0,
        animation:    p.animation,
        onGround:     p.onGround,
        stocks:       p.stocks,
        respawning:   p.respawning,
        crouching:    p.crouching,
        hitId:        p.hitId,
        jumpId:       p.jumpId,
        voltage:      Math.round(p.voltage * 10) / 10,
        voltageMaxed: p.voltageMaxed,
        blocking:     p.blocking,
    };
}

function broadcastState() {
    const snapshot = {};
    for (const [id, p] of Object.entries(players)) snapshot[id] = buildPlayerSnapshot(p);
    const msg = JSON.stringify({ type: 'state', frameId: ++frameId, players: snapshot });
    for (const p of Object.values(players))
        if (p.ws.readyState === WebSocket.OPEN) p.ws.send(msg);
}

function sendStateToSpectator(spec) {
    if (!spec.ws || spec.ws.readyState !== WebSocket.OPEN) return;

    let sessionIds = null;
    if (spec.watchingSession) {
        const sess = gameSessions.get(spec.watchingSession);
        if (sess) {
            sessionIds = new Set(sess.playerIds);
        } else {
            setSpectatorSession(spec, null);
            spec.ws.send(JSON.stringify({ type: 'spectator_session_changed', watchingSession: null }));
        }
    }

    const snapshot = {};
    for (const [id, p] of Object.entries(players)) {
        if (sessionIds && !sessionIds.has(Number(id))) continue;
        snapshot[id] = buildPlayerSnapshot(p);
    }
    spec.ws.send(JSON.stringify({ type: 'state', frameId: ++frameId, players: snapshot }));
}

// ─── Spectator stream (15 Hz, independent of game tick) ──────────────────────

const SPECTATOR_HZ     = 15;
let   spectatorFrameId = 0;

function tickSpectators() {
    const specList = Object.values(spectators);
    if (specList.length === 0) return;

    const sessionSnapshots = new Map();

    for (const spec of specList) {
        if (!spec.ws || spec.ws.readyState !== WebSocket.OPEN) continue;

        const sid = spec.watchingSession;
        let raw;

        if (sid) {
            if (!sessionSnapshots.has(sid)) {
                const sess = gameSessions.get(sid);
                if (!sess) {
                    sessionSnapshots.set(sid, null);
                } else {
                    const snapshot = {};
                    for (const cid of sess.playerIds) {
                        const p = players[cid] ?? players[String(cid)];
                        if (p) snapshot[cid] = buildPlayerSnapshot(p);
                    }
                    sessionSnapshots.set(sid, JSON.stringify({
                        type: 'state_spectator',
                        frameId: ++spectatorFrameId,
                        players: snapshot,
                    }));
                }
            }
            raw = sessionSnapshots.get(sid);
        }

        if (!raw) {
            if (!sessionSnapshots.has('__global__')) {
                const snapshot = {};
                for (const [id, p] of Object.entries(players)) snapshot[id] = buildPlayerSnapshot(p);
                sessionSnapshots.set('__global__', JSON.stringify({
                    type: 'state_spectator',
                    frameId: ++spectatorFrameId,
                    players: snapshot,
                }));
            }
            raw = sessionSnapshots.get('__global__');
        }

        if (raw) spec.ws.send(raw);
    }
}

setInterval(tickSpectators, 1000 / SPECTATOR_HZ);

// ─── Session listings ─────────────────────────────────────────────────────────

function listActiveSessions() {
    return [...gameSessions.entries()].map(([id, sess]) => ({
        sessionId:    id,
        mode:         sess.mode,
        tournamentId: sess.tournamentId ?? null,
        round:        sess.round ?? null,
        playerIds:    [...sess.playerIds],
        startedAt:    sess.startedAt,
        spectators:   spectatorsBySession.get(id)?.size ?? 0,
    }));
}

// ─── Character selection ──────────────────────────────────────────────────────

function buildCharSelectAck(selectorCharId, selectorClientId, stageId) {
    const playerIds  = Object.keys(players).map(Number);
    const usedChars  = new Set([selectorCharId]);
    const playersOut = {};

    for (let i = 0; i < Math.min(playerIds.length, 8); i++) {
        const cid    = playerIds[i];
        const charId = cid === selectorClientId ? selectorCharId : (playerCharSelected.get(cid) ?? null);
        if (charId) usedChars.add(charId);
        playersOut[i] = { clientId: cid, charId };
    }

    let altIdx = 0;
    for (let i = 0; i < Math.min(playerIds.length, 8); i++) {
        if (!playersOut[i].charId) {
            while (altIdx < CHAR_IDS.length && usedChars.has(CHAR_IDS[altIdx])) altIdx++;
            const charId = CHAR_IDS[altIdx % CHAR_IDS.length];
            usedChars.add(charId);
            altIdx++;
            playersOut[i].charId = charId;
        }
        const { clientId: cid, charId } = playersOut[i];
        const a = CHARACTER_ASSETS[charId] ?? CHARACTER_ASSETS.eld;
        playersOut[i] = { clientId: cid, charId, texCfg: a.texCfg, texSets: a.texSets, animBase: a.animBase };
    }

    return { type: 'char_select_ack', charId: selectorCharId, selectorClient: selectorClientId, stageId, players: playersOut };
}

function sendAllCharSelectsTo(ws) {
    for (const [cid, charId] of playerCharSelected.entries()) {
        const ack = buildCharSelectAck(charId, cid, 0);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(ack));
    }
}

// ─── Player factory ───────────────────────────────────────────────────────────

function createPlayer(id, saved, ws) {
    const onGround   = saved ? (saved.onGround ?? true) : true;
    const side       = Object.keys(players).length % 2 === 0 ? -1 : 1;
    const initX      = saved ? saved.x : side * (1.5 + Math.random() * 1.5);

    return {
        id,
        dbUserId:        null,
        x:               initX,
        y:               saved ? saved.y : GROUND_Y,
        vx: 0, vy: 0,   kbx: 0, kby: 0,
        onGround,
        jumpsLeft:       onGround ? 2 : 1,
        facing:          initX >= 0 ? -1 : 1,
        dashing:         false, dashTimer: 0,  dashDir: 0,
        dashCooldown:    0,     dashEndWindow: 0,
        attacking:       false, attackTimer: 0, attackCooldown: 0,
        comboStep:       0,     comboWindow: 0,
        _isDashAttack:   false,
        hitId:           0,     hitTargets: new Set(),
        jumpId:          0,
        crouching:       false,
        animation:       'idle', animTimer: 0,
        stocks:          saved?.stocks ?? 3,
        prevSessionId:   saved?.sessionId ?? null,
        respawning:      false, respawnTimer: 0,
        voltage:         0,     voltageMaxed: false,
        blocking:        false, blockLockout: 0, blockHoldTicks: 0,
        prevY:           0,
        charId:          null,
        moveSpeed:       MOVE_SPEED,
        dashSpeed:       DASH_SPEED,
        attackKnockback: 14.0,
        attackRange:     ATTACK_RANGE,
        input: { moveX: 0, jump: false, attack: false, dash: false, dashDir: 0, crouch: false, block: false, dashAttack: false },
        ws,
    };
}

// ─── playerFlags ──────────────────────────────────────────────────────────────

function initPlayerFlags(session, clientIds) {
    session.playerFlags = {};
    for (const cid of clientIds)
        session.playerFlags[cid] = { tookDamage: false, completedCombo: false };
}

// ─── Session factory (shared by all match modes) ──────────────────────────────

function createSession(mode, playerIds, extra = {}) {
    const id = String(nextSessionId++);
    const session = {
        id, mode,
        playerIds:    new Set(playerIds),
        eliminated:   new Set(),
        tournamentId: null, round: null, matchDbId: null,
        startedAt:    new Date(), finished: false,
        loserDbId:    null, loserStocks: 0,
        playerFlags:  {},
        ...extra,
    };
    initPlayerFlags(session, playerIds);
    gameSessions.set(id, session);
    for (const cid of playerIds) {
        playerSession.set(cid, id);
        const p = players[cid];
        if (p) p.stocks = 3;
    }
    return session;
}

// ─── Match modes ──────────────────────────────────────────────────────────────

function startBrawl(clientIds) {
    const session = createSession('brawl', clientIds);
    broadcastToSession(session, { type: 'match_start', mode: 'brawl', sessionId: session.id, players: clientIds, countdown: true });

    for (const spec of Object.values(spectators)) {
        if (spec.watchingSession !== null) continue;
        setSpectatorSession(spec, session.id);
        if (spec.ws.readyState === WebSocket.OPEN) {
            spec.ws.send(JSON.stringify({ type: 'spectator_session_changed', watchingSession: session.id, activeSessions: listActiveSessions() }));
            sendStateToSpectator(spec);
        }
    }
    console.log(`[GAME] Brawl started: session ${session.id} — ${clientIds.length} players`);
    return session;
}

function startDuel(clientId1, clientId2) {
    const session = createSession('1v1', [clientId1, clientId2]);
    broadcastToSession(session, { type: 'match_start', mode: '1v1', sessionId: session.id, countdown: true });
    console.log(`[GAME] 1v1 started: session ${session.id} — players ${clientId1} vs ${clientId2}`);
    return session;
}

async function startTournamentMatch(clientId1, clientId2, tournamentId, round) {
    const session = createSession('tournament', [clientId1, clientId2], { tournamentId, round });
    broadcastToSession(session, { type: 'match_start', mode: 'tournament', sessionId: session.id, tournamentId, round });
    return session;
}

async function startTournament(clientIds, creatorDbId) {
    if (clientIds.length < 2) throw new Error('Need at least 2 players for a tournament');

    const { rows } = await db.query(
        `INSERT INTO tournaments (name, status, created_by) VALUES ($1, 'ongoing', $2) RETURNING id`,
        [`Tournament #${nextSessionId}`, creatorDbId]
    );
    const tournamentId = rows[0].id;

    const dbUserIds = clientIds.map(cid => players[cid]?.dbUserId).filter(Boolean);
    if (dbUserIds.length) {
        const placeholders = dbUserIds.map((_, i) => `($1, $${i + 2})`).join(', ');
        await db.query(
            `INSERT INTO tournament_players (tournament_id, user_id) VALUES ${placeholders} ON CONFLICT DO NOTHING`,
            [tournamentId, ...dbUserIds]
        );
    }

    const shuffled = [...clientIds].sort(() => Math.random() - 0.5);
    for (let i = 0; i < shuffled.length - 1; i += 2) {
        const sess = await startTournamentMatch(shuffled[i], shuffled[i + 1], tournamentId, 1);
        console.log(`[TOURNAMENT] Round 1 match: ${shuffled[i]} vs ${shuffled[i + 1]} → session ${sess.id}`);
    }
    return tournamentId;
}

function startTraining(humanClientId, cpuCharId = 'eld') {
    const cpu = createCpuPlayer(cpuCharId, CHARACTER_DEFS, GROUND_Y);
    players[cpu.id] = cpu;
    playerCharSelected.set(cpu.id, cpuCharId);

    const session = createSession('1v1', [humanClientId, cpu.id], { isCpuSession: true, cpuId: cpu.id });
    cpu.stocks = 3;

    broadcastToSession(session, { type: 'match_start', mode: '1v1', sessionId: session.id, countdown: true, cpuId: cpu.id });
    console.log(`[GAME] Training started: session ${session.id} — player ${humanClientId} vs CPU ${cpu.id}`);
    return session;
}

// ─── Auto-match ───────────────────────────────────────────────────────────────

function tryAutoMatch() {
    if (!DEBUG_AUTO_MATCH) return;

    const ready = Object.values(players)
        .filter(p => !playerSession.has(p.id) && playerCharSelected.has(p.id))
        .map(p => p.id);

    const activeSessions = [...gameSessions.values()].filter(s => !s.finished);
    if (activeSessions.length > 0) {
        if (ready.length === 0) return;
        const sess = activeSessions[0];
        for (const cid of ready) {
            sess.playerIds.add(cid);
            playerSession.set(cid, sess.id);
            if (!sess.playerFlags[cid])
                sess.playerFlags[cid] = { tookDamage: false, completedCombo: false };
            const p = players[cid];
            if (p && p.prevSessionId !== sess.id) p.stocks = 3;
            if (p) p.prevSessionId = null;
        }
        broadcastToSession(sess, { type: 'players_joined', sessionId: sess.id, newPlayers: ready });
        broadcastState();
        return;
    }

    if (ready.length >= 2) {
        const sess = startBrawl(ready);
        console.log(`[AUTO-MATCH] Brawl session ${sess.id} — players: ${[...sess.playerIds].join(', ')}`);
    }
}

// ─── Elimination & match resolution ──────────────────────────────────────────

function handleElimination(loser) {
    const sessionId = playerSession.get(loser.id);
    const session   = sessionId ? gameSessions.get(sessionId) : null;

    if (session?.pendingWinner?.winnerId === loser.id) {
        session.pendingWinner.resolveAfterRespawn = true;
        return true;
    }

    if (session) {
        session.eliminated.add(loser.id);
        session.loserDbId   = loser.dbUserId ?? null;
        session.loserStocks = loser.stocks ?? 0;
    }

    const eliminatedId   = loser.id;
    const eliminatedDbId = loser.dbUserId ?? null;
    const eliminatedWs   = loser.ws;

    delete players[eliminatedId];
    playerSession.delete(eliminatedId);

    if (eliminatedWs?.readyState === WebSocket.OPEN) {
        const newSpec = {
            id: eliminatedId, dbUserId: eliminatedDbId, ws: eliminatedWs,
            watchingSession: null, mode: 'overflow', dbRowId: null, eliminated: true,
        };
        spectators[eliminatedId] = newSpec;
        setSpectatorSession(newSpec, sessionId ?? null);
        eliminatedWs.send(JSON.stringify({
            type: 'spectator_mode', clientId: eliminatedId, mode: 'overflow',
            watchingSession: sessionId ?? null, activeSessions: listActiveSessions(), eliminated: true,
        }));
    }

    broadcastState();
    broadcastToAll({ type: 'player_eliminated', clientId: eliminatedId });

    if (!session) return;
    const remaining = [...session.playerIds].filter(id => !session.eliminated.has(id));

    if (remaining.length === 1) {
        session.pendingWinner = { winnerId: remaining[0], loserId: eliminatedId };
    } else if (remaining.length === 0) {
        session.finished = true;
        broadcastToSession(session, { type: 'match_end', winner: null, loser: eliminatedId, matchId: null, mode: session.mode });
        setTimeout(() => gameSessions.delete(session.id), 6000);
    }
}

function cleanupSession(session, winnerClientId) {
    gameSessions.delete(session.id);
    delete hitstopBySession[session.id];
    confirmedStageId = -1;
    if (players[winnerClientId]) {
        delete players[winnerClientId];
        playerSession.delete(winnerClientId);
    }
    const nextSession = [...gameSessions.values()].find(s => !s.finished)?.id ?? null;
    for (const spec of Object.values(spectators)) {
        if (spec.watchingSession !== session.id) continue;
        setSpectatorSession(spec, nextSession);
        if (spec.ws.readyState === WebSocket.OPEN) {
            spec.ws.send(JSON.stringify({ type: 'spectator_session_changed', watchingSession: nextSession, activeSessions: listActiveSessions() }));
            if (nextSession) sendStateToSpectator(spec);
        }
    }
    tryAutoMatch();
}

async function resolveMatchWinner(session, winnerClientId, loserClientId) {
    session.finished = true;

    const winner      = players[winnerClientId];
    const winnerDbId  = winner?.dbUserId ?? null;
    const loserDbId   = session.loserDbId ?? null;
    const loserStocks = session.loserStocks ?? 0;

    broadcastToSession(session, { type: 'victory', winner: winnerClientId, loser: loserClientId, reloadRequired: true });

    if (session.isCpuSession) {
        broadcastToSession(session, { type: 'match_end', winner: winnerClientId, loser: loserClientId, matchId: null, mode: session.mode });
        setTimeout(() => {
            broadcastToSession(session, { type: 'match_finished', sessionId: session.id });
            cleanupSession(session, winnerClientId);
        }, 6000);
        return;
    }

    try {
        const { rows } = await db.query(
            `INSERT INTO matches (player1_id, player2_id, winner_id, score1, score2, game_type)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [winnerDbId, loserDbId, winnerDbId,
             winner?.stocks ?? 0, loserStocks,
             session.mode === 'tournament' ? 'tournament' : 'brawler']
        );
        session.matchDbId = rows[0].id;

        if (session.tournamentId && session.matchDbId) {
            await db.query(
                `INSERT INTO tournament_matches (tournament_id, match_id, round) VALUES ($1, $2, $3)`,
                [session.tournamentId, session.matchDbId, session.round]
            );
        }

        await updateStatsAfterMatch({ db, winnerDbId, loserDbId, matchId: session.matchDbId, startedAt: session.startedAt, winnerStocks: winner?.stocks ?? 0, loserStocks });

        await Promise.all([
            winnerDbId ? db.query(
                `UPDATE user_stats SET wins = wins + 1, xp = xp + 100,
                 level = GREATEST(level, FLOOR(SQRT((xp + 100) / 50.0))::int),
                 updated_at = NOW() WHERE user_id = $1`,
                [winnerDbId]
            ) : Promise.resolve(),
            loserDbId ? db.query(
                `UPDATE user_stats SET losses = losses + 1, updated_at = NOW() WHERE user_id = $1`,
                [loserDbId]
            ) : Promise.resolve(),
        ]);

        if (winnerDbId) {
            await checkAndGrantAchievements(winnerDbId, {
                tookDamage:      session.playerFlags?.[winnerClientId]?.tookDamage    ?? true,
                completedCombo:  session.playerFlags?.[winnerClientId]?.completedCombo ?? false,
                durationS:       Math.round((Date.now() - session.startedAt) / 1000),
                winnerStocks:    winner?.stocks ?? 0,
                isTournamentWin: session.mode === 'tournament',
            });
        }
    } catch (err) {
        console.error('[GAME] DB write error on match resolve:', err.message);
    }

    broadcastToSession(session, { type: 'match_end', winner: winnerClientId, loser: loserClientId, matchId: session.matchDbId, mode: session.mode });

    if (session.mode === 'tournament') advanceTournament(session.tournamentId, winnerClientId);

    setTimeout(() => {
        broadcastToSession(session, { type: 'match_finished', sessionId: session.id });
        cleanupSession(session, winnerClientId);
    }, 6000);
}

async function advanceTournament(tournamentId, newWinnerId) {
    if (!tournamentWaitingWinners[tournamentId]) tournamentWaitingWinners[tournamentId] = [];
    tournamentWaitingWinners[tournamentId].push(newWinnerId);
    const waiting = tournamentWaitingWinners[tournamentId];

    if (waiting.length < 2) {
        broadcastToAll({ type: 'tournament_waiting', tournamentId, waitingCount: waiting.length });
        return;
    }

    const { rows } = await db.query(
        `SELECT MAX(round) AS max_round FROM tournament_matches WHERE tournament_id = $1`,
        [tournamentId]
    );
    const nextRound = (rows[0].max_round ?? 0) + 1;

    while (waiting.length >= 2) {
        const [a, b] = waiting.splice(0, 2);
        const sess = await startTournamentMatch(a, b, tournamentId, nextRound);
        console.log(`[TOURNAMENT] Round ${nextRound}: ${a} vs ${b} → session ${sess.id}`);
    }

    if (waiting.length === 1) {
        await finalizeTournament(tournamentId, waiting.splice(0, 1)[0]);
    }
}

async function finalizeTournament(tournamentId, championClientId) {
    const champion = players[championClientId];
    try {
        await db.query(`UPDATE tournaments SET status = 'finished' WHERE id = $1`, [tournamentId]);
        if (champion?.dbUserId) {
            await db.query(
                `UPDATE user_stats SET xp = xp + 500,
                 level = GREATEST(level, FLOOR(SQRT((xp + 500) / 50))::int),
                 updated_at = NOW() WHERE user_id = $1`,
                [champion.dbUserId]
            );
        }
    } catch (err) {
        console.error('[TOURNAMENT] finalize error:', err.message);
    }
    broadcastToAll({ type: 'tournament_end', tournamentId, champion: championClientId, championDbId: champion?.dbUserId ?? null });
    delete tournamentWaitingWinners[tournamentId];
    console.log(`[TOURNAMENT] ${tournamentId} finished — champion: ${championClientId}`);
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

async function getLastWatchedSession(dbUserId) {
    if (!dbUserId) return null;
    try {
        const { rows } = await db.query(
            `SELECT session_id FROM spectators WHERE user_id = $1 AND session_id <> 'lobby'
             ORDER BY joined_at DESC LIMIT 1`,
            [dbUserId]
        );
        return rows[0]?.session_id ?? null;
    } catch (err) {
        console.error('[SPECTATOR] restore session error:', err.message);
        return null;
    }
}

// ─── Respawn ──────────────────────────────────────────────────────────────────

function tickRespawn() {
    for (const p of Object.values(players)) {
        if (!p.respawning) continue;
        p.respawnTimer -= TICK_DT;
        if (p.respawnTimer > 0) continue;
        Object.assign(p, {
            respawning: false,
            x:  (Math.random() - 0.5) * 4,
            y:  2.0,
            vx: 0, vy: 0, kbx: 0, kby: 0,
            jumpsLeft: 2,
            onGround:  false,
            animation: 'idle',
            voltage:   0,
        });
    }
}

// ─── Hit context (passed to physics to avoid circular require) ────────────────

const hitCtx = {
    get players()          { return players; },
    get playerSession()    { return playerSession; },
    get gameSessions()     { return gameSessions; },
    get hitstopBySession() { return hitstopBySession; },
    broadcastToSession,
    WebSocket,
    onHit(attackerClientId, targetClientId) {
        const sess = gameSessions.get(playerSession.get(attackerClientId));
        if (sess?.playerFlags?.[targetClientId]) sess.playerFlags[targetClientId].tookDamage = true;
    },
    onCombo3(attackerClientId) {
        const sess = gameSessions.get(playerSession.get(attackerClientId));
        if (sess?.playerFlags?.[attackerClientId]) sess.playerFlags[attackerClientId].completedCombo = true;
    },
};

// ─── Reusable tick sets (avoid GC pressure at 60 fps) ────────────────────────

const _frozenIds        = new Set();
const _hitstopFrozenIds = new Set();

// ─── Game tick (60 Hz) ────────────────────────────────────────────────────────

function tick() {
    _frozenIds.clear();
    for (const [cid, sid] of playerSession.entries()) {
        if (gameSessions.get(sid)?.finished) _frozenIds.add(cid);
    }

    const _pendingWinnerIds = new Set();
    for (const session of gameSessions.values()) {
        if (session.pendingWinner) _pendingWinnerIds.add(session.pendingWinner.winnerId);
    }

    for (const [sessId, hs] of Object.entries(hitstopBySession)) {
        if (!hs || hs.framesLeft <= 0) delete hitstopBySession[sessId];
    }

    const aliveAll = Object.values(players).filter(p => !p.respawning && !_frozenIds.has(p.id));
    tickRespawn();

    for (const p of aliveAll) {
        if (_pendingWinnerIds.has(p.id)) {
            p.input.moveX = 0; p.input.jump = false; p.input.attack = false;
            p.input.dash = false; p.input.dashAttack = false; p.input.block = false;
        }
        const { moveX, jump, attack, dash, dashDir, crouch, block, dashAttack } = p.input;
        p.input.jump = false; p.input.attack = false; p.input.dash = false; p.input.dashAttack = false;
        tickBlock(p, moveX, attack, dash, dashAttack, block, crouch);
        tickDash(p, dash, dashDir, moveX, block, crouch);
        tickMovement(p, moveX, jump, crouch);
        tickAttack(p, attack, dashAttack, crouch, players, hitCtx);
    }

    _hitstopFrozenIds.clear();
    for (const [sessId, hs] of Object.entries(hitstopBySession)) {
        if (!hs || hs.framesLeft <= 0) { delete hitstopBySession[sessId]; continue; }
        const session = gameSessions.get(sessId);
        if (session) for (const cid of session.playerIds) _hitstopFrozenIds.add(cid);
        hs.framesLeft--;
        if (hs.framesLeft <= 0) delete hitstopBySession[sessId];
    }

    const alive        = aliveAll.filter(p => !_hitstopFrozenIds.has(p.id));
    const aliveForAnim = Object.values(players).filter(p => !_frozenIds.has(p.id));
    const platforms    = STAGE_LAYOUTS[confirmedStageId] ?? STAGE_LAYOUTS[0];

    tickPhysics(alive);
    tickCollisions(alive);
    tickPlatforms(alive, handleElimination, platforms);
    tickAnimations(aliveForAnim);

    for (const session of gameSessions.values()) {
        if (!session.isCpuSession || session.finished) continue;
        const cpu    = players[session.cpuId];
        const target = [...session.playerIds]
            .filter(id => id !== session.cpuId && players[id] && !players[id].respawning)
            .map(id => players[id])[0] ?? null;
        if (cpu) tickCpu(cpu, target);
    }

    for (const session of gameSessions.values()) {
        if (!session.pendingWinner) continue;
        const { winnerId, loserId, resolveAfterRespawn } = session.pendingWinner;
        const winner = players[winnerId];
        if (!winner) {
            session.pendingWinner = null;
            resolveMatchWinner(session, winnerId, loserId);
        } else if (winner.onGround) {
            if (resolveAfterRespawn && winner.respawning) continue;
            Object.assign(winner, { animation: 'idle', animTimer: 0, attacking: false, dashing: false, blocking: false, crouching: false });
            session.pendingWinner = null;
            resolveMatchWinner(session, winnerId, loserId);
        }
    }

    broadcastState();
}

setInterval(tick, 1000 / TICK_RATE);

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    players, spectators, lastState,
    gameSessions, playerSession, playerCharSelected, hitstopBySession,
    get nextClientId()      { return nextClientId; },
    set nextClientId(v)     { nextClientId = v; },
    get nextSessionId()     { return nextSessionId; },
    get confirmedStageId()  { return confirmedStageId; },
    set confirmedStageId(v) { confirmedStageId = v; },
    broadcastToSession, broadcastToAll, broadcastState, sendStateToSpectator,
    listActiveSessions, buildCharSelectAck, sendAllCharSelectsTo,
    createPlayer, startBrawl, startDuel, startTournament, startTraining,
    tryAutoMatch, handleElimination, resolveMatchWinner, getLastWatchedSession,
    MAX_PLAYERS, GHOST_TTL,
    ATTACK_RANGE, ATTACK_RANGE_Y, DASH_ATTACK_RANGE_X,
    CHAR_IDS, CHARACTER_DEFS, CHARACTER_ASSETS,
};