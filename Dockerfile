FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm install --no-audit --no-fund
COPY server/ server/
COPY web/ web/
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
RUN mkdir -p /app/data
VOLUME /app/data
EXPOSE 4000
CMD ["node", "--disable-warning=ExperimentalWarning", "server/dist/index.js"]
