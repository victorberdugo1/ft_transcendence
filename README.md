# ft_transcendence — Base del proyecto

## Arquitectura

```
NAVEGADOR
  │
  ▼
nginx :443 (HTTPS)
  ├── /          → frontend (nginx sirviendo HTML + game.wasm)
  ├── /api/*     → backend  (Express REST API)
  └── /ws        → backend  (WebSocket del juego)
                      │
                      ▼
                  PostgreSQL
```

### ¿Por qué Raylib + WebAssembly?

Raylib es una librería C de gráficos. Con **Emscripten** se compila a WebAssembly (`.wasm`) y corre directamente en el navegador.

**Flujo del juego:**
```
Backend (Node.js)          Frontend (Raylib WASM)
  game loop                   canvas en el navegador
  calcula física    ──WS──▶   ws-client.js recibe estado
  manda estado      ◀──WS──   manda input del teclado
```

El backend es la fuente de verdad. Raylib solo visualiza.

## Primera vez

```bash
make setup          # Crea .env desde .env.example
# Edita .env con tus contraseñas
make build          # Build (primera vez: ~15 min por Raylib)
make up             # Levantar todo
# Abre https://localhost en Chrome (aceptar cert self-signed)
```

## Comandos útiles

```bash
make dev            # Levantar con logs en pantalla
make logs-backend   # Logs solo del backend
make logs-frontend  # Logs solo del frontend
make shell-backend  # Entrar al contenedor del backend
make down           # Parar todo
make clean          # Borrar TODO (volúmenes incluidos)
```

## Estructura de ficheros

```
.
├── docker-compose.yml      ← Orquestación (no tocar si no sabes)
├── .env.example            ← Copia a .env y rellena
├── Makefile                ← Comandos de conveniencia
│
├── nginx/
│   ├── Dockerfile          ← Genera cert HTTPS self-signed
│   └── nginx.conf          ← Rutas: /, /api/, /ws
│
├── frontend/
│   ├── Dockerfile          ← Etapa 1: compila C→WASM / Etapa 2: nginx
│   ├── index.html          ← Carga game.wasm + ws-client.js
│   ├── nginx.conf          ← Config del nginx del frontend
│   └── js/
│       └── ws-client.js    ← Puente WebSocket ↔ WASM
│
├── game/
│   └── src/
│       └── main.c          ← Código Raylib del juego [MODIFICAR]
│
├── backend/
│   ├── Dockerfile          ← Node.js (fácil de cambiar)
│   ├── package.json
│   └── src/
│       └── index.js        ← Game loop + WebSocket + API [MODIFICAR]
│
└── database/
    └── init.sql            ← Schema inicial de PostgreSQL [MODIFICAR]
```

## Cómo trabaja cada compañero

### Cambiar el juego (main.c)
Edita `game/src/main.c`. Añade campos al `GameState` y dibújalos con Raylib.
Después: `make re` para recompilar.

### Cambiar la lógica del servidor (index.js)
Edita `backend/src/index.js`. Cambia `gameState`, `updateGameState()`, etc.
El servidor recarga automáticamente con nodemon (sin `make re`).

### Cambiar el schema de la DB (init.sql)
Edita `database/init.sql`.
Para aplicar cambios: `make clean && make up` (borra el volumen).

### Cambiar el backend a otro lenguaje
1. Edita `backend/Dockerfile` (ver comentarios dentro)
2. Borra `backend/src/index.js` y escribe el equivalente en tu lenguaje
3. El contrato es simple: escuchar en `:3000`, tener `/ws` y `/api/*`

## Módulos del subject (14 puntos mínimo)

Con esta base ya tienes:
- **Web: Use frameworks** → Minor frontend (React, si se añade) + Minor backend (Express) = **2 pts**
- **Web: Real-time WebSocket** → Major = **2 pts**  
- **Web: ORM** → Minor (añadir Prisma) = **1 pt**
- **Gaming: Web-based game** → Major = **2 pts**
- **Gaming: Remote players** → Major (ya funciona, 2 jugadores distintos IPs) = **2 pts**

**Total base: 9 pts.** Faltan 5 pts → elegir módulos adicionales.
