const http      = require('http');
const WebSocket = require('ws');

const server = http.createServer();
const wss = new WebSocket.Server({ noServer: true });

/* ─── CONFIG ─── */

const ANIM_DURATIONS = {
  jump:  0.8,
  kick:  0.7,
  punch: 0.6,
};

let nextClientId = 1;
const players = {};

const TICK_RATE        = 20;
const MOVE_SPEED       = 3.0;
const TICK_DT          = 1 / TICK_RATE;
const IDLE_GRACE_TICKS = 3; // ticks de gracia antes de volver a idle (~150ms)

/* ─── UPGRADE ─── */

server.on('upgrade', (request, socket, head) => {
  if (request.url === '/ws') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

/* ─── WEBSOCKET ─── */

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
    animTimer: 0,
    isMoving:  false,
    idleGrace: 0,
  };

  console.log(`[SERVER] Cliente ${clientId} conectado`);

  ws.send(JSON.stringify({ type: 'init', clientId }));
  broadcastState();

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); }
    catch { return; }

    if (msg.type === 'input') {
      const p = players[clientId];
      if (!p) return;

      p.input.rotation = msg.rotation ?? 0;

      if (msg.dz !== 0 || msg.dx !== 0) {
        p.isMoving = true;
        p.input.dx = msg.dx || 0;
        p.input.dz = msg.dz || 0;
      }

      if (msg.action && msg.action !== 0) {
        p.input.action = msg.action;
      }
    }
  });

  ws.on('close', () => {
    delete players[clientId];
    console.log(`[SERVER] Cliente ${clientId} desconectado`);
    broadcastState();
  });
});

/* ─── GAME LOOP ─── */

setInterval(() => {
  for (const [, p] of Object.entries(players)) {
    const { dx, dz, rotation, action } = p.input;

    p.rotation = rotation;

    if (p.isMoving) {
      p.x += Math.sin(p.rotation) * dz * MOVE_SPEED * TICK_DT;
      p.z += Math.cos(p.rotation) * dz * MOVE_SPEED * TICK_DT;
      p.idleGrace = IDLE_GRACE_TICKS;
    } else if (p.idleGrace > 0) {
      p.idleGrace--;
    }

    const isEffectivelyMoving = p.isMoving || p.idleGrace > 0;

    if (action !== 0 && actionName(action)) {
      const name = actionName(action);
      p.animation = name;
      p.animTimer = ANIM_DURATIONS[name];

    } else if (p.animTimer > 0) {
      p.animTimer -= TICK_DT;
      if (p.animTimer <= 0) {
        p.animation = isEffectivelyMoving ? 'walk' : 'idle';
      }

    } else {
      p.animation = isEffectivelyMoving ? 'walk' : 'idle';
    }

    p.input.dx     = 0;
    p.input.dz     = 0;
    p.input.action = 0;
    p.isMoving     = false;
  }

  broadcastState();
}, 1000 / TICK_RATE);

/* ─── HELPERS ─── */

function actionName(action) {
  if (action === 2) return 'jump';
  if (action === 3) return 'kick';
  if (action === 4) return 'punch';
  return '';
}

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

/* ─── START ─── */

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[SERVER] WS listo en puerto ${PORT}`);
});