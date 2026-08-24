FROM node:24.18.1-bookworm-slim

ENV NODE_ENV=development
WORKDIR /workspace

COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
COPY tsconfig.base.json vitest.config.ts vitest.black-box.config.ts ./

RUN npm ci
RUN npm run build

USER node
