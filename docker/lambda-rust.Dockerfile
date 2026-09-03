# syntax=docker/dockerfile:1.7
ARG RUST_VERSION=1.89

# Build on each requested target architecture. The Alpine Rust image emits a
# musl-linked binary, avoiding a newer glibc dependency in the Lambda runtime.
FROM --platform=$TARGETPLATFORM rust:${RUST_VERSION}-alpine AS build

ARG LAMBDA_BINARY
WORKDIR /workspace

RUN apk add --no-cache \
      build-base \
      ca-certificates \
      git \
      musl-dev \
      openssl-dev \
      openssl-libs-static \
      pkgconf

COPY . .

RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/workspace/target \
    test -n "$LAMBDA_BINARY" \
    && cargo build --locked --release --bin "$LAMBDA_BINARY" \
    && install -D -m 0755 "target/release/${LAMBDA_BINARY}" /out/bootstrap \
    && (strip /out/bootstrap || true)

FROM public.ecr.aws/lambda/provided:al2023 AS runtime

COPY --from=build /out/bootstrap /var/runtime/bootstrap

CMD ["bootstrap"]
