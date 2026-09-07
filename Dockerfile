FROM node:22.14-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.local.json ./
COPY src ./src
COPY scripts/build-local.mjs ./scripts/build-local.mjs
RUN npm ci && npm run build

FROM node:22.14-bookworm-slim
ENV NODE_ENV=production BROKEROUTER_HOST=0.0.0.0 BROKEROUTER_PORT=8787 BROKEROUTER_DATABASE_PATH=/data/brokerouter.sqlite
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY package.json ./package.json
RUN mkdir /data && chown -R node:node /app /data
USER node
EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:8787/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/adapters/node/server.js"]
