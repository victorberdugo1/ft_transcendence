FROM emscripten/emsdk:3.1.50 AS game-builder

WORKDIR /build

# Raylib Web
RUN git clone --depth 1 --branch 5.0 https://github.com/raysan5/raylib.git && \
    cd raylib/src && \
    make PLATFORM=PLATFORM_WEB -j$(nproc)

# Código del juego (incluye src/data/)
COPY game/src/ ./src/

# Compilación WASM
# --preload-file: empaqueta data/ dentro del .wasm para que fopen() funcione
# ASYNCIFY eliminado: innecesario con emscripten_set_main_loop y cuelga el build
RUN emcc src/main.c \
    raylib/src/libraylib.a \
    -o game.js \
    -I raylib/src \
    -I src \
    -DPLATFORM_WEB \
    -s USE_GLFW=3 \
    -s TOTAL_MEMORY=134217728 \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s EXPORTED_FUNCTIONS='["_main"]' \
    -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap"]' \
    --preload-file src/data@data \
    -O2

# ─────────────────────────────
# RUNTIME nginx
# ─────────────────────────────
FROM nginx:alpine

COPY --from=game-builder /build/game.js   /usr/share/nginx/html/
COPY --from=game-builder /build/game.wasm /usr/share/nginx/html/
COPY --from=game-builder /build/game.data /usr/share/nginx/html/

COPY index.html /usr/share/nginx/html/
COPY js/        /usr/share/nginx/html/js/

EXPOSE 80
