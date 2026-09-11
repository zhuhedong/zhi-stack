FROM node:24-bookworm-slim AS frontend
WORKDIR /build
COPY package*.json ./
RUN npm ci
COPY index.html vite.config.ts tsconfig*.json tokens.css ./
COPY public ./public
COPY src ./src
RUN npm run build

FROM rust:1-bookworm AS backend
WORKDIR /build
COPY server ./server
RUN cargo build --manifest-path server/Cargo.toml --release --locked

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* && useradd --system --uid 10001 infohub && mkdir -p /data/files && chown infohub /data/files && chmod 700 /data/files
WORKDIR /app
ENV FILE_STORAGE=local LOCAL_STORAGE_PATH=/data/files BIND_ADDR=0.0.0.0:3210
COPY --from=backend /build/server/target/release/infohub-server /usr/local/bin/infohub-server
COPY --from=frontend /build/dist ./dist
USER infohub
EXPOSE 3210
CMD ["infohub-server"]
