const http      = require('http');
const WebSocket = require('ws');
const express   = require('express');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ noServer: true });

app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', players: Object.keys(players).length });
});

/* ─── CONFIG ─── */

const TICK_RATE   = 60;
const TICK_DT     = 1 / TICK_RATE;
const GHOST_TTL   = 30_000;

const GRAVITY          = -28.0;
const JUMP_FORCE       = 12.0;
const MOVE_SPEED       = 5.0;
const DASH_SPEED       = 14.0;
const DASH_DURATION    = 0.12;
const DASH_COOLDOWN    = 0.5;
const GROUND_Y         = 0.0;
const KNOCKBACK_DECAY  = 0.85;
const MIN_KNOCKBACK    = 0.05;

const STAGE_LEFT   = -8.0;
const STAGE_RIGHT  =  8.0;
const STAGE_BOTTOM = -6.0;

const ATTACK_DURATION   = 0.3;
const ATTACK_COOLDOWN   = 0.5;
const ATTACK_RANGE      = 1.4;
const ATTACK_RANGE_Y    = 0.8;
const ATTACK_KNOCKBACK  = 14.0;
const ATTACK_KB_UP      = 6.0;

const ANIM_DURATIONS = { jump: 0.8, kick: 0.7, punch: 0.6, dash: 0.15, hurt: 0.4 };

let nextClientId = 1;
const players    = {};
const lastState  = {};

/* ─── UPGRADE ─── */

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws') {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

/* ─── WEBSOCKET ─── */

wss.on('connection', (ws) => {
  let clientId = null;

  ws.once('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { msg = {}; }

    if (msg.type === 'rejoin' && msg.clientId && !players[msg.clientId]) {
      clientId = msg.clientId;
      if (clientId >= nextClientId) nextClientId = clientId + 1;
    } else {
      clientId = nextClientId++;
    }

    const saved = lastState[clientId];
    if (saved) clearTimeout(saved.timer);

    const spawnX = (Math.random() - 0.5) * 4;

    const restoredX = saved ? saved.x : spawnX;
    const restoredY = saved ? saved.y : GROUND_Y;
    const restoredOnGround = saved ? (saved.onGround ?? true) : true;

    players[clientId] = {
      id:        clientId,
      x:         restoredX,
      y:         restoredY,
      vx: 0, vy: 0,
      kbx: 0, kby: 0,
      onGround:      restoredOnGround,
      jumpsLeft:     restoredOnGround ? 2 : 1,
      facing:        1,
      dashing:       false,
      dashTimer:     0,
      dashDir:       0,
      dashCooldown:  0,
      attacking:     false,
      attackTimer:   0,
      attackCooldown:0,
      animation:    'idle',
      animTimer:    0,
      hitId:        0,
      stocks:       3,
      score:        0,
      respawning:   false,
      respawnTimer: 0,
      crouching:    false,
      input: { moveX: 0, jump: false, attack: false, dash: false, dashDir: 0, crouch: false },
      ws,
    };

    delete lastState[clientId];

    ws.send(JSON.stringify({ type: 'init', clientId }));
    broadcastState();
    console.log(`[SERVER] Jugador ${clientId} conectado`);

    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === 'input') {
        const p = players[clientId];
        if (!p) return;
        p.input.moveX   = msg.moveX  ?? 0;
        p.input.jump    = !!msg.jump;
        p.input.attack  = !!msg.attack;
        p.input.dash    = !!msg.dash;
        p.input.dashDir = msg.dashDir ?? 0;
        p.input.crouch  = !!msg.crouch;
      }
    });
  });

  ws.on('close', () => {
    if (clientId !== null && players[clientId]) {
      const p = players[clientId];
      lastState[clientId] = {
        x: p.x, y: p.y, onGround: p.onGround,
        timer: setTimeout(() => delete lastState[clientId], GHOST_TTL),
      };
      delete players[clientId];
      console.log(`[SERVER] Jugador ${clientId} desconectado`);
      broadcastState();
    }
  });

  ws.on('error', () => ws.close());
});

/* ─── CONSTANTES DE FÍSICA ─── */

const PLATFORMS = [
  { x: 0,  y: GROUND_Y, hw: (STAGE_RIGHT - STAGE_LEFT) / 2 },
  { x: -4, y: 1.6,      hw: 1.2 },
  { x:  4, y: 1.6,      hw: 1.2 },
  { x:  0, y: 2.8,      hw: 1.2 },
];

const PLAYER_RADIUS = 0.45;
const PLAYER_HEIGHT = 1.6;

/* ─── GAME LOOP ─── */

setInterval(() => {
  const alive = Object.values(players).filter(p => !p.respawning);

  for (const p of Object.values(players)) {
    if (!p.respawning) continue;
    p.respawnTimer -= TICK_DT;
    if (p.respawnTimer <= 0) {
      p.respawning = false;
      p.x  = (Math.random() - 0.5) * 4;
      p.y  = 2.0;
      p.vx = 0; p.vy = 0;
      p.kbx = 0; p.kby = 0;
      p.jumpsLeft = 2;
      p.onGround  = false;
      p.animation = 'idle';
    }
  }

  for (const p of alive) {
    const { moveX, jump, attack, dash, dashDir, crouch } = p.input;
    p.input.jump   = false;
    p.input.attack = false;
    p.input.dash   = false;

    if (p.dashCooldown > 0) p.dashCooldown -= TICK_DT;
    if (dash && !p.dashing && p.dashCooldown <= 0) {
      p.dashing      = true;
      p.dashTimer    = DASH_DURATION;
      p.dashDir      = dashDir !== 0 ? Math.sign(dashDir) : p.facing;
      p.dashCooldown = DASH_COOLDOWN;
      p.kbx = 0; p.kby = 0;
      p.animation = 'dash';
      p.animTimer = ANIM_DURATIONS.dash;
    }

    if (p.dashing) {
      p.dashTimer -= TICK_DT;
      p.vx = p.dashDir * DASH_SPEED;
      if (p.dashTimer <= 0) { p.dashing = false; p.vx = 0; }
    } else {
      if (crouch) {
        p.vx = 0;
      } else if (moveX !== 0) {
        p.vx = moveX * MOVE_SPEED;
        p.facing = Math.sign(moveX);
      } else {
        p.vx = 0;
      }
    }

    p.crouching = p.onGround && !p.dashing && !p.attacking && crouch;

    if (jump && p.jumpsLeft > 0) {
      p.vy = JUMP_FORCE;
      p.jumpsLeft--;
      p.onGround = false;
      p.animation = 'jump';
      p.animTimer = ANIM_DURATIONS.jump;
      if (!p.dashing && moveX !== 0) {
        p.vx = moveX * MOVE_SPEED;
        p.facing = Math.sign(moveX);
      }
    }

    if (p.attackCooldown > 0) p.attackCooldown -= TICK_DT;
    if (attack && !p.attacking && p.attackCooldown <= 0) {
      p.attacking      = true;
      p.attackTimer    = ATTACK_DURATION;
      p.attackCooldown = ATTACK_COOLDOWN;
      const animName   = p.onGround ? 'punch' : 'kick';
      p.animation = animName;
      p.animTimer = ANIM_DURATIONS[animName];

      for (const other of alive) {
        if (other.id === p.id) continue;
        const dx = other.x - p.x;
        const dy = other.y - p.y;
        const inFront = Math.sign(dx) === p.facing || Math.abs(dx) < 0.3;
        if (inFront && Math.abs(dx) < ATTACK_RANGE && Math.abs(dy) < ATTACK_RANGE_Y) {
          const dir = dx >= 0 ? 1 : -1;
          other.kbx += dir * ATTACK_KNOCKBACK;
          other.kby += ATTACK_KB_UP;
          other.hitId++;
          other.animation = 'hurt';
          other.animTimer = ANIM_DURATIONS.hurt;
          other.dashing   = false;
          other.attacking = false;
          other.onGround  = false;
        }
      }
    }

    if (p.attackTimer > 0) {
      p.attackTimer -= TICK_DT;
      if (p.attackTimer <= 0) p.attacking = false;
    }
  }

  for (const p of alive) {
    p.kbx *= Math.pow(KNOCKBACK_DECAY, TICK_DT * TICK_RATE);
    p.kby *= Math.pow(KNOCKBACK_DECAY, TICK_DT * TICK_RATE);
    if (Math.abs(p.kbx) < MIN_KNOCKBACK) p.kbx = 0;
    if (Math.abs(p.kby) < MIN_KNOCKBACK) p.kby = 0;

    if (!p.onGround) p.vy += GRAVITY * TICK_DT;

    // Guardar Y antes de mover — necesario para la detección de plataformas
    p.prevY = p.y;

    p.x += (p.vx + p.kbx) * TICK_DT;
    p.y += (p.vy + p.kby) * TICK_DT;
  }

  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      const a = alive[i];
      const b = alive[j];

      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const overlapX = 2 * PLAYER_RADIUS - Math.abs(dx);
      const overlapY = PLAYER_HEIGHT - Math.abs(dy);

      if (overlapX <= 0 || overlapY <= 0) continue;

      const dir = dx >= 0 ? 1 : -1;

      const va = a.vx + a.kbx;
      const vb = b.vx + b.kbx;

      const aMoving = Math.abs(a.vx) > 0.1 || Math.abs(a.kbx) > 0.5;
      const bMoving = Math.abs(b.vx) > 0.1 || Math.abs(b.kbx) > 0.5;
      const opposite = Math.sign(va) !== Math.sign(vb) && aMoving && bMoving;

      if (opposite) {
        const bounce = 1.5;
        a.kbx -= dir * bounce;
        b.kbx += dir * bounce;
      } else if (aMoving && !bMoving) {
        b.kbx += dir * Math.abs(va) * 0.5;
      } else if (bMoving && !aMoving) {
        a.kbx -= dir * Math.abs(vb) * 0.5;
      }

      const sep = overlapX * 0.5 + 0.01;
      a.x -= dir * sep;
      b.x += dir * sep;
    }
  }

  for (const p of alive) {
    let landed = false;
    for (const plat of PLATFORMS) {
      const inRange = Math.abs(p.x - plat.x) <= plat.hw;
      // El jugador venía de arriba si su Y anterior estaba en o por encima de la superficie
      const wasAbove = p.prevY >= plat.y;
      // Ha cruzado hacia abajo este tick
      const crossed  = p.y <= plat.y && (p.vy + p.kby) <= 0;

      if (inRange && wasAbove && crossed) {
        p.y        = plat.y;
        p.vy       = 0;
        p.kby      = 0;
        p.onGround = true;
        p.jumpsLeft = 2;
        landed     = true;
        break;
      }
    }
    if (!landed) p.onGround = false;

    if (p.y < STAGE_BOTTOM || p.x < STAGE_LEFT - 2 || p.x > STAGE_RIGHT + 2) {
      p.stocks = Math.max(0, p.stocks - 1);
      if (p.stocks === 0) p.stocks = 3;
      p.respawning   = true;
      p.respawnTimer = 1.5;
      p.vx = 0; p.vy = 0; p.kbx = 0; p.kby = 0;
      p.animation = 'idle';
    }
  }

  for (const p of alive) {
    if (p.respawning) continue;
    if (p.animTimer > 0) {
      p.animTimer -= TICK_DT;
      if (p.animTimer <= 0) p.animation = decideAnim(p);
    } else {
      p.animation = decideAnim(p);
    }
  }

  broadcastState();
}, 1000 / TICK_RATE);

/* ─── HELPERS ─── */

function decideAnim(p) {
  if (!p.onGround) return 'jump';
  if (p.dashing) return 'dash';
  if (p.crouching) return 'crouch';
  if (p.vx !== 0) return 'walk';
  return 'idle';
}

function broadcastState() {
  const snapshot = {};
  for (const [id, p] of Object.entries(players)) {
    snapshot[id] = {
      id:         p.id,
      x:          +p.x.toFixed(3),
      y:          +p.y.toFixed(3),
      rotation:   p.facing === -1 ? Math.PI : 0,
      animation:  p.animation,
      onGround:   p.onGround,
      stocks:     p.stocks,
      score:      p.score,
      respawning: p.respawning,
      crouching:  p.crouching,
      hitId:      p.hitId,
    };
  }

  const msg = JSON.stringify({ type: 'state', players: snapshot });
  for (const p of Object.values(players)) {
    if (p.ws.readyState === WebSocket.OPEN) p.ws.send(msg);
  }
}

/* ─── START ─── */

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[SERVER] WS listo en puerto ${PORT}`);
});