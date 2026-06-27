# syntax=docker/dockerfile:1
# GitOps manifest render/check image.
FROM node:24-slim
WORKDIR /app
COPY package.json topology.toml ./
COPY tools tools
COPY base base
COPY argocd argocd
COPY generated generated
COPY docs docs
RUN npm install && npm test && npm run check
CMD ["npm", "run", "check"]
