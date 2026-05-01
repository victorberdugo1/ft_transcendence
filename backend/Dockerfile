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
RUN npm install && npm install -g nodemon

# ============================================================
# Copiar código fuente
# ============================================================
COPY src/ ./src/

# ============================================================
# Puerto del backend
# ============================================================
EXPOSE 3000

# ============================================================
# Dev: hot reload / Prod: node directo
# ============================================================
ARG NODE_ENV=development
ENV NODE_ENV=${NODE_ENV}

CMD ["sh", "-c", "if [ \"$NODE_ENV\" = 'production' ]; then node src/index.js; else nodemon --watch src src/index.js; fi"]