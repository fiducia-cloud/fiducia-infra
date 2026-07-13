# syntax=docker/dockerfile:1
# GitOps manifest render/check image.
FROM node:26-slim@sha256:ffc78385a788964bb3cbab5e434ff79a10bdc25b8ae6db03fe5fe6cb14053c09
WORKDIR /app
COPY package.json package-lock.json topology.toml ./
COPY tools tools
COPY base base
COPY argocd argocd
COPY generated generated
COPY docs docs
RUN npm ci --ignore-scripts && npm test && npm run check
USER node
CMD ["npm", "run", "check"]
