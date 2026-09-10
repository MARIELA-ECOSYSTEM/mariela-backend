# MARIELA Backend

API REST (NestJS + MongoDB, runtime Bun) que sustenta o Backoffice administrativo e o MARIELA PDV da loja MARIELA.

## Requisitos

- [Bun](https://bun.sh) 1.x
- MongoDB 6+ acessível (local, container ou gerenciado)

## Configuração

Copie `.env.example` para `.env` e preencha os valores reais:

```bash
cp .env.example .env
```

Todas as variáveis aceitas são validadas na inicialização (`src/config/env.validation.ts`) — a aplicação **falha rápido e não sobe** se algo obrigatório estiver ausente, vazio ou mal formatado. Em particular:

- `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `PDV_JWT_ACCESS_SECRET`, `PDV_JWT_REFRESH_SECRET` nunca podem ser vazios/só espaços, em nenhum ambiente; em `NODE_ENV=production`, cada um precisa ter pelo menos 32 caracteres.
- ADMIN (Backoffice) e PDV (Vendedor) usam pares de segredos JWT **completamente distintos** — nunca reutilize um segredo do ADMIN para o PDV ou vice-versa; um vazamento de um nunca deve comprometer o outro domínio de identidade.

### Timezone

O processo fixa `TZ=America/Sao_Paulo` automaticamente na inicialização (`src/main.ts`) caso a variável de ambiente `TZ` não esteja definida — resolve, no nível de infraestrutura, a dependência que Dashboard/Vendas/Caixas/Coleções/Campanhas sempre tiveram do timezone do sistema operacional do host. Ainda assim, recomenda-se declarar `TZ=America/Sao_Paulo` explicitamente no ambiente/orquestrador (já presente em `.env.example` e no `Dockerfile`), para deixar essa decisão visível na configuração do host, não só implícita no código.

### Swagger (`/docs`, `/docs-json`)

Sempre habilitado fora de produção. Em `NODE_ENV=production`, fica **desabilitado por padrão** — habilite explicitamente com `SWAGGER_ENABLED=true` se houver necessidade real de consultar o schema da API em produção.

## Rodando localmente

```bash
bun install
bun run start:dev      # watch mode
```

## Testes

```bash
bun test                                        # suíte completa (integração com MongoDB real)
bunx tsc --noEmit -p tsconfig.build.json        # typecheck
bunx nest build                                  # build de produção
```

A suíte é majoritariamente de integração (MongoDB real via `mongodb://127.0.0.1:27017` — banco `mariela_test`, nunca `mariela_dev`/produção). É necessário um MongoDB acessível localmente para rodar os testes.

## Primeiro administrador (seed)

Não existe rota HTTP para criar o primeiro usuário ADMIN, de propósito. Use o script local:

```bash
ADMIN_EMAIL=admin@mariela.com ADMIN_NAME="Administradora" ADMIN_PASSWORD="uma-senha-forte" bun run seed:admin
```

Idempotente — rodar de novo com o mesmo e-mail não duplica nem falha, só avisa que o usuário já existe. Nunca imprime a senha em nenhuma saída.

## Health check

`GET /health` (fora do prefixo `/api/v1`) — responde:

- `200` com `{ status: "ok", database: { status: "up" } }` quando a API e a conexão com o MongoDB estão operacionais;
- `503` com `{ status: "degradado", database: { status: "down" } }` quando o MongoDB está inacessível.

Adequado tanto como *liveness* (o processo respondeu) quanto *readiness* (o banco está acessível) num único endpoint — não há distinção entre os dois papéis além do código HTTP, deliberadamente simples para o estágio atual de operação (uma única instância).

## Deploy com Docker

```bash
docker compose up --build -d
```

Sobe a API (`Dockerfile`, multi-stage, usuário não-root, `HEALTHCHECK` embutido usando `/health`) e um MongoDB de conveniência num único host — o cenário mais simples de implantação para a loja física. `docker-compose.yml` espera um `.env` já preenchido no diretório do projeto (`env_file: .env`).

> O `Dockerfile`/`docker-compose.yml` foram escritos e revisados nesta etapa mas **não foram validados com um build real** (ambiente de desenvolvimento sem Docker disponível) — valide `docker compose up --build` antes do primeiro uso em produção.

Para um deploy sem Docker, compile e rode diretamente:

```bash
bun run build
bun run start:prod
```

## Backup e recuperação do MongoDB

**Fora do escopo deste backend** — é responsabilidade operacional da infraestrutura de banco de dados escolhida para produção. Requisitos mínimos recomendados, independentemente do provedor:

- Backup automático recorrente (diário, no mínimo) dos dados de produção.
- Retenção definida (ex.: 30 dias) compatível com a necessidade de auditoria financeira da loja (Vendas/Caixas).
- Teste de restore periódico comprovado — um backup nunca testado não é um backup confiável.

Se o MongoDB de produção for auto-hospedado (ex.: dentro do próprio `docker-compose.yml` acima), `mongodump`/`mongorestore` agendados contra o volume `mongodb_data` são o mínimo aceitável; um provedor gerenciado (Atlas ou equivalente) normalmente já resolve isso nativamente.

## CI/CD

Não há workflow de CI configurado neste repositório (`.github/workflows`) nesta etapa — o modo de implantação atual (deploy manual/on-premise para uma única loja) não o exige como bloqueador. Ver `docs/` ou o histórico de etapas de auditoria (`18.x`) para o estado de maturidade de cada módulo antes de considerar automatizar o pipeline.

## Arquitetura

- **Backoffice** (`/auth/*`, demais rotas sob `/api/v1`): identidade `Usuario`, guard `JwtAuthGuard` + `RolesGuard`.
- **MARIELA PDV** (`/pdv/*`): identidade `Vendedor`, guard `PdvJwtAuthGuard` — domínio de autenticação **completamente isolado** do Backoffice (segredos JWT distintos, nunca compartilhados).
- MongoDB via Mongoose; cada módulo de domínio registra seus próprios schemas via `MongooseModule.forFeature`.
