// ── Estado de juego restaurado ──
(function restoreLastState() {
  try {
    const saved = sessionStorage.getItem('gameState');
    window._gameState = saved ? JSON.parse(saved) : { players: {} };
  } catch {
    window._gameState = { players: {} };
  }
})();

window._myClientId = -1;
window._ws         = null;

// ── Sistema de input ──
// Usamos un objeto de teclas con estado para evitar repetición
const keys = {};

window.addEventListener('keydown', e => { keys[e.code] = true;  });
window.addEventListener('keyup',   e => { keys[e.code] = false; });

// Colas de eventos de un solo frame (jump, attack, dash)
const frameEvents = { jump: false, attack: false, dash: false, dashDir: 0 };

window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  // Salto: W / ArrowUp / Space
  if (e.code === 'KeyW' || e.code === 'ArrowUp' || e.code === 'Space') {
    frameEvents.jump = true;
  }
  // Ataque: Z / J
  if (e.code === 'KeyZ' || e.code === 'KeyJ') {
    frameEvents.attack = true;
  }
  // Dash: X / K  o doble tap de dirección (detectado abajo)
  if (e.code === 'KeyX' || e.code === 'KeyK') {
    const dir = (keys['KeyD'] || keys['ArrowRight']) ? 1
               : (keys['KeyA'] || keys['ArrowLeft'])  ? -1 : 0;
    frameEvents.dash    = true;
    frameEvents.dashDir = dir;
  }
});

// Doble tap para dash (←← o →→ en ≤200ms)
let lastTap = { code: '', time: 0 };
window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (e.code === 'ArrowLeft'  || e.code === 'KeyA' ||
      e.code === 'ArrowRight' || e.code === 'KeyD') {
    const now = Date.now();
    if (e.code === lastTap.code && now - lastTap.time < 200) {
      const dir = (e.code === 'ArrowRight' || e.code === 'KeyD') ? 1 : -1;
      frameEvents.dash    = true;
      frameEvents.dashDir = dir;
    }
    lastTap = { code: e.code, time: now };
  }
});

// ── Input loop: 60fps ──
const INPUT_HZ = 60;
setInterval(() => {
  const moveX = (keys['KeyD'] || keys['ArrowRight'] ? 1 : 0)
              - (keys['KeyA'] || keys['ArrowLeft']  ? 1 : 0);

  const crouch = !!(keys['KeyS'] || keys['ArrowDown']);

  window._sendInput(
    moveX,
    frameEvents.jump,
    frameEvents.attack,
    frameEvents.dash,
    frameEvents.dashDir,
    crouch,
  );

  // Limpiar eventos de un frame
  frameEvents.jump    = false;
  frameEvents.attack  = false;
  frameEvents.dash    = false;
  frameEvents.dashDir = 0;
}, 1000 / INPUT_HZ);

// ── WebSocket ──
(function connectWS() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url      = `${protocol}//${location.host}/ws`;

  console.log('[WS] Conectando a', url);
  const ws = new WebSocket(url);
  window._ws = ws;

  function setStatus(text) {
    const el = document.getElementById('status');
    if (el) el.textContent = text;
  }

  ws.addEventListener('open', () => {
    setStatus('⬤ Conectado');
    const savedId = sessionStorage.getItem('clientId');
    if (savedId) {
      ws.send(JSON.stringify({ type: 'rejoin', clientId: parseInt(savedId, 10) }));
    }
  });

  ws.addEventListener('message', ({ data }) => {
    let msg; try { msg = JSON.parse(data); } catch { return; }

    if (msg.type === 'init') {
      window._myClientId = msg.clientId;
      sessionStorage.setItem('clientId', msg.clientId);
    } else if (msg.type === 'state') {
      window._gameState = msg;
      try { sessionStorage.setItem('gameState', JSON.stringify(msg)); } catch {}
    } else {
      window._gameState = msg;
    }
  });

  ws.addEventListener('close', () => {
    window._myClientId = -1;
    setStatus('⬤ Desconectado (reconectando...)');
    setTimeout(connectWS, 2000);
  });

  ws.addEventListener('error', err => {
    console.error('[WS] Error:', err);
    ws.close();
  });
})();

// ── API pública para main.c vía EM_JS ──
window._sendInput = function(moveX, jump, attack, dash, dashDir, crouch) {
  if (window._ws && window._ws.readyState === WebSocket.OPEN) {
    window._ws.send(JSON.stringify({
      type:    'input',
      moveX,
      jump:    jump    ? 1 : 0,
      attack:  attack  ? 1 : 0,
      dash:    dash    ? 1 : 0,
      dashDir: dashDir ?? 0,
      crouch:  crouch  ? 1 : 0,
    }));
  }
};