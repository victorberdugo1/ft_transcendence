FROM emscripten/emsdk:3.1.50 AS game-builder

WORKDIR /build

RUN git clone --depth 1 --branch 5.0 https://github.com/raysan5/raylib.git && \
    cd raylib/src && \
    make PLATFORM=PLATFORM_WEB -j$(nproc)

COPY game/src/ ./src/

RUN emcc src/main.c \
    raylib/src/libraylib.a \
    -o game.js \
    -I raylib/src \
    -I src \
    -DPLATFORM_WEB \
    -s USE_GLFW=3 \
    -s TOTAL_MEMORY=268435456 \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s MAXIMUM_MEMORY=536870912 \
    -s STACK_SIZE=2097152 \
    -s EXPORTED_FUNCTIONS='["_main"]' \
    -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap"]' \
    --preload-file src/data@data \
    -O2

FROM node:20-alpine AS react-builder

WORKDIR /app
COPY app/package*.json ./
RUN npm install
COPY app/ ./
RUN npm run build

FROM nginx:alpine

COPY --from=react-builder /app/dist         /usr/share/nginx/html/
COPY --from=game-builder  /build/game.js    /usr/share/nginx/html/
COPY --from=game-builder  /build/game.wasm  /usr/share/nginx/html/
COPY --from=game-builder  /build/game.data  /usr/share/nginx/html/
COPY js/                                    /usr/share/nginx/html/js/

EXPOSE 80