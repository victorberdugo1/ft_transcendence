/**
 * ws-client.js
 *
 * Puente entre el WebSocket del backend y el juego Raylib (WASM).
 *
 * CÓMO FUNCIONA:
 *   1. Se conecta a wss://localhost/ws
 *   2. Guarda el estado del juego en window._gameState
 *   3. El código C (main.c) lee ese estado cada frame usando EM_JS
 *
 * PARA AÑADIR CAMPOS AL ESTADO:
 *   - Añade el campo en el backend (index.js, gameState)
 *   - Lee el campo en C con  ws_get_float("mi_campo")
 *     o                      ws_get_int("mi_campo")
 */

// Estado inicial (valores por defecto mientras carga)
window._gameState = {
  ball_x:  400,
  ball_y:  300,
  p1_y:    250,
  p2_y:    250,
  score1:  0,
  score2:  0,
};

window._ws = null;

(function connectWS() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url      = protocol + '//' + location.host + '/ws';
  const statusEl = document.getElementById('status');

  console.log('[WS] Conectando a', url);
  const ws = new WebSocket(url);
  window._ws = ws;

  ws.addEventListener('open', () => {
    console.log('[WS] Conectado');
    if (statusEl) {
      statusEl.textContent = '⬤ Conectado';
      statusEl.className = 'connected';
    }
  });

  ws.addEventListener('message', (event) => {
    try {
      // El backend manda JSON con el estado completo del juego
      window._gameState = JSON.parse(event.data);
    } catch (e) {
      console.warn('[WS] Mensaje no es JSON:', event.data);
    }
  });

  ws.addEventListener('close', () => {
    console.warn('[WS] Desconectado. Reconectando en 2s...');
    if (statusEl) {
      statusEl.textContent = '⬤ Desconectado (reconectando...)';
      statusEl.className = 'disconnected';
    }
    // Reconexión automática
    setTimeout(connectWS, 2000);
  });

  ws.addEventListener('error', (err) => {
    console.error('[WS] Error:', err);
    ws.close();
  });
})();

/**
 * Envía input al servidor.
 * Llamado desde C vía EM_JS (ver main.c → ws_send_input)
 * player:    1 o 2
 * direction: -1 (arriba), 1 (abajo), 0 (parado)
 */
window._sendInput = function(player, direction) {
  if (window._ws && window._ws.readyState === WebSocket.OPEN) {
    window._ws.send(JSON.stringify({
      type: 'input',
      player,
      direction,
    }));
  }
};
