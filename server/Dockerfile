FROM node:24-bookworm-slim AS build
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci
COPY server/tsconfig.json ./
COPY server/src ./src
COPY scripts/build-map-graph.ts scripts/validate-map.ts /app/scripts/
RUN npm run build

FROM node:24-bookworm-slim
# Chinese inside formulas (\text{...}) needs a CJK font, or it renders blank.
RUN apt-get update && apt-get install -y --no-install-recommends fonts-wqy-microhei poppler-utils \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev && mkdir -p /app/data && chown node:node /app/data
COPY --from=build /app/server/dist ./dist
# Public images served by GET /v1/assets/:file (mascot poses, 3D icons).
COPY server/assets /app/server/assets
# 用户协议、隐私政策、儿童隐私政策 served by GET /v1/legal/:doc.
COPY server/legal /app/server/legal
COPY admin /app/admin
USER node
EXPOSE 8787
CMD ["node", "--env-file-if-exists=.env", "dist/index.js"]
