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

Sobe a API (`Dockerfile`, multi-stage, usuário não-root, `HEALTHCHECK` embutido usando `/health`) e um MongoDB autenticado num único host — o cenário mais simples de implantação para a loja física. `docker-compose.yml` espera um `.env` já preenchido no diretório do projeto (`env_file: .env`), incluindo as 4 credenciais do MongoDB descritas em `.env.example` (usuário root administrativo + usuário de aplicação, escopado só ao banco `mariela` — ver comentários lá e em `docker/mongo-init/init-mariela-user.js`).

A porta do MongoDB (27017) é publicada só em `127.0.0.1` (loopback do próprio host) — suficiente para `mongosh`/`mongodump` administrativos locais, mas não alcançável pela rede; combinado com a autenticação, mesmo quem alcançar essa porta pelo host precisa de credencial válida.

> O `Dockerfile`/`docker-compose.yml` (incluindo a autenticação do MongoDB da Etapa 28) foram escritos e revisados mas **não foram validados com um build/subida reais** (ambiente de desenvolvimento sem Docker disponível) — valide `docker compose up --build` antes do primeiro uso em produção, prestando atenção especial à criação do usuário de aplicação (só acontece na primeira inicialização, com o volume vazio).

Para um deploy sem Docker, compile e rode diretamente:

```bash
bun run build
bun run start:prod
```

## Backup e recuperação do MongoDB

Produção roda no MongoDB Atlas, plano **Free (M0)** — que **não** oferece Cloud Backup/snapshots nativos (confirmado na documentação oficial da MongoDB, Fase 29-FI.1). O mecanismo em uso é `mongodump`/`mongorestore` agendado externamente, com script pronto e testado em `ops/backup/` (scripts operacionais, fora do backend — nunca uma dependência do projeto). Procedimento completo, política de retenção e checklist de validação de restore: ver [`docs/backup-mongodb.md`](docs/backup-mongodb.md).

Se o MongoDB de produção migrar para auto-hospedado (ex.: dentro do próprio `docker-compose.yml` acima) ou para um tier Atlas com Cloud Backup nativo (M10+/Flex), reavaliar se os scripts em `ops/backup/` continuam necessários ou se o backup nativo do provedor passa a ser suficiente.

## CI/CD

`.github/workflows/ci.yml` roda em todo Pull Request e todo push em `main`: instalação determinística (`bun install --frozen-lockfile`), typecheck, suíte completa (contra um MongoDB de serviço do próprio runner) e build de produção. Não há deploy automático — esse é um passo manual/operacional separado (ver seção "Deploy com Docker" acima).

## Arquitetura

- **Backoffice** (`/auth/*`, demais rotas sob `/api/v1`): identidade `Usuario`, guard `JwtAuthGuard` + `RolesGuard`.
- **MARIELA PDV** (`/pdv/*`): identidade `Vendedor`, guard `PdvJwtAuthGuard` — domínio de autenticação **completamente isolado** do Backoffice (segredos JWT distintos, nunca compartilhados).
- MongoDB via Mongoose; cada módulo de domínio registra seus próprios schemas via `MongooseModule.forFeature`.
