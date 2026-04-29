FROM emscripten/emsdk:3.1.50 AS game-builder

WORKDIR /build

# Raylib para Web (correcto)
RUN git clone --depth 1 --branch 5.0 https://github.com/raysan5/raylib.git && \
    cd raylib/src && \
    make PLATFORM=PLATFORM_WEB -j$(nproc)

# Código del juego
COPY game/src/ ./src/

# Compilar WASM correctamente
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

FROM nginx:alpine

COPY --from=game-builder /build/game.js /usr/share/nginx/html/
COPY --from=game-builder /build/game.wasm /usr/share/nginx/html/

COPY frontend/index.html /usr/share/nginx/html/
COPY frontend/js/ /usr/share/nginx/html/js/
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
