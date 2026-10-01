# Guandan AI Arena — single Node app (Express server serves built dist/ + API)
# Full node_modules required at runtime: `npm start` = `tsx server/index.ts`
# (tsx is a devDependency; build also uses vue-tsc/tsc).
FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

# Coolify's default HTTP healthcheck runs `curl ... || wget ...` inside the
# container. node:22-bookworm-slim ships without curl/wget, so install curl
# (slim, no recommends) to make the platform healthcheck pass.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

# Install ALL dependencies. tsx (runtime) and vite/vue-tsc/typescript (build)
# are devDependencies, so force dev install despite NODE_ENV=production.
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund

# Build client (vue-tsc + tsc typecheck, vite build -> dist/).
# Also type-checks server/ and tests/ per package.json build script.
COPY . .
RUN npm run build

# Runtime: serve built dist/ + Express API on PORT (default 3001)
EXPOSE 3001
ENV HOST=0.0.0.0
ENV PORT=3001

# Standalone healthcheck (used when the image is run directly). When deployed
# via Coolify, Coolify's compose-level healthcheck takes precedence.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
