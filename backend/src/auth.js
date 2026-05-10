'use strict';

const bcrypt = require('bcrypt');
const crypto = require('crypto');
const db     = require('./db');

const BCRYPT_ROUNDS = 10;
const SESSION_DAYS  = 7;
const SESSION_COOKIE = 'sid';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateToken() {
    return crypto.randomBytes(64).toString('hex');
}

function parseSidCookie(req) {
    const header = req.headers.cookie || '';
    for (const part of header.split(';')) {
        const [k, v] = part.trim().split('=');
        if (k === SESSION_COOKIE) return v;
    }
    return null;
}

// ─── Middleware ────────────────────────────────────────────────────────────────

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

function requireAuth(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    next();
}

// ─── Route handlers ───────────────────────────────────────────────────────────

async function register(req, res) {
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
            expires:  expiresAt,
        });

        res.status(201).json({ user: rows[0] });

    } catch (err) {
        if (err.code === '23505')
            return res.status(409).json({ error: 'Username or email already exists' });
        console.error('[AUTH] register error:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
}

async function login(req, res) {
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
}

async function logout(req, res) {
    const token = parseSidCookie(req);
    try {
        await db.query('DELETE FROM sessions WHERE token = $1', [token]);
        await db.query('UPDATE users SET is_online = FALSE WHERE id = $1', [req.user.user_id]);
    } catch (err) {
        console.error('[AUTH] logout error:', err.message);
    }
    res.clearCookie(SESSION_COOKIE);
    res.json({ ok: true });
}

function me(req, res) {
    res.json({ user: req.user });
}

// ─── Export ───────────────────────────────────────────────────────────────────

module.exports = {
    loadSession,
    requireAuth,
    parseSidCookie,
    SESSION_COOKIE,
    register,
    login,
    logout,
    me,
};
