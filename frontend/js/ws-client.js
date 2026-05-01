window._gameState = { players: {} };
window._myClientId = -1;
window._ws = null;

(function connectWS() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url      = `${protocol}//${location.host}/ws`;

  console.log('[WS] Conectando a', url);
  const ws = new WebSocket(url);
  window._ws = ws;

  function setStatus(text) {
    // Espera a que React monte el elemento
    const el = document.getElementById('status');
    if (el) el.textContent = text;
  }

  ws.addEventListener('open', () => {
    console.log('[WS] Conectado');
    setStatus('⬤ Conectado');
  });

  ws.addEventListener('message', ({ data }) => {
    let msg;
    try { msg = JSON.parse(data); }
    catch { console.warn('[WS] Mensaje no JSON:', data); return; }

    if (msg.type === 'init') {
      window._myClientId = msg.clientId;
      console.log('[WS] Mi clientId:', window._myClientId);
    } else if (msg.type === 'state') {
      window._gameState = msg;
    } else {
      window._gameState = msg;
    }
  });

  ws.addEventListener('close', () => {
    console.warn('[WS] Desconectado. Reconectando en 2s...');
    window._myClientId = -1;
    setStatus('⬤ Desconectado (reconectando...)');
    setTimeout(connectWS, 2000);
  });

  ws.addEventListener('error', err => {
    console.error('[WS] Error:', err);
    ws.close();
  });
})();

window._sendInput = function(dx, dz, rotation, action) {
  if (window._ws && window._ws.readyState === WebSocket.OPEN) {
    window._ws.send(JSON.stringify({ type: 'input', dx, dz, rotation, action }));
  }
};