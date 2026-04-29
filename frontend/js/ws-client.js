/**
 * ws-client.js
 *
 * Puente WebSocket para ft_transcendence multiplayer con bones_core.h.
 *
 * PROTOCOLO (mensajes del servidor → cliente):
 *
 *   { type: "init", clientId: 7 }
 *     → El servidor nos dice quiénes somos.
 *
 *   { type: "state", players: {
 *       7: { id:7, x:0, y:0, z:0, rotation:0, animation:"idle" },
 *       8: { id:8, x:1, y:0, z:0, rotation:0, animation:"walk" },
 *       ...
 *     }
 *   }
 *     → Estado completo del mundo. Se envía cada tick del servidor.
 *
 * PROTOCOLO (mensajes cliente → servidor):
 *
 *   { type: "input", dx, dz, rotation, action }
 *     dx/dz:    desplazamiento calculado en C
 *     rotation: nueva rotación del personaje
 *     action:   0=ninguna, 2=jump, 3=kick, 4=punch
 */

// Estado del mundo (leído por main.c vía EM_JS)
window._gameState = {
  players: {}
};

// Nuestro clientId asignado por el servidor (-1 = aún no asignado)
window._myClientId = -1;
window._ws = null;

(function connectWS() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url      = `${protocol}//${location.host}/ws`;
  const statusEl = document.getElementById('status');

  console.log('[WS] Conectando a', url);
  const ws = new WebSocket(url);
  window._ws = ws;

  ws.addEventListener('open', () => {
    console.log('[WS] Conectado');
    if (statusEl) {
      statusEl.textContent = '⬤ Conectado';
      statusEl.className   = 'connected';
    }
  });

  ws.addEventListener('message', ({ data }) => {
    let msg;
    try { msg = JSON.parse(data); }
    catch { console.warn('[WS] Mensaje no JSON:', data); return; }

    if (msg.type === 'init') {
      // El servidor nos dice nuestro id
      window._myClientId = msg.clientId;
      console.log('[WS] Mi clientId:', window._myClientId);

    } else if (msg.type === 'state') {
      // Estado completo de todos los jugadores
      window._gameState = msg;   // { type, players: { id: {...}, ... } }

    } else {
      // Retrocompatibilidad: mensaje antiguo con campos planos (Pong, etc.)
      window._gameState = msg;
    }
  });

  ws.addEventListener('close', () => {
    console.warn('[WS] Desconectado. Reconectando en 2s...');
    window._myClientId = -1;
    if (statusEl) {
      statusEl.textContent = '⬤ Desconectado (reconectando...)';
      statusEl.className   = 'disconnected';
    }
    setTimeout(connectWS, 2000);
  });

  ws.addEventListener('error', err => {
    console.error('[WS] Error:', err);
    ws.close();
  });
})();

/**
 * Envía input al servidor.
 * Llamado desde C vía EM_JS (ver main.c → ws_send_input).
 *
 * dx, dz:   desplazamiento del personaje en este frame
 * rotation: rotación actual (radianes)
 * action:   0=ninguna, 2=jump, 3=kick, 4=punch
 */
window._sendInput = function(dx, dz, rotation, action) {
  if (window._ws && window._ws.readyState === WebSocket.OPEN) {
    window._ws.send(JSON.stringify({
      type: 'input',
      dx,
      dz,
      rotation,
      action,
    }));
  }
};