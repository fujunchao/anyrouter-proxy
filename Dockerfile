# ---- 构建阶段 ----
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ---- 运行阶段 ----
FROM node:20-alpine

WORKDIR /app

# 零生产依赖，只需要构建产物
COPY --from=builder /app/dist/server.js ./server.js

EXPOSE 5489

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:5489/health || exit 1

CMD ["node", "server.js"]
