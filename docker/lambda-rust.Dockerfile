# syntax=docker/dockerfile:1.7
ARG RUST_VERSION=1.95
FROM --platform=$TARGETPLATFORM rust:${RUST_VERSION}-bookworm AS build
ARG LAMBDA_BIN
WORKDIR /workspace
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
 && apt-get install -y --no-install-recommends musl-tools
COPY Cargo.toml Cargo.lock ./
COPY . .
RUN set -eux; test -n "$LAMBDA_BIN"; \
 case "$(uname -m)" in x86_64) target=x86_64-unknown-linux-musl ;; aarch64|arm64) target=aarch64-unknown-linux-musl ;; *) exit 1 ;; esac; \
 rustup target add "$target"; cargo build --locked --release --target "$target" --bin "$LAMBDA_BIN"; \
 install -D -m 0755 "target/${target}/release/${LAMBDA_BIN}" /out/bootstrap

FROM public.ecr.aws/lambda/provided:al2023 AS runtime
COPY --from=build /out/bootstrap ${LAMBDA_RUNTIME_DIR}/bootstrap
CMD ["bootstrap"]
