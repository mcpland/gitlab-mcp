FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && chown node:node /app
COPY --chown=node:node package.json pnpm-lock.yaml ./
USER node
RUN pnpm install --prod --frozen-lockfile --ignore-scripts
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node .env.example ./.env.example
EXPOSE 3333
CMD ["node", "dist/http.js"]
