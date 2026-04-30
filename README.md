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

El backend es la fuente de verdad. El frontend (Raylib compilado a WebAssembly) solo visualiza y manda inputs.

```
Backend (Node.js)          Frontend (Raylib WASM)
  game loop                   canvas en el navegador
  calcula física    ──WS──▶   ws-client.js recibe estado
  manda estado      ◀──WS──   manda input del teclado
```

---

## Puesta en marcha

```bash
make setup      # Crea .env desde .env.example (no sobreescribe si ya existe)
# Edita .env con tus contraseñas
make wasm       # Primera vez: ~15 min (compila Raylib → WASM y levanta)
```

Abre https://localhost en Chrome y acepta el certificado self-signed.

---

## Comandos

| Comando | Qué hace |
|---|---|
| `make setup` | Copia `.env.example` a `.env` si no existe |
| `make wasm` | Recompila el frontend (C→WASM) y levanta |
| `make up` | Levanta todos los contenedores en background |
| `make dev` | Levanta con logs en pantalla (Ctrl+C para parar) |
| `make build` | Build de todas las imágenes sin levantar |
| `make re` | Baja, recompila WASM y vuelve a levantar |
| `make logs` | Logs de todos los servicios en tiempo real |
| `make logs-backend` | Logs solo del backend |
| `make logs-frontend` | Logs solo del frontend |
| `make shell-backend` | Shell dentro del contenedor del backend |
| `make shell-frontend` | Shell dentro del contenedor del frontend |
| `make down` | Para todos los contenedores |
| `make clean` | Para todo y borra imágenes + volúmenes (reset total) |

> `make shell-<servicio>` funciona con cualquier nombre de servicio definido en `docker-compose.yml`.

---

## Estructura del proyecto

```
.
├── docker-compose.yml      ← Orquestación (no tocar si no sabes)
├── .env.example            ← Copia a .env y rellena
├── Makefile
│
├── nginx/
│   ├── Dockerfile          ← Genera cert HTTPS self-signed
│   └── nginx.conf          ← Rutas: /, /api/, /ws
│
├── frontend/
│   ├── Dockerfile          ← Etapa 1: compila C→WASM / Etapa 2: nginx
│   ├── index.html          ← Carga game.wasm + ws-client.js
│   ├── nginx.conf
│   ├── game/src/
│   │   └── main.c          ← Código Raylib del juego
│   └── js/
│       └── ws-client.js    ← Puente WebSocket ↔ WASM
│
├── backend/
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       └── index.js        ← Game loop + WebSocket + API
│
└── database/
    └── init.sql            ← Schema de PostgreSQL
```

---

## Qué hace cada parte

**`frontend/game/src/main.c`** — El juego en sí. Código C con Raylib que se compila a WebAssembly. Recibe el estado del juego por WebSocket y lo dibuja en un canvas. También captura los inputs del teclado y los manda al servidor. Cada vez que lo toques necesitas `make re` para recompilar.

**`frontend/js/ws-client.js`** — El puente entre el navegador y el WASM. Abre la conexión WebSocket, recibe mensajes del servidor y los pasa a la función C correspondiente, y viceversa.

**`frontend/index.html`** — Página mínima que carga el canvas, el JS generado por Emscripten y `ws-client.js`.

**`backend/src/index.js`** — El servidor. Aquí vive el game loop, la física, el `GameState`, y los endpoints REST (`/api/*`). Nodemon lo recarga automáticamente al guardar, no hace falta reiniciar nada.

**`database/init.sql`** — Schema inicial de PostgreSQL. Se ejecuta solo la primera vez que se crea el volumen. Para aplicar cambios: `make clean && make wasm`.

**`nginx/nginx.conf`** — Proxy inverso que enruta `/` al frontend, `/api/*` y `/ws` al backend. También termina el TLS.

**`backend/Dockerfile`** — Está comentado para explicar cómo cambiar el backend a otro lenguaje. El único contrato que hay que respetar es escuchar en `:3000` y exponer `/ws` y `/api/*`.