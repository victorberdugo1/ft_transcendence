'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  DEPENDENCIES
// ─────────────────────────────────────────────────────────────────────────────
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
    host:     process.env.PGHOST     || 'db',
    port:     process.env.PGPORT     || 5432,
    database: process.env.PGDATABASE || 'transcendence',
    user:     process.env.PGUSER     || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
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
const BCRYPT_ROUNDS   = 10;
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

        // Create empty stats row for new user
        await db.query(
            'INSERT INTO user_stats (user_id) VALUES ($1) ON CONFLICT DO NOTHING',
            [rows[0].id]
        );

        // Automatically create a session after registration
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
            expires:  expiresAt,
        });

        res.status(201).json({ user: rows[0] });

    } catch (err) {
        if (err.code === '23505') // unique_violation
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
        if (!match)  return res.status(401).json({ error: 'Invalid credentials' });

        const token     = generateToken();
        const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
        await db.query(
            'INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)',
            [token, user.id, expiresAt]
        );

        // Mark user as online
        await db.query('UPDATE users SET is_online = TRUE WHERE id = $1', [user.id]);

        res.cookie(SESSION_COOKIE, token, {
            httpOnly: true,
            secure:   process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            expires:  expiresAt,
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
const VOLTAGE_PER_HIT      =  12;
const VOLTAGE_DRAIN_BLOCK  =   8;
const VOLTAGE_SCALE_ATTACK = 1.0;
const VOLTAGE_SCALE_DEFEND = 1.0;

function voltageMultiplier(v) {
    if (v >= VOLTAGE_MAX) return 5.0;
    return 1.0 + Math.log(1 + v / 40) * 0.38;
}

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
const MAX_PLAYERS = 8;   // connections beyond this become spectators

let nextClientId = 1;
const players   = {};
const lastState = {};

// ─────────────────────────────────────────────────────────────────────────────
//  SPECTATOR REGISTRY
// ─────────────────────────────────────────────────────────────────────────────
/**
 * spectators[clientId] = {
 *   id, dbUserId, ws,
 *   watchingSession: string|null,  // sessionId being watched (null = lobby mode)
 *   mode: 'overflow'|'voluntary',
 *   dbRowId: number|null,          // spectators table PK for updating left_at
 * }
 */
const spectators = {};

// ─────────────────────────────────────────────────────────────────────────────
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
    let clientId  = null;
    let dbUserId  = null;
    let isSpectator = false;

    // Resolve DB user from session cookie on the upgrade request
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

    ws.once('message', async (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { msg = {}; }

        // ── Assign clientId ───────────────────────────────────────────────────
        if (msg.type === 'rejoin' && msg.clientId && !players[msg.clientId] && !spectators[msg.clientId]) {
            clientId = msg.clientId;
            if (clientId >= nextClientId) nextClientId = clientId + 1;
        } else {
            clientId = nextClientId++;
        }

        // ── Decide: player or spectator ───────────────────────────────────────
        // Voluntary spectator: client sends { type: 'watch', sessionId? }
        // Overflow spectator: no room for more players (> MAX_PLAYERS)
        const activePlayers   = Object.keys(players).length;
        const voluntaryWatch  = msg.type === 'watch';
        isSpectator = voluntaryWatch || activePlayers >= MAX_PLAYERS;

        if (isSpectator) {
            // ── SPECTATOR PATH ────────────────────────────────────────────────
            const mode            = voluntaryWatch ? 'voluntary' : 'overflow';
            const watchingSession = (voluntaryWatch && msg.sessionId)
                ? msg.sessionId
                : null;   // null = lobby (will receive all broadcasts)

            spectators[clientId] = {
                id: clientId,
                dbUserId,
                ws,
                watchingSession,
                mode,
                dbRowId: null,
            };

            // Persist to DB (best-effort)
            try {
                const sessionForDb = watchingSession ?? null;
                const tournamentId = watchingSession
                    ? (gameSessions.get(watchingSession)?.tournamentId ?? null)
                    : null;

                const { rows: dbRows } = await db.query(
                    `INSERT INTO spectators (user_id, session_id, tournament_id, mode)
                     VALUES ($1, $2, $3, $4) RETURNING id`,
                    [dbUserId, sessionForDb ?? 'lobby', tournamentId, mode]
                );
                spectators[clientId].dbRowId = dbRows[0]?.id ?? null;
            } catch (err) {
                console.error('[SPECTATOR] DB insert error:', err.message);
            }

            // Tell the client it's in spectator mode + send current state
            ws.send(JSON.stringify({
                type:     'spectator_mode',
                clientId,
                mode,
                watchingSession,
                activeSessions: listActiveSessions(),
            }));

            // Send current game state immediately so the view isn't blank
            sendStateToSpectator(spectators[clientId]);

            console.log(`[SPECTATOR] Client ${clientId} connected as ${mode} spectator` +
                        (watchingSession ? ` watching session ${watchingSession}` : ' (lobby)'));

            // ── Spectator message loop ────────────────────────────────────────
            ws.on('message', (raw2) => {
                let m2;
                try { m2 = JSON.parse(raw2); } catch { return; }

                // Allow spectator to switch the session they're watching
                if (m2.type === 'watch' && spectators[clientId]) {
                    spectators[clientId].watchingSession = m2.sessionId ?? null;
                    ws.send(JSON.stringify({
                        type:     'spectator_session_changed',
                        watchingSession: spectators[clientId].watchingSession,
                    }));
                    sendStateToSpectator(spectators[clientId]);
                }
                // All other messages (input, etc.) are silently ignored
            });

        } else {
            // ── PLAYER PATH (original behaviour) ─────────────────────────────
            const saved = lastState[clientId];
            if (saved) clearTimeout(saved.timer);

            players[clientId] = createPlayer(clientId, saved, ws);
            players[clientId].dbUserId = dbUserId;
            delete lastState[clientId];

            ws.send(JSON.stringify({
                type:     'init',
                clientId,
                config: {
                    attackRange:     ATTACK_RANGE,
                    attackRangeY:    ATTACK_RANGE_Y,
                    dashAttackRange: DASH_ATTACK_RANGE_X,
                },
            }));

            broadcastState();
            console.log(`[SERVER] Player ${clientId} connected (${activePlayers + 1}/${MAX_PLAYERS})`);

            ws.on('message', (raw2) => {
                let m2;
                try { m2 = JSON.parse(raw2); } catch { return; }
                if (m2.type !== 'input') return;

                const p = players[clientId];
                if (!p) return;

                p.input.moveX      = m2.moveX      ?? 0;
                p.input.jump       = !!m2.jump;
                p.input.attack     = !!m2.attack;
                p.input.dash       = !!m2.dash;
                p.input.dashDir    = m2.dashDir     ?? 0;
                p.input.crouch     = !!m2.crouch;
                p.input.block      = !!m2.block;
                p.input.dashAttack = !!m2.dashAttack;
            });
        }
    });

    ws.on('close', async () => {
        if (clientId === null) return;

        if (isSpectator && spectators[clientId]) {
            const spec = spectators[clientId];
            // Update left_at in DB
            if (spec.dbRowId) {
                db.query(`UPDATE spectators SET left_at = NOW() WHERE id = $1`, [spec.dbRowId])
                  .catch(err => console.error('[SPECTATOR] left_at update error:', err.message));
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
            timer:    setTimeout(() => delete lastState[clientId], GHOST_TTL),
        };
        delete players[clientId];
        playerSession.delete(clientId);
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
        dbUserId: null,    // set after createPlayer() by connection handler
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
    };
}

// ─────────────────────────────────────────────────────────────────────────────
//  GAME LOOP  (60 Hz)
// ─────────────────────────────────────────────────────────────────────────────
setInterval(tick, 1000 / TICK_RATE);

function tick() {
    const alive = Object.values(players).filter(p => !p.respawning);

    tickRespawn();
    for (const p of alive) tickPlayer(p);
    tickPhysics(alive);
    tickCollisions(alive);
    tickPlatforms(alive);
    tickAnimations(alive);

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
        p.onGround
        && !p.dashing
        && !p.attacking
        && !attack
        && !dashAttack
        && p.blockLockout   <= 0
        && p.dashEndWindow  <= 0
        && !p.voltageMaxed;

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
        p.vx         = p.dashDir * DASH_SPEED;

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
            p.vx = moveX * MOVE_SPEED * BLOCK_MOVE_FACTOR;
        } else if (crouch) {
            p.vx = 0;
        } else if (moveX !== 0) {
            p.vx    = moveX * MOVE_SPEED;
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
            p.vx     = moveX * MOVE_SPEED;
            p.facing = Math.sign(moveX);
        }
    }
}

function tickAttack(p, attack, dashAttack, crouch) {
    if (p.attackCooldown > 0) p.attackCooldown -= TICK_DT;
    if (p.comboWindow    > 0) p.comboWindow    -= TICK_DT;

    const isDashAttack = (attack || dashAttack) && p.dashEndWindow > 0;
    const canAttack    = (attack || (dashAttack && p.dashEndWindow > 0))
                         && !p.attacking
                         && p.attackCooldown <= 0;

    if (canAttack) {
        p.attacking     = true;
        p.attackTimer   = ATTACK_DURATION;
        p._isDashAttack = isDashAttack;

        const animName = resolveAttackAnim(p, isDashAttack, crouch);
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
    const rangeX = p._isDashAttack ? DASH_ATTACK_RANGE_X : ATTACK_RANGE;

    const hbCX = p.x + p.facing * (rangeX / 2);
    const hbCY = p.y + 0.5;
    const hbHW = rangeX / 2;
    const hbHH = ATTACK_RANGE_Y / 2;
    const hurtHW = 0.24;
    const hurtHH = 0.36;

    for (const target of alive) {
        if (target.id === p.id)            continue;
        if (p.hitTargets.has(target.id))   continue;

        const tCX = target.x;
        const tCY = target.y + 0.36;

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

    let kbx = dir * ATTACK_KNOCKBACK * totalMult;
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
        p.x    += (p.vx + p.kbx) * TICK_DT;
        p.y    += (p.vy + p.kby) * TICK_DT;
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
    const dx       = b.x - a.x;
    const dy       = b.y - a.y;
    const overlapX = 2 * PLAYER_RADIUS - Math.abs(dx);
    const overlapY = PLAYER_HEIGHT     - Math.abs(dy);

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
                return;   // player removed from game — skip respawn
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
//  SPECTATOR HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Returns a summary of all active game sessions (for the spectator lobby). */
function listActiveSessions() {
    const result = [];
    for (const [id, sess] of gameSessions.entries()) {
        const spectatorCount = Object.values(spectators)
            .filter(s => s.watchingSession === id).length;
        result.push({
            sessionId:    id,
            mode:         sess.mode,
            tournamentId: sess.tournamentId ?? null,
            round:        sess.round        ?? null,
            playerIds:    [...sess.playerIds],
            startedAt:    sess.startedAt,
            spectators:   spectatorCount,
        });
    }
    return result;
}

/**
 * Send the current game state to a single spectator.
 * If they're watching a specific session, only send that session's players;
 * otherwise send all players (lobby/overview mode).
 */
function sendStateToSpectator(spec) {
    if (!spec.ws || spec.ws.readyState !== WebSocket.OPEN) return;

    const snapshot = {};
    const sessionIds = spec.watchingSession
        ? new Set(gameSessions.get(spec.watchingSession)?.playerIds ?? [])
        : null;   // null = send everyone

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

    spec.ws.send(JSON.stringify({ type: 'state', players: snapshot }));
}

/** Broadcast state updates to all spectators as well as players. */
function broadcastStateToSpectators() {
    for (const spec of Object.values(spectators)) {
        sendStateToSpectator(spec);
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

    const msg = JSON.stringify({ type: 'state', players: snapshot });

    // Send to active players
    for (const p of Object.values(players)) {
        if (p.ws.readyState === WebSocket.OPEN) p.ws.send(msg);
    }

    // Send to spectators (filtered per session)
    broadcastStateToSpectators();
}

// ─────────────────────────────────────────────────────────────────────────────
//  GAME MODES
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Active game sessions. Key = sessionId (string).
 * Each session:
 *   { id, mode: '1v1'|'tournament', playerIds: Set<clientId>,
 *     eliminated: Set<clientId>,
 *     tournamentId: number|null,
 *     round: number,
 *     matchDbId: number|null,
 *     startedAt: Date }
 */
const gameSessions = new Map();
let nextSessionId = 1;

/**
 * Maps clientId → sessionId so a player can be looked up quickly.
 */
const playerSession = new Map();

// ─── 1v1 ─────────────────────────────────────────────────────────────────────

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
    };
    gameSessions.set(id, session);
    playerSession.set(clientId1, id);
    playerSession.set(clientId2, id);

    // Reset both players to full stocks
    for (const cid of [clientId1, clientId2]) {
        const p = players[cid];
        if (p) p.stocks = 3;
    }

    broadcastToSession(session, { type: 'match_start', mode: '1v1', sessionId: id });
    console.log(`[GAME] 1v1 started: session ${id} — players ${clientId1} vs ${clientId2}`);
    return session;
}

// ─── TOURNAMENT ───────────────────────────────────────────────────────────────

/**
 * Create a tournament in the DB and kick off round 1.
 * @param {number[]} clientIds   – exactly 8 (or 4, or 2) connected clientIds
 * @param {number}   creatorDbId – users.id of the creator
 */
async function startTournament(clientIds, creatorDbId) {
    if (clientIds.length < 2) throw new Error('Need at least 2 players for a tournament');

    // Power-of-2 bracket only
    const sizes = [2, 4, 8];
    const bracketSize = sizes.find(s => s >= clientIds.length) ?? 8;

    const { rows } = await db.query(
        `INSERT INTO tournaments (name, status, created_by)
         VALUES ($1, 'ongoing', $2) RETURNING id`,
        [`Tournament #${nextSessionId}`, creatorDbId]
    );
    const tournamentId = rows[0].id;

    // Register all participants
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

    // Shuffle and pair for round 1
    const shuffled = [...clientIds].sort(() => Math.random() - 0.5);
    const pairs     = [];
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

// ─── ELIMINATION ─────────────────────────────────────────────────────────────

/**
 * Called when a player reaches 0 stocks.
 * Handles session bookkeeping, DB writes, and tournament advancement.
 */
function handleElimination(loser) {
    const sessionId = playerSession.get(loser.id);
    const session   = sessionId ? gameSessions.get(sessionId) : null;

    // Snapshot the loser's DB identity and remaining stocks BEFORE removing from players[].
    // resolveMatchWinner() needs these after the player object is gone.
    if (session) {
        session.eliminated.add(loser.id);
        session.loserDbId    = loser.dbUserId ?? null;
        session.loserStocks  = loser.stocks   ?? 0;
    }
    delete players[loser.id];
    playerSession.delete(loser.id);

    broadcastState();
    broadcastToAll({ type: 'player_eliminated', clientId: loser.id });

    if (!session) return;

    const remaining = [...session.playerIds].filter(id => !session.eliminated.has(id));

    if (remaining.length === 1) {
        // We have a winner for this match
        const winnerId = remaining[0];
        resolveMatchWinner(session, winnerId, loser.id);
    }
}

/** Persist the match result and, for tournaments, advance the bracket. */
async function resolveMatchWinner(session, winnerClientId, loserClientId) {
    const winner     = players[winnerClientId];
    const winnerDbId = winner?.dbUserId ?? null;
    // loserDbId and loserStocks were captured by handleElimination() before
    // the loser was removed from players[], so they are always available here.
    const loserDbId   = session.loserDbId   ?? null;
    const loserStocks = session.loserStocks  ?? 0;

    try {
        // ── Persist match to DB ─────────────────────────────────────────────
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

        // ── Link to tournament_matches if applicable ────────────────────────
        if (session.tournamentId && session.matchDbId) {
            await db.query(
                `INSERT INTO tournament_matches (tournament_id, match_id, round)
                 VALUES ($1, $2, $3)`,
                [session.tournamentId, session.matchDbId, session.round]
            );
        }

        // ── Update user_stats ───────────────────────────────────────────────
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

    // ── Notify clients ───────────────────────────────────────────────────────
    broadcastToSession(session, {
        type:     'match_end',
        winner:   winnerClientId,
        loser:    loserClientId,
        matchId:  session.matchDbId,
        mode:     session.mode,
    });

    console.log(`[GAME] Match resolved — winner: ${winnerClientId}, session: ${session.id}`);

    // ── Tournament bracket advancement ───────────────────────────────────────
    if (session.mode === 'tournament') {
        advanceTournament(session.tournamentId, winnerClientId);
    }

    // Clean up session
    gameSessions.delete(session.id);
}

/**
 * Check if there are enough tournament winners waiting for the next round,
 * and start the next round's matches when ready.
 */
async function advanceTournament(tournamentId, newWinnerId) {
    // Collect winners waiting for next round (not yet in a session)
    if (!tournamentWaitingWinners) tournamentWaitingWinners = {};
    if (!tournamentWaitingWinners[tournamentId]) {
        tournamentWaitingWinners[tournamentId] = [];
    }
    tournamentWaitingWinners[tournamentId].push(newWinnerId);

    const waiting = tournamentWaitingWinners[tournamentId];

    if (waiting.length < 2) {
        // Not enough winners yet to form a new match
        broadcastToAll({
            type: 'tournament_waiting',
            tournamentId,
            waitingCount: waiting.length,
        });
        return;
    }

    // Determine round number from DB
    const { rows: roundRows } = await db.query(
        `SELECT MAX(round) AS max_round FROM tournament_matches WHERE tournament_id = $1`,
        [tournamentId]
    );
    const nextRound = (roundRows[0].max_round ?? 0) + 1;

    // Pair waiting winners into new matches
    while (waiting.length >= 2) {
        const [a, b] = waiting.splice(0, 2);
        const sess   = await startTournamentMatch(a, b, tournamentId, nextRound);
        console.log(`[TOURNAMENT] Round ${nextRound}: ${a} vs ${b} → session ${sess.id}`);
    }

    // If exactly 1 winner remains it's the tournament champion
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
            // Grant extra XP for winning the tournament
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

// Keyed by tournamentId → array of clientIds waiting for their next match
let tournamentWaitingWinners = {};

// ─── ACHIEVEMENTS ─────────────────────────────────────────────────────────────

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

// ─── BROADCAST HELPERS ────────────────────────────────────────────────────────

function broadcastToSession(session, msg) {
    const raw = JSON.stringify(msg);
    // Send to players in the session
    for (const cid of session.playerIds) {
        const p = players[cid];
        if (p?.ws?.readyState === WebSocket.OPEN) p.ws.send(raw);
    }
    // Also send to spectators watching this session
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
    // Spectators also get global events (eliminations, tournament updates)
    for (const spec of Object.values(spectators)) {
        if (spec.ws?.readyState === WebSocket.OPEN) spec.ws.send(raw);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  GAME MODE REST ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

/** POST /api/duel  – Start a 1v1 between two clientIds.
 *  Body: { clientId1: number, clientId2: number }
 */
app.post('/api/duel', requireAuth, (req, res) => {
    const { clientId1, clientId2 } = req.body ?? {};
    if (!clientId1 || !clientId2 || clientId1 === clientId2)
        return res.status(400).json({ error: 'Two distinct clientIds are required' });
    if (!players[clientId1] || !players[clientId2])
        return res.status(404).json({ error: 'One or both players are not connected' });

    const session = startDuel(clientId1, clientId2);
    res.json({ sessionId: session.id });
});

/** POST /api/tournament – Start a tournament.
 *  Body: { clientIds: number[] }  (2, 4 or 8 elements)
 */
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

/** GET /api/tournament/:id – Get bracket status. */
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

/** GET /api/leaderboard – Top 10 by wins. */
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
//  DEV HELPERS  — remove or gate behind NODE_ENV before going to production
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/players
 * Returns the list of currently connected WebSocket clients.
 * Useful for picking clientIds to pass to /api/duel or /api/tournament.
 *
 * Response: { players: [ { clientId, dbUserId, inSession } ], spectatorCount }
 */
app.get('/api/players', (req, res) => {
    const list = Object.values(players).map(p => ({
        clientId:  p.id,
        dbUserId:  p.dbUserId ?? null,
        inSession: playerSession.has(p.id),
    }));
    res.json({ players: list, spectatorCount: Object.keys(spectators).length });
});

/**
 * GET /api/sessions
 * Lists all active game sessions — used by the spectator lobby UI.
 * Public — no auth required.
 *
 * Response: { sessions: [...], lobbySpectators: number, totalSpectators: number }
 */
app.get('/api/sessions', (req, res) => {
    const lobbySpectators = Object.values(spectators)
        .filter(s => s.watchingSession === null).length;

    res.json({
        sessions:        listActiveSessions(),
        lobbySpectators,
        totalSpectators: Object.keys(spectators).length,
    });
});

/**
 * GET /api/spectators/:sessionId
 * Returns the DB history of who watched a specific session (past + current).
 * Requires auth.
 *
 * Response: { spectators: [...] }
 */
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

/**
 * POST /api/dev/duel
 * Starts a 1v1 between ALL connected players that are not already in a session.
 * Pairs them in connection order; any leftover player waits.
 * No auth required — for local development only.
 *
 * Response: { sessions: [ sessionId, ... ] }
 */
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

/**
 * POST /api/dev/tournament
 * Starts a tournament with ALL connected players that are not already in a session.
 * No auth required — for local development only.
 *
 * Response: { tournamentId }
 */
app.post('/api/dev/tournament', async (req, res) => {
    const free = Object.values(players)
        .filter(p => !playerSession.has(p.id))
        .map(p => p.id);

    if (free.length < 2)
        return res.status(400).json({ error: 'Need at least 2 players not already in a session' });

    try {
        // Use id=0 as the creator when no authenticated user is present
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