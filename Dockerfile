FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
# NODE_ENV (development | uat | production) also selects the Postgres CA file; set it per deployment.
# Mount the CA bundles at /app/backend/cert (dev.pem / uat.pem / prod.pem) or point POSTGRES_CERT_DIR elsewhere.
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /app/logs && chown 1001:0 /app/logs
USER 1001
EXPOSE 3050
CMD ["node", "dist/index.js"]
