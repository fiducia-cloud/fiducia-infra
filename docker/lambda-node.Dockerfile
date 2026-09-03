# syntax=docker/dockerfile:1.7
ARG NODE_VERSION=22
FROM --platform=$TARGETPLATFORM node:${NODE_VERSION}-bookworm-slim AS build
ARG LAMBDA_SOURCE=src/lambda
WORKDIR /workspace
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
RUN test -d "$LAMBDA_SOURCE" \
 && mkdir -p /out \
 && cp -R "$LAMBDA_SOURCE"/. /out/ \
 && npm prune --omit=dev \
 && cp -R node_modules package.json /out/

FROM public.ecr.aws/lambda/nodejs:22 AS runtime
COPY --from=build /out/ ${LAMBDA_TASK_ROOT}/
CMD ["index.handler"]
