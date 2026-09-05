FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# WASM_MT=1: bundle the multithreaded engine alongside the single-threaded
# one (scripts/download-wasm.mjs), so the app's runtime probe can pick MT by
# default with ST available as a fallback / manual override (visit /st —
# see worker-singleton.ts).
RUN WASM_MT=1 node scripts/download-wasm.mjs
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.29-alpine@sha256:0c79d56aee561a1d81c63f00eee5fb5fe29279560cdc55e91425133104c7fbe6
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 8080
