import { useEffect, useRef, useState } from "react";

export default function App() {
  const canvasRef = useRef(null);
  const [status, setStatus] = useState("Conectando...");

  useEffect(() => {
    window.Module = {
      canvas: canvasRef.current,
      locateFile: (path) => `/${path}`,
      onRuntimeInitialized: () => {
        setStatus("Juego cargado");
      }
    };

    const script = document.createElement("script");
    script.src = "/game.js";
    script.async = true;
    script.onload = () => setStatus("Juego inicializado");
    script.onerror = () => setStatus("Error cargando game.js");

    document.body.appendChild(script);

    return () => {
      if (script.parentNode) {
        script.parentNode.removeChild(script);
      }
    };
  }, []);

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        margin: 0,
        background: "#0a0a0a",
        color: "#fff",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "0.5rem",
        overflow: "hidden",
        fontFamily: "monospace"
      }}
    >
      <div
        style={{
          width: "min(100vw, calc((100vh - 4rem) * 800 / 600))",
          aspectRatio: "800 / 600",
          border: "1px solid #2a2a2a",
          background: "#000"
        }}
      >
        <canvas
          ref={canvasRef}
          id="canvas"
          style={{
            display: "block",
            width: "100%",
            height: "100%",
            imageRendering: "pixelated"
          }}
        />
      </div>
      <div style={{ fontSize: "0.8rem", color: "#aaa" }}>{status}</div>
    </div>
  );
}