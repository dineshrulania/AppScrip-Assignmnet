# One image, three roles (api | worker | simulator | notifier-mock) chosen by the command.
FROM node:22-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
COPY server/package.json server/
COPY web/package.json web/
COPY simulator/package.json simulator/
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production SERVE_WEB=1 DB_PATH=/data/netwatch.db
COPY --from=build /app /app
VOLUME /data
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s CMD node -e "fetch('http://localhost:4000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" || exit 0
CMD ["npm", "-w", "server", "run", "api"]
