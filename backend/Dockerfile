# ============================================================
# backend/Dockerfile
# Node.js 20 + Express + ws + nodemon (dev)
# ============================================================

FROM node:20-alpine

WORKDIR /app

# ============================================================
# Instalar dependencias (capa cacheable)
# IMPORTANTE: el contexto ya es /backend (por docker-compose)
# ============================================================

COPY package*.json ./
RUN npm install

# ============================================================
# Copiar código fuente
# ============================================================

COPY src/ ./src/

# ============================================================
# Puerto del backend
# ============================================================

EXPOSE 3000

# ============================================================
# Herramienta de desarrollo (hot reload)
# ============================================================

RUN npm install -g nodemon

CMD ["nodemon", "--watch", "src", "src/index.js"]
