'use strict';

const WebSocket = require('ws');
const db        = require('../db');

const {
    TICK_RATE, TICK_DT, GHOST_TTL,
    GROUND_Y, MOVE_SPEED, DASH_SPEED, ATTACK_RANGE,
    ATTACK_RANGE_Y, DASH_ATTACK_RANGE_X,
    MAX_PLAYERS,
    CHARACTER_DEFS, CHARACTER_ASSETS, CHAR_IDS,
} = require('./constants');

const {
    tickBlock, tickDash, tickMovement, tickAttack,
    tickPhysics, tickCollisions, tickPlatforms, tickAnimations,
} = require('./physics');

// Stub until aprenafe delivers achievements.js.
// Once achievements.js exists, this no-op is replaced automatically.
let checkAndGrantAchievements = async () => {};
let updateStatsAfterMatch     = async () => {};
try {
    ({ checkAndGrantAchievements } = require('./achievements'));
} catch { /* achievements.js not yet available */ }
try {
    ({ updateStatsAfterMatch } = require('./stats'));
} catch { /* stats.js not yet available */ }

// ─── Shared mutable state (owned by this module) ──────────────────────────────

const players    = {};
const spectators = {};
const lastState  = {};

const gameSessions       = new Map();
const playerSession      = new Map();
const playerCharSelected = new Map();
const hitstopBySession   = {};

let nextClientId  = 1;
let nextSessionId = 1;
let frameId       = 0;

let tournamentWaitingWinners = {};

// Stage elegido por el host; se envía a todos los jugadores que se unan después.
// -1 = ninguno elegido todavía.
let confirmedStageId = -1;

let DEBUG_AUTO_MATCH = true;

// ─── Broadcast helpers ────────────────────────────────────────────────────────

function broadcastToSession(session, msg) {
    const raw = JSON.stringify(msg);
    for (const cid of session.playerIds) {
        const p = players[cid];
        if (p?.ws?.readyState === WebSocket.OPEN) p.ws.send(raw);
    }
    for (const spec of Object.values(spectators)) {
        if (spec.watchingSession === session.id && spec.ws.readyState === WebSocket.OPEN) {
            spec.ws.send(raw);
        }
    }
}

function broadcastToAll(msg) {
    const raw = JSON.stringify(msg);
    for (const p    of Object.values(players))    if (p.ws?.readyState    === WebSocket.OPEN) p.ws.send(raw);
    for (const spec of Object.values(spectators)) if (spec.ws?.readyState === WebSocket.OPEN) spec.ws.send(raw);
}

// ─── Spectator state broadcast ────────────────────────────────────────────────

function sendStateToSpectator(spec) {
    if (!spec.ws || spec.ws.readyState !== WebSocket.OPEN) return;

    const snapshot = {};
    let sessionIds = null;

    if (spec.watchingSession) {
        const sess = gameSessions.get(spec.watchingSession);
        if (sess) {
            sessionIds = new Set(sess.playerIds);
        } else {
            spec.watchingSession = null;
            spec.ws.send(JSON.stringify({ type: 'spectator_session_changed', watchingSession: null }));
        }
    }

    for (const [id, p] of Object.entries(players)) {
        if (sessionIds && !sessionIds.has(Number(id))) continue;
        snapshot[id] = buildPlayerSnapshot(p);
    }

    spec.ws.send(JSON.stringify({ type: 'state', frameId: ++frameId, players: snapshot }));
}

function broadcastStateToSpectators() {
    for (const spec of Object.values(spectators)) sendStateToSpectator(spec);
}

function buildPlayerSnapshot(p) {
    return {
        id:           p.id,
        charId:       p.charId ?? null,
        x:            +p.x.toFixed(3),
        y:            +p.y.toFixed(3),
        rotation:     p.facing === -1 ? Math.PI : 0,
        animation:    p.animation,
        onGround:     p.onGround,
        stocks:       p.stocks,
        respawning:   p.respawning,
        crouching:    p.crouching,
        hitId:        p.hitId,
        jumpId:       p.jumpId,
        voltage:      +p.voltage.toFixed(1),
        voltageMaxed: p.voltageMaxed,
        blocking:     p.blocking,
    };
}

function broadcastState() {
    const snapshot = {};
    for (const [id, p] of Object.entries(players)) snapshot[id] = buildPlayerSnapshot(p);

    const msg = JSON.stringify({ type: 'state', frameId: ++frameId, players: snapshot });
    for (const p of Object.values(players)) if (p.ws.readyState === WebSocket.OPEN) p.ws.send(msg);
    broadcastStateToSpectators();
}

// ─── Session listings ─────────────────────────────────────────────────────────

function listActiveSessions() {
    const result = [];
    for (const [id, sess] of gameSessions.entries()) {
        const spectatorCount = Object.values(spectators).filter(s => s.watchingSession === id).length;
        result.push({
            sessionId:    id,
            mode:         sess.mode,
            tournamentId: sess.tournamentId ?? null,
            round:        sess.round ?? null,
            playerIds:    [...sess.playerIds],
            startedAt:    sess.startedAt,
            spectators:   spectatorCount,
        });
    }
    return result;
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
        const cid    = playersOut[i].clientId;
        const charId = playersOut[i].charId;
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
    const onGround    = saved ? (saved.onGround ?? true) : true;
    const playerCount = Object.keys(players).length;
    const side        = playerCount % 2 === 0 ? -1 : 1;
    const spawnX      = side * (1.5 + Math.random() * 1.5);
    const initX       = saved ? saved.x : spawnX;
    const initFacing  = initX >= 0 ? -1 : 1;

    return {
        id,
        dbUserId: null,
        x:  initX,
        y:  saved ? saved.y : GROUND_Y,
        vx: 0, vy: 0,
        kbx: 0, kby: 0,
        onGround,
        jumpsLeft:      onGround ? 2 : 1,
        facing:         initFacing,
        dashing:        false,
        dashTimer:      0,
        dashDir:        0,
        dashCooldown:   0,
        dashEndWindow:  0,
        attacking:      false,
        attackTimer:    0,
        attackCooldown: 0,
        comboStep:      0,
        comboWindow:    0,
        _isDashAttack:  false,
        hitId:          0,
        hitTargets:     new Set(),
        jumpId:         0,
        crouching:      false,
        animation:      'idle',
        animTimer:      0,
        stocks:         saved?.stocks ?? 3,
        prevSessionId:  saved?.sessionId ?? null,
        respawning:     false,
        respawnTimer:   0,
        voltage:        0,
        voltageMaxed:   false,
        blocking:       false,
        blockLockout:   0,
        blockHoldTicks: 0,
        prevY:          0,
        input: {
            moveX: 0, jump: false, attack: false,
            dash: false, dashDir: 0, crouch: false,
            block: false, dashAttack: false,
        },
        ws,
        charId:          null,
        moveSpeed:       MOVE_SPEED,
        dashSpeed:       DASH_SPEED,
        attackKnockback: 14.0,
        attackRange:     ATTACK_RANGE,
    };
}

// ─── playerFlags helpers ──────────────────────────────────────────────────────
// playerFlags tracks per-player in-match events used by achievements.js.
// Each entry: { tookDamage: bool, completedCombo: bool }

function initPlayerFlags(session, clientIds) {
    session.playerFlags = {};
    for (const cid of clientIds) {
        session.playerFlags[cid] = { tookDamage: false, completedCombo: false };
    }
}

// ─── Match modes ──────────────────────────────────────────────────────────────

function startBrawl(clientIds) {
    const id = String(nextSessionId++);
    const session = {
        id, mode: 'brawl',
        playerIds: new Set(clientIds),
        eliminated: new Set(),
        tournamentId: null, round: null, matchDbId: null,
        startedAt: new Date(), finished: false,
        loserDbId: null, loserStocks: 0,
        playerFlags: {},
    };
    initPlayerFlags(session, clientIds);
    gameSessions.set(id, session);
    for (const cid of clientIds) {
        playerSession.set(cid, id);
        const p = players[cid];
        if (p) p.stocks = 3;
    }
    broadcastToSession(session, { type: 'match_start', mode: 'brawl', sessionId: id, players: clientIds, countdown: true });

    for (const spec of Object.values(spectators)) {
        if (spec.watchingSession !== null) continue;
        spec.watchingSession = id;
        if (spec.ws.readyState === WebSocket.OPEN) {
            spec.ws.send(JSON.stringify({ type: 'spectator_session_changed', watchingSession: id, activeSessions: listActiveSessions() }));
            sendStateToSpectator(spec);
        }
    }
    console.log(`[GAME] Brawl iniciado: sesión ${id} — ${clientIds.length} jugadores`);
    return session;
}

function startDuel(clientId1, clientId2) {
    const id = String(nextSessionId++);
    const session = {
        id, mode: '1v1',
        playerIds: new Set([clientId1, clientId2]),
        eliminated: new Set(),
        tournamentId: null, round: null, matchDbId: null,
        startedAt: new Date(), finished: false,
        loserDbId: null, loserStocks: 0,
        playerFlags: {},
    };
    initPlayerFlags(session, [clientId1, clientId2]);
    gameSessions.set(id, session);
    playerSession.set(clientId1, id);
    playerSession.set(clientId2, id);
    for (const cid of [clientId1, clientId2]) { const p = players[cid]; if (p) p.stocks = 3; }
    broadcastToSession(session, { type: 'match_start', mode: '1v1', sessionId: id, countdown: true });
    console.log(`[GAME] 1v1 started: session ${id} — players ${clientId1} vs ${clientId2}`);
    return session;
}

async function startTournamentMatch(clientId1, clientId2, tournamentId, round) {
    const id = String(nextSessionId++);
    const session = {
        id, mode: 'tournament',
        playerIds: new Set([clientId1, clientId2]),
        eliminated: new Set(),
        tournamentId, round, matchDbId: null,
        startedAt: new Date(), finished: false,
        loserDbId: null, loserStocks: 0,
        playerFlags: {},
    };
    initPlayerFlags(session, [clientId1, clientId2]);
    gameSessions.set(id, session);
    playerSession.set(clientId1, id);
    playerSession.set(clientId2, id);
    for (const cid of [clientId1, clientId2]) { const p = players[cid]; if (p) p.stocks = 3; }
    broadcastToSession(session, { type: 'match_start', mode: 'tournament', sessionId: id, tournamentId, round });
    return session;
}

async function startTournament(clientIds, creatorDbId) {
    if (clientIds.length < 2) throw new Error('Need at least 2 players for a tournament');

    const { rows } = await db.query(
        `INSERT INTO tournaments (name, status, created_by)
         VALUES ($1, 'ongoing', $2) RETURNING id`,
        [`Tournament #${nextSessionId}`, creatorDbId]
    );
    const tournamentId = rows[0].id;

    for (const cid of clientIds) {
        const p = players[cid];
        if (p?.dbUserId) {
            await db.query(
                `INSERT INTO tournament_players (tournament_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                [tournamentId, p.dbUserId]
            );
        }
    }

    const shuffled = [...clientIds].sort(() => Math.random() - 0.5);
    for (let i = 0; i < shuffled.length - 1; i += 2) {
        const sess = await startTournamentMatch(shuffled[i], shuffled[i + 1], tournamentId, 1);
        console.log(`[TOURNAMENT] Round 1 match: ${shuffled[i]} vs ${shuffled[i + 1]} → session ${sess.id}`);
    }
    return tournamentId;
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
            // Init playerFlags for the new late-joiner
            if (sess.playerFlags && !sess.playerFlags[cid]) {
                sess.playerFlags[cid] = { tookDamage: false, completedCombo: false };
            }
            const p = players[cid];
            if (p && p.prevSessionId !== sess.id) p.stocks = 3;
            if (p) p.prevSessionId = null;
        }
        broadcastToSession(sess, { type: 'players_joined', sessionId: sess.id, newPlayers: ready });
        broadcastState();
        return;
    }

    if (ready.length < 2) return;
    const sess = startBrawl(ready);
    console.log(`[AUTO-MATCH] Sesión brawl ${sess.id} con jugadores: ${[...sess.playerIds].join(', ')}`);
}

// ─── Elimination & match resolution ──────────────────────────────────────────

function handleElimination(loser) {
    const sessionId = playerSession.get(loser.id);
    const session   = sessionId ? gameSessions.get(sessionId) : null;

    if (session) {
        session.eliminated.add(loser.id);
        session.loserDbId   = loser.dbUserId ?? null;
        session.loserStocks = loser.stocks ?? 0;
    }

    const eliminatedWs   = loser.ws;
    const eliminatedId   = loser.id;
    const eliminatedDbId = loser.dbUserId ?? null;

    delete players[eliminatedId];
    playerSession.delete(eliminatedId);

    if (eliminatedWs && eliminatedWs.readyState === WebSocket.OPEN) {
        spectators[eliminatedId] = {
            id: eliminatedId, dbUserId: eliminatedDbId, ws: eliminatedWs,
            watchingSession: sessionId ?? null, mode: 'overflow', dbRowId: null, eliminated: true,
        };
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
        resolveMatchWinner(session, remaining[0], eliminatedId);
    } else if (remaining.length === 0) {
        session.finished = true;
        broadcastToSession(session, { type: 'match_end', winner: null, loser: eliminatedId, matchId: null, mode: session.mode });
        setTimeout(() => gameSessions.delete(session.id), 6000);
    }
}

async function resolveMatchWinner(session, winnerClientId, loserClientId) {
    session.finished = true;

    const winner      = players[winnerClientId];
    const winnerDbId  = winner?.dbUserId ?? null;
    const loserDbId   = session.loserDbId ?? null;
    const loserStocks = session.loserStocks ?? 0;

    broadcastToSession(session, { type: 'victory', winner: winnerClientId, loser: loserClientId, reloadRequired: true });

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

        // updateStatsAfterMatch handles win_streak, best_streak, and duration_s (aprenafe — stats.js)
        await updateStatsAfterMatch({
            db,
            winnerDbId,
            loserDbId,
            matchId:      session.matchDbId,
            startedAt:    session.startedAt,
            winnerStocks: winner?.stocks ?? 0,
            loserStocks,
        });

        if (winnerDbId) {
            await db.query(
                `UPDATE user_stats SET wins = wins + 1, xp = xp + 100,
                 level = GREATEST(level, FLOOR(SQRT((xp + 100) / 50.0))::int),
                 updated_at = NOW() WHERE user_id = $1`,
                [winnerDbId]
            );
            // checkAndGrantAchievements is owned by aprenafe (achievements.js)
            await checkAndGrantAchievements(winnerDbId, {
                tookDamage:      session.playerFlags?.[winnerClientId]?.tookDamage  ?? true,
                completedCombo:  session.playerFlags?.[winnerClientId]?.completedCombo ?? false,
                durationS:       Math.round((Date.now() - session.startedAt) / 1000),
                winnerStocks:    winner?.stocks ?? 0,
                isTournamentWin: session.mode === 'tournament',
            });
        }
        if (loserDbId) {
            await db.query(
                `UPDATE user_stats SET losses = losses + 1, updated_at = NOW() WHERE user_id = $1`,
                [loserDbId]
            );
        }

    } catch (err) {
        console.error('[GAME] DB write error on match resolve:', err.message);
    }

    broadcastToSession(session, { type: 'match_end', winner: winnerClientId, loser: loserClientId, matchId: session.matchDbId, mode: session.mode });

    if (session.mode === 'tournament') advanceTournament(session.tournamentId, winnerClientId);

    setTimeout(() => {
        broadcastToSession(session, { type: 'match_finished', sessionId: session.id });
        for (const spec of Object.values(spectators)) {
            if (spec.watchingSession === session.id && spec.ws.readyState === WebSocket.OPEN) {
                spec.ws.send(JSON.stringify({ type: 'match_finished', sessionId: session.id }));
            }
        }
        gameSessions.delete(session.id);
        delete hitstopBySession[session.id];
        // Resetear el stage confirmado para que el siguiente lobby empiece desde el SSS.
        confirmedStageId = -1;
        if (players[winnerClientId]) {
            delete players[winnerClientId];
            playerSession.delete(winnerClientId);
        }
        const nextSession = [...gameSessions.values()].find(s => !s.finished)?.id ?? null;
        for (const spec of Object.values(spectators)) {
            if (spec.watchingSession !== session.id) continue;
            spec.watchingSession = nextSession;
            if (spec.ws.readyState === WebSocket.OPEN) {
                spec.ws.send(JSON.stringify({ type: 'spectator_session_changed', watchingSession: nextSession, activeSessions: listActiveSessions() }));
                if (nextSession) sendStateToSpectator(spec);
            }
        }
        tryAutoMatch();
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

    const { rows: roundRows } = await db.query(
        `SELECT MAX(round) AS max_round FROM tournament_matches WHERE tournament_id = $1`,
        [tournamentId]
    );
    const nextRound = (roundRows[0].max_round ?? 0) + 1;

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
    broadcastToAll({
        type: 'tournament_end', tournamentId,
        champion: championClientId, championDbId: champion?.dbUserId ?? null,
    });
    delete tournamentWaitingWinners[tournamentId];
    console.log(`[TOURNAMENT] ${tournamentId} finished — champion: ${championClientId}`);
}

// ─── DB helpers for spectator ─────────────────────────────────────────────────

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

// ─── Game tick ────────────────────────────────────────────────────────────────

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

// hitCtx is passed to physics.js functions so they can broadcast hitstop
// and notify session.js of hit/combo events (for playerFlags).
const hitCtx = {
    get players()          { return players; },
    get playerSession()    { return playerSession; },
    get gameSessions()     { return gameSessions; },
    get hitstopBySession() { return hitstopBySession; },
    broadcastToSession,
    WebSocket,

    // Called by applyHit when a hit connects (not a block).
    // Sets playerFlags[targetId].tookDamage = true on the session.
    onHit(attackerClientId, targetClientId) {
        const sessId = playerSession.get(attackerClientId);
        if (!sessId) return;
        const sess = gameSessions.get(sessId);
        if (sess?.playerFlags?.[targetClientId]) {
            sess.playerFlags[targetClientId].tookDamage = true;
        }
    },

    // Called by tickAttack when attack_combo_3 finishes landing.
    // Sets playerFlags[attackerClientId].completedCombo = true on the session.
    onCombo3(attackerClientId) {
        const sessId = playerSession.get(attackerClientId);
        if (!sessId) return;
        const sess = gameSessions.get(sessId);
        if (sess?.playerFlags?.[attackerClientId]) {
            sess.playerFlags[attackerClientId].completedCombo = true;
        }
    },
};

function tick() {
    const frozenIds = new Set();
    for (const [cid, sid] of playerSession.entries()) {
        if (gameSessions.get(sid)?.finished) frozenIds.add(cid);
    }

    for (const [sessId, hs] of Object.entries(hitstopBySession)) {
        if (!hs || hs.framesLeft <= 0) delete hitstopBySession[sessId];
    }

    const aliveAll = Object.values(players).filter(p => !p.respawning && !frozenIds.has(p.id));
    tickRespawn();

    for (const p of aliveAll) {
        const { moveX, jump, attack, dash, dashDir, crouch, block, dashAttack } = p.input;
        p.input.jump = false; p.input.attack = false; p.input.dash = false; p.input.dashAttack = false;
        tickBlock(p, moveX, attack, dash, dashAttack, block, crouch);
        tickDash(p, dash, dashDir, moveX, block, crouch);
        tickMovement(p, moveX, jump, crouch);
        tickAttack(p, attack, dashAttack, crouch, players, hitCtx);
    }

    const hitstopFrozenIds = new Set();
    for (const [sessId, hs] of Object.entries(hitstopBySession)) {
        if (!hs || hs.framesLeft <= 0) { delete hitstopBySession[sessId]; continue; }
        const session = gameSessions.get(sessId);
        if (session) for (const cid of session.playerIds) hitstopFrozenIds.add(cid);
        hs.framesLeft--;
        if (hs.framesLeft <= 0) delete hitstopBySession[sessId];
    }

    const alive        = aliveAll.filter(p => !hitstopFrozenIds.has(p.id));
    const aliveForAnim = Object.values(players).filter(p => !frozenIds.has(p.id));
    tickPhysics(alive);
    tickCollisions(alive);
    tickPlatforms(alive, handleElimination);
    tickAnimations(aliveForAnim);
    broadcastState();
}

setInterval(tick, 1000 / TICK_RATE);

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    // State (read-only references for ws/handler.js)
    players,
    spectators,
    lastState,
    gameSessions,
    playerSession,
    playerCharSelected,
    hitstopBySession,
    get nextClientId()  { return nextClientId; },
    set nextClientId(v) { nextClientId = v; },
    get nextSessionId() { return nextSessionId; },
    get confirmedStageId()  { return confirmedStageId; },
    set confirmedStageId(v) { confirmedStageId = v; },

    // Functions
    broadcastToSession,
    broadcastToAll,
    broadcastState,
    sendStateToSpectator,
    listActiveSessions,
    buildCharSelectAck,
    sendAllCharSelectsTo,
    createPlayer,
    startBrawl,
    startDuel,
    startTournament,
    tryAutoMatch,
    handleElimination,
    resolveMatchWinner,
    getLastWatchedSession,

    MAX_PLAYERS,
    GHOST_TTL,
    ATTACK_RANGE, ATTACK_RANGE_Y, DASH_ATTACK_RANGE_X,
    CHAR_IDS, CHARACTER_DEFS, CHARACTER_ASSETS,
};