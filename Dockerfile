# syntax=docker/dockerfile:1

# Etapa 18.23 — imagem de produção do mariela-backend.
#
# O projeto roda em Bun (não Node) — package.json define
# `"start:prod": "bun dist/main.js"` e `nest build` compila TypeScript para
# `dist/`. Este Dockerfile só empacota esse fluxo já existente; não introduz
# nenhum comportamento novo de build/execução.
#
# Multi-stage: a etapa `deps`/`build` instala TODAS as dependências
# (incluindo devDependencies, necessárias para `nest build`) e compila; a
# etapa final `runtime` reinstala só as dependências de produção, copia
# unicamente `dist/` e roda com um usuário não-root.

FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM deps AS build
WORKDIR /app
COPY . .
RUN bun run build

FROM oven/bun:1-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV TZ=America/Sao_Paulo

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production && \
    addgroup --system app && adduser --system --ingroup app app
COPY --from=build /app/dist ./dist

USER app
EXPOSE 3000

# `/health` já distingue processo vivo (200) de MongoDB indisponível (503,
# ver src/modules/saude) — o HEALTHCHECK do container usa exatamente essa
# mesma distinção, sem lógica própria.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "dist/main.js"]
