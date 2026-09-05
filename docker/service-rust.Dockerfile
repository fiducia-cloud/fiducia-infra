# syntax=docker/dockerfile:1.7
ARG RUST_VERSION=1.95
FROM --platform=$TARGETPLATFORM rust:${RUST_VERSION}-bookworm AS build
ARG SERVICE_BIN
WORKDIR /workspace
COPY Cargo.toml Cargo.lock ./
COPY . .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/workspace/target \
    test -n "$SERVICE_BIN" \
 && cargo build --locked --release --bin "$SERVICE_BIN" \
 && install -D -m 0755 "target/release/${SERVICE_BIN}" /out/service

FROM debian:bookworm-slim AS runtime
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates
RUN useradd --system --uid 10001 --home /nonexistent --shell /usr/sbin/nologin app
COPY --from=build /out/service /usr/local/bin/service
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/service"]
