# ── Stage 1: raylib compilado (imagen base, se cachea indefinidamente) ────────
# Este stage solo se reconstruye si cambia la versión de raylib o emsdk.
FROM emscripten/emsdk:3.1.50 AS raylib-base

WORKDIR /build

RUN git clone --depth 1 --branch 5.0 https://github.com/raysan5/raylib.git && \
    cd raylib/src && \
    make PLATFORM=PLATFORM_WEB \
    CUSTOM_CFLAGS="-DSUPPORT_FILEFORMAT_JPG=1" \
    -j$(nproc)

# ── Stage 2: compilar main.c (solo se recompila si cambia game/src/) ──────────
FROM raylib-base AS game-builder

COPY game/src/ ./src/

RUN emcc src/main.c \
    raylib/src/libraylib.a \
    -o game.js \
    -I raylib/src \
    -I src \
    -DPLATFORM_WEB \
    -Wall \
    -Wextra \
    -Werror \
    -s USE_GLFW=3 \
    -s TOTAL_MEMORY=268435456 \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s MAXIMUM_MEMORY=536870912 \
    -s STACK_SIZE=2097152 \
    -s EXPORTED_FUNCTIONS='["_main"]' \
    -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap"]' \
    --preload-file src/data@data \
    -O2

# ── Stage 3: React (solo se reinstala npm si cambia package.json) ─────────────
FROM node:20-alpine AS react-builder

WORKDIR /app
COPY app/package*.json ./
RUN npm install
COPY app/ ./
RUN npm run build

# ── Stage 4: imagen final nginx ───────────────────────────────────────────────
FROM nginx:alpine

COPY --from=react-builder /app/dist         /usr/share/nginx/html/
COPY --from=game-builder  /build/game.js    /usr/share/nginx/html/
COPY --from=game-builder  /build/game.wasm  /usr/share/nginx/html/
COPY --from=game-builder  /build/game.data  /usr/share/nginx/html/
COPY js/                                    /usr/share/nginx/html/js/

EXPOSE 80