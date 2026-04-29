FROM emscripten/emsdk:3.1.50 AS game-builder

WORKDIR /build

# Raylib Web
RUN git clone --depth 1 --branch 5.0 https://github.com/raysan5/raylib.git && \
    cd raylib/src && \
    make PLATFORM=PLATFORM_WEB -j$(nproc)

# Código del juego
COPY game/src/ ./src/

# Compilación WASM
RUN emcc src/main.c \
    raylib/src/libraylib.a \
    -o game.js \
    -I raylib/src \
    -DPLATFORM_WEB \
    -s USE_GLFW=3 \
    -s ASYNCIFY \
    -s TOTAL_MEMORY=67108864 \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s EXPORTED_FUNCTIONS='["_main"]' \
    -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap"]' \
    -O2

# ─────────────────────────────
# RUNTIME nginx
# ─────────────────────────────
FROM nginx:alpine

# Copiar build WASM
COPY --from=game-builder /build/game.js /usr/share/nginx/html/
COPY --from=game-builder /build/game.wasm /usr/share/nginx/html/

# frontend REAL (SIN prefijo frontend/)
COPY index.html /usr/share/nginx/html/
COPY js/ /usr/share/nginx/html/js/

# ✅ Copiar assets
COPY game/src/data/ /usr/share/nginx/html/data/

EXPOSE 80