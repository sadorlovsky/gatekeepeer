# Образ для Fly.io. Debian-база (не alpine): у @libsql/client нативный биндинг,
# с glibc prebuilt-бинарь ставится без сборки. Контейнер stateless — БД в Turso.

# --- Зависимости (только прод, без devDependencies) ---
FROM oven/bun:1.3.12 AS install
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# --- Рантайм ---
FROM oven/bun:1.3.12-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=install /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
EXPOSE 3000
CMD ["bun", "run", "start"]
