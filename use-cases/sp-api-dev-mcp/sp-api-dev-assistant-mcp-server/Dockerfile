# syntax=docker/dockerfile:1

# =============================================================================
# SP-API Dev Assistant — HTTP (Streamable-HTTP) service image.
#
# Runs `dist/http.js`: a networked, multi-account MCP server on :3000 (/mcp).
# Each session is bound to one seller account via a request header; credentials
# resolve server-side from a mounted JSON vault (see docker-compose.yml).
#
# Baked into the image at build time (so the container starts fast / offline):
#   - the ONNX embedding model (Xenova/multilingual-e5-small), cached inside
#     node_modules/@huggingface/transformers/.cache — used by sp_api_reference.
#   - the SP-API swagger catalog (selling-partner-api-models) at /opt/spapi-models,
#     used by sp_api_explore_catalog and sp_api_execute (CATALOG_PATH).
#
# Left to runtime (persisted on a named volume mounted at ~/.sp-api-dev-mcp):
#   - the docs search index (built on first sp_api_reference; needs network once).
#   - the SDK clone fetched on demand by the code-generation clone_repo action.
#
# Build:  docker compose build      (or: docker build -t sp-api-dev-assistant:local .)
# =============================================================================

# ---- Stage 1: builder ------------------------------------------------------
FROM node:22-bookworm-slim AS builder

# git: clone the catalog repo. python3/make/g++: node-gyp fallback for any
# native dep (sharp, onnxruntime) lacking a prebuilt binary for this platform.
RUN apt-get update && apt-get install -y --no-install-recommends \
        git ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
# Drop the `prepare` script (lint/format/type-check) for the image build — it is
# a local-dev hook and the source isn't present yet at install time. Dependency
# install scripts (sharp/onnxruntime native binaries) still run. The original
# package.json is restored by the later `COPY . .`.
RUN npm pkg delete scripts.prepare && npm ci

COPY . .
# tsc + copy resources into dist/.
RUN npm run build

# Bake the embedding model into node_modules/@huggingface/transformers/.cache
# (transformers.js caches inside the package dir). Needs network at build time.
RUN node --input-type=module -e "import('./dist/tools/search-tools/embedding-service.js').then(async (m) => { await new m.TransformersEmbeddingService().preload(); console.log('embedding model cached'); }).catch((e) => { console.error(e); process.exit(1); })"

# Bake the swagger catalog (shallow clone — blobs only, no history).
RUN git clone --depth 1 \
        https://github.com/amzn/selling-partner-api-models.git \
        /opt/spapi-models \
    && rm -rf /opt/spapi-models/.git

# ---- Stage 2: runtime ------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# git is needed at runtime for the code-generation clone_repo action.
RUN apt-get update && apt-get install -y --no-install-recommends \
        git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm config set update-notifier false

ENV NODE_ENV=production
ENV PORT=3000
# The swagger catalog baked above.
ENV CATALOG_PATH=/opt/spapi-models/models
WORKDIR /app

# Copy the whole builder node_modules so the baked model (.cache inside the
# @huggingface/transformers package) and native binaries travel with the image.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /opt/spapi-models /opt/spapi-models

EXPOSE 3000

# Liveness against the HTTP entry's /healthz (uses Node's global fetch).
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
    CMD node -e "fetch('http://localhost:'+ (process.env.PORT||3000) +'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/http.js"]
