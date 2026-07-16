# syntax=docker/dockerfile:1
# GitOps manifest render/check image.
# Node major must match .nvmrc and .github/workflows/ci.yml (22).
FROM node:26-slim@sha256:715e55e4b84e4bb0ff48e49b398a848f08e55daed8eb6a0ea1839ae53bc57583
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
