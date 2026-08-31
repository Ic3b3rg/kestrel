FROM node:24.18.1-trixie-slim

ENV NODE_ENV=development
WORKDIR /workspace

RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/* \
  && install -d -m 0700 -o node -g node /var/lib/kestrel/artifacts \
  && install -d -m 0700 -o node -g node /var/lib/kestrel/model-provider

COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
COPY tsconfig.base.json vitest.config.ts vitest.black-box.config.ts ./

RUN npm ci
RUN npm run build

USER node
