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

/** Genera un token de sesión seguro (hex de 64 bytes = 128 caracteres). */
function generateToken() {
    return crypto.randomBytes(64).toString('hex');
}

/** Parsea la cookie sid de la cabecera Cookie. */
function parseSidCookie(req) {
    const header = req.headers.cookie || '';
    for (const part of header.split(';')) {
        const [k, v] = part.trim().split('=');
        if (k === SESSION_COOKIE) return v;
    }
    return null;
}

/**
 * Middleware: adjunta req.user si la cookie de sesión es válida.
 * No rechaza; las rutas protegidas llaman a requireAuth().
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

/** Middleware: rechaza con 401 si no hay sesión válida. */
function requireAuth(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    next();
}

app.use(loadSession);

// ─────────────────────────────────────────────────────────────────────────────
//  AUTH ROUTES
// ─────────────────────────────────────────────────────────────────────────────

/** POST /api/register – Registro de nuevo usuario. */
app.post('/api/register', async (req, res) => {
    const { username, email, password } = req.body ?? {};

    if (!username || !email || !password)
        return res.status(400).json({ error: 'username, email y password son obligatorios' });

    if (password.length < 8)
        return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });

    try {
        const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

        const { rows } = await db.query(
            `INSERT INTO users (username, email, password_hash)
             VALUES ($1, $2, $3)
             RETURNING id, username, email, avatar_url, role`,
            [username.trim(), email.trim().toLowerCase(), hash]
        );

        // Crear estadísticas vacías
        await db.query(
            'INSERT INTO user_stats (user_id) VALUES ($1) ON CONFLICT DO NOTHING',
            [rows[0].id]
        );

        // Crear sesión automáticamente tras el registro
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
            return res.status(409).json({ error: 'Usuario o email ya existe' });
        console.error('[AUTH] register error:', err.message);
        res.status(500).json({ error: 'Error interno' });
    }
});

/** POST /api/login – Inicio de sesión. */
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body ?? {};

    if (!email || !password)
        return res.status(400).json({ error: 'email y password son obligatorios' });

    try {
        const { rows } = await db.query(
            'SELECT * FROM users WHERE email = $1',
            [email.trim().toLowerCase()]
        );

        const user = rows[0];
        if (!user) return res.status(401).json({ error: 'Credenciales incorrectas' });

        const match = await bcrypt.compare(password, user.password_hash);
        if (!match)  return res.status(401).json({ error: 'Credenciales incorrectas' });

        const token     = generateToken();
        const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
        await db.query(
            'INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)',
            [token, user.id, expiresAt]
        );

        // Marcar usuario como online
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
        res.status(500).json({ error: 'Error interno' });
    }
});

/** POST /api/logout – Cierra la sesión. */
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

/** GET /api/me – Devuelve el usuario actual. */
app.get('/api/me', requireAuth, (req, res) => {
    res.json({ user: req.user });
});

// ─────────────────────────────────────────────────────────────────────────────
//  SIMULACIÓN CONSTANTS  (sin cambios)
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
let nextClientId = 1;
const players   = {};
const lastState = {};

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
wss.on('connection', (ws) => {
    let clientId = null;

    ws.once('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { msg = {}; }

        if (msg.type === 'rejoin' && msg.clientId && !players[msg.clientId]) {
            clientId = msg.clientId;
            if (clientId >= nextClientId) nextClientId = clientId + 1;
        } else {
            clientId = nextClientId++;
        }

        const saved = lastState[clientId];
        if (saved) clearTimeout(saved.timer);

        players[clientId] = createPlayer(clientId, saved, ws);
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
        console.log(`[SERVER] Player ${clientId} connected`);

        ws.on('message', (raw) => {
            let msg;
            try { msg = JSON.parse(raw); } catch { return; }
            if (msg.type !== 'input') return;

            const p = players[clientId];
            if (!p) return;

            p.input.moveX      = msg.moveX      ?? 0;
            p.input.jump       = !!msg.jump;
            p.input.attack     = !!msg.attack;
            p.input.dash       = !!msg.dash;
            p.input.dashDir    = msg.dashDir     ?? 0;
            p.input.crouch     = !!msg.crouch;
            p.input.block      = !!msg.block;
            p.input.dashAttack = !!msg.dashAttack;
        });
    });

    ws.on('close', () => {
        if (clientId === null || !players[clientId]) return;

        const p = players[clientId];
        lastState[clientId] = {
            x:        p.x,
            y:        p.y,
            onGround: p.onGround,
            timer:    setTimeout(() => delete lastState[clientId], GHOST_TTL),
        };
        delete players[clientId];
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
            if (p.stocks === 0) p.stocks = 3;   // TODO: game-over logic

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
    for (const p of Object.values(players)) {
        if (p.ws.readyState === WebSocket.OPEN) p.ws.send(msg);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  HTTP SERVER
// ─────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] Listening on port ${PORT}`);
});