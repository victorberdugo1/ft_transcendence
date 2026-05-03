import { useEffect, useRef, useState } from "react";

function calcResolution() {
  const ratio = 800 / 600;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (vw / vh > ratio) {
    const h = vh;
    return { w: Math.round(h * ratio), h };
  } else {
    const w = vw;
    return { w, h: Math.round(w / ratio) };
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

    // Mostrar el canvas solo cuando el jugador ya tiene posición correcta en el estado
    const poll = setInterval(() => {
      const id = window._myClientId;
      if (id <= 0) return;
      const state = window._gameState;
      if (!state || !state.players) return;
      const me = state.players[id];
      if (!me) return;
      // La posición ya está en el estado del servidor: mostrar
      setVisible(true);
      clearInterval(poll);
    }, 50);

    let resizeTimer;
    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => window.location.reload(), 500);
    };
    window.addEventListener("resize", onResize);

    return () => {
      clearTimeout(resizeTimer);
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
