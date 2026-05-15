import { useEffect, useRef, useState } from "react";

const GAME_RATIO = 800 / 600;

function calcResolution() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (vw / vh > GAME_RATIO) {
    const h = vh;
    return { w: Math.round(h * GAME_RATIO), h };
  } else {
    const w = vw;
    return { w, h: Math.round(w / GAME_RATIO) };
  }
}

export default function App() {
  const canvasRef  = useRef(null);
  const [status, setStatus]   = useState("Conectando...");
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const { w, h } = calcResolution();
    window._canvasWidth  = w;
    window._canvasHeight = h;

    window.Module = {
      canvas: canvasRef.current,
      locateFile: (path) => `/${path}`,
      onRuntimeInitialized: () => setStatus("Juego cargado"),
    };

    const script = document.createElement("script");
    script.src = "/game.js";
    script.async = false;
    script.onload = () => setStatus("Juego inicializado");
    script.onerror = () => setStatus("Error cargando game.js");
    document.body.appendChild(script);

    // sendStageSelect está definido en ws-client.js y maneja tanto la
    // confirmación local como el envío al servidor vía WebSocket.

    const poll = setInterval(() => {
      if (window._isSpectator && window._myClientId > 0) {
        setVisible(true);
        clearInterval(poll);
        return;
      }
      const id = window._myClientId;
      if (id <= 0) return;
      const state = window._gameState;
      if (!state || !state.players) return;
      if (!state.players[id]) return;
      setVisible(true);
      clearInterval(poll);
    }, 50);

    const onResize = () => {
      const { w, h } = calcResolution();
      window._canvasWidth  = w;
      window._canvasHeight = h;
    };
    window.addEventListener("resize", onResize);

    return () => {
      clearInterval(poll);
      window.removeEventListener("resize", onResize);
      script.parentNode?.removeChild(script);
    };
  }, []);

  return (
    <div style={{
      width: "100vw",
      height: "100vh",
      background: "#0a0a0a",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      overflow: "hidden",
    }}>
      <div style={{
        width: "min(100vw, calc(100vh * 800 / 600))",
        height: "min(100vh, calc(100vw * 600 / 800))",
        position: "relative",
      }}>
        <canvas
          ref={canvasRef}
          id="canvas"
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            imageRendering: "pixelated",
            display: "block",
            opacity: visible ? 1 : 0,
            transition: "opacity 0.15s ease",
          }}
        />
      </div>

      <div style={{
        position: "fixed",
        bottom: 8,
        left: "50%",
        transform: "translateX(-50%)",
        fontSize: "0.7rem",
        color: "#444",
        pointerEvents: "none",
      }}>
        {status}
      </div>
    </div>
  );
}