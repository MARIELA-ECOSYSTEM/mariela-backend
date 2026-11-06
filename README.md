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

## Desativar um administrador

Também sem rota HTTP. `bun run admin:desativar` grava `ativo: false`, revoga **todas** as sessões (refresh tokens) do usuário e registra o evento `ADMIN_DEACTIVATED` em `eventos_auth` (motivo, executor, sessões revogadas). O documento, a senha, o perfil e todo o histórico são preservados. Só desativa ADMIN.

```bash
# dry-run (padrão, somente leitura): mostra o estado e o que seria feito
ADMIN_EMAIL=alvo@exemplo.com bun run admin:desativar --banco <banco-da-MONGODB_URI>

# aplica — a confirmação repete o MESMO e-mail; o motivo é obrigatório
ADMIN_EMAIL=alvo@exemplo.com ADMIN_DEACTIVATE_CONFIRM=alvo@exemplo.com \
ADMIN_DEACTIVATE_REASON="motivo" [ADMIN_DEACTIVATE_EXECUTOR="quem executa"] \
  bun run admin:desativar --banco <banco> --apply [--confirmar-producao <banco>]
```

- `--banco` precisa ser exatamente o banco da `MONGODB_URI`; `mariela_dev_local` é recusado; em banco protegido (produção ou não reconhecido como teste local) o `--apply` exige também `--confirmar-producao <nome-exato>`. Recusa rodar a partir de `dist/`, com `NODE_ENV=production`, no Render ou em container.
- Idempotente: reexecutar não duplica o evento; se o usuário já estava inativo, só revoga sessões remanescentes (evento `ADMIN_SESSIONS_REVOKED` quando houver alguma). Uma falha no meio é relatada com a etapa; reexecutar conclui.
- Login e renovação de sessão passam a ser recusados na hora. **Limitação:** um access token JWT já emitido continua válido até expirar (`JWT_ACCESS_EXPIRES_IN`, padrão 15 min) — o guard é stateless.
- Não há comando de reativação.

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

## Mídia (imagens e vídeos) — Cloudflare R2

O backend **não recebe arquivos**: ele só autoriza o envio e confere o resultado. O arquivo vai direto do Backoffice para um bucket do Cloudflare R2 (API compatível com S3) por uma URL pré-assinada; o MongoDB guarda só metadados e URLs públicas. Nada de mídia fica no disco do servidor.

**Arquitetura**

- Abstração `MediaStorage` (token `MEDIA_STORAGE`; `MEDIA_PRESIGNER` aponta para a mesma instância), implementada por `R2PresignerProvider`: assina uploads (cálculo local, sem rede) e faz `HeadObject`, `GetObject` com Range e `DeleteObject`.
- Endpoint S3: `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`, região `auto`.
- Leitura **pública** pelo domínio de `R2_PUBLIC_BASE_URL`: a URL de cada objeto é `R2_PUBLIC_BASE_URL + "/" + chave` (a base precisa apontar para a raiz do bucket). Só a escrita é assinada.
- Chaves geradas pelo backend: `products/{produtoId}/{uuid}.{ext}`. O cliente nunca informa bucket, chave nem URL.

**Galeria do produto (fluxo atual)** — `Produto.midias[]`, `Produto.midiaPrincipalId`, ciclo de vida em `uploads_midia`. Todos os endpoints exigem `ADMIN` (o token do PDV é rejeitado).

1. `POST /api/v1/produtos/:id/midias/uploads` com `{ fileName, contentType, kind, size, substituiMidiaId? }` → `{ uploadId, uploadUrl, method: "PUT", headers, expiresIn: 600 }`. Cria o registro `pendente`; a galeria não muda.
2. O cliente faz `PUT uploadUrl` com o arquivo e **exatamente** os `headers` devolvidos: `Content-Type` e `Cache-Control: public, max-age=31536000, immutable`. O `Content-Length` (definido pelo navegador a partir do arquivo) precisa ser igual ao `size` declarado. Os três estão na assinatura: qualquer diferença faz o R2 recusar. A URL vale **10 minutos**.
3. `POST /api/v1/produtos/:id/midias/uploads/:uploadId/confirmacao` com `{ varianteId?, principal?, substituiMidiaId? }` → `201 { midia, midias, midiaPrincipalId }`. O backend confere no R2 a existência, o tamanho, o `Content-Type` e a assinatura real do formato (primeiros bytes); só então grava a mídia no produto, segurando a reserva atômica do registro (`pendente → confirmando`). Repetir a confirmação é idempotente.
4. Gestão: `GET /produtos/:id/midias`, `PATCH /produtos/:id/midias/:midiaId` (variante, só imagem), `PUT /produtos/:id/midias/principal`, `PUT /produtos/:id/midias/ordem`, `DELETE /produtos/:id/midias/:midiaId` (tira da galeria; **o objeto no R2 não é apagado**).

**Endpoint antigo (Fase 40) — legado, a ser descontinuado** — `POST /api/v1/media/presigned-upload` com `{ fileName, contentType, kind, size, produtoId }` → `{ uploadUrl, method, headers: { Content-Type }, publicUrl, key, expiresIn }`; o cliente gravava `publicUrl` em `variante.foto`/`video`. Continua ativo e com o contrato inalterado, mas **não cria registro em `uploads_midia`**: um objeto enviado por ele e nunca salvo fica órfão, invisível à limpeza. Novos usos devem ir para a galeria.

**Regras (validadas no backend)**

| | Imagem (`kind: "image"`) | Vídeo (`kind: "video"`) |
|---|---|---|
| Tipos | `image/jpeg`, `image/png`, `image/webp`, `image/gif` | `video/mp4` |
| Tamanho máximo | 5 MB | 15 MB |
| Por produto (galeria) | 20 | 3 |

A extensão de `fileName` precisa corresponder ao tipo. A substituição (`substituiMidiaId`) precisa ser do mesmo tipo e não conta no limite.

**Erros:** `400 VALIDATION_ERROR`, `401`, `404`, `409 CONFLICT` (limite, upload expirado/em limpeza, alvo de substituição divergente, concorrência), `503 STORAGE_NOT_CONFIGURED` (alguma variável `R2_*` ausente; cita só os nomes), `503 STORAGE_UNAVAILABLE` (o R2 falhou ou não respondeu dentro do prazo).

**Variáveis** (opcionais para o boot; ver `.env.example`):

- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_BASE_URL` — as cinco são necessárias para a mídia funcionar.
- `R2_CONNECTION_TIMEOUT_MS` (padrão 3000), `R2_REQUEST_TIMEOUT_MS` (padrão 10000), `R2_MAX_ATTEMPTS` (padrão 2) — transporte das chamadas ao R2. O prazo de cada tentativa (conexão + resposta) é aplicado pelo próprio backend; só falhas transitórias (5xx, 429, rede, prazo esgotado) são repetidas; erros permanentes (403, 404, 400...) falham na hora. Os padrões são decisões deste projeto, não recomendações da Cloudflare. Os comandos locais usam os padrões.

`bun run midias:verificar-r2` confere, **sem rede**, se as variáveis do processo estão presentes e com formato válido (nunca imprime os valores). Não testa credenciais, bucket, domínio nem CORS.

**Configuração externa necessária (Cloudflare — fora do código; não verificada por este repositório):**

- Token R2 com permissão de leitura e escrita de objetos, restrito ao bucket (o backend assina `PutObject` e executa `HeadObject`, `GetObject` e `DeleteObject`).
- Leitura pública do bucket pelo domínio de `R2_PUBLIC_BASE_URL`.
- **CORS do bucket** (o `PUT` vai direto ao R2, não passa pelo CORS do backend): origens iguais às de `CORS_ORIGINS` — inclusive `http://tauri.localhost` (Backoffice empacotado no Windows) e, se houver macOS/Linux, `tauri://localhost`; em desenvolvimento, `http://localhost:8081` (Backoffice) e `http://localhost:8080` (PDV) —, método `PUT` e cabeçalhos permitidos **`content-type` e `cache-control`**. Sem `cache-control`, o upload da galeria falha no preflight.
- Recomendado: um bucket separado para testes, nunca o de produção.

**Limpeza e histórico**

- `bun run midias:limpar-abandonadas --banco <banco>` (dry-run por padrão) exclui só objetos de uploads `pendente` vencidos (`limpezaApos` + 15 min) que nenhum produto nem venda referencia, e marca o registro `descartado` (registros nunca são apagados). Reserva atômica (`limpando`) excludente com a confirmação. Nesta etapa, `--apply` só no banco de teste local.
- Mídias removidas da galeria e fotos copiadas nas vendas são **preservadas**: nenhum fluxo apaga um objeto que já esteve na galeria.
- `bun run midias:migrar-legado --banco <banco>` (dry-run por padrão) copia `variante.foto`/`video` para a galeria sem alterar os campos legados.

Ainda não implementado: miniaturas/redimensionamento, pôster de vídeo.

## Backup e recuperação do MongoDB

Produção roda no MongoDB Atlas, plano **Free (M0)** — que **não** oferece Cloud Backup/snapshots nativos (confirmado na documentação oficial da MongoDB, Fase 29-FI.1). O mecanismo em uso é `mongodump`/`mongorestore` agendado externamente, com script pronto e testado em `ops/backup/` (scripts operacionais, fora do backend — nunca uma dependência do projeto). Procedimento completo, política de retenção e checklist de validação de restore: ver [`docs/backup-mongodb.md`](docs/backup-mongodb.md).

Se o MongoDB de produção migrar para auto-hospedado (ex.: dentro do próprio `docker-compose.yml` acima) ou para um tier Atlas com Cloud Backup nativo (M10+/Flex), reavaliar se os scripts em `ops/backup/` continuam necessários ou se o backup nativo do provedor passa a ser suficiente.

## CI/CD

`.github/workflows/ci.yml` roda em todo Pull Request e todo push em `main`: instalação determinística (`bun install --frozen-lockfile`), typecheck, suíte completa (contra um MongoDB de serviço do próprio runner), build de produção e audit de dependências (`bun audit`). O audit tem uma única exceção explícita, `GHSA-g3hv-75wg-m249` (dependência de desenvolvimento do `@nestjs/cli`, sem correção compatível), com a justificativa e a política de revisão no comentário do próprio passo no workflow. Não há deploy automático — esse é um passo manual/operacional separado (ver seção "Deploy com Docker" acima).

## Arquitetura

- **Backoffice** (`/auth/*`, demais rotas sob `/api/v1`): identidade `Usuario`, guard `JwtAuthGuard` + `RolesGuard`.
- **MARIELA PDV** (`/pdv/*`): identidade `Vendedor`, guard `PdvJwtAuthGuard` — domínio de autenticação **completamente isolado** do Backoffice (segredos JWT distintos, nunca compartilhados).
- MongoDB via Mongoose; cada módulo de domínio registra seus próprios schemas via `MongooseModule.forFeature`.
- Cadastro central de cores/tamanhos/categorias/formas de pagamento, unicidade case-insensitive, validação nos fluxos de Produtos/Estoque/Vendas/Caixa e o risco residual de concorrência (sem transações multi-documento, por decisão arquitetural): ver [`docs/configuracoes-cores-tamanhos.md`](docs/configuracoes-cores-tamanhos.md).
