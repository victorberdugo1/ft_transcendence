/**
 * index.js  –  Backend de referencia para ft_transcendence multiplayer
 *
 * Instala dependencias:
 *   npm install ws express
 *
 * Arrancar:
 *   node index.js
 */

const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const path      = require('path');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

// Servir los ficheros estáticos del juego (game.js, game.wasm, data/, etc.)
app.use(express.static(path.join(__dirname, 'public')));

/* ─── Estado del servidor ─────────────────────────────────── */

let nextClientId = 1;

// players: { clientId: { id, x, y, z, rotation, animation, ws } }
const players = {};

const TICK_RATE  = 20;          // Hz
const MOVE_SPEED = 3.0;         // unidades/s
const TICK_DT    = 1 / TICK_RATE;

/* ─── WebSocket ───────────────────────────────────────────── */

wss.on('connection', (ws) => {
  const clientId = nextClientId++;

  players[clientId] = {
    id:        clientId,
    x:         (Math.random() - 0.5) * 6,  // posición aleatoria al entrar
    y:         0,
    z:         (Math.random() - 0.5) * 6,
    rotation:  0,
    animation: 'idle',
    ws,
    input: { dx: 0, dz: 0, rotation: 0, action: 0 },
  };

  console.log(`[SERVER] Cliente ${clientId} conectado. Total: ${Object.keys(players).length}`);

  // 1. Decirle su id
  ws.send(JSON.stringify({ type: 'init', clientId }));

  // 2. Mandar el estado actual inmediatamente
  broadcastState();

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); }
    catch { return; }

    if (msg.type === 'input') {
      const p = players[clientId];
      if (p) {
        p.input.dx       = msg.dx       || 0;
        p.input.dz       = msg.dz       || 0;
        p.input.rotation = msg.rotation || 0;
        p.input.action   = msg.action   || 0;
      }
    }
  });

  ws.on('close', () => {
    console.log(`[SERVER] Cliente ${clientId} desconectado`);
    delete players[clientId];
    broadcastState();
  });
});

/* ─── Game tick ───────────────────────────────────────────── */

setInterval(() => {
  for (const [, p] of Object.entries(players)) {
    const { dx, dz, rotation, action } = p.input;

    // Actualizar rotación
    p.rotation = rotation;

    // Mover en la dirección que mira el personaje
    if (dx !== 0 || dz !== 0) {
      p.x += Math.sin(p.rotation) * dz * MOVE_SPEED * TICK_DT;
      p.z += Math.cos(p.rotation) * dz * MOVE_SPEED * TICK_DT;
      p.animation = 'walk';
    } else if (action === 0) {
      p.animation = 'idle';
    }

    // Acciones puntuales
    if (action === 2) p.animation = 'jump';
    if (action === 3) p.animation = 'kick';
    if (action === 4) p.animation = 'punch';

    // Reset input acumulado
    p.input.dx = 0;
    p.input.dz = 0;
    p.input.action = 0;
  }

  broadcastState();
}, 1000 / TICK_RATE);

/* ─── Broadcast ───────────────────────────────────────────── */

function broadcastState() {
  // Preparar el payload sin la referencia al ws
  const snapshot = {};
  for (const [id, p] of Object.entries(players)) {
    snapshot[id] = {
      id:        p.id,
      x:         p.x,
      y:         p.y,
      z:         p.z,
      rotation:  p.rotation,
      animation: p.animation,
    };
  }

  const msg = JSON.stringify({ type: 'state', players: snapshot });

  for (const [, p] of Object.entries(players)) {
    if (p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(msg);
    }
  }
}

/* ─── Arrancar ────────────────────────────────────────────── */

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[SERVER] Escuchando en http://localhost:${PORT}`);
});