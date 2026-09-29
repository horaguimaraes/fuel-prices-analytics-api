# --- build ---------------------------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# --- runtime -------------------------------------------------------------------------
FROM node:22-slim
ENV NODE_ENV=production \
    DB_PATH=/data/fuel.db \
    PORT=3000
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY data/sample ./data/sample
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# First start: load the bundled sample so the API is not empty. Real data: see README.
CMD ["sh", "-c", "[ -f \"$DB_PATH\" ] || node dist/etl/cli.js data/sample/anp-sample.csv; exec node dist/server.js"]
