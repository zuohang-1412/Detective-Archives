FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
RUN npm ci

COPY apps/api apps/api
RUN npm run build

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/apps/api/dist apps/api/dist
COPY apps/admin apps/admin
COPY apps/api/src/data apps/api/src/data
COPY database database
COPY scripts scripts

USER node
EXPOSE 3000

CMD ["sh", "-c", "node scripts/check-api-production-config.mjs && node scripts/db-migrate.mjs && node scripts/db-seed-catalog.mjs && node scripts/run-catalog-imports.mjs --apply && node apps/api/dist/server.js"]
