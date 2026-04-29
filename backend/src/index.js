/**
 * backend/src/index.js
 *
 * Servidor del juego ft_transcendence.
 *
 * RESPONSABILIDADES:
 *   1. Game loop autoritativo (el servidor decide el estado)
 *   2. WebSocket: manda el estado a todos los clientes conectados
 *   3. REST API: base para autenticación, usuarios, etc.
 *   4. Conexión a PostgreSQL
 *
 * FLUJO:
 *   Cliente Raylib (WASM) ──input──▶ WebSocket ──▶ [aquí] actualiza estado
 *   [aquí] game loop ──state──▶ WebSocket ──▶ Cliente Raylib (renderiza)
 */

require('dotenv').config();

const express    = require('express');
const http       = require('http');
const WebSocket  = require('ws');
const { Pool }   = require('pg');

/* ─── App ─────────────────────────────────────────────────── */
const app    = express();
const server = http.createServer(app);
app.use(express.json());

/* ─── Base de datos ───────────────────────────────────────── */
const db = new Pool({
    host:     process.env.DB_HOST     || 'db',
    port:     parseInt(process.env.DB_PORT) || 5432,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
});

db.connect()
    .then(() => console.log('✅ PostgreSQL conectado'))
    .catch(err => console.error('❌ PostgreSQL error:', err.message));

/* ─── WebSocket ───────────────────────────────────────────── */
/*
 * IMPORTANTE: nginx hace proxy de /ws a este servidor.
 * El servidor WS escucha en la misma ruta que el HTTP.
 */
const wss = new WebSocket.Server({ server, path: '/ws' });

const clients = new Set();

wss.on('connection', (ws, req) => {
    console.log(`[WS] Cliente conectado. Total: ${clients.size + 1}`);
    clients.add(ws);

    /* Mandar el estado actual inmediatamente al conectarse */
    ws.send(JSON.stringify(gameState));

    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw);
            handleInput(msg);
        } catch (e) {
            console.warn('[WS] Mensaje inválido:', raw);
        }
    });

    ws.on('close', () => {
        clients.delete(ws);
        console.log(`[WS] Cliente desconectado. Total: ${clients.size}`);
    });

    ws.on('error', (err) => {
        console.error('[WS] Error:', err.message);
        clients.delete(ws);
    });
});

/** Manda el estado actual a TODOS los clientes conectados */
function broadcast(data) {
    const msg = JSON.stringify(data);
    for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(msg);
        }
    }
}

/* ────────────────────────────────────────────────────────────
 *  ESTADO DEL JUEGO  [SWAP FÁCIL]
 *
 *  Cambia estos campos para tu juego.
 *  El código C (main.c) lee exactamente estos nombres con
 *  ws_get_float("ball_x"), ws_get_int("score1"), etc.
 * ────────────────────────────────────────────────────────────*/
const SCREEN_W = parseInt(process.env.SCREEN_WIDTH)  || 800;
const SCREEN_H = parseInt(process.env.SCREEN_HEIGHT) || 600;
const PADDLE_H = 80;
const BALL_R   = 10;

let gameState = {
    ball_x:  SCREEN_W / 2,
    ball_y:  SCREEN_H / 2,
    ball_vx: 4,           // velocidad (solo backend, no se manda)
    ball_vy: 3,
    p1_y:    SCREEN_H / 2 - PADDLE_H / 2,
    p2_y:    SCREEN_H / 2 - PADDLE_H / 2,
    score1:  0,
    score2:  0,
};

/* ────────────────────────────────────────────────────────────
 *  MANEJO DE INPUT  [SWAP FÁCIL]
 * ────────────────────────────────────────────────────────────*/
const PADDLE_SPEED = 6;

function handleInput(msg) {
    if (msg.type !== 'input') return;

    const speed = msg.direction * PADDLE_SPEED;

    if (msg.player === 1) {
        gameState.p1_y = clamp(gameState.p1_y + speed, 0, SCREEN_H - PADDLE_H);
    } else if (msg.player === 2) {
        gameState.p2_y = clamp(gameState.p2_y + speed, 0, SCREEN_H - PADDLE_H);
    }
}

/* ────────────────────────────────────────────────────────────
 *  GAME LOOP AUTORITATIVO  [SWAP FÁCIL]
 *
 *  El servidor calcula la física y manda el estado a los clientes.
 *  Los clientes (Raylib WASM) solo visualizan.
 * ────────────────────────────────────────────────────────────*/
const TICK_RATE = parseInt(process.env.GAME_TICK_RATE) || 60;

setInterval(() => {
    updateGameState();
    broadcast(getPublicState());
}, 1000 / TICK_RATE);

function updateGameState() {
    /* Mover la pelota */
    gameState.ball_x += gameState.ball_vx;
    gameState.ball_y += gameState.ball_vy;

    /* Rebotar en paredes arriba/abajo */
    if (gameState.ball_y - BALL_R <= 0 || gameState.ball_y + BALL_R >= SCREEN_H) {
        gameState.ball_vy *= -1;
        gameState.ball_y = clamp(gameState.ball_y, BALL_R, SCREEN_H - BALL_R);
    }

    /* Colisión con paleta izquierda (P1) */
    if (gameState.ball_x - BALL_R <= 35 &&
        gameState.ball_y >= gameState.p1_y &&
        gameState.ball_y <= gameState.p1_y + PADDLE_H)
    {
        gameState.ball_vx = Math.abs(gameState.ball_vx); // rebota a la derecha
    }

    /* Colisión con paleta derecha (P2) */
    if (gameState.ball_x + BALL_R >= SCREEN_W - 35 &&
        gameState.ball_y >= gameState.p2_y &&
        gameState.ball_y <= gameState.p2_y + PADDLE_H)
    {
        gameState.ball_vx = -Math.abs(gameState.ball_vx); // rebota a la izquierda
    }

    /* Punto para P2 (pelota sale por la izquierda) */
    if (gameState.ball_x < 0) {
        gameState.score2++;
        resetBall();
    }

    /* Punto para P1 (pelota sale por la derecha) */
    if (gameState.ball_x > SCREEN_W) {
        gameState.score1++;
        resetBall();
    }
}

function resetBall() {
    gameState.ball_x  = SCREEN_W / 2;
    gameState.ball_y  = SCREEN_H / 2;
    gameState.ball_vx = (Math.random() > 0.5 ? 1 : -1) * 4;
    gameState.ball_vy = (Math.random() > 0.5 ? 1 : -1) * 3;
}

/** Solo manda los campos que el cliente necesita (sin velocidades internas) */
function getPublicState() {
    return {
        ball_x:  gameState.ball_x,
        ball_y:  gameState.ball_y,
        p1_y:    gameState.p1_y,
        p2_y:    gameState.p2_y,
        score1:  gameState.score1,
        score2:  gameState.score2,
    };
}

/* ─── REST API ────────────────────────────────────────────── */
/*
 * Base para los módulos del subject.
 * Añade rutas aquí o en ficheros separados (routes/).
 */

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', clients: clients.size });
});

app.get('/api/state', (req, res) => {
    res.json(getPublicState());
});

/* Placeholder: autenticación (módulo User Management) */
app.post('/api/auth/register', async (req, res) => {
    // TODO: implementar registro con bcrypt + JWT
    res.status(501).json({ error: 'Not implemented yet' });
});

app.post('/api/auth/login', async (req, res) => {
    // TODO: implementar login
    res.status(501).json({ error: 'Not implemented yet' });
});

/* ─── Arrancar servidor ───────────────────────────────────── */
const PORT = parseInt(process.env.PORT) || 3000;
server.listen(PORT, () => {
    console.log(`✅ Servidor escuchando en :${PORT}`);
    console.log(`   WebSocket: ws://localhost:${PORT}/ws`);
    console.log(`   API:       http://localhost:${PORT}/api`);
});

/* ─── Utilidades ──────────────────────────────────────────── */
function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}
