/**
 * index.js  –  Backend para ft_transcendence multiplayer
 */

const http      = require('http');
const WebSocket = require('ws');

const server = http.createServer();
const wss    = new WebSocket.Server({ server });

/* ─── Duración mínima de animaciones de acción (segundos) ─── */
// El servidor mantiene la animación activa al menos este tiempo
// antes de volver a idle, aunque el cliente ya no mande el action.
const ANIM_DURATIONS = {
  jump:  0.8,
  kick:  0.7,
  punch: 0.6,
};

/* ─── Estado del servidor ─────────────────────────────────── */

let nextClientId = 1;

// players: { clientId: { id, x, y, z, rotation, animation, ws, input,
//                         animTimer, isMoving } }
const players = {};

const TICK_RATE  = 20;
const MOVE_SPEED = 3.0;
const TICK_DT    = 1 / TICK_RATE;

/* ─── WebSocket ───────────────────────────────────────────── */

wss.on('connection', (ws) => {
  const clientId = nextClientId++;

  players[clientId] = {
    id:        clientId,
    x:         (Math.random() - 0.5) * 6,
    y:         0,
    z:         (Math.random() - 0.5) * 6,
    rotation:  0,
    animation: 'idle',
    ws,
    input:     { dx: 0, dz: 0, rotation: 0, action: 0 },
    animTimer: 0,      // tiempo restante de la animación de acción actual
    isMoving:  false,  // se actualiza por acumulación entre ticks
  };

  console.log(`[SERVER] Cliente ${clientId} conectado. Total: ${Object.keys(players).length}`);

  ws.send(JSON.stringify({ type: 'init', clientId }));
  broadcastState();

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); }
    catch { return; }

    if (msg.type === 'input') {
      const p = players[clientId];
      if (!p) return;

      p.input.rotation = (msg.rotation !== undefined) ? msg.rotation : 0;

      // Acumular movimiento: si en CUALQUIER mensaje del cliente hay dz!=0,
      // marcamos isMoving=true para este tick. Se limpia al final del tick.
      if (msg.dz !== 0 || msg.dx !== 0) {
        p.isMoving = true;
        p.input.dx = msg.dx || 0;
        p.input.dz = msg.dz || 0;
      }

      // Acción: solo sobreescribir si no hay ya una acción en curso
      // (evita que un action=0 posterior en el mismo tick borre la acción)
      if (msg.action && msg.action !== 0) {
        p.input.action = msg.action;
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

    // 1. Actualizar rotación siempre
    p.rotation = rotation;

    // 2. Mover si hay input de movimiento acumulado
    if (p.isMoving) {
      p.x += Math.sin(p.rotation) * dz * MOVE_SPEED * TICK_DT;
      p.z += Math.cos(p.rotation) * dz * MOVE_SPEED * TICK_DT;
    }

    // 3. Resolver animación
    if (action !== 0 && actionName(action) !== '') {
      // Acción nueva: iniciar timer
      const name = actionName(action);
      p.animation = name;
      p.animTimer = ANIM_DURATIONS[name];

    } else if (p.animTimer > 0) {
      // Acción en curso: decrementar timer, mantener animación
      p.animTimer -= TICK_DT;
      if (p.animTimer <= 0) {
        p.animTimer = 0;
        // Al terminar la acción, decidir qué viene después
        p.animation = p.isMoving ? 'walk' : 'idle';
      }
      // Si animTimer > 0 no tocamos p.animation

    } else {
      // Sin acción activa: walk o idle según movimiento
      p.animation = p.isMoving ? 'walk' : 'idle';
    }

    // 4. Limpiar input para el siguiente tick
    p.input.dx     = 0;
    p.input.dz     = 0;
    p.input.action = 0;
    p.isMoving     = false;
    /* rotation NO se resetea: mantener la última hasta que el cliente mande otra */
  }

  broadcastState();
}, 1000 / TICK_RATE);

/* ─── Helper ──────────────────────────────────────────────── */

function actionName(action) {
  if (action === 2) return 'jump';
  if (action === 3) return 'kick';
  if (action === 4) return 'punch';
  return '';
}

/* ─── Broadcast ───────────────────────────────────────────── */

function broadcastState() {
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