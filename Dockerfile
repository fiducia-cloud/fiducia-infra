# syntax=docker/dockerfile:1
# GitOps manifest render/check image.
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json topology.toml ./
COPY tools tools
COPY base base
COPY argocd argocd
COPY generated generated
COPY docs docs
RUN npm ci && npm test && npm run check
USER node
CMD ["npm", "run", "check"]
