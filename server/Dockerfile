# Tiny image: the app is plain ESM with zero npm dependencies (Node built-ins + node:sqlite),
# so there is no install step and nothing to compile.
FROM node:24-alpine

RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY package.json ./
COPY src ./src
RUN mkdir -p /data && chown -R app:app /data
USER app

ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DB_PATH=/data/directory.db
EXPOSE 8787
CMD ["node", "src/index.mjs"]
