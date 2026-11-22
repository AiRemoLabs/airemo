FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter @airemo/relay...
RUN pnpm --filter "@airemo/relay..." build
RUN pnpm --filter @airemo/relay deploy --legacy --prod /out

FROM node:22-slim
WORKDIR /app
COPY --from=build /out .
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["node", "dist/main.js"]
