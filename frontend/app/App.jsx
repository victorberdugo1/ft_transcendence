import { useEffect, useRef, useState } from "react";

export default function App() {
  const canvasRef = useRef(null);
  const [status, setStatus] = useState("Conectando...");

  useEffect(() => {
    if (!canvasRef.current) return;

    window.Module = {
      canvas: canvasRef.current,
      locateFile: (path) => "/" + path,
    };

    const gameScript = document.createElement("script");
    gameScript.src = "/game.js";
    gameScript.async = false;
    gameScript.onload = () => setStatus("Juego cargado");
    gameScript.onerror = () => setStatus("Error cargando game.js");
    document.body.appendChild(gameScript);

    return () => {
      if (gameScript.parentNode) gameScript.remove();
    };
  }, []);

  return (
    <div style={{
      width: "100vw",
      height: "100vh",
      background: "#000",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    }}>
      <canvas
        ref={canvasRef}
        id="canvas"
        style={{
          // Ocupa todo el espacio disponible respetando ratio 800/600
          maxWidth: "100%",
          maxHeight: "100%",
          aspectRatio: "800 / 600",
          display: "block",
        }}
      />
      <div id="status" style={{ position: "fixed", top: 10, left: 10, color: "#fff", fontSize: "0.8rem" }}>
        {status}
      </div>
    </div>
  );
}