'use strict';

const http      = require('http');
const WebSocket = require('ws');
const express   = require('express');
const bcrypt    = require('bcrypt');
const crypto    = require('crypto');
const { Pool }  = require('pg');

// ─────────────────────────────────────────────────────────────────────────────
//  DATABASE
// ─────────────────────────────────────────────────────────────────────────────
const db = new Pool({
    host:     process.env.PGHOST      || 'db',
    port:     process.env.PGPORT      || 5432,
    database: process.env.PGDATABASE  || 'transcendence',
    user:     process.env.PGUSER      || 'postgres',
    password: process.env.PGPASSWORD  || 'postgres',
});

// ─────────────────────────────────────────────────────────────────────────────
//  SERVER BOOTSTRAP
// ─────────────────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ noServer: true });

app.use(express.json());

// ─────────────────────────────────────────────────────────────────────────────
//  AUTH HELPERS
// ─────────────────────────────────────────────────────────────────────────────
const BCRYPT_ROUNDS  = 10;
const SESSION_DAYS    = 7;
const SESSION_COOKIE  = 'sid';

/** Generates a secure session token (64-byte hex = 128 characters). */
function generateToken() {
    return crypto.randomBytes(64).toString('hex');
}

/** Parses the sid cookie from the Cookie header. */
function parseSidCookie(req) {
    const header = req.headers.cookie || '';
    for (const part of header.split(';')) {
        const [k, v] = part.trim().split('=');
        if (k === SESSION_COOKIE) return v;
    }
    return null;
}

/**
 * Middleware: attaches req.user if the session cookie is valid.
 * Does not reject; protected routes call requireAuth().
 */
async function loadSession(req, res, next) {
    try {
        const token = parseSidCookie(req);
        if (!token) return next();

        const { rows } = await db.query(
            `SELECT s.user_id, u.username, u.email, u.avatar_url, u.role
             FROM sessions s
             JOIN users u ON u.id = s.user_id
             WHERE s.token = $1 AND s.expires_at > NOW()`,
            [token]
        );
        if (rows.length) req.user = rows[0];
    } catch (err) {
        console.error('[AUTH] loadSession error:', err.message);
    }
    next();
}

/** Middleware: rejects with 401 if there is no valid session. */
function requireAuth(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    next();
}

app.use(loadSession);

// ─────────────────────────────────────────────────────────────────────────────
//  AUTH ROUTES
// ─────────────────────────────────────────────────────────────────────────────

/** POST /api/register – Register a new user. */
app.post('/api/register', async (req, res) => {
    const { username, email, password } = req.body ?? {};

    if (!username || !email || !password)
        return res.status(400).json({ error: 'username, email and password are required' });

    if (password.length < 8)
        return res.status(400).json({ error: 'Password must be at least 8 characters' });

    try {
        const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

        const { rows } = await db.query(
            `INSERT INTO users (username, email, password_hash)
             VALUES ($1, $2, $3)
             RETURNING id, username, email, avatar_url, role`,
            [username.trim(), email.trim().toLowerCase(), hash]
        );

        await db.query(
            'INSERT INTO user_stats (user_id) VALUES ($1) ON CONFLICT DO NOTHING',
            [rows[0].id]
        );

        const token     = generateToken();
        const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
        await db.query(
            'INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)',
            [token, rows[0].id, expiresAt]
        );

        res.cookie(SESSION_COOKIE, token, {
            httpOnly: true,
            secure:   process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            expires:   expiresAt,
        });

        res.status(201).json({ user: rows[0] });

    } catch (err) {
        if (err.code === '23505')
            return res.status(409).json({ error: 'Username or email already exists' });
        console.error('[AUTH] register error:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

/** POST /api/login – Sign in. */
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body ?? {};

    if (!email || !password)
        return res.status(400).json({ error: 'email and password are required' });

    try {
        const { rows } = await db.query(
            'SELECT * FROM users WHERE email = $1',
            [email.trim().toLowerCase()]
        );

        const user = rows[0];
        if (!user) return res.status(401).json({ error: 'Invalid credentials' });

        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) return res.status(401).json({ error: 'Invalid credentials' });

        const token     = generateToken();
        const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
        await db.query(
            'INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)',
            [token, user.id, expiresAt]
        );

        await db.query('UPDATE users SET is_online = TRUE WHERE id = $1', [user.id]);

        res.cookie(SESSION_COOKIE, token, {
            httpOnly: true,
            secure:   process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            expires:   expiresAt,
        });

        res.json({
            user: {
                id:         user.id,
                username:   user.username,
                email:      user.email,
                avatar_url: user.avatar_url,
                role:       user.role,
            },
        });

    } catch (err) {
        console.error('[AUTH] login error:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

/** POST /api/logout – End the session. */
app.post('/api/logout', requireAuth, async (req, res) => {
    const token = parseSidCookie(req);
    try {
        await db.query('DELETE FROM sessions WHERE token = $1', [token]);
        await db.query('UPDATE users SET is_online = FALSE WHERE id = $1', [req.user.user_id]);
    } catch (err) {
        console.error('[AUTH] logout error:', err.message);
    }
    res.clearCookie(SESSION_COOKIE);
    res.json({ ok: true });
});

/** GET /api/me – Returns the current user. */
app.get('/api/me', requireAuth, (req, res) => {
    res.json({ user: req.user });
});

// ─────────────────────────────────────────────────────────────────────────────
//  SIMULATION CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const TICK_RATE = 60;
const TICK_DT   = 1 / TICK_RATE;
const GHOST_TTL = 30_000;

const GRAVITY         = -28.0;
const JUMP_FORCE      =  10.8;
const MOVE_SPEED      =   5.0;
const DASH_SPEED      =  14.0;
const DASH_DURATION   =   0.12;
const DASH_COOLDOWN   =   0.5;
const GROUND_Y        =   0.0;
const KNOCKBACK_DECAY =   0.85;
const MIN_KNOCKBACK   =   0.05;

const STAGE_LEFT   = -8.0;
const STAGE_RIGHT  =  8.0;
const STAGE_BOTTOM = -6.0;

const ATTACK_DURATION  = 0.3;
const ATTACK_COOLDOWN  = 0.5;
const ATTACK_RANGE     = 0.525;
const ATTACK_RANGE_Y   = 0.5;
const ATTACK_KNOCKBACK = 14.0;
const ATTACK_KB_UP     =  6.0;

// ─────────────────────────────────────────────────────────────────────────────
//  VOLTAGE SYSTEM
// ─────────────────────────────────────────────────────────────────────────────
const VOLTAGE_MAX          = 200;
const VOLTAGE_PER_HIT       =  12;
const VOLTAGE_DRAIN_BLOCK   =   8;
const VOLTAGE_SCALE_ATTACK  = 1.0;
const VOLTAGE_SCALE_DEFEND  = 1.0;

function voltageMultiplier(v) {
    if (v >= VOLTAGE_MAX) return 6.0;
    return 1.0 + Math.log(1 + v / 40) * 0.38;
}

// ─────────────────────────────────────────────────────────────────────────────
//  HITSTOP SYSTEM  (estilo Smash Bros / HAL Laboratory)
//
//  El hitstop es una PAUSA PURA: toda física e input se congela durante
//  exactamente N frames.  No hay bullet-time parcial — el freeze es total
//  y la salida explosiva.  La duración escala con el voltaje del atacante.
//
//  Duraciones (a 60 Hz):
//    voltage <  30  →  3 frames  (~50 ms)  — micro-stop, apenas perceptible
//    30 –  79       →  6 frames  (~100 ms) — golpe normal con peso
//    80 – 149       → 10 frames  (~167 ms) — golpe fuerte, claramente visible
//   150 – 199       → 15 frames  (~250 ms) — heavy, bullet time notable
//    200 (maxed)    → 22 frames  (~367 ms) — ultra, espectacular
// ─────────────────────────────────────────────────────────────────────────────
function calcHitstop(attackerVoltage) {
    const v = attackerVoltage;
    if (v >= 200) {
        return { durationFrames: 22, tier: 'ultra' };
    } else if (v >= 150) {
        const t = (v - 150) / 50;
        return { durationFrames: Math.round(15 + t * 7), tier: 'heavy' };
    } else if (v >= 80) {
        const t = (v - 80) / 70;
        return { durationFrames: Math.round(10 + t * 5), tier: 'medium' };
    } else if (v >= 30) {
        const t = (v - 30) / 50;
        return { durationFrames: Math.round(6 + t * 4), tier: 'light' };
    } else {
        return { durationFrames: 3, tier: 'micro' };
    }
}

// Estado global de hitstop por sesión.
// hitstopBySession[sessionId] = { framesLeft, tier } | null
const hitstopBySession = {};

// ─────────────────────────────────────────────────────────────────────────────
//  BLOCK SYSTEM
// ─────────────────────────────────────────────────────────────────────────────
const BLOCK_KB_MULTIPLIER = 0.15;
const BLOCK_MOVE_FACTOR   = 0.05;
const BLOCK_HOLD_TICKS    = 35;
const BLOCK_DASH_LOCKOUT  = 0.6;

// ─────────────────────────────────────────────────────────────────────────────
//  DASH ATTACK
// ─────────────────────────────────────────────────────────────────────────────
const DASH_ATTACK_WINDOW  = 0.18;
const DASH_ATTACK_KB_MULT = 1.65;
const DASH_ATTACK_RANGE_X = 1.65;

// ─────────────────────────────────────────────────────────────────────────────
//  ANIMATION
// ─────────────────────────────────────────────────────────────────────────────
const ANIM_DURATIONS = {
    attack_air:     0.5,
    attack_crouch:  0.5,
    attack_combo_1: 0.35,
    attack_combo_2: 0.35,
    attack_combo_3: 0.5,
    attack_dash:    0.4,
    dash:           0.15,
    hurt:           0.4,
    jump:           0.15,
    block:          0.0,
};

const COMBO_WINDOW = 0.25;

// ─────────────────────────────────────────────────────────────────────────────
//  STAGE GEOMETRY
// ─────────────────────────────────────────────────────────────────────────────
const PLATFORMS = [
    { x:  0, y: GROUND_Y, hw: (STAGE_RIGHT - STAGE_LEFT) / 2 },
    { x: -4, y: 1.6,      hw: 1.2 },
    { x:  4, y: 1.6,      hw: 1.2 },
    { x:  0, y: 2.8,      hw: 1.2 },
];

const PLAYER_RADIUS = 0.24;
const PLAYER_HEIGHT = 0.72;

// ─────────────────────────────────────────────────────────────────────────────
//  PLAYER REGISTRY
// ─────────────────────────────────────────────────────────────────────────────
const MAX_PLAYERS = 8;

let nextClientId = 1;
const players    = {};
const lastState  = {};

// ─────────────────────────────────────────────────────────────────────────────
//  SPECTATOR REGISTRY
// ─────────────────────────────────────────────────────────────────────────────
/**
 * spectators[clientId] = {
 *   id, dbUserId, ws,
 *   watchingSession: string|null,
 *   mode: 'overflow'|'voluntary',
 *   dbRowId: number|null
 * }
 */
const spectators = {};
let frameId = 0;

// ─────────────────────────────────────────────────────────────────────────────
//  SPECTATOR HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function getLastWatchedSession(dbUserId) {
    if (!dbUserId) return null;
    try {
        const { rows } = await db.query(
            `SELECT session_id
             FROM spectators
             WHERE user_id = $1 AND session_id <> 'lobby'
             ORDER BY joined_at DESC
             LIMIT 1`,
            [dbUserId]
        );
        return rows[0]?.session_id ?? null;
    } catch (err) {
        console.error('[SPECTATOR] restore session error:', err.message);
        return null;
    }
}

function listActiveSessions() {
    const result = [];
    for (const [id, sess] of gameSessions.entries()) {
        const spectatorCount = Object.values(spectators)
            .filter(s => s.watchingSession === id).length;
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
            spec.ws.send(JSON.stringify({
                type: 'spectator_session_changed',
                watchingSession: null,
            }));
        }
    }

    for (const [id, p] of Object.entries(players)) {
        if (sessionIds && !sessionIds.has(Number(id))) continue;
        snapshot[id] = {
            id:           p.id,
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

    spec.ws.send(JSON.stringify({
        type: 'state',
        frameId: ++frameId,
        players: snapshot,
    }));
}

function broadcastStateToSpectators() {
    for (const spec of Object.values(spectators)) {
        sendStateToSpectator(spec);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
//  CHARACTER DEFINITIONS  (stats por personaje)
//  moveSpeed      → velocidad de movimiento (base: 5.0)
//  dashSpeed      → velocidad de dash (base: 14.0)
//  attackKnockback→ fuerza de knockback (base: 14.0)
//  attackRange    → alcance del ataque (base: 0.525)
// ─────────────────────────────────────────────────────────────────────────────
const CHARACTER_DEFS = {
    eld: { name: 'Eldwin',  moveSpeed: 4.5,  dashSpeed: 13.0, attackKnockback: 16.0, attackRange: 0.55  },
    hil: { name: 'Hilda',   moveSpeed: 5.5,  dashSpeed: 15.0, attackKnockback: 12.0, attackRange: 0.50  },
    qui: { name: 'Quimbur', moveSpeed: 3.8,  dashSpeed: 11.0, attackKnockback: 18.0, attackRange: 0.60  },
    gab: { name: 'Gabriel', moveSpeed: 6.0,  dashSpeed: 16.0, attackKnockback: 11.0, attackRange: 0.48  },
};

const CHARACTER_ASSETS = {
    eld: { texCfg: 'data/textures/eld/bone_textures.txt', texSets: 'data/textures/eld/texture_sets.txt', animBase: 'data/animations/eld/', portrait: 'data/eldwin_portrait.jpg'  },
    hil: { texCfg: 'data/textures/hil/bone_textures.txt', texSets: 'data/textures/hil/texture_sets.txt', animBase: 'data/animations/hil/', portrait: 'data/hilda_portrait.jpg'   },
    qui: { texCfg: 'data/textures/qui/bone_textures.txt', texSets: 'data/textures/qui/texture_sets.txt', animBase: 'data/animations/qui/', portrait: 'data/quimbur_portrait.jpg' },
    gab: { texCfg: 'data/textures/gab/bone_textures.txt', texSets: 'data/textures/gab/texture_sets.txt', animBase: 'data/animations/gab/', portrait: 'data/gabriel_portrait.jpg' },
};
const CHAR_IDS = ['eld', 'hil', 'qui', 'gab'];

function buildCharSelectAck(selectorCharId, selectorClientId, stageId) {
    const playerIds  = Object.keys(players).map(Number);
    const usedChars  = new Set([selectorCharId]);
    const playersOut = {};
    let   altIdx     = 0;

    for (let i = 0; i < Math.min(playerIds.length, 8); i++) {
        const cid = playerIds[i];
        let charId;
        if (cid === selectorClientId) {
            charId = selectorCharId;
        } else {
            while (altIdx < CHAR_IDS.length && usedChars.has(CHAR_IDS[altIdx])) altIdx++;
            charId = CHAR_IDS[altIdx % CHAR_IDS.length];
            usedChars.add(charId);
            altIdx++;
        }
        const a = CHARACTER_ASSETS[charId] ?? CHARACTER_ASSETS.eld;
        playersOut[i] = { clientId: cid, charId, texCfg: a.texCfg, texSets: a.texSets, animBase: a.animBase };
    }
    return { type: 'char_select_ack', charId: selectorCharId, selectorClient: selectorClientId, stageId, players: playersOut };
}

//  WEBSOCKET UPGRADE
// ─────────────────────────────────────────────────────────────────────────────
server.on('upgrade', (req, socket, head) => {
    if (req.url === '/ws') {
        wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
    } else {
        socket.destroy();
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  CONNECTION HANDLER
// ─────────────────────────────────────────────────────────────────────────────
wss.on('connection', async (ws, req) => {
    let clientId = null;
    let dbUserId = null;
    let isSpectator = false;
    let mode = null;
    let firstMessageSeen = false;
    let autoSpectatorTimer = null;

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

    async function insertOrUpdateSpectatorRow(specMode, watchingSession) {
        const current = spectators[clientId];
        if (!current) return;

        const tournamentId = watchingSession
            ? (gameSessions.get(watchingSession)?.tournamentId ?? null)
            : null;

        if (!current.dbRowId) {
            try {
                const { rows: dbRows } = await db.query(
                    `INSERT INTO spectators (user_id, session_id, tournament_id, mode)
                     VALUES ($1, $2, $3, $4)
                     RETURNING id`,
                    [dbUserId, watchingSession ?? 'lobby', tournamentId, specMode]
                );
                current.dbRowId = dbRows[0]?.id ?? null;
            } catch (err) {
                console.error('[SPECTATOR] DB insert error:', err.message);
            }
        } else {
            db.query(
                `UPDATE spectators
                 SET session_id = $1,
                     tournament_id = $2,
                     mode = $3
                 WHERE id = $4`,
                [watchingSession ?? 'lobby', tournamentId, specMode, current.dbRowId]
            ).catch(err => console.error('[SPECTATOR] DB update error:', err.message));
        }
    }

    function sendSpectatorWelcome(specMode, watchingSession) {
        if (!spectators[clientId]) return;

        ws.send(JSON.stringify({
            type: 'spectator_mode',
            clientId,
            mode: specMode,
            watchingSession,
            activeSessions: listActiveSessions(),
        }));

        sendStateToSpectator(spectators[clientId]);
    }

    async function ensureSpectatorReady(specMode = 'overflow', watchingSession = null) {
        if (clientId === null) {
            clientId = nextClientId++;
            if (clientId >= nextClientId) nextClientId = clientId + 1;
        }

        if (!spectators[clientId]) {
            spectators[clientId] = {
                id: clientId,
                dbUserId,
                ws,
                watchingSession,
                mode: specMode,
                dbRowId: null,
            };
            isSpectator = true;
            mode = specMode;

            await insertOrUpdateSpectatorRow(specMode, watchingSession);
            sendSpectatorWelcome(specMode, watchingSession);
            console.log(
                `[SPECTATOR] Client ${clientId} connected as ${specMode} spectator` +
                (watchingSession ? ` watching session ${watchingSession}` : ' (lobby)')
            );
        } else {
            spectators[clientId].watchingSession = watchingSession;
            spectators[clientId].mode = specMode;
            isSpectator = true;
            mode = specMode;

            await insertOrUpdateSpectatorRow(specMode, watchingSession);
            ws.send(JSON.stringify({
                type: 'spectator_session_changed',
                watchingSession,
            }));
            sendStateToSpectator(spectators[clientId]);
        }
    }

    async function promoteToPlayer(initialMsg = null) {
        if (!clientId && clientId !== 0) {
            clientId = nextClientId++;
            if (clientId >= nextClientId) nextClientId = clientId + 1;
        }

        if (players[clientId]) return;

        // -------------------------
        //  FIX: LIMIT 8 PLAYERS
        // -------------------------
        if (Object.keys(players).length >= MAX_PLAYERS) {
            // Auto-assign the first active session so the overflow spectator
            // immediately watches real gameplay instead of an empty lobby.
            const firstSession = gameSessions.size > 0
                ? gameSessions.keys().next().value
                : null;
            await ensureSpectatorReady('overflow', firstSession);
            return;
        }

        if (spectators[clientId]) {
            const spec = spectators[clientId];
            if (spec.dbRowId) {
                db.query(
                    `UPDATE spectators SET left_at = NOW() WHERE id = $1`,
                    [spec.dbRowId]
                ).catch(err => console.error('[SPECTATOR] left_at update error:', err.message));
            }
            delete spectators[clientId];
        }

        const saved = lastState[clientId];
        if (saved) clearTimeout(saved.timer);

        players[clientId] = createPlayer(clientId, saved, ws);
        players[clientId].dbUserId = dbUserId;
        delete lastState[clientId];

        // Restaurar personaje si ya lo había elegido antes (reconexión)
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
            type: 'init',
            clientId,
            config: {
                attackRange:     players[clientId]?.attackRange ?? ATTACK_RANGE,
                attackRangeY:    ATTACK_RANGE_Y,
                dashAttackRange: DASH_ATTACK_RANGE_X,
            },
        }));

        // Si ya tenía personaje elegido, reenviar el ack para que el cliente
        // no muestre el selector de nuevo
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

        // Intentar arrancar partida si ya hay ≥2 jugadores libres
        tryAutoMatch();
    }

    autoSpectatorTimer = setTimeout(async () => {
        if (firstMessageSeen) return;
        if (players[clientId] || spectators[clientId]) return;
        // Auto-assign the first active session so the spectator watches
        // real gameplay immediately instead of an empty lobby.
        const firstSession = gameSessions.size > 0
            ? gameSessions.keys().next().value
            : null;
        await ensureSpectatorReady('overflow', firstSession);
    }, 120);

    ws.on('message', async (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw);
        } catch {
            return;
        }

        firstMessageSeen = true;
        if (autoSpectatorTimer) {
            clearTimeout(autoSpectatorTimer);
            autoSpectatorTimer = null;
        }

        // Primer mensaje del cliente: decidir inmediatamente jugador vs espectador.
        // Evita la carrera entre el timeout de 120ms y el loop de input de 60Hz.
        if (msg.type === 'join') {
            if (Object.keys(players).length >= MAX_PLAYERS) {
                if (clientId === null) {
                    clientId = nextClientId++;
                    if (clientId >= nextClientId) nextClientId = clientId + 1;
                }
                // Auto-assign the first active session so the spectator
                // immediately watches real gameplay instead of an empty lobby.
                const firstSession = gameSessions.size > 0
                    ? gameSessions.keys().next().value
                    : null;
                await ensureSpectatorReady('overflow', firstSession);
            } else {
                await promoteToPlayer(null);
            }
            return;
        }

        if (msg.type === 'rejoin' && msg.clientId) {
            // Caso 1: jugador sigue en memoria — reconectar WS y reenviar init
            if (players[msg.clientId]) {
                clientId = msg.clientId;
                if (clientId >= nextClientId) nextClientId = clientId + 1;
                players[clientId].ws = ws;
                isSpectator = false;
                mode = 'player';
                ws.send(JSON.stringify({
                    type: 'init',
                    clientId,
                    config: {
                        attackRange:     players[clientId]?.attackRange ?? ATTACK_RANGE,
                        attackRangeY:    ATTACK_RANGE_Y,
                        dashAttackRange: DASH_ATTACK_RANGE_X,
                    },
                }));
                // Reenviar char_select_ack si ya había elegido personaje
                const savedChar = playerCharSelected.get(clientId);
                if (savedChar) {
                    const ack = buildCharSelectAck(savedChar, clientId, 0);
                    ws.send(JSON.stringify(ack));
                }
                return;
            }

            // Caso 2: espectador sigue en memoria — reconectar WS
            if (spectators[msg.clientId]) {
                clientId = msg.clientId;
                if (clientId >= nextClientId) nextClientId = clientId + 1;
                spectators[clientId].ws = ws;
                isSpectator = true;
                mode = spectators[clientId].mode;
                sendSpectatorWelcome(mode, spectators[clientId].watchingSession);
                return;
            }

            // Caso 3: ya no está en memoria — tratar como join nuevo
            if (clientId !== null && clientId !== msg.clientId) {
                delete spectators[clientId];
                delete players[clientId];
            }
            clientId = msg.clientId;
            if (clientId >= nextClientId) nextClientId = clientId + 1;

            if (Object.keys(players).length < MAX_PLAYERS) {
                await promoteToPlayer(null);
            } else {
                const firstSession = gameSessions.size > 0
                    ? gameSessions.keys().next().value
                    : null;
                await ensureSpectatorReady('overflow', firstSession);
            }
            return;
        }

        if (msg.type === 'watch') {
            if (!clientId && clientId !== 0) {
                clientId = nextClientId++;
                if (clientId >= nextClientId) nextClientId = clientId + 1;
            }

            const watchingSession = (msg.sessionId && gameSessions.get(msg.sessionId))
                ? msg.sessionId
                : (msg.sessionId ?? await getLastWatchedSession(dbUserId));

            await ensureSpectatorReady('voluntary', watchingSession ?? null);

            if (spectators[clientId]) {
                spectators[clientId].watchingSession = watchingSession ?? null;
                spectators[clientId].mode = 'voluntary';

                await insertOrUpdateSpectatorRow('voluntary', watchingSession ?? null);

                ws.send(JSON.stringify({
                    type: 'spectator_session_changed',
                    watchingSession: spectators[clientId].watchingSession,
                }));

                sendStateToSpectator(spectators[clientId]);
            }
            return;
        }

        if (msg.type === 'input') {
            // Prevent spectators from being promoted by input when room is full
            if (spectators[clientId]) return;

            if (!players[clientId]) {
                await promoteToPlayer(msg);
                return;
            }

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

            // Aplicar stats al jugador que seleccionó
            const p = players[clientId];
            if (p) {
                const def = CHARACTER_DEFS[charId] ?? CHARACTER_DEFS.eld;
                p.charId          = charId;
                p.moveSpeed       = def.moveSpeed;
                p.dashSpeed       = def.dashSpeed;
                p.attackKnockback = def.attackKnockback;
                p.attackRange     = def.attackRange;
            }

            // Registrar personaje elegido (persiste para reconexiones)
            playerCharSelected.set(clientId, charId);

            // Broadcast ack con assets a todos
            const ack = buildCharSelectAck(charId, clientId, stageId);
            const raw = JSON.stringify(ack);
            for (const pl   of Object.values(players))    if (pl.ws   && pl.ws.readyState   === WebSocket.OPEN) pl.ws.send(raw);
            for (const spec of Object.values(spectators)) if (spec.ws && spec.ws.readyState === WebSocket.OPEN) spec.ws.send(raw);
            console.log(`[CHAR_SELECT] client=${clientId} char=${charId} moveSpeed=${players[clientId]?.moveSpeed}`);

            // Intentar arrancar combate si hay ≥2 jugadores libres con personaje elegido
            tryAutoMatch();
        }
    });

    ws.on('close', async () => {
        if (autoSpectatorTimer) {
            clearTimeout(autoSpectatorTimer);
            autoSpectatorTimer = null;
        }

        if (clientId === null) return;

        if (spectators[clientId]) {
            const spec = spectators[clientId];
            if (spec.dbRowId) {
                db.query(
                    `UPDATE spectators SET left_at = NOW() WHERE id = $1`,
                    [spec.dbRowId]
                ).catch(err => console.error('[SPECTATOR] left_at update error:', err.message));
            }
            delete spectators[clientId];
            console.log(`[SPECTATOR] Client ${clientId} disconnected`);
            return;
        }

        if (!players[clientId]) return;

        const p = players[clientId];
        lastState[clientId] = {
            x:        p.x,
            y:        p.y,
            onGround: p.onGround,
            // Al expirar el ghost TTL, borrar también la selección de personaje
            timer:    setTimeout(() => {
                delete lastState[clientId];
                playerCharSelected.delete(clientId);
            }, GHOST_TTL),
        };
        delete players[clientId];
        playerSession.delete(clientId);
        // NO borramos playerCharSelected aquí — se conserva para reconexión (rejoin)
        console.log(`[SERVER] Player ${clientId} disconnected`);
        broadcastState();
    });

    ws.on('error', () => ws.close());
});

// ─────────────────────────────────────────────────────────────────────────────
//  PLAYER FACTORY
// ─────────────────────────────────────────────────────────────────────────────
function createPlayer(id, saved, ws) {
    const spawnX   = (Math.random() - 0.5) * 4;
    const onGround = saved ? (saved.onGround ?? true) : true;

    return {
        id,
        dbUserId: null,
        x:  saved ? saved.x : spawnX,
        y:  saved ? saved.y : GROUND_Y,
        vx: 0, vy: 0,
        kbx: 0, kby: 0,
        onGround,
        jumpsLeft:      onGround ? 2 : 1,
        facing:         1,
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
        stocks:         3,
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
        /* Stats por personaje — sobreescritos por char_select */
        charId:          null,
        moveSpeed:       MOVE_SPEED,
        dashSpeed:       DASH_SPEED,
        attackKnockback: ATTACK_KNOCKBACK,
        attackRange:     ATTACK_RANGE,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
//  GAME LOOP  (60 Hz)
setInterval(tick, 1000 / TICK_RATE);

function tick() {
    // Jugadores en sesiones FINISHED (pantalla de victoria) se congelan:
    // seguimos enviando estado para que se renderice la animación, pero no
    // ejecutamos física ni detección de golpes.
    const frozenIds = new Set();
    for (const [cid, sid] of playerSession.entries()) {
        const sess = gameSessions.get(sid);
        if (sess?.finished) frozenIds.add(cid);
    }

    // ── Pre-tick: limpiar hitstops expirados del tick anterior ───────────────
    for (const [sessId, hs] of Object.entries(hitstopBySession)) {
        if (!hs || hs.framesLeft <= 0) delete hitstopBySession[sessId];
    }

    // Todos los jugadores vivos corren tickPlayer (incluye detección de golpes).
    // Si un golpe ocurre aquí, applyHit() escribe en hitstopBySession ahora mismo.
    const aliveAll = Object.values(players).filter(p => !p.respawning && !frozenIds.has(p.id));
    tickRespawn();
    for (const p of aliveAll) tickPlayer(p);

    // ── Post-tickPlayer: evaluar hitstop con los datos RECIÉN generados ───────
    // Ahora sí sabemos qué sesiones acaban de recibir un golpe este tick.
    const hitstopFrozenIds = new Set();
    for (const [sessId, hs] of Object.entries(hitstopBySession)) {
        if (!hs || hs.framesLeft <= 0) { delete hitstopBySession[sessId]; continue; }
        const session = gameSessions.get(sessId);
        if (session) {
            for (const cid of session.playerIds) hitstopFrozenIds.add(cid);
        }
        hs.framesLeft--;
        if (hs.framesLeft <= 0) delete hitstopBySession[sessId];
    }

    // alive para física = los que NO están congelados por hitstop
    const alive = aliveAll.filter(p => !hitstopFrozenIds.has(p.id));
    const aliveForAnim = Object.values(players).filter(p => !frozenIds.has(p.id));
    tickPhysics(alive);
    tickCollisions(alive);
    tickPlatforms(alive);
    tickAnimations(aliveForAnim);

    broadcastState();
}

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

function tickPlayer(p) {
    const { moveX, jump, attack, dash, dashDir, crouch, block, dashAttack } = p.input;
    p.input.jump       = false;
    p.input.attack     = false;
    p.input.dash       = false;
    p.input.dashAttack = false;

    tickBlock(p, moveX, attack, dash, dashAttack, block, crouch);
    tickDash(p, dash, dashDir, moveX, block, crouch);
    tickMovement(p, moveX, jump, crouch);
    tickAttack(p, attack, dashAttack, crouch);
}

function tickBlock(p, moveX, attack, dash, dashAttack, block, crouch) {
    if (p.blockLockout > 0) p.blockLockout -= TICK_DT;
    const blockAllowed =
        p.onGround && !p.dashing && !p.attacking && !attack && !dashAttack
        && p.blockLockout  <= 0 && p.dashEndWindow <= 0 && !p.voltageMaxed;
    if (block && blockAllowed) {
        p.blockHoldTicks++;
    } else {
        p.blockHoldTicks = 0;
    }
    p.blocking = p.blockHoldTicks >= BLOCK_HOLD_TICKS;
    if (p.blocking && !p.voltageMaxed) {
        p.voltage = Math.max(0, p.voltage - VOLTAGE_DRAIN_BLOCK * TICK_DT);
    }
}

function tickDash(p, dash, dashDir, moveX, block, crouch) {
    if (p.dashEndWindow > 0) p.dashEndWindow -= TICK_DT;
    if (p.dashCooldown  > 0) p.dashCooldown  -= TICK_DT;
    if (dash && !p.dashing && p.dashCooldown <= 0 && !p.blocking) {
        p.dashing      = true;
        p.dashTimer    = DASH_DURATION;
        p.dashDir      = dashDir !== 0 ? Math.sign(dashDir) : p.facing;
        p.dashCooldown = DASH_COOLDOWN;
        p.kbx          = 0;
        p.kby          = 0;
        p.animation    = 'dash';
        p.animTimer    = ANIM_DURATIONS.dash;
    }
    if (p.dashing) {
        p.dashTimer -= TICK_DT;
        p.vx         = p.dashDir * (p.dashSpeed ?? DASH_SPEED);
        if (p.dashTimer <= 0) {
            p.dashing        = false;
            p.vx             = 0;
            p.dashEndWindow  = DASH_ATTACK_WINDOW;
            p.blockLockout   = BLOCK_DASH_LOCKOUT;
            p.blockHoldTicks = 0;
        }
    }
}

function tickMovement(p, moveX, jump, crouch) {
    if (!p.dashing) {
        if (p.blocking) {
            p.vx = moveX * (p.moveSpeed ?? MOVE_SPEED) * BLOCK_MOVE_FACTOR;
        } else if (crouch) {
            p.vx = 0;
        } else if (moveX !== 0) {
            p.vx     = moveX * (p.moveSpeed ?? MOVE_SPEED);
            p.facing = Math.sign(moveX);
        } else {
            p.vx = 0;
        }
    }
    p.crouching = p.onGround && !p.dashing && !p.attacking && !p.blocking && crouch;
    if (jump && p.jumpsLeft > 0 && !p.blocking) {
        p.vy        = JUMP_FORCE;
        p.onGround  = false;
        p.jumpsLeft--;
        p.jumpId++;
        p.animation = 'jump';
        p.animTimer = ANIM_DURATIONS.jump;
        if (!p.dashing && moveX !== 0) {
            p.vx     = moveX * (p.moveSpeed ?? MOVE_SPEED);
            p.facing = Math.sign(moveX);
        }
    }
}

function tickAttack(p, attack, dashAttack, crouch) {
    if (p.attackCooldown > 0) p.attackCooldown -= TICK_DT;
    if (p.comboWindow    > 0) p.comboWindow    -= TICK_DT;
    const isDashAttack = (attack || dashAttack) && p.dashEndWindow > 0;
    const canAttack    = (attack || (dashAttack && p.dashEndWindow > 0))
                         && !p.attacking && p.attackCooldown <= 0;
    if (canAttack) {
        p.attacking     = true;
        p.attackTimer   = ATTACK_DURATION;
        p._isDashAttack = isDashAttack;
        const animName      = resolveAttackAnim(p, isDashAttack, crouch);
        p.animation      = animName;
        p.animTimer      = ANIM_DURATIONS[animName];
        p.comboWindow    = p.animTimer + COMBO_WINDOW;
        p.attackCooldown = p.comboStep > 0 ? 0.1 : ATTACK_COOLDOWN;
        p.hitTargets     = new Set();
        if (isDashAttack) p.dashEndWindow = 0;
    }
    if (p.attackTimer > 0) {
        p.attackTimer -= TICK_DT;
        resolveHits(p);
        if (p.attackTimer <= 0) {
            p.attacking     = false;
            p._isDashAttack = false;
        }
    }
}

function resolveAttackAnim(p, isDashAttack, crouch) {
    if (isDashAttack) { p.comboStep = 0; return 'attack_dash'; }
    if (!p.onGround)  { p.comboStep = 0; return 'attack_air'; }
    if (crouch)       { p.comboStep = 0; return 'attack_crouch'; }
    if (p.comboWindow > 0 && p.comboStep > 0) {
        p.comboStep = p.comboStep < 3 ? p.comboStep + 1 : 1;
        return `attack_combo_${p.comboStep}`;
    }
    p.comboStep = 1;
    return 'attack_combo_1';
}

function resolveHits(p) {
    const alive  = Object.values(players).filter(t => !t.respawning);
    const rangeX = p._isDashAttack ? DASH_ATTACK_RANGE_X : (p.attackRange ?? ATTACK_RANGE);
    const hbCX   = p.x + p.facing * (rangeX / 2);
    const hbCY   = p.y + 0.5;
    const hbHW   = rangeX / 2;
    const hbHH   = ATTACK_RANGE_Y / 2;
    const hurtHW = 0.24;
    const hurtHH = 0.36;
    for (const target of alive) {
        if (target.id === p.id) continue;
        if (p.hitTargets.has(target.id)) continue;
        const tCX     = target.x;
        const tCY     = target.y + 0.36;
        const overlapX = Math.abs(hbCX - tCX) < (hbHW + hurtHW);
        const overlapY = Math.abs(hbCY - tCY) < (hbHH + hurtHH);
        if (!overlapX || !overlapY) continue;
        applyHit(p, target);
    }
}

function applyHit(attacker, target) {
    const dir          = target.x >= attacker.x ? 1 : -1;
    const attackerMult = voltageMultiplier(attacker.voltage) * VOLTAGE_SCALE_ATTACK;
    const defenderMult = voltageMultiplier(target.voltage)   * VOLTAGE_SCALE_DEFEND;
    const dashMult     = attacker._isDashAttack ? DASH_ATTACK_KB_MULT : 1.0;
    const totalMult    = attackerMult * defenderMult * dashMult;
    let kbx = dir * (attacker.attackKnockback ?? ATTACK_KNOCKBACK) * totalMult;
    let kby = ATTACK_KB_UP           * totalMult;
    const isBlocking = target.blocking && target.voltage < VOLTAGE_MAX;
    if (isBlocking) {
        kbx *= BLOCK_KB_MULTIPLIER;
        kby *= BLOCK_KB_MULTIPLIER;
        target.voltage = Math.min(VOLTAGE_MAX, target.voltage + VOLTAGE_PER_HIT * 0.25);
    } else {
        target.voltage = Math.min(VOLTAGE_MAX, target.voltage + VOLTAGE_PER_HIT);
    }
    if (target.voltage >= VOLTAGE_MAX) {
        target.voltage      = VOLTAGE_MAX;
        target.voltageMaxed = true;
    }
    target.kbx += kbx;
    target.kby += kby;
    target.hitId++;
    if (!isBlocking) {
        Object.assign(target, {
            animation: 'hurt',
            animTimer: ANIM_DURATIONS.hurt,
            dashing:   false,
            attacking: false,
            onGround:  false,
        });
    }
    attacker.hitTargets.add(target.id);

    // ── Hitstop: calcular según voltaje del atacante ───────────────────────
    const hs = calcHitstop(attacker.voltage);

    const sessId = playerSession.get(attacker.id);
    if (sessId) {
        const existing = hitstopBySession[sessId];
        // Solo sobreescribir si el nuevo hitstop es más largo
        if (!existing || hs.durationFrames > existing.framesLeft) {
            hitstopBySession[sessId] = {
                framesLeft: hs.durationFrames,
                tier:       hs.tier,
            };
            const session = gameSessions.get(sessId);
            if (session) {
                broadcastToSession(session, {
                    type:       'hitstop',
                    tier:       hs.tier,
                    frames:     hs.durationFrames,
                    attackerId: attacker.id,
                    targetId:   target.id,
                });
            }
        }
    }
}

function tickPhysics(alive) {
    const decayFactor = Math.pow(KNOCKBACK_DECAY, TICK_DT * TICK_RATE);
    for (const p of alive) {
        p.kbx *= decayFactor;
        p.kby *= decayFactor;
        if (Math.abs(p.kbx) < MIN_KNOCKBACK) p.kbx = 0;
        if (Math.abs(p.kby) < MIN_KNOCKBACK) p.kby = 0;
        if (!p.onGround) p.vy += GRAVITY * TICK_DT;
        p.prevY = p.y;
        p.x += (p.vx + p.kbx) * TICK_DT;
        p.y += (p.vy + p.kby) * TICK_DT;
    }
}

function tickCollisions(alive) {
    for (let i = 0; i < alive.length; i++) {
        for (let j = i + 1; j < alive.length; j++) {
            resolvePlayerCollision(alive[i], alive[j]);
        }
    }
}

function resolvePlayerCollision(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const overlapX = 2 * PLAYER_RADIUS - Math.abs(dx);
    const overlapY = PLAYER_HEIGHT - Math.abs(dy);
    if (overlapX <= 0 || overlapY <= 0) return;
    const dir      = dx >= 0 ? 1 : -1;
    const va       = a.vx + a.kbx;
    const vb       = b.vx + b.kbx;
    const aMoving  = Math.abs(a.vx) > 0.1 || Math.abs(a.kbx) > 0.5;
    const bMoving  = Math.abs(b.vx) > 0.1 || Math.abs(b.kbx) > 0.5;
    const opposite = Math.sign(va) !== Math.sign(vb) && aMoving && bMoving;
    if (opposite) {
        a.kbx -= dir * 1.5;
        b.kbx += dir * 1.5;
    } else if (aMoving && !bMoving) {
        b.kbx += dir * Math.abs(va) * 0.5;
    } else if (bMoving && !aMoving) {
        a.kbx -= dir * Math.abs(vb) * 0.5;
    }
    const sep = overlapX * 0.5 + 0.01;
    a.x -= dir * sep;
    b.x += dir * sep;
}

function tickPlatforms(alive) {
    for (const p of alive) {
        let landed = false;
        for (const plat of PLATFORMS) {
            const inRange  = Math.abs(p.x - plat.x) <= plat.hw;
            const wasAbove = p.prevY >= plat.y - PLAYER_HEIGHT;
            const crossed  = p.y <= plat.y && (p.vy + p.kby) <= 0;
            if (inRange && wasAbove && crossed) {
                p.y         = plat.y;
                p.vy        = 0;
                p.kby       = 0;
                p.onGround  = true;
                p.jumpsLeft = 2;
                landed      = true;
                if (p.animation === 'jump') {
                    p.animTimer = 0;
                    p.animation = decideAnim(p);
                }
                break;
            }
        }
        if (!landed) p.onGround = false;
        const outOfBounds =
            p.y < STAGE_BOTTOM
            || p.x < STAGE_LEFT  - 2
            || p.x > STAGE_RIGHT + 2;
        if (outOfBounds) {
            p.stocks = Math.max(0, p.stocks - 1);
            if (p.stocks === 0) {
                handleElimination(p);
                return;
            }
            Object.assign(p, {
                respawning:   true,
                respawnTimer: 1.5,
                vx: 0, vy: 0, kbx: 0, kby: 0,
                animation:    'idle',
                voltageMaxed: false,
            });
        }
    }
}

function tickAnimations(alive) {
    for (const p of alive) {
        if (p.respawning) continue;
        if (p.animTimer > 0) {
            p.animTimer -= TICK_DT;
            if (p.animTimer <= 0) p.animation = decideAnim(p);
        } else if (p.animation !== 'hurt') {
            p.animation = decideAnim(p);
        }
    }
}

function decideAnim(p) {
    if (!p.onGround) return 'jump';
    if (p.dashing)   return 'dash';
    if (p.crouching) return 'crouch';
    if (p.blocking)  return 'block';
    if (p.vx !== 0)  return 'walk';
    return 'idle';
}

// ─────────────────────────────────────────────────────────────────────────────
//  GAME MODES
// ─────────────────────────────────────────────────────────────────────────────
//
//  TODO (frontend): cuando se implemente el lobby, los modos de batalla,
//  el chat, las invitaciones y los torneos, esta sección se expandirá con:
//
//    · startDuel(id1, id2)          — 1v1 ranked/unranked
//    · startTournament(ids, dbId)   — bracket con 2/4/8 jugadores
//    · startBrawl(ids)              — todos contra todos (ya implementado abajo)
//
//  El flujo previsto es:
//    1. Jugadores en lobby ven lista de salas/invitaciones (React UI).
//    2. El host o un admin llama a la ruta REST correspondiente.
//    3. El servidor crea la sesión y notifica a todos con 'match_start'.
//    4. Los espectadores reciben 'spectator_session_changed' automáticamente.
//
//  Por ahora solo existe el modo DEBUG (auto-matchmaking) que mete a todos
//  los jugadores libres en una sola sesión brawl de hasta 8 jugadores.
//
// ─────────────────────────────────────────────────────────────────────────────

const gameSessions = new Map();
let nextSessionId = 1;
const playerSession = new Map();
// clientIds que ya han elegido personaje (persiste entre reconexiones)
const playerCharSelected = new Map(); // clientId → charId

// ─────────────────────────────────────────────────────────────────────────────
//  ⚠️  DEBUG AUTO-MATCHMAKING — ELIMINAR CUANDO SE IMPLEMENTE EL LOBBY
//
//  Cada 2 segundos, si hay ≥2 jugadores libres y ninguna sesión activa,
//  los mete a todos en una sola sesión brawl (hasta MAX_PLAYERS jugadores).
//  Así los espectadores siempre tienen algo que ver sin necesitar lobby.
// ─────────────────────────────────────────────────────────────────────────────
let DEBUG_AUTO_MATCH = true;

/**
 * Intenta iniciar una sesión brawl con todos los jugadores libres.
 * Solo arranca si ≥2 jugadores libres YA eligieron personaje.
 * Se llama reactivamente al unirse/terminar partida/elegir personaje.
 */
function tryAutoMatch() {
    if (!DEBUG_AUTO_MATCH) return;

    // Ignorar sesiones en estado FINISHED — ya no cuentan como "activas"
    const activeSessions = [...gameSessions.values()].filter(s => !s.finished);
    if (activeSessions.length > 0) return;

    // Solo jugadores libres que ya eligieron personaje
    const ready = Object.values(players)
        .filter(p => !playerSession.has(p.id) && playerCharSelected.has(p.id))
        .map(p => p.id);

    if (ready.length < 2) return;

    const sess = startBrawl(ready);
    console.log(`[AUTO-MATCH] Sesión brawl ${sess.id} con jugadores: ${[...sess.playerIds].join(', ')}`);
}
// ─────────────────────────────────────────────────────────────────────────────
//  FIN DEBUG AUTO-MATCHMAKING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Inicia una sesión brawl (todos contra todos) con los clientIds dados.
 * Soporta de 2 a MAX_PLAYERS jugadores en la misma sesión.
 * Es el modo base hasta que el lobby gestione los modos de batalla.
 */
function startBrawl(clientIds) {
    const id = String(nextSessionId++);
    const session = {
        id,
        mode:         'brawl',
        playerIds:    new Set(clientIds),
        eliminated:   new Set(),
        tournamentId: null,
        round:        null,
        matchDbId:    null,
        startedAt:    new Date(),
        finished:     false,   // true durante la pantalla de victoria — nadie puede unirse
    };
    gameSessions.set(id, session);

    for (const cid of clientIds) {
        playerSession.set(cid, id);
        const p = players[cid];
        if (p) p.stocks = 3;
    }

    broadcastToSession(session, {
        type:      'match_start',
        mode:      'brawl',
        sessionId: id,
        players:   clientIds,
        countdown: true,
    });

    // Notificar a espectadores sin sesión asignada para que vean esta
    for (const spec of Object.values(spectators)) {
        if (spec.watchingSession !== null) continue;
        spec.watchingSession = id;
        if (spec.ws.readyState === WebSocket.OPEN) {
            spec.ws.send(JSON.stringify({
                type:            'spectator_session_changed',
                watchingSession: id,
                activeSessions:  listActiveSessions(),
            }));
            sendStateToSpectator(spec);
        }
    }

    console.log(`[GAME] Brawl iniciado: sesión ${id} — ${clientIds.length} jugadores`);
    return session;
}

/** Start a 1v1 match between two connected clientIds. */
function startDuel(clientId1, clientId2) {
    const id = String(nextSessionId++);
    const session = {
        id,
        mode: '1v1',
        playerIds: new Set([clientId1, clientId2]),
        eliminated: new Set(),
        tournamentId: null,
        round: null,
        matchDbId: null,
        startedAt: new Date(),
        finished: false,
    };
    gameSessions.set(id, session);
    playerSession.set(clientId1, id);
    playerSession.set(clientId2, id);

    for (const cid of [clientId1, clientId2]) {
        const p = players[cid];
        if (p) p.stocks = 3;
    }

    broadcastToSession(session, { type: 'match_start', mode: '1v1', sessionId: id, countdown: true });
    console.log(`[GAME] 1v1 started: session ${id} — players ${clientId1} vs ${clientId2}`);
    return session;
}

/**
 * Create a tournament in the DB and kick off round 1.
 * @param {number[]} clientIds
 * @param {number} creatorDbId
 */
async function startTournament(clientIds, creatorDbId) {
    if (clientIds.length < 2) throw new Error('Need at least 2 players for a tournament');

    const sizes = [2, 4, 8];
    const bracketSize = sizes.find(s => s >= clientIds.length) ?? 8;

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
                `INSERT INTO tournament_players (tournament_id, user_id)
                 VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                [tournamentId, p.dbUserId]
            );
        }
    }

    const shuffled = [...clientIds].sort(() => Math.random() - 0.5);
    const pairs = [];
    for (let i = 0; i < shuffled.length - 1; i += 2) {
        pairs.push([shuffled[i], shuffled[i + 1]]);
    }

    console.log(`[TOURNAMENT] id=${tournamentId} — ${pairs.length} matches in round 1`);

    for (const [a, b] of pairs) {
        const sess = await startTournamentMatch(a, b, tournamentId, 1);
        console.log(`[TOURNAMENT] Round 1 match: ${a} vs ${b} → session ${sess.id}`);
    }

    return tournamentId;
}

/** Start a single tournament match between two players. */
async function startTournamentMatch(clientId1, clientId2, tournamentId, round) {
    const id = String(nextSessionId++);
    const session = {
        id,
        mode: 'tournament',
        playerIds: new Set([clientId1, clientId2]),
        eliminated: new Set(),
        tournamentId,
        round,
        matchDbId: null,
        startedAt: new Date(),
        finished: false,
    };
    gameSessions.set(id, session);
    playerSession.set(clientId1, id);
    playerSession.set(clientId2, id);

    for (const cid of [clientId1, clientId2]) {
        const p = players[cid];
        if (p) p.stocks = 3;
    }

    broadcastToSession(session, {
        type: 'match_start',
        mode: 'tournament',
        sessionId: id,
        tournamentId,
        round,
    });

    return session;
}

/**
 * Called when a player reaches 0 stocks.
 * Handles session bookkeeping, DB writes, and tournament advancement.
 */
function handleElimination(loser) {
    const sessionId = playerSession.get(loser.id);
    const session   = sessionId ? gameSessions.get(sessionId) : null;

    if (session) {
        session.eliminated.add(loser.id);
        session.loserDbId    = loser.dbUserId ?? null;
        session.loserStocks  = loser.stocks ?? 0;
    }

    // Convertir al jugador eliminado en espectador de su propia sesión
    const eliminatedWs     = loser.ws;
    const eliminatedId     = loser.id;
    const eliminatedDbId   = loser.dbUserId ?? null;

    delete players[eliminatedId];
    playerSession.delete(eliminatedId);

    if (eliminatedWs && eliminatedWs.readyState === WebSocket.OPEN) {
        spectators[eliminatedId] = {
            id:              eliminatedId,
            dbUserId:        eliminatedDbId,
            ws:              eliminatedWs,
            watchingSession: sessionId ?? null,
            mode:            'overflow',
            dbRowId:         null,
        };

        eliminatedWs.send(JSON.stringify({
            type:            'spectator_mode',
            clientId:        eliminatedId,
            mode:            'overflow',
            watchingSession: sessionId ?? null,
            activeSessions:  listActiveSessions(),
            eliminated:      true,   // el cliente puede mostrar "eliminado" en la UI
        }));

        console.log(`[GAME] Player ${eliminatedId} eliminated → spectator watching session ${sessionId}`);
    }

    broadcastState();
    broadcastToAll({ type: 'player_eliminated', clientId: eliminatedId });

    if (!session) return;

    const remaining = [...session.playerIds].filter(id => !session.eliminated.has(id));

    if (remaining.length === 1) {
        const winnerId = remaining[0];
        resolveMatchWinner(session, winnerId, eliminatedId);
    }
}

/** Persist the match result and, for tournaments, advance the bracket. */
async function resolveMatchWinner(session, winnerClientId, loserClientId) {
    // ── Marcar la sesión como terminada INMEDIATAMENTE ──────────────────────
    // Esto evita que nuevos jugadores libres arranquen otra partida en esta sesión
    // y que el tick siga procesando colisiones para los jugadores eliminados.
    session.finished = true;

    const winner     = players[winnerClientId];
    const winnerDbId = winner?.dbUserId ?? null;
    const loserDbId   = session.loserDbId ?? null;
    const loserStocks = session.loserStocks ?? 0;

    // ── Emitir VICTORY a todos los presentes en la sesión ───────────────────
    // El cliente reproducirá la animación 'victory' y la congelará en el último frame.
    // El ganador recibirá isWinner=true; los demás (espectadores/eliminados) isWinner=false.
    broadcastToSession(session, {
        type:     'victory',
        winner:   winnerClientId,
        loser:    loserClientId,
        // El ganador necesita hacer reload para entrar en la próxima partida
        reloadRequired: true,
    });

    // También notificar a los espectadores que miraban esta sesión
    const raw = JSON.stringify({
        type:     'victory',
        winner:   winnerClientId,
        loser:    loserClientId,
        reloadRequired: true,
    });
    for (const spec of Object.values(spectators)) {
        if (spec.watchingSession === session.id && spec.ws.readyState === WebSocket.OPEN) {
            spec.ws.send(raw);
        }
    }

    console.log(`[GAME] Victory — ganador: ${winnerClientId}, sesión: ${session.id}`);

    // ── Escribir en BD (async, no bloquea la pantalla de victoria) ──────────
    try {
        const { rows } = await db.query(
            `INSERT INTO matches
               (player1_id, player2_id, winner_id, score1, score2, game_type)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id`,
            [winnerDbId, loserDbId, winnerDbId,
             winner?.stocks ?? 0, loserStocks,
             session.mode === 'tournament' ? 'tournament' : 'brawler']
        );
        session.matchDbId = rows[0].id;

        if (session.tournamentId && session.matchDbId) {
            await db.query(
                `INSERT INTO tournament_matches (tournament_id, match_id, round)
                 VALUES ($1, $2, $3)`,
                [session.tournamentId, session.matchDbId, session.round]
            );
        }

        if (winnerDbId) {
            await db.query(
                `UPDATE user_stats
                 SET wins  = wins + 1,
                     xp    = xp + 100,
                     level = GREATEST(level, FLOOR(SQRT((xp + 100) / 50.0))::int),
                     updated_at = NOW()
                 WHERE user_id = $1`,
                [winnerDbId]
            );
            await checkAndGrantAchievements(winnerDbId);
        }
        if (loserDbId) {
            await db.query(
                `UPDATE user_stats
                 SET losses = losses + 1,
                     updated_at = NOW()
                 WHERE user_id = $1`,
                [loserDbId]
            );
        }

    } catch (err) {
        console.error('[GAME] DB write error on match resolve:', err.message);
    }

    // match_end también se envía (para compatibilidad con HUD / torneos)
    broadcastToSession(session, {
        type:     'match_end',
        winner:   winnerClientId,
        loser:    loserClientId,
        matchId:  session.matchDbId,
        mode:     session.mode,
    });

    if (session.mode === 'tournament') {
        advanceTournament(session.tournamentId, winnerClientId);
    }

    // ── Esperar la duración de la pantalla de victoria antes de limpiar ─────
    // Durante este tiempo la sesión sigue en gameSessions con finished=true.
    // Cualquier nuevo jugador que se conecte irá a una sesión NUEVA aparte.
    const VICTORY_DISPLAY_MS = 6000;   // 6 s — tiempo suficiente para ver la animación

    setTimeout(() => {
        gameSessions.delete(session.id);
        delete hitstopBySession[session.id];   // limpiar estado de hitstop

        // Reasignar espectadores que miraban esta sesión
        const nextSession = [...gameSessions.values()].find(s => !s.finished)?.id ?? null;
        for (const spec of Object.values(spectators)) {
            if (spec.watchingSession !== session.id) continue;
            spec.watchingSession = nextSession;
            if (spec.ws.readyState === WebSocket.OPEN) {
                spec.ws.send(JSON.stringify({
                    type:            'spectator_session_changed',
                    watchingSession: nextSession,
                    activeSessions:  listActiveSessions(),
                }));
                if (nextSession) sendStateToSpectator(spec);
            }
        }

        // Intentar arrancar una nueva partida con los jugadores que esperan
        tryAutoMatch();

    }, VICTORY_DISPLAY_MS);
}

/**
 * Check if there are enough tournament winners waiting for the next round,
 * and start the next round's matches when ready.
 */
async function advanceTournament(tournamentId, newWinnerId) {
    if (!tournamentWaitingWinners) tournamentWaitingWinners = {};
    if (!tournamentWaitingWinners[tournamentId]) {
        tournamentWaitingWinners[tournamentId] = [];
    }
    tournamentWaitingWinners[tournamentId].push(newWinnerId);

    const waiting = tournamentWaitingWinners[tournamentId];

    if (waiting.length < 2) {
        broadcastToAll({
            type: 'tournament_waiting',
            tournamentId,
            waitingCount: waiting.length,
        });
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
        const champion = waiting.splice(0, 1)[0];
        await finalizeTournament(tournamentId, champion);
    }
}

/** A single player remains — mark tournament finished. */
async function finalizeTournament(tournamentId, championClientId) {
    const champion = players[championClientId];
    try {
        await db.query(
            `UPDATE tournaments SET status = 'finished' WHERE id = $1`,
            [tournamentId]
        );
        if (champion?.dbUserId) {
            await db.query(
                `UPDATE user_stats
                 SET xp = xp + 500,
                     level = GREATEST(level, FLOOR(SQRT((xp + 500) / 50))::int),
                     updated_at = NOW()
                 WHERE user_id = $1`,
                [champion.dbUserId]
            );
        }
    } catch (err) {
        console.error('[TOURNAMENT] finalize error:', err.message);
    }

    broadcastToAll({
        type:            'tournament_end',
        tournamentId,
        champion:        championClientId,
        championDbId:    champion?.dbUserId ?? null,
    });

    delete tournamentWaitingWinners[tournamentId];
    console.log(`[TOURNAMENT] ${tournamentId} finished — champion: ${championClientId}`);
}

let tournamentWaitingWinners = {};

// ─────────────────────────────────────────────────────────────────────────────
//  ACHIEVEMENTS
// ─────────────────────────────────────────────────────────────────────────────
async function checkAndGrantAchievements(dbUserId) {
    try {
        const { rows: stats } = await db.query(
            'SELECT wins FROM user_stats WHERE user_id = $1',
            [dbUserId]
        );
        if (!stats.length) return;
        const { wins } = stats[0];

        const toGrant = [];
        if (wins >= 1)  toGrant.push('first_win');
        if (wins >= 10) toGrant.push('veteran');

        for (const key of toGrant) {
            await db.query(
                `INSERT INTO user_achievements (user_id, achievement_id)
                 SELECT $1, id FROM achievements WHERE key = $2
                 ON CONFLICT DO NOTHING`,
                [dbUserId, key]
            );
        }
    } catch (err) {
        console.error('[ACH] error:', err.message);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  BROADCAST HELPERS
// ─────────────────────────────────────────────────────────────────────────────
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
    for (const p of Object.values(players)) {
        if (p.ws?.readyState === WebSocket.OPEN) p.ws.send(raw);
    }
    for (const spec of Object.values(spectators)) {
        if (spec.ws?.readyState === WebSocket.OPEN) spec.ws.send(raw);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  STATE BROADCAST
// ─────────────────────────────────────────────────────────────────────────────
function broadcastState() {
    const snapshot = {};

    for (const [id, p] of Object.entries(players)) {
        snapshot[id] = {
            id:           p.id,
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

    const msg = JSON.stringify({
        type: 'state',
        frameId: ++frameId,
        players: snapshot,
    });

    for (const p of Object.values(players)) {
        if (p.ws.readyState === WebSocket.OPEN) p.ws.send(msg);
    }

    broadcastStateToSpectators();
}

// ─────────────────────────────────────────────────────────────────────────────
//  GAME MODE REST ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/duel', requireAuth, (req, res) => {
    const { clientId1, clientId2 } = req.body ?? {};
    if (!clientId1 || !clientId2 || clientId1 === clientId2)
        return res.status(400).json({ error: 'Two distinct clientIds are required' });
    if (!players[clientId1] || !players[clientId2])
        return res.status(404).json({ error: 'One or both players are not connected' });

    const session = startDuel(clientId1, clientId2);
    res.json({ sessionId: session.id });
});

app.post('/api/tournament', requireAuth, async (req, res) => {
    const { clientIds } = req.body ?? {};
    if (!Array.isArray(clientIds) || clientIds.length < 2)
        return res.status(400).json({ error: 'At least 2 players are required' });
    for (const cid of clientIds) {
        if (!players[cid])
            return res.status(404).json({ error: `Player ${cid} is not connected` });
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
        const { rows: tournament } = await db.query(
            'SELECT * FROM tournaments WHERE id = $1', [id]
        );
        if (!tournament.length) return res.status(404).json({ error: 'Tournament not found' });

        const { rows: participants } = await db.query(
            `SELECT tp.user_id, tp.eliminated, u.username, u.avatar_url
             FROM tournament_players tp
             JOIN users u ON u.id = tp.user_id
             WHERE tp.tournament_id = $1`, [id]
        );
        const { rows: tMatches } = await db.query(
            `SELECT tm.round, tm.match_id, m.winner_id, m.score1, m.score2,
                    m.player1_id, m.player2_id
             FROM tournament_matches tm
             JOIN matches m ON m.id = tm.match_id
             WHERE tm.tournament_id = $1
             ORDER BY tm.round, tm.id`, [id]
        );

        res.json({ tournament: tournament[0], participants, matches: tMatches });
    } catch (err) {
        console.error('[API] tournament fetch error:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

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

// ─────────────────────────────────────────────────────────────────────────────
//  DEV HELPERS
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/players', (req, res) => {
    const list = Object.values(players).map(p => ({
        clientId:  p.id,
        dbUserId:  p.dbUserId ?? null,
        inSession: playerSession.has(p.id),
    }));
    res.json({ players: list, spectatorCount: Object.keys(spectators).length });
});

app.get('/api/sessions', (req, res) => {
    const lobbySpectators = Object.values(spectators)
        .filter(s => s.watchingSession === null).length;

    res.json({
        sessions:        listActiveSessions(),
        lobbySpectators,
        totalSpectators: Object.keys(spectators).length,
    });
});

app.get('/api/spectators/:sessionId', requireAuth, async (req, res) => {
    const { sessionId } = req.params;
    try {
        const { rows } = await db.query(
            `SELECT sp.id, sp.user_id, u.username, u.avatar_url,
                    sp.mode, sp.joined_at, sp.left_at
             FROM spectators sp
             LEFT JOIN users u ON u.id = sp.user_id
             WHERE sp.session_id = $1
             ORDER BY sp.joined_at`,
            [sessionId]
        );
        res.json({ spectators: rows });
    } catch (err) {
        console.error('[API] spectators fetch error:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

app.post('/api/dev/duel', (req, res) => {
    const free = Object.values(players)
        .filter(p => !playerSession.has(p.id))
        .map(p => p.id);

    if (free.length < 2)
        return res.status(400).json({ error: 'Need at least 2 players not already in a session' });

    const sessions = [];
    for (let i = 0; i + 1 < free.length; i += 2) {
        const sess = startDuel(free[i], free[i + 1]);
        sessions.push(sess.id);
    }
    res.json({ sessions });
});

app.post('/api/dev/tournament', async (req, res) => {
    const free = Object.values(players)
        .filter(p => !playerSession.has(p.id))
        .map(p => p.id);

    if (free.length < 2)
        return res.status(400).json({ error: 'Need at least 2 players not already in a session' });

    try {
        const creatorDbId = req.user?.user_id ?? null;
        const tournamentId = await startTournament(free, creatorDbId);
        res.json({ tournamentId });
    } catch (err) {
        console.error('[DEV] tournament error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  HTTP SERVER
// ─────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] Listening on port ${PORT}`);
});