# MARIELA PDV — Especificação Técnica (v1)

> **Status: ESPECIFICAÇÃO — nenhum código de produção foi escrito nesta etapa.**
> Auditoria realizada em 2026-09-07 contra o estado real do backend (`backend/src/modules/`) no branch `docs/fix-readme-bun-setup`, commit `fcc80e4` ("desenvolviment do backend").
>
> Este documento é o contrato definitivo para a implementação do MARIELA PDV. Qualquer decisão arquitetural relevante já foi tomada aqui; a próxima etapa é "implemente o módulo X exatamente conforme esta especificação", módulo por módulo, seguindo o plano na seção S.

---

## A. Auditoria do backend existente

### A.1 Arquitetura confirmada

- NestJS 12 modular monolith, ESM, Mongoose, sem replica set confirmado (nada no projeto assume transações multi-documento — ver seção L).
- Autenticação ADMIN é **inteiramente hand-rolled**: não existe `PassportStrategy`/`JwtStrategy` em lugar nenhum. `JwtAuthGuard` chama `JwtService.verifyAsync` diretamente e é **stateless** (não consulta o Mongo a cada requisição).
- `@nestjs/throttler` **não está instalado**. O único rate-limiting existente é `LoginThrottleService` (em memória, por processo, documentado como não seguro para múltiplas instâncias), usado exclusivamente pelo login ADMIN.
- Módulos registrados hoje em `app.module.ts`: `SaudeModule, AuthModule, ProdutosModule, EstoqueModule, ClientesModule, FornecedoresModule, ColecoesModule, CampanhasModule, VendedoresModule, CaixasModule, VendasModule, DashboardModule`. Nenhum módulo de PDV existe.
- Toda resposta HTTP de sucesso é envelopada em `{ data }` por um `ResponseInterceptor` global (a menos que o handler já devolva um objeto com a chave `data`, usado pelos endpoints paginados: `{ data, meta, facets }`).
- Todo erro passa por um `HttpExceptionFilter` global que produz `{ statusCode, code, message, errors }`; `ApiException` é a fábrica de erros de negócio (ver seção "Erros" abaixo).
- Padrão de concorrência otimista: todos os 8 schemas de domínio (`Produto, Cliente, Fornecedor, Colecao, Campanha, Vendedor, Caixa, Venda`) têm `optimisticConcurrency: true` — sem isso, Mongoose nunca lançaria `VersionError` em saves concorrentes (bug histórico já corrigido no projeto).
- Padrão de serialização: `aplicarSerializacaoPadrao(schema, camposOcultos)` troca `_id`→`id`, remove `__v`, e oculta campos internos (`senhaHash`, `telefoneNormalizado`, `excluidoEm`) — deve ser aplicado em **todo** schema, inclusive subdocumentos.
- Padrão de sequência atômica: `SequenciasService.proximoValor(chave)` → `SequenciasRepository` faz `findOneAndUpdate({_id: chave}, {$inc:{valor:1}}, {upsert:true, returnDocument:"after"})` — atômico de verdade, uma única operação Mongo. Este é o único gerador de código seguro sob concorrência no projeto e **deve ser reutilizado tal como está** para qualquer código do PDV (venda, ou uma futura sessão de caixa/turno).
- Padrão "salvarComRetentativa": todo módulo (Produtos, Clientes, Vendedores, Vendas) usa um loop de até 3 tentativas: lê o documento, aplica uma função `mutar`, tenta `.save()`, se pegar `VersionError` repete. **Este é o mecanismo real que protege a baixa de estoque hoje** (`ProdutosService.ajustarQuantidadeTamanho` → `produtosRepository.salvarComRetentativa`) — **não** é um `findOneAndUpdate` atômico com filtro `quantidade >= X` (ver seção L, é uma lacuna real de concorrência a resolver).
- Padrão "atômico por filtro Mongo" (mais forte que o anterior) já existe em dois lugares: `CaixasRepository.fecharAtomico` (`findOneAndUpdate({_id, status:"aberto"}, ...)`) e o índice único parcial `{status:1}` em `Caixa` que impede duas aberturas simultâneas (a segunda inserção vira erro de chave duplicada, capturado e traduzido em `ApiException.conflict`). `ProdutosRepository.adicionarVarianteAtomico` usa a mesma técnica para evitar cor duplicada. **Este é o padrão que o PDV deve usar/estender para a baixa de estoque** (ver L.3).

### A.2 Problemas e incompatibilidades encontrados na auditoria (relevantes para o PDV)

1. **Não existe nenhuma rota HTTP para autenticação de Vendedor.** `VendedoresService` só *escreve* `senhaHash` (criar/atualizar/redefinir); não existe `autenticar()`/`verificarSenha()` em lugar nenhum. Terá que ser criado do zero.
2. **`POST /vendas` não existe.** `VendasService.criar()` está pronto e funcional (baixa estoque, gera código, lança no caixa, atualiza agregados) mas não é exposto por nenhum controller. É o candidato natural a virar o motor do endpoint de criação do PDV — **não deve ser reescrito**, apenas exposto atrás de uma nova autorização.
3. **`VendedoresService.listarVendas()` e `CaixasService.listarVendas()`/`listarRecebimentos()` estão hardcoded retornando listas vazias.** Comentários no código dizem "Vendas ainda não existe" — isso está desatualizado (Vendas já existe e efetivamente grava em Caixa via `registrarMovimentoDeVenda`), mas ninguém religou essas 3 leituras. Não é bloqueante para o PDV, mas é uma dívida a registrar (fora do escopo desta especificação — pertence ao Backoffice).
4. **Atribuição de responsável no caixa é hardcoded para vendas.** `VendasService.criar()` chama `caixasService.registrarMovimentoDeVenda({ ..., responsavelId: null, responsavelNome: vendedor.nome })` — na prática já registra o nome do vendedor certo (snapshot), então **não há mudança necessária aqui**; `responsavelId: null` é aceitável porque o snapshot de nome já é suficiente para o extrato. `baixarParcela` hoje hardcoda `responsavelNome: "Backoffice"` porque só o ADMIN pode chamá-la hoje — se o PDV vier a participar desse fluxo no futuro (fora do escopo desta v1, ver seção 24 do prompt), essa string terá que ser trocada pelo vendedor autenticado.
5. **Baixa de estoque não é atômica por filtro Mongo, é otimista com retry.** Sob alta concorrência real (dois PDVs vendendo a última peça no mesmo milissegundo), o mecanismo atual funciona corretamente (um dos dois `save()` sempre falha com `VersionError` e é re-tentado do zero, re-validando estoque) mas não é a técnica mais robusta disponível no próprio código-base (compare com `fecharAtomico`/`adicionarVarianteAtomico`). Ver decisão em L.3.
6. **`refresh_tokens` está tipado/documentado para `Usuario` apenas.** `RefreshToken.usuarioId: Types.ObjectId` e o comentário do schema dizem explicitamente que isso nunca é um Vendedor. Reaproveitar a coleção exigiria mudar o schema; a decisão tomada (seção C) é **não reaproveitar**, criar uma coleção paralela.
7. **Nenhum enum de forma de pagamento existe no backend.** `formaPagamento` é uma `string` livre validada só por `@IsString() @MaxLength(60)` tanto em `PagamentoSolicitado` (interno) quanto em `BaixarParcelaDto`. O PDV **não pode inventar um enum novo sem alterar o contrato existente de Vendas** — a decisão (seção 17) é manter `string` livre no payload, mas validar contra uma whitelist de aplicação (ver seção 17 abaixo) — sem quebrar o schema existente.

---

## B. Auditoria do módulo Vendas — o que reaproveitar, o que falta

### B.1 Pronto e reutilizável sem alteração
- `Venda` schema completo (itens, pagamentos, parcelas, histórico, cancelamento) — **não muda**.
- `VendasService.criar(dados: DadosCriarVenda, usuarioId: string | null): Promise<VendaDocument>` — motor de criação completo: valida vendedor ativo, caixa aberto, pré-checa estoque de todos os itens, baixa estoque item a item com rollback compensatório em caso de falha no meio, calcula `valorBruto/descontoPromocional/subtotal/descontoVenda/valorFinal/valorPago/valorPendente`, monta parcelas, gera `codigo`/`numero` via sequência atômica, define `status` (`em_pagamento`/`concluida`), lança no caixa **somente o valor efetivamente pago**, atualiza agregados de Cliente/Vendedor, registra evento de auditoria. **Este método já é, na prática, o "controller" de negócio do PDV** — falta só uma casca HTTP com a autorização certa.
- `VendasService.obterPorId`, `.listar`, `.estatisticas`, `.baixarParcela`, `.cancelar` — continuam existindo e continuam **exclusivos do Backoffice/ADMIN** (ver seção 7 do prompt e decisões abaixo).
- `idempotencyKey` já suportado ponta a ponta: índice único parcial no schema, checagem em `criar()` que devolve a venda existente em vez de duplicar.
- `CaixasService.registrarMovimentoDeVenda(...)` — ponto de integração único e correto, já usado por `criar`/`baixarParcela`/`cancelar`. O PDV **nunca** deve escrever em `movimentos_caixa` diretamente.
- Regra "só dinheiro recebido entra no caixa" já implementada e testada (`valorPago > 0` decide se lança movimento; `cancelar` lança `min(valorDevolvido, venda.valorPago)`).

### B.2 O que falta construir (não altera o service existente)
- Uma rota HTTP nova (`POST /pdv/vendas`, ver contrato completo na seção G) que:
  1. autentica o vendedor (guard novo, seção C/D);
  2. valida que o `vendedorId` do payload (se o payload trouxer um) **bate com o vendedor do token** — nunca confiar em um `vendedorId` enviado pelo cliente quando ele diverge da identidade autenticada (ver seção N);
  3. chama `VendasService.criar(dados, usuarioId: null)` — o parâmetro `usuarioId` existente é "quem administrou", usado hoje só para o evento de auditoria por um ADMIN; para uma venda feita pelo PDV, será `null` (nenhum `Usuario` administrou) e o `vendedorId` real já vem dentro de `dados` e é gravado na venda normalmente. **Não é necessário alterar a assinatura do método.**
- Nenhuma alteração ao schema, tipos ou repository de Vendas é necessária para viabilizar o PDV nesta v1.

### B.3 Decisão da seção 45 do prompt (dividir `VendasService`?)
**Decisão: NÃO dividir.** `VendasService` continua único. O PDV não precisa de nenhuma lógica de negócio que `criar()` não tenha — só precisa de uma nova via de entrada HTTP (`PdvVendasController`, módulo `PdvModule`) que injeta o `VendasService` já existente (exportado por `VendasModule`) e delega diretamente. Criar um `PDVVendasService` só para reimplementar o que `criar()` já faz seria exatamente a duplicação de regra proibida pela seção 46 do prompt. A separação de responsabilidade certa é **por módulo de transporte** (`VendasController` para ADMIN, `PdvVendasController` para vendedor), não por lógica de domínio.

---

## C. Arquitetura de autenticação do PDV

### C.1 Decisão: autenticação de Vendedor separada, paralela à de ADMIN — nunca role dentro de `Usuario`

Confirmado pela auditoria: `ROLES = ["ADMIN"]`, `Usuario.role: Role`, e `JwtPayload.sub` são documentados explicitamente como referindo-se só ao ADMIN. Adicionar `"VENDEDOR"` a `ROLES` violaria a premissa arquitetural fixa do projeto (Vendedor não é Usuario) e forçaria o Guard/Payload compartilhado a lidar com dois tipos de identidade heterogêneos (um tem `senhaHash`+`role` fixo ADMIN; o outro tem `ativo`/`excluidoEm`/agregados comerciais). **Justificativa arquitetural**: os dois principals têm ciclos de vida, campos e regras de negócio completamente diferentes (ADMIN nunca é excluído/soft-deleted como identidade de autenticação; Vendedor pode ser inativado e continuar existindo para histórico). Compartilhar `JwtPayload`/`Role` exigiria checagens condicionais espalhadas por todos os guards existentes (`RolesGuard` teria que aprender um terceiro estado). Portanto: **dois JWTs distintos, dois guards distintos, dois payloads distintos, nunca um cruzando o domínio do outro.**

### C.2 Endpoint de login: `POST /pdv/auth/login` (não `/vendedores/auth/login`)

Decisão: namespace **`/pdv/auth/...`**, não `/vendedores/auth/...`. Razão: `/vendedores` já é o namespace administrativo ADMIN-only do Backoffice (CRUD de vendedores); misturar uma rota pública de login sob esse prefixo criaria ambiguidade de guard (a maioria das rotas em `/vendedores/*` exige `@Roles("ADMIN")`, mas login precisa ser público) e confundiria o "dono" do namespace. `/pdv/*` é o namespace do sistema PDV inteiro — login, sessão, catálogo, caixa, venda — e cresce coerentemente com o resto do contrato (seção G).

### C.3 Novo módulo: `PdvModule` (contém sub-áreas: `auth`, `sessao`, futuramente catálogo/caixa/venda conforme plano de implementação)

```
backend/src/modules/pdv/
  pdv-auth.module.ts
  pdv-auth.controller.ts        # POST /pdv/auth/login, /refresh, /logout
  pdv-auth.service.ts
  pdv-sessao.controller.ts      # GET /pdv/me
  guards/
    pdv-jwt-auth.guard.ts       # equivalente a JwtAuthGuard, mas valida payload de Vendedor
  schemas/
    vendedor-refresh-token.schema.ts   # coleção NOVA `vendedor_refresh_tokens`
    evento-pdv-auth.schema.ts          # coleção NOVA `eventos_pdv_auth`
  types/
    vendedor-jwt-payload.interface.ts
    vendedor-publico.interface.ts
  dto/
    pdv-login.dto.ts
    pdv-refresh-token.dto.ts
  pdv-login-throttle.service.ts  # cópia adaptada de LoginThrottleService (não reexportada de Auth — mesmo padrão que VendedoresService já usa para não importar de Auth)
```

Justificativa de não importar nada do módulo `AuthModule` (além de repetir o padrão): o próprio `VendedoresService` já estabelece esse precedente ("este módulo não importa nada do módulo Auth além de replicar o mesmo padrão de hashing") — a intenção documentada no código é manter os dois domínios de identidade **fisicamente desacoplados**, para que uma mudança na autenticação ADMIN nunca tenha risco de vazar para a autenticação do PDV e vice-versa.

### C.4 Adicionar `VendedoresService.autenticar()` (peça que falta)

Como constatado na auditoria, não existe nenhum método de verificação de senha em `VendedoresService`/`VendedoresRepository`. É necessário adicionar **um único método novo**, seguindo o mesmo padrão de `AuthService.login`:

```ts
// VendedoresService — método NOVO
async autenticar(telefoneOuCodigo: string, senha: string): Promise<VendedorDocument | null> {
  const vendedor = await this.vendedoresRepository.encontrarPorCodigoOuTelefone(telefoneOuCodigo);
  const senhaConfere = await Bun.password.verify(senha, vendedor?.senhaHash ?? HASH_FANTASMA_VENDEDOR);
  if (!vendedor || !senhaConfere || !vendedor.ativo || vendedor.excluidoEm) return null;
  return vendedor;
}
```
- Reaproveita exatamente o padrão de defesa contra canal lateral de tempo (`HASH_FANTASMA`) já usado em `AuthService.login` — precisa de sua própria constante `HASH_FANTASMA_VENDEDOR` computada uma vez no boot do `PdvAuthService` (não importar a de Auth, mesmo motivo de C.3).
- **Credencial de login**: decisão — **telefone normalizado OU código (`VEN-0001`)**, não e-mail (Vendedor não tem e-mail no schema atual, e não deve ganhar um só para login — seria um campo inventado). Na prática, a tela de login do PDV pedirá "telefone ou código" + senha. Justificativa: é o único identificador único e memorável que já existe no domínio de Vendedor (fora o `_id` do Mongo, que não é apresentável).
- Isso exige um novo método no repository: `VendedoresRepository.encontrarPorCodigoOuTelefone(valor: string): Promise<VendedorDocument | null>` — busca por `codigo` OU por `telefoneNormalizado` (normalizando o valor de entrada com a mesma função já usada em `criar`/`atualizar`). Pequena adição, não uma reescrita.

### C.5 Payload JWT do Vendedor — distinto do ADMIN

```ts
// vendedor-jwt-payload.interface.ts
export interface VendedorJwtPayload {
  sub: string;        // Vendedor._id
  codigo: string;      // ex.: "VEN-0001"
  tipo: "VENDEDOR";     // discriminador fixo — nunca "ADMIN", nunca reaproveita `Role`
  iat?: number;
  exp?: number;
}
```
`tipo: "VENDEDOR"` fixo (não um array de roles) — não há hierarquia de papéis dentro do domínio Vendedor nesta v1 (todo vendedor autenticado tem as mesmas permissões, ver seção "Autorização do vendedor"). Isso também garante, por construção, que um token de Vendedor nunca passa na checagem de `JwtAuthGuard`/`RolesGuard` do Backoffice (que exigem `role` ∈ `ROLES = ["ADMIN"]`) — mesmo que alguém tentasse usar um token de Vendedor contra uma rota `/produtos`, `payloadValido()` rejeitaria por não ter o campo `role`.

### C.6 `PdvJwtAuthGuard` — novo guard, JWT com segredo próprio

- Assinado com um segredo **novo e distinto**: `JWT_PDV_ACCESS_SECRET` (nova variável de ambiente). Nunca reaproveitar `JWT_ACCESS_SECRET` do ADMIN — um vazamento de segredo de um domínio nunca deve comprometer o outro.
- `JwtModule` global atual só registra o par de segredos do ADMIN. Para o PDV, em vez de reconfigurar o `JwtModule` global (que afetaria todo o app), o `PdvAuthModule` cria sua **própria instância local** de `JwtService` via `JwtModule.registerAsync({...})` **sem `global: true`**, escopada ao módulo do PDV — o Nest permite múltiplas instâncias de `JwtModule` coexistindo desde que não sejam ambas globais. `PdvJwtAuthGuard` injeta essa instância local (`@Inject` com token do módulo, não o `JwtService` global) para nunca correr o risco de verificar um token de vendedor com o segredo do ADMIN por engano de DI.
- `expiresIn` do access token do PDV: **mais curto que o do ADMIN** — decisão: **30 minutos** (vs. 15 min do ADMIN, mas com refresh mais frequente esperado por sessão de loja aberta o dia todo — ver C.9). Justificativa: o PDV roda numa tela fixa de loja, não em um dispositivo pessoal como o Backoffice; a troca de vendedor (ver seção "Sessão") precisa ser rápida, e o refresh token cobre a sessão longa.

### C.7 Refresh token do Vendedor — coleção paralela `vendedor_refresh_tokens`

Decisão da seção A.2.6: **não reaproveitar `refresh_tokens`**. Nova coleção, schema quase idêntico (mesmo mecanismo comprovado de rotação/revogação/reuse-detection do ADMIN, comprovadamente correto e testado):

```ts
@Schema({ collection: "vendedor_refresh_tokens", timestamps: { createdAt: "criadoEm", updatedAt: false } })
export class VendedorRefreshToken {
  vendedorId!: Types.ObjectId;   // required, index — FK só a Vendedor
  tokenHash!: string;            // required, unique — HMAC-SHA256(JWT_PDV_REFRESH_SECRET, raw)
  expiresAt!: Date;              // required
  revogadoEm!: Date | null;
  rotacionadoEm!: Date | null;
  substituidoPor!: string | null;
  dispositivoId!: string | null;  // NOVO campo — ver C.8, não existe no RefreshToken do ADMIN
  userAgent!: string | null;
  ip!: string | null;
  criadoEm!: Date;
}
VendedorRefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
```
- Mesma lógica de rotação atômica (`findOneAndUpdate` com `revogadoEm: null` + `returnDocument: "before"`), mesma detecção de reuso (token já revogado sendo reapresentado → revoga toda a família + evento de auditoria), mesmo TTL por data absoluta.
- `refreshExpiresIn`: **12 horas** (não 7 dias como o ADMIN). Justificativa: um PDV de loja física plausivelmente reinicia a sessão a cada abertura de expediente; 7 dias é desnecessário e amplia a janela de um token roubado. 12h cobre um turno + alguma folga.
- Campo novo `dispositivoId` (opcional, ver C.8) permite, no futuro, revogar/limitar sessões por terminal físico sem quebrar o contrato — não implementado nesta v1 além de armazenar o valor se o cliente enviar.

### C.8 Identificação de dispositivo/PDV

Decisão: **opcional e não bloqueante nesta v1.** O corpo de `POST /pdv/auth/login` aceita um campo opcional `dispositivoId?: string` (um UUID gerado e persistido localmente pelo próprio app PDV na primeira execução, ex. via `localStorage`/arquivo de config do Tauri). Ele é apenas **armazenado** junto ao refresh token para fins forenses/observabilidade (seção 40) — nenhuma regra de negócio depende dele nesta versão (não há limite de dispositivos por vendedor, não há "logout remoto de um terminal específico"). Isso deixa a porta aberta para features futuras (seção 33, múltiplos PDVs) sem inventar infraestrutura não pedida agora.

### C.9 Sessão simultânea e troca de vendedor

- **Sessões simultâneas são permitidas**: nada nesta especificação impede que o mesmo vendedor esteja autenticado em dois PDVs ao mesmo tempo (ex.: cobriu a falta de um colega em outro caixa). Cada login emite um novo par de tokens; múltiplos refresh tokens ativos por vendedor coexistem normalmente (mesmo comportamento hoje possível para o ADMIN, que também não tem limite de sessões).
- **Troca de vendedor no mesmo terminal** ("vendedor A termina o turno, vendedor B assume o mesmo PDV físico"): tratada como **logout + login normais**, não como uma operação especial. O frontend do PDV deve ter uma tela de logout rápido (ver seção 37) que chama `POST /pdv/auth/logout` (revoga só o refresh token da sessão atual) e volta à tela de login. Não é necessário revogar as sessões de outros vendedores nesse terminal — não existe o conceito de "sessão amarrada ao terminal" nesta v1 (ver C.8).

### C.10 Recuperação/redefinição de senha do vendedor

Decisão explícita (conforme exigido pela seção 5 do prompt): **o PDV não tem nenhuma tela de recuperação/redefinição de senha.** A única via de redefinição continua sendo administrativa: `PATCH /vendedores/:id/senha` no Backoffice (já existe, ADMIN-only). Justificativa: a seção 6 do prompt exige exatamente essa restrição salvo necessidade explícita, e não há necessidade demonstrada — um vendedor que esqueceu a senha pede para o ADMIN redefinir, o mesmo modelo operacional de um caixa físico de loja.

### C.11 Bloqueio de vendedor inativo/excluído

- No login (`autenticar`): vendedor com `ativo === false` OU `excluidoEm !== null` → login rejeitado com a mesma mensagem genérica de credenciais inválidas usada hoje pelo ADMIN (nunca revelar "existe mas está inativo" — mesma defesa contra enumeração já aplicada em `AuthService.login`).
- No refresh: se o vendedor foi inativado **depois** de emitido o refresh token (turno em andamento e o ADMIN desativa o vendedor no meio do expediente), o próximo `POST /pdv/auth/refresh` deve detectar isso (mesma checagem que `AuthService.refresh` já faz para `Usuario.ativo`) e revogar toda a família de tokens daquele vendedor, forçando novo login (que falhará, pois está inativo) — efetivamente derrubando a sessão em até `accessExpiresIn` (30 min) de atraso máximo, já que o `PdvJwtAuthGuard` é stateless (mesmo trade-off já aceito para o ADMIN).
- **Decisão explícita**: não implementar uma checagem síncrona de "vendedor ainda ativo" a cada requisição autenticada (isso exigiria consultar o Mongo em todo request, quebrando o padrão stateless já estabelecido e testado para o ADMIN) — o atraso máximo de 30 minutos para revogação efetiva é aceito como trade-off consistente com o resto do sistema.

### C.12 Proteção contra força bruta

Novo `PdvLoginThrottleService`, cópia adaptada de `LoginThrottleService` (mesmo padrão: mapa em memória por processo, chave `` `${ip}:${telefoneOuCodigoNormalizado}` ``, janela e limite **configuráveis via as mesmas constantes ou novas** — decisão: reutilizar os mesmos valores, `15 minutos / 5 tentativas`, por não haver motivo de negócio para divergir). Mesma limitação documentada (não é seguro em múltiplas instâncias) é herdada — aceitável nesta v1 pelo mesmo motivo que é aceitável hoje para o ADMIN (implantação single-instance).

---

## D. Arquitetura de sessão

### D.1 `GET /pdv/me`

Retorna a identidade do vendedor autenticado a partir do payload do token (sem nova consulta ao Mongo, mesmo padrão implícito de `AuthController.me` — embora `AuthController.me` hoje **consulte** o Mongo via `usuariosRepository`; decisão aqui é **divergir**: `GET /pdv/me` também consulta o Mongo, porque o frontend do PDV precisa exibir dados que mudam com frequência administrativa e não estão no payload — nome atualizado, foto). Resposta:

```json
{
  "data": {
    "id": "66f...",
    "codigo": "VEN-0001",
    "nome": "Ana Paula",
    "foto": null,
    "ativo": true
  }
}
```
Nunca inclui `senhaHash`, `telefoneNormalizado`, `vendas/totalVendido/ultimaVenda` (dados comerciais não são "sessão" — se o PDV precisar exibir o desempenho do próprio vendedor, isso é uma decisão de UX fora do escopo desta v1; não inventar esse endpoint agora).

### D.2 Estado de sessão no frontend do PDV (ver seção Q para detalhes)

- Access token em memória (nunca `localStorage` — mesmo raciocínio de segurança que se aplicaria ao Backoffice, mitigando XSS/roubo de token persistente).
- Refresh token em armazenamento seguro do Tauri (o PDV, como o Backoffice, é uma aplicação desktop Tauri — ver seção Q.1) ou em cookie `httpOnly` se o PDV rodar em navegador dedicado (decisão de plataforma pertence à etapa de implementação do frontend, seção Q, não a esta especificação de backend).
- `dispositivoId` gerado uma única vez e persistido localmente (arquivo de config do Tauri), reenviado em todo login (ver C.8).

### D.3 Logout

`POST /pdv/auth/logout` — idempotente, revoga só o refresh token apresentado (mesmo contrato de `AuthController.logout`), sem checar Authorization header (o access token, se ainda válido, simplesmente expira sozinho — mesmo modelo do ADMIN).

---

## E. Arquitetura de Caixa × PDV

### E.1 Auditoria das 4 opções da seção 9 do prompt

- **Modelo A** (ADMIN abre, vendedor só opera): mais simples, mas não reflete a operação real de uma loja pequena — obrigaria o ADMIN a estar fisicamente presente ou logado remotamente toda manhã antes de qualquer venda.
- **Modelo B** (vendedor seleciona um caixa já aberto existente): pressupõe que a abertura já ocorreu por outra via (ADMIN ou o próprio vendedor) — é sobre *seleção*, não *abertura*, então não resolve sozinho quem abre.
- **Modelo C** (PDV abre o caixa): dá autonomia total ao vendedor, inclusive para abrir caixa sem qualquer supervisão — risco operacional (abertura de caixa é um evento financeiro sensível: define o valor inicial em dinheiro).
- **Modelo D** (combinação): é a decisão tomada.

### E.2 Decisão: Modelo D — vendedor pode abrir OU usar um caixa já aberto; só ADMIN fecha

- **Quem abre**: tanto o ADMIN (Backoffice, endpoint já existente `POST /caixas`) quanto o **vendedor autenticado no PDV** (endpoint **novo** `POST /pdv/caixa/abertura`, ver seção G) podem abrir um caixa. Justificativa: numa loja física real, geralmente é a primeira vendedora a chegar quem abre o caixa contando o dinheiro trocado — exigir que o ADMIN sempre abra remotamente é operacionalmente irreal (a própria seção 9 do prompt pede para não decidir arbitrariamente e usar o "modelo operacional esperado para uma loja física" — este é ele).
  - O índice único parcial (`status: "aberto"`) já garante, a nível de banco, que só um caixa pode estar aberto por vez — **não importa se quem tenta abrir é o ADMIN pelo Backoffice ou um vendedor pelo PDV, a segunda tentativa recebe 409 automaticamente**. Nenhuma mudança de schema necessária.
  - O campo `AberturaCaixaSub.responsavelId`/`responsavelNome` já suporta um Vendedor como responsável (`CaixasService.resolverResponsavel` já aceita e valida um `responsavelId` de Vendedor via `vendedoresRepository.encontrarPorIdOuFalhar`) — **isso já funciona hoje sem nenhuma alteração**, só falta o novo endpoint do PDV chamar `CaixasService.abrir({ responsavelId: <id do vendedor autenticado>, valorInicial, observacao }, usuarioId: null)`.
- **Quem usa (vende contra o caixa)**: qualquer vendedor autenticado pode vender contra o **único caixa atualmente aberto** — não existe (e não deve existir nesta v1) o conceito de "caixa pessoal de cada vendedor"; é um único caixa físico compartilhado pela loja, exatamente como o schema já modela (`{status:1}` único parcial = **um único caixa aberto no sistema inteiro a qualquer momento**). Isso responde diretamente "como lidar com dois vendedores no mesmo caixa": **é o comportamento esperado e correto** — o caixa é do estabelecimento, não do vendedor; múltiplos vendedores vendendo contra o mesmo caixa aberto é o modelo real de uma loja com mais de uma atendente.
- **Quem pode trocar**: não existe "trocar de caixa" nesta v1 — só existe abrir (se nenhum estiver aberto) e vender contra o único aberto. Não inventar um fluxo de troca sem requisito.
- **Quem fecha**: decisão — **só o ADMIN fecha, pelo Backoffice** (`POST /caixas/:id/fechamento`, já existe, ADMIN-only, sem alteração). Justificativa: fechamento de caixa é uma conferência financeira (`valorInformado` vs. `valorEsperado`, com `diferenca` exigindo justificativa se fora da tolerância) — é um controle administrativo típico de loja física (o gerente confere o dinheiro no fim do dia), coerente com a seção 7 do prompt que não presume que o vendedor possa "fechar caixa" e pede documentação explícita. **O PDV nunca expõe um endpoint de fechamento.**
- **Como identificar o caixa**: o PDV nunca recebe/envia um `caixaId` escolhido livremente pelo vendedor — ele sempre consulta **`GET /pdv/caixa/atual`** (novo endpoint, análogo a `GET /caixas/atual` mas acessível ao vendedor) para descobrir o único caixa aberto (ou `null`/404 se nenhum estiver aberto) e usa esse `id` ao criar uma venda. O backend, na criação da venda, **revalida** que aquele `caixaId` ainda está `status === "aberto"` (já é o comportamento de `VendasService.criar`, inalterado).
- **Como impedir vendedor de operar caixa fechado/inexistente**: já garantido pelo `VendasService.criar` existente (`if (caixa.status !== "aberto") throw ApiException.validation(...)`) e por `CaixasService.exigirAberto` (usado por qualquer movimento). Nenhuma mudança necessária — só é preciso que o PDV, ao tentar abrir uma tela de venda sem caixa aberto, mostre um estado vazio claro ("Nenhum caixa aberto — abra o caixa para começar a vender") em vez de deixar o vendedor tentar e receber um 400 genérico.
- **Múltiplos PDVs**: como o caixa é único e compartilhado (não por terminal), múltiplos PDVs físicos vendendo simultaneamente contra o mesmo caixa aberto é exatamente o modelo suportado — cada venda é um documento independente, e o índice único de caixa garante que não há ambiguidade sobre contra qual caixa lançar. Nenhuma infraestrutura nova é necessária para múltiplos PDVs nesta arquitetura (ver seção 33).

### E.3 Novos endpoints necessários no namespace `/pdv/caixa`

| Endpoint | Descrição |
|---|---|
| `GET /pdv/caixa/atual` | Retorna o caixa aberto (ou 404 se nenhum) — versão vendedor-autorizada de `GET /caixas/atual`, delega ao mesmo `CaixasService.obterAtual()` |
| `POST /pdv/caixa/abertura` | Abre um caixa com `responsavelId` = vendedor autenticado (não aceita `responsavelId` no corpo — sempre o do token, ver seção N) — delega a `CaixasService.abrir` |

**Nenhum outro endpoint de caixa é exposto ao PDV** — sem entrada/saída manual (só ADMIN), sem fechamento (só ADMIN), sem listagem de movimentações/histórico (dado financeiro administrativo, seção 7 do prompt).

---

## F. Fluxo completo da venda (login → conclusão)

```text
1. Vendedor abre o app PDV
2. POST /pdv/auth/login (telefoneOuCodigo, senha, dispositivoId?)
     → 401 se credenciais inválidas/inativo (mensagem genérica)
     → 200 { accessToken, refreshToken, expiresIn, vendedor }
3. GET /pdv/caixa/atual
     → 404 "Nenhum caixa aberto"
          → tela "Abrir caixa": POST /pdv/caixa/abertura { valorInicial, observacao? }
     → 200 { id, codigo, abertura: {...} }
4. Tela principal: busca de produto
     → GET /pdv/produtos?busca=... (paginado, só produtos ativos com estoque > 0 por padrão — ver seção 10/H)
5. Seleção de variante/tamanho → monta item local no carrinho (produtoId, varianteId, tamanhoId, quantidade, preço EXIBIDO vindo da API)
6. (opcional) Buscar/selecionar cliente
     → GET /pdv/clientes?busca=...
     → (se permitido) POST /pdv/clientes { nome, telefone } — mesma validação/duplicidade do Backoffice
7. (opcional) Vendedor aplica desconto na venda (dentro do limite — ver seção 13)
8. Tela de pagamento: um ou mais lançamentos (forma, valor) — pode ser parcial
9. Confirmar venda → POST /pdv/vendas { idempotencyKey, caixaId, clienteId?, itens[], descontoVenda?, pagamentos[], totalParcelas? }
     Backend (dentro de VendasService.criar, sem alteração de lógica):
       a. idempotencyKey já visto? → devolve a venda existente (sem duplicar)
       b. vendedor ativo? caixa aberto?
       c. para cada item: produto/variante/tamanho existem? estoque suficiente?
       d. recalcula preço efetivo (promoção) e valores — NUNCA usa preço vindo do PDV
       e. baixa estoque item a item (com rollback compensatório se algum item falhar no meio)
       f. calcula valorFinal/valorPago/valorPendente, gera parcelas se houver pendente
       g. gera codigo/numero via sequência atômica
       h. persiste a Venda (status em_pagamento ou concluida)
       i. se valorPago > 0: registra movimento "venda" no caixa (só o valor recebido)
       j. atualiza agregados de Cliente (se houver) e Vendedor
       k. registra evento de auditoria "venda.criada"
     → 201 { data: <VendaResumo completo, ver seção H> }
     → 400/404/409 conforme seção "Erros" — o PDV mostra a mensagem e permite corrigir/tentar de novo com a MESMA idempotencyKey
10. Tela de confirmação: exibe código da venda, troco (se dinheiro, calculado no FRONTEND só para exibição — ver seção 18), saldo pendente se houver
11. Reinicia para o passo 4 (nova venda) — carrinho local é descartado
```

Nenhum passo aqui inventa um endpoint fora dos definidos na seção G.

---

## G. Contrato HTTP — tabela completa (rotas NOVAS do PDV)

Todas as rotas abaixo estão sob o prefixo global já existente `api/v1` (ex.: rota final real = `/api/v1/pdv/auth/login`). "Auth" = guard aplicado; "Permissão" = quem passa.

| Método | Endpoint | Auth | Permissão | Descrição |
|---|---|---|---|---|
| POST | `/pdv/auth/login` | nenhum | público | Autentica vendedor por telefone/código + senha |
| POST | `/pdv/auth/refresh` | nenhum | público (token no corpo) | Rotaciona access+refresh token do vendedor |
| POST | `/pdv/auth/logout` | nenhum | público (token no corpo) | Revoga o refresh token apresentado |
| GET | `/pdv/me` | PdvJwtAuthGuard | vendedor autenticado | Identidade do vendedor logado |
| GET | `/pdv/caixa/atual` | PdvJwtAuthGuard | vendedor autenticado | Caixa aberto atual (404 se nenhum) |
| POST | `/pdv/caixa/abertura` | PdvJwtAuthGuard | vendedor autenticado | Abre um caixa (responsável = vendedor do token) |
| GET | `/pdv/produtos` | PdvJwtAuthGuard | vendedor autenticado | Catálogo para venda (somente leitura, campos restritos) |
| GET | `/pdv/produtos/:id` | PdvJwtAuthGuard | vendedor autenticado | Detalhe de um produto (variantes/tamanhos/estoque) |
| GET | `/pdv/clientes` | PdvJwtAuthGuard | vendedor autenticado | Busca de clientes para vincular à venda |
| POST | `/pdv/clientes` | PdvJwtAuthGuard | vendedor autenticado | Cria cliente durante a venda (mesmas regras do Backoffice) |
| POST | `/pdv/vendas` | PdvJwtAuthGuard | vendedor autenticado | Cria a venda (motor: `VendasService.criar`, inalterado) |
| GET | `/pdv/vendas/minhas` | PdvJwtAuthGuard | vendedor autenticado | Vendas do próprio vendedor autenticado (ver seção "Autorização") |

**Explicitamente NÃO criado nesta v1** (decisão documentada, não esquecimento):
- `POST /pdv/vendas/:id/cancelamento` — cancelamento continua exclusivo do Backoffice (seção 25 do prompt: "o PDV não deve ganhar automaticamente permissão para cancelar").
- `POST /pdv/vendas/:id/parcelas/:id/baixa` — baixa de parcela continua exclusiva do Backoffice nesta v1 (seção 24 do prompt pede só para "definir como o PDV poderá **futuramente** participar" — decisão: não agora, sem caso de uso concreto ainda).
- Qualquer rota de estoque administrativo (`/pdv/estoque/entrada`, `/saida`) — fora do escopo do PDV.
- Qualquer rota de configuração/relatório/dashboard no namespace `/pdv`.

### Rotas administrativas existentes — confirmação de compatibilidade (seção 44 do prompt)

Nenhuma rota abaixo muda de assinatura, guard ou comportamento:
```
GET  /vendas
GET  /vendas/estatisticas
GET  /vendas/:id
POST /vendas/:id/parcelas/:parcelaId/baixa
POST /vendas/:id/cancelamento
```
`POST /vendas` continua **não existindo** no namespace administrativo — a criação de venda só existe em `/pdv/vendas`, mantendo a separação Backoffice↔administração / PDV↔venda absoluta e literal.

---

## H. Payloads — request/response de cada endpoint novo

### `POST /pdv/auth/login`
```json
// Request
{ "usuario": "83999998888", "senha": "minhasenha123", "dispositivoId": "a1b2c3-..." }
```
```json
// 200
{
  "data": {
    "accessToken": "eyJ...",
    "refreshToken": "8f3a...opaque...",
    "expiresIn": 1800,
    "vendedor": { "id": "66f...", "codigo": "VEN-0001", "nome": "Ana Paula", "foto": null }
  }
}
```
`usuario` aceita telefone (com ou sem máscara — normalizado no backend, mesma função já usada em `criar`/`atualizar` de Vendedor) OU código (`VEN-0001`, case-insensitive). 401 `INVALID_CREDENTIALS` para qualquer combinação de: não existe, senha errada, inativo, excluído — mensagem única, sem diferenciação (mesmo padrão do ADMIN).

### `POST /pdv/auth/refresh`
```json
{ "refreshToken": "8f3a...opaque..." }
```
→ mesma resposta de login (novo par de tokens). 401 `REFRESH_TOKEN_INVALID` / `REFRESH_TOKEN_REUSED` / `USER_INACTIVE` (reaproveita os mesmos `ErrorCode`s já existentes — não são exclusivos do ADMIN, são genéricos o suficiente).

### `POST /pdv/auth/logout`
```json
{ "refreshToken": "8f3a...opaque..." }
```
→ `200 { "data": { "ok": true } }` sempre (idempotente).

### `GET /pdv/me`
→ ver seção D.1.

### `GET /pdv/caixa/atual`
→ `200 { "data": { "id", "codigo", "status": "aberto", "abertura": { "dataHora", "responsavelNome", "valorInicial" } } }` — **sem** `resumo` financeiro completo (margem/saldo detalhado é dado administrativo, ver seção "Autorização"; o PDV só precisa saber "existe um caixa aberto e qual o id dele" para montar a venda). `404 NOT_FOUND` se nenhum caixa está aberto.

### `POST /pdv/caixa/abertura`
```json
{ "valorInicial": 200, "observacao": "" }
```
→ `201 { "data": { "id", "codigo", "abertura": {...} } }`. `409 CONFLICT "Já existe um caixa aberto."` se outro vendedor/ADMIN já abriu (corrida resolvida pelo índice único — nenhuma lógica nova de aplicação).

### `GET /pdv/produtos?busca=&categoria=&page=&limit=`
Reaproveita os parâmetros de busca/paginação já existentes em `ListarProdutosQueryDto` (`busca`, `categorias` CSV, `page`, `limit`) — **decisão: reexpor um subconjunto**, não todos os filtros administrativos (sem `colecoes`/`campanhas`/`fornecedores`/`promocao`/`novidade` como filtros de PDV nesta v1 — não há caso de uso de venda que precise filtrar por fornecedor). Resposta por item, **projeção restrita** (ver seção "Segurança" — nunca `precoCusto`/`margemLucro`):
```json
{
  "data": [
    {
      "id": "66e...",
      "codProduto": "PROD-0007",
      "nome": "Vestido Midi Amalfi",
      "categoria": "Vestidos",
      "precoVenda": 259.9,
      "ehPromocao": true,
      "precoPromocional": 199.9,
      "precoEfetivo": 199.9,
      "variantes": [
        {
          "id": "66e...",
          "cor": "Azul",
          "foto": "https://...",
          "tamanhos": [ { "id": "66e...", "tamanho": "M", "quantidade": 4 } ]
        }
      ]
    }
  ],
  "meta": { "total": 42, "page": 1, "limit": 20, "totalPages": 3 }
}
```
Filtro implícito e obrigatório (não configurável pelo cliente): `excluidoEm: null` (já padrão) **e, por padrão, exclui variantes/tamanhos com `quantidade === 0`** da resposta do PDV (decisão de UX — não faz sentido oferecer para venda um tamanho zerado; o Backoffice continua mostrando tudo). Campo novo `precoEfetivo` **calculado no backend** via a mesma `precoEfetivo()` de `produtos/utils/precos.util.ts` — nunca duplicado no PDV (seção 12 do prompt).

### `GET /pdv/produtos/:id`
Mesma projeção do item de listagem, sem paginação — detalhe completo de variantes/tamanhos com estoque, para a tela de seleção.

### `GET /pdv/clientes?busca=&page=&limit=`
```json
{ "data": [ { "id", "codigo", "nome", "telefone", "totalComprado", "ultimaCompra" } ], "meta": {...} }
```
Reaproveita `ClientesService.listar` (já existe, sem alteração) — apenas reexposto sob `/pdv`. `totalComprado`/`ultimaCompra` incluídos porque são úteis para o vendedor reconhecer clientes recorrentes na hora da venda (não é dado financeiro sensível como custo/margem).

### `POST /pdv/clientes`
Mesmo `CriarClienteDto` do Backoffice (`nome`, `foto?`, `telefone`, `dataNascimento?`, `observacao?`), delega diretamente a `ClientesService.criar(dto, usuarioId: null)` — **decisão da seção 14 do prompt: sim, é permitido criar cliente durante a venda**, via este endpoint dedicado (não duplicando `POST /clientes` do Backoffice, apenas reexpondo o mesmo service atrás do guard do PDV). Mesma validação de duplicidade de telefone já existente.

### `POST /pdv/vendas` — o contrato mais importante

```json
// Request
{
  "idempotencyKey": "pdv-9f3a2e1c-...",
  "caixaId": "66f...",
  "clienteId": null,
  "itens": [
    { "produtoId": "66e...", "varianteId": "66e...", "tamanhoId": "66e...", "quantidade": 1 }
  ],
  "descontoVenda": 0,
  "pagamentos": [
    { "forma": "PIX", "valor": 259.9 }
  ],
  "totalParcelas": 1,
  "observacao": ""
}
```
Este é **exatamente** `DadosCriarVenda` (já existe em `vendas.types.ts`), **sem nenhum campo novo**:
- `vendedorId` **não é enviado no corpo** — é resolvido no backend a partir do `sub` do token do vendedor autenticado (o controller injeta `dados.vendedorId = vendedorAutenticado.sub` antes de chamar `VendasService.criar`, nunca confiando em um `vendedorId` que o cliente pudesse enviar — ver seção N).
- `idempotencyKey`: **obrigatória** nesta rota (o DTO do PDV torna `@IsNotEmpty` o que hoje é opcional em `DadosCriarVenda` — decisão: para o ADMIN via testes internos era opcional, mas para uma rede real de PDV sujeita a timeout/retry, exigir sempre a chave é a defesa correta, seção 21).
- `caixaId`: obrigatório, deve ser o retornado por `GET /pdv/caixa/atual` (o backend revalida que está aberto).
- `clienteId`: opcional (`null` = "Consumidor final", mesmo comportamento já existente).
- `precoOriginal`/`precoPraticado`/`subtotal`/`valorFinal`/`valorPago`/`troco` **nunca aparecem no request** — são todos calculados/validados no backend, nunca aceitos do cliente (seção 12/18 do prompt). Se o PDV precisar exibir "troco" ao operador, ele calcula isso **visualmente** a partir do valor entregue informado na UI (que não é enviado à API — ver seção 18) menos o `valorFinal` que a API já devolveu antes da confirmação final (o PDV pode consultar o preço efetivo via `GET /pdv/produtos` antes de montar o carrinho, mas o valor QUE CONTA é sempre o recalculado pela API na resposta de `POST /pdv/vendas`).

```json
// 201 Response — devolve a VendaDocument já serializada (mesmo shape usado por GET /vendas/:id)
{
  "data": {
    "id": "66f...",
    "codigo": "VENDA-2026-09-07-0001",
    "numero": "000001",
    "status": "concluida",
    "dataVenda": "2026-09-07T14:32:10.000Z",
    "clienteId": null,
    "clienteNome": "Consumidor final",
    "vendedorId": "66f...",
    "vendedorNome": "Ana Paula",
    "caixaId": "66f...",
    "caixaCodigo": "CAIXA-0001",
    "itens": [ { "id", "produtoId", "codProduto", "nome", "categoria", "varianteId", "cor", "tamanho", "quantidade", "precoOriginal", "precoPraticado", "emPromocao", "subtotal" } ],
    "totalItens": 1,
    "valorBruto": 259.9,
    "descontoPromocional": 0,
    "descontoVenda": 0,
    "descontoTotal": 0,
    "valorFinal": 259.9,
    "valorPago": 259.9,
    "valorPendente": 0,
    "valorDevolvido": 0,
    "temPromocao": false,
    "temDesconto": false,
    "formaPagamento": "PIX",
    "totalParcelas": 1,
    "parcelasPagas": 0,
    "pagamentos": [ { "id", "forma", "valor", "dataPagamento", "parcelas" } ],
    "parcelas": []
  }
}
```
Campos **não** incluídos na resposta ao PDV, mesmo existindo no documento: `historico` (narrativa administrativa interna), `cancelamento` (sempre `null` numa venda recém-criada), `observacao` (se vazia, irrelevante) — decisão: **reaproveitar a serialização padrão da Venda tal como está** (o Mongoose `toJSON` já é o único formatador em uso em todo o projeto; não vale a pena criar uma segunda "visão" do documento só para o PDV nesta v1 — simplicidade sobre uma otimização de payload sem medição de necessidade real).

### `GET /pdv/vendas/minhas?page=&limit=`
Lista as vendas do **próprio** vendedor autenticado (filtro fixo `vendedorId = sub do token`, nunca um parâmetro manipulável) — delega a `VendasService.listar` com a faceta `vendedor` fixada no backend, ignorando qualquer tentativa do cliente de pedir outro vendedor. Ver seção "Autorização" para a decisão de escopo.

---

## I. Máquina de estados da Venda (real, extraída do schema — não inventada)

```text
                    ┌──────────────┐
   criar()  ──────► │ em_pagamento │ ◄── valorPendente > 0 no momento da criação
                    └──────┬───────┘
                           │  baixarParcela() zera valorPendente
                           │  (ADMIN-only nesta v1)
                           ▼
                    ┌──────────────┐
                    │  concluida   │ ◄── criar() já entrega direto aqui se valorPendente === 0
                    └──────┬───────┘
                           │
        cancelar(tipo:"integral")  OU
        cancelar(tipo:"parcial") que devolve o ÚLTIMO item pendente
                           │
                           ▼
                    ┌──────────────┐
                    │  cancelada   │  (estado terminal — "rejeita cancelar venda já cancelada")
                    └──────────────┘
```
Detalhe real (não simplificado): uma devolução **parcial** que não zera todos os itens **não muda o status** — a venda continua `em_pagamento` ou `concluida` normalmente, só `valorDevolvido` aumenta. Só transiciona para `cancelada` quando `tipo === "integral"` OU quando a soma de devoluções parciais finalmente cobre 100% de todos os itens (`todosDevolvidos`). O PDV **nunca aciona nenhuma transição além da primeira seta** (criação) — todo o resto do diagrama é exclusivo do Backoffice.

---

## J. Máquina de estados do Caixa × PDV

```text
┌──────────┐   POST /caixas  (ADMIN, Backoffice)         ┌────────┐
│ (nenhum) │ ─ OU ─────────────────────────────────────► │ aberto │
└──────────┘   POST /pdv/caixa/abertura (Vendedor, PDV)   └───┬────┘
                                                               │
                              vendas/recebimentos/devoluções   │  (qualquer vendedor,
                              lançam movimentos, NÃO mudam       via POST /pdv/vendas
                              o status do caixa                  ou fluxos ADMIN)
                                                               │
                                                               ▼
                                                     POST /caixas/:id/fechamento
                                                     (SÓ ADMIN, Backoffice)
                                                               │
                                                               ▼
                                                        ┌──────────┐
                                                        │ fechado  │ (terminal — imutável,
                                                        └──────────┘  exigirAberto() bloqueia
                                                                       qualquer novo movimento)
```
O índice único parcial `{status:1}` garante que **nunca existem dois nós "aberto" simultaneamente** no sistema inteiro — é a mesma máquina de estados hoje, o PDV só ganha uma segunda seta de entrada no estado "aberto".

---

## K. Máquina de estados do pagamento (por parcela/venda)

```text
Venda criada com pagamentos parciais (valorPago < valorFinal)
   │
   ▼
┌────────────┐
│  pendente  │  (parcela.pagoEm === null)
└─────┬──────┘
      │  baixarParcela() — ADMIN-only nesta v1, PDV não participa
      ▼
┌────────────┐
│    pago    │  (parcela.pagoEm !== null, imutável — "esta parcela já está baixada" se tentar de novo)
└────────────┘
```
**Não existe estado "vencido"** no schema real (`ParcelaVenda` não tem nenhum campo/enum de vencimento automático — só `vencimento: Date` informativo). **Não existe estado "cancelado" por parcela individual** — cancelamento é sempre no nível da Venda (ou de itens, via devolução), nunca de uma parcela isolada. Não inventar esses estados: o contrato real só tem `pendente`/`pago`, tal como a auditoria confirmou.

---

## L. Estoque + concorrência — como garantir consistência

### L.1 O que já existe e funciona
`ProdutosService.ajustarQuantidadeTamanho` usa `salvarComRetentativa` (optimistic concurrency, até 3 tentativas): lê o documento fresco, recalcula `resultado = quantidadeAtual + delta`, rejeita com `ApiException.validation` se `resultado < 0`, salva; se outro processo salvou no meio (`VersionError`), a tentativa inteira é refeita **do zero, relendo o estoque atualizado**. Isso é **correto sob concorrência real** — só não é a técnica mais eficiente disponível no projeto.

### L.2 Cenário de corrida do prompt (seção 20): 2 PDVs disputando a última unidade
```text
PDV A: lê estoque=1 → decide vender 1 → save() → sucesso (estoque vira 0, __v incrementa)
PDV B: lê estoque=1 (leitura ANTES do save de A, __v antigo) → decide vender 1 → save()
         → Mongoose detecta __v desatualizado → VersionError → RETRY automático
         → relê estoque (agora 0) → resultado = 0 + (-1) = -1 < 0 → ApiException.validation("Quantidade indisponível...")
         → PDV B recebe 400, sem venda criada, sem estoque negativo
```
**Resultado: 1 sucesso, 1 falha — exatamente o comportamento exigido pela seção 20/42 do prompt, já garantido pelo código existente, sem necessidade de nenhuma mudança de infraestrutura.** Já validado por teste real neste mesmo projeto (a suíte de Vendas tem um teste de concorrência genuína "duas vendas concorrentes disputando a última unidade" que passa).

### L.3 Decisão sobre reforçar com `findOneAndUpdate` atômico (não fazer nesta v1)
A auditoria identificou que existe uma técnica mais forte disponível no próprio código (`fecharAtomico`/`adicionarVarianteAtomico`, filtro `quantidade >= X` numa única operação Mongo, sem round-trip de leitura+escrita). **Decisão: não trocar `ajustarQuantidadeTamanho` por essa técnica nesta v1.** Justificativas:
1. O mecanismo atual já é comprovadamente correto (seção L.2) e testado.
2. Trocar a técnica de baixa de estoque é uma mudança ao módulo Produtos "sem necessidade indispensável" — violaria a restrição de não alterar módulos existentes sem justificativa forte (seção 44 do prompt). O gargalo hipotético (múltiplos retries sob contenção extrema) não foi demonstrado como problema real de volume para uma loja física.
3. Fica registrado como **item de otimização futura** (não bloqueante): se o volume de concorrência real (múltiplos PDVs, alta contenção no mesmo tamanho de produto) se mostrar um problema de performance depois de implementado, a migração de `ajustarQuantidadeTamanho` para um `findOneAndUpdate({ "variantes.tamanhos.quantidade": {$gte: qtd} })` atômico é uma refatoração isolada e não muda nenhum contrato HTTP.

### L.4 Transações multi-documento
Confirmado pela auditoria: nada no projeto assume/usa `session.startTransaction()` — nem Vendas, nem Caixa. O ambiente atual **não tem replica set confirmado** (transações multi-documento do MongoDB exigem replica set/cluster, não funcionam num `mongod` standalone). `VendasService.criar` já lida com isso da forma correta disponível sem replica set: baixa item a item com **rollback compensatório manual** (se o item 3 falhar, desfaz a baixa dos itens 1 e 2 já aplicados) — documentado no próprio código como uma limitação aceita ("não é uma transação real"). **Decisão: manter esse padrão.** Caminho para produção, se um replica set vier a existir: envolver o laço de baixa + criação da venda + escrita no caixa em uma única `ClientSession` com `withTransaction` — uma migração que não muda o contrato HTTP, só a implementação interna de `VendasService.criar`, e que só vale a pena investir se/quando o ambiente de produção realmente rodar um replica set.

---

## M. Idempotência — contrato completo

- **Formato**: string livre, gerada pelo cliente (PDV) — decisão: **UUID v4** prefixado (`pdv-<uuid>`) para facilitar auditoria/observabilidade (seção 40), mas o backend não valida formato, só unicidade (mesmo comportamento já implementado — `DadosCriarVenda.idempotencyKey?: string`, sem `@Matches`).
- **Escopo**: global à coleção `vendas` (o índice existente é `{ idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } }` — não escopado por vendedor/caixa). Um UUID gerado pelo PDV é, na prática, globalmente único, então isso nunca colide entre vendedores diferentes.
- **Armazenamento**: campo `idempotencyKey` no próprio documento da Venda — nenhuma coleção auxiliar nova.
- **TTL**: **nenhum** — a chave vive para sempre junto com a venda (correto: uma venda nunca "expira" só porque já faz tempo que foi criada).
- **Resposta em retry**: `VendasService.criar` já implementa isso — se a chave já existe, devolve a **mesma venda já criada** (200/201, mesmo corpo), sem re-executar nenhuma baixa de estoque ou novo lançamento no caixa. **Decisão do PDV**: o controller deve devolver `201` tanto na primeira criação quanto num retry idempotente (não `200`) — simplicidade: o cliente não precisa diferenciar os dois casos, o resultado observável (a venda existe, com aquele conteúdo) é o mesmo.
- **Payload mudou usando a mesma chave**: **decisão explícita, novo comportamento a implementar** (o código atual não checa isso — apenas devolve a venda existente sem comparar o payload novo). Para a v1 do PDV: **não implementar detecção de divergência de payload** (fora do escopo mínimo necessário — o cliente PDV é confiável o suficiente para nunca reenviar um payload diferente sob a mesma chave, já que a chave é gerada localmente por tentativa de venda, nunca reutilizada entre carrinhos diferentes). Registrado como uma simplificação consciente, não uma lacuna esquecida.
- **Concorrência da mesma chave** (duas requisições idênticas literalmente simultâneas, não um retry sequencial): o índice único do Mongo (`unique: true` no filtro parcial) garante que só uma consegue inserir; a segunda, ao tentar `criar()`, primeiro checa `encontrarPorIdempotencyKey` (pode não ver a primeira ainda, corrida real) e tenta inserir também — **aqui existe uma janela de corrida não coberta hoje** (dois `create()` simultâneos com a mesma `idempotencyKey` podem ambos passar a checagem "não existe ainda" antes que qualquer um termine de escrever). Mitigação: o índice único do Mongo faz a **segunda gravação falhar com erro 11000** (mesma técnica já usada em `FornecedoresRepository`/`CaixasRepository` para chave duplicada) — mas `VendasRepository.criar` hoje **não captura esse erro especificamente**. **Ação necessária na implementação (não uma mudança de arquitetura, um ajuste pontual)**: `VendasRepository.criar` deve capturar erro 11000 em `idempotencyKey` e, nesse caso, buscar e devolver a venda que venceu a corrida (mesmo efeito de "retry devolve a mesma venda"), em vez de propagar um 500. Este é o único ajuste pontual necessário em código já existente de Vendas para o PDV funcionar corretamente sob concorrência real de idempotência — é um bugfix de robustez, não uma mudança de contrato.

---

## N. Segurança — autenticação + autorização + proteção

### N.1 Autorização do vendedor — exatamente o que pode e não pode (seção 7 do prompt, respondida item a item)

| Ação | Permitido? | Como é garantido |
|---|---|---|
| Autenticar | Sim | `POST /pdv/auth/login` |
| Consultar produtos disponíveis | Sim | `GET /pdv/produtos` (projeção restrita, sem custo/margem) |
| Consultar estoque necessário para venda | Sim | Incluído na mesma resposta de produtos (quantidade por tamanho) |
| Consultar preços | Sim | `precoVenda`/`precoEfetivo`, nunca `precoCusto`/`margemLucro` |
| Criar venda | Sim | `POST /pdv/vendas` |
| Informar cliente | Sim | `clienteId` no payload da venda, ou criar via `POST /pdv/clientes` |
| Receber pagamento | Sim | `pagamentos[]` no payload da venda |
| Finalizar venda | Sim | Resposta de `POST /pdv/vendas` |
| Consultar vendas próprias | Sim | `GET /pdv/vendas/minhas` (escopo travado ao próprio vendedor) |
| **Consultar vendas de outros vendedores** | **Não** | Não existe endpoint; `GET /vendas` continua ADMIN-only |
| **Cancelar venda** | **Não** | Não existe `POST /pdv/vendas/:id/cancelamento` |
| **Devolver produto** | **Não** | Mesmo acima — devolução é uma forma de cancelamento parcial, exclusiva do Backoffice |
| **Alterar cliente depois da venda** | **Não** | Venda é snapshot imutável (seção 22); não existe endpoint de edição de venda em lugar nenhum do sistema, nem para ADMIN |
| **Aplicar desconto** | **Sim, com limite** | `descontoVenda` no payload — ver N.2 para o limite exato |
| **Consultar margem** | **Não** | Nunca retornado em `/pdv/produtos*` |
| **Consultar custo** | **Não** | Idem — `precoCusto` nunca aparece em nenhuma resposta do PDV |
| **Consultar estoque completo (todos os produtos, inclusive sem giro)** | **Sim, parcialmente** | O vendedor vê o estoque de QUALQUER produto ativo (não é restrito por categoria/vendedor) — é necessário para vender; mas nunca vê dado financeiro agregado (não há `GET /pdv/estoque/valor-total`, por exemplo) |
| **Consultar dados financeiros (faturamento, ticket médio, dashboards)** | **Não** | Nenhuma rota de `/dashboard` ou estatísticas é exposta sob `/pdv` |
| **Consultar caixa (resumo financeiro completo)** | **Não** | `GET /pdv/caixa/atual` devolve só o necessário para operar (id, status, abertura) — nunca `resumo` (saldoEsperado, totalVendas, etc., que é visão administrativa) |
| **Realizar entrada/saída manual no caixa** | **Não** | Não existe rota — só `POST /caixas/:id/entrada`/`saida` (ADMIN, Backoffice) |
| **Fechar caixa** | **Não** | Só `POST /caixas/:id/fechamento` (ADMIN, Backoffice) — ver seção E |
| **Abrir caixa** | **Sim** | `POST /pdv/caixa/abertura` — decisão do Modelo D (seção E) |

### N.2 Limite de desconto aplicável pelo vendedor

Decisão (seção 13 do prompt, "definir limite"): reaproveitar **exatamente** a validação já existente em `VendasService.criar` (`0 <= descontoVenda <= subtotal`) — **sem impor um teto adicional de percentual nesta v1** (ex.: "vendedor só pode dar até 10%"). Justificativa: não existe, hoje, nenhum campo no schema de Vendedor ou em qualquer configuração do sistema que defina "limite de desconto por vendedor" — inventar essa regra de negócio agora seria exatamente o que a seção 49 do prompt proíbe ("não inventar permissões", "não inventar regra de negócio"). Se a loja quiser um teto de desconto por vendedor no futuro, isso é uma feature nova a ser especificada separadamente (provavelmente um novo campo em `Vendedor` ou uma configuração global), não algo a assumir aqui. **Desconto por item não existe** (o schema só tem `descontoVenda` no nível da venda, nunca por item — não inventar). **Desconto não exige motivo** nesta v1 (não há campo para isso em `DadosCriarVenda`/`ItemVendaSolicitado` — só o cancelamento exige `motivo`, campo que já existe só ali).

### N.3 Nunca confiar em valores calculados pelo PDV

Já garantido estruturalmente porque `VendasService.criar` recalcula tudo (`precoEfetivo`, `valorBruto`, `descontoPromocional`, `valorFinal`) a partir do estado real do produto no banco — o payload do PDV só envia **intenção** (produtoId/varianteId/tamanhoId/quantidade, forma/valor de pagamento, desconto solicitado), nunca um valor final. O controller do PDV **nunca** deve aceitar campos como `precoUnitario`, `subtotal`, `valorFinal`, `troco` no corpo de `POST /pdv/vendas` — o DTO correspondente deve ser estritamente igual a `DadosCriarVenda` menos `vendedorId` (resolvido do token) e com `idempotencyKey` tornado obrigatório; `class-validator`'s `whitelist: true` + `forbidNonWhitelisted: true` (já configurado globalmente no `ValidationPipe` do projeto) já rejeita automaticamente qualquer campo extra não declarado no DTO — nenhuma configuração nova necessária, só desenhar o DTO certo.

### N.4 `vendedorId` nunca vem do cliente

Todo endpoint do PDV que precisaria de um `vendedorId` (criação de venda, abertura de caixa) **resolve esse valor exclusivamente de `request.user.sub`** (o payload do `PdvJwtAuthGuard`), nunca de um campo do corpo/query. Isso vale mesmo que o DTO tecnicamente permitisse o campo — a decisão de design é que o controller **sobrescreve** qualquer tentativa, atribuindo sempre a identidade do token.

### N.5 Enumeração de IDs

Todos os endpoints do PDV que recebem um `:id` (produto, cliente) devolvem `404 NOT_FOUND` para IDs inexistentes ou malformados (mesmo padrão de `isValidObjectId` já usado em todos os repositories) — nenhuma distinção entre "não existe" e "existe mas você não pode ver" (não há esse segundo caso no domínio de produtos/clientes, que não são vendedor-específicos).

### N.6 Rate limiting do PDV

Cobrir login (seção C.12). Nas rotas de venda/catálogo, **decisão: nenhum rate limit adicional nesta v1** — o volume esperado de um PDV de loja física é ordens de grandeza menor que um risco de abuso justificando a complexidade de `@nestjs/throttler` (que nem está instalado no projeto).

### N.7 Nunca expor dados administrativos internos

- `senhaHash` de Vendedor: já nunca serializado (schema já aplica `aplicarSerializacaoPadrao(..., ["senhaHash", ...])`) — nada a fazer.
- `precoCusto`/`margemLucro` de Produto: **DTOs de resposta do PDV precisam de uma projeção explícita** (não podem simplesmente devolver `produto.toJSON()` como o Backoffice faz) — este é o único ponto do contrato do PDV que exige uma serialização diferente da administrativa, documentado aqui para não ser esquecido na implementação.
- Configurações internas (`.env`, segredos JWT, connection string): nunca expostos por nenhuma rota, óbvio, mas reforçado aqui porque é uma restrição explícita da seção 34 do prompt.

---

## O. Auditoria — eventos do PDV

Nova coleção `eventos_pdv` (append-only, mesmo padrão de `eventos_venda`/`eventos_auth`/`eventos_caixa`):

```ts
@Schema({ collection: "eventos_pdv", timestamps: { createdAt: "criadoEm", updatedAt: false } })
export class EventoPdv {
  vendedorId!: string | null;    // quem executou (null só para eventos de login falho antes de identificar)
  tipo!: TipoEventoPdv;           // enum abaixo
  vendaId!: string | null;
  caixaId!: string | null;
  ip!: string | null;
  userAgent!: string | null;
  dispositivoId!: string | null;
  detalhes!: Record<string, unknown>;
}
```
```ts
TIPOS_EVENTO_PDV = [
  "pdv.login_sucesso", "pdv.login_falha", "pdv.logout", "pdv.refresh", "pdv.refresh_reusado",
  "pdv.caixa_aberto", "pdv.venda_criada",
] as const;
```
Nunca registra: senha, token (raw ou hash), payload completo do pagamento (só `valor`/`forma`, nunca dado de cartão se um dia existir integração de maquininha — fora de escopo). `pdv.venda_criada` registra `{ vendaId, codigo, valorFinal }` — mesmo nível de detalhe que `VendasService.registrarEvento` já grava para `eventos_venda` (essa coleção **continua existindo e sendo escrita normalmente** pelo `VendasService.criar` já existente, sem alteração — `eventos_pdv` é um log **adicional**, específico da camada de transporte/autenticação do PDV, não um substituto de `eventos_venda`).

---

## P. Banco — collections e índices

### Coleções consultadas (sem escrita nova além do já existente)
`produtos`, `clientes`, `vendedores`, `caixas`, `movimentos_caixa` (escrita já existente via `CaixasService`), `vendas`, `eventos_venda` (escrita já existente), `sequencias` (leitura/escrita já existente, chave `"venda"` reaproveitada tal como está — nenhuma chave nova necessária).

### Coleções NOVAS
| Coleção | Schema | Índices |
|---|---|---|
| `vendedor_refresh_tokens` | `VendedorRefreshToken` (seção C.7) | `{tokenHash:1}` único; `{expiresAt:1}` TTL (`expireAfterSeconds:0`); `{vendedorId:1}` |
| `eventos_pdv` | `EventoPdv` (seção O) | `{vendedorId:1, criadoEm:-1}`; `{tipo:1}` |

**Nenhum índice novo em coleções existentes.** Justificativa item a item:
- `produtos`: já indexado por `excluidoEm`, `categoria`, `quantidadeTotal` — suficiente para `GET /pdv/produtos` (busca por nome/código já usa `$text` ou regex conforme o padrão existente de `ProdutosRepository.listarComFacetas`, reaproveitado sem mudança).
- `vendedores`: já indexado por `telefoneNormalizado` (único parcial) — o novo `encontrarPorCodigoOuTelefone` usa esse índice para a busca por telefone e o índice implícito de `_id`/`codigo` (`unique: true` no campo) para a busca por código; nenhum índice composto novo necessário para o volume esperado.
- `vendas`: já indexado por `vendedorId`, `dataVenda`, `status` — suficiente para `GET /pdv/vendas/minhas` (filtro `vendedorId` + ordenação por `dataVenda`).

---

## Q. Frontend do PDV — arquitetura proposta (ainda não implementar)

### Q.1 Stack
Mesma stack do Backoffice por consistência de equipe/ferramentas: **Tauri + React + TypeScript + Vite**, app **separada** (novo diretório/repositório de frontend, ou um novo target dentro do mesmo monorepo — decisão de organização de repositório é operacional, não arquitetural, e pode ser definida na etapa de implementação). TanStack Router + TanStack Query, mesmo padrão do Backoffice (reaproveitar o `apiClient` de baixo nível — interceptors de refresh automático — mas com **um client HTTP distinto** apontando para os endpoints `/pdv/*` e usando os tokens do PDV, nunca compartilhando o `axios`/`fetch` instance nem o token storage do Backoffice, mesmo que rodem na mesma máquina).

### Q.2 Rotas propostas
```
/login                    — tela de login (telefone/código + senha)
/                         — tela principal (busca de produto + carrinho)
/caixa/abertura           — só aparece se GET /pdv/caixa/atual → 404
/cliente/buscar           — modal/tela de busca e criação de cliente
/pagamento                — tela de pagamento (formas + parcelamento)
/venda/:id/confirmacao    — tela de sucesso pós-venda
/vendas                   — "minhas vendas" (consulta, opcional na v1 inicial)
```

### Q.3 Estado
- Carrinho: estado local em memória (Zustand ou Context — não persistido em disco; se o app fechar no meio de uma venda, o carrinho se perde e o vendedor recomeça — decisão consciente, seção 32, PDV é online-only e não precisa sobreviver a crash nesta v1).
- Sessão (tokens): fora do React Query, num store dedicado (mesmo padrão do Backoffice `use-auth.tsx`, mas apontando para o `PdvAuthProvider` novo).
- Produtos/clientes: TanStack Query com `staleTime` curto para produtos (estoque muda a cada venda de qualquer PDV — decisão: **invalidar a query de produtos após toda venda concluída com sucesso**, e usar um `staleTime` de poucos segundos, não minutos, diferente do Backoffice que pode tolerar dados mais "frios").

### Q.4 Hooks propostos
```
usePdvAuth() / usePdvLogin() / usePdvLogout()
useCaixaAtual()
useAbrirCaixa()
useBuscarProdutos(busca)
useProduto(id)
useBuscarClientes(busca)
useCriarCliente()
useCriarVenda()   // mutation — sempre gera um novo idempotencyKey (uuid) na hora de montar o payload, guardado em estado local ATÉ a mutation resolver (sucesso ou erro definitivo), reenviado em caso de retry manual do usuário
```

### Q.5 API client
`src/services/api/pdv-auth.api.ts`, `pdv-produtos.api.ts`, `pdv-clientes.api.ts`, `pdv-caixa.api.ts`, `pdv-vendas.api.ts` — nomenclatura e formato espelhando exatamente o padrão já em uso no Backoffice (`dashboard.api.ts`, `vendas.api.ts`, etc.), só que todos apontando para `/pdv/*`.

### Q.6 Componentes (alto nível, sem implementar)
`TelaLogin`, `BuscaProduto` (input com debounce, resultado em grade/lista tocável), `CartaoProduto`, `SeletorVarianteTamanho`, `Carrinho` (lista de itens + total), `BuscaCliente`, `FormularioCliente`, `TelaPagamento` (lista de lançamentos + campo "valor entregue"/"troco calculado no cliente"), `TelaConfirmacao`.

### Q.7 Tratamento de erros/loading/confirmação/timeout (seção 36)
- Toda mutation de criação de venda usa a MESMA `idempotencyKey` em qualquer reenvio automático/manual — nunca gera uma nova a cada tentativa da mesma "intenção de venda".
- Em caso de timeout (a requisição pode ter chegado ao servidor e criado a venda, mas a resposta não voltou): a UI mostra um estado "confirmando..." e, ao reconectar/tentar de novo, reenvia com a mesma chave — o backend devolve a venda já criada (idempotência), a UI trata isso como sucesso normal, nunca como duplicata.
- Erros de validação (400) mostram a mensagem específica (`errors[].message`, já estruturado pelo backend) ao lado do campo/item relevante (ex.: "Estoque insuficiente para Vestido Midi (Azul, M). Disponível: 0." aparece junto do item do carrinho).

---

## R. Testes — plano completo

### R.1 Unitários/serviço (backend, `bun:test`, sem HTTP)
**Autenticação PDV**
- login com credenciais corretas (telefone) → tokens válidos
- login com credenciais corretas (código `VEN-0001`) → tokens válidos
- senha incorreta → `INVALID_CREDENTIALS`
- vendedor inativo → `INVALID_CREDENTIALS` (mensagem genérica, não revela o motivo)
- vendedor excluído (soft delete) → `INVALID_CREDENTIALS`
- vendedor inexistente → `INVALID_CREDENTIALS` (mesmo tempo de resposta que senha errada — checagem indireta via `HASH_FANTASMA_VENDEDOR`)
- refresh válido → novo par de tokens, token antigo revogado
- refresh com token já revogado (reuso) → revoga toda a família, `REFRESH_TOKEN_REUSED`
- refresh de vendedor que foi inativado depois do login → `USER_INACTIVE`, família revogada
- logout → idempotente, segunda chamada com o mesmo token não erra
- throttle: 6ª tentativa de login errada na mesma janela → `TOO_MANY_REQUESTS`

**Produtos (via `/pdv/produtos`)**
- produto ativo com estoque aparece na listagem
- produto excluído (soft delete) não aparece
- variante/tamanho com quantidade 0 não aparece na resposta do PDV (mas aparece no Backoffice — teste de que os dois contratos divergem de propósito)
- resposta nunca contém `precoCusto`/`margemLucro` (snapshot/assert de campos ausentes)
- produto inexistente → 404

**Criação de venda (`POST /pdv/vendas` via service, reaproveitando a suíte de `vendas.service.spec.ts` já existente como base — só a CAMADA de entrada muda)**
- venda simples, um item, pagamento integral → `concluida`
- múltiplos itens de produtos diferentes
- com desconto de venda válido
- desconto de venda inválido (maior que o subtotal) → 400
- com cliente
- sem cliente → "Consumidor final"
- pagamento integral → `concluida`
- pagamento parcial → `em_pagamento`, parcela(s) geradas
- parcelamento em N parcelas → soma bate com `valorPendente`
- `vendedorId` do payload (se o DTO permitir e alguém tentar enviar um diferente) é **ignorado**, sempre usa o do token — teste explícito de que forjar esse campo não tem efeito
- caixa fechado/inexistente → 400/404, nenhuma baixa de estoque ocorre
- vendedor inativo tentando vender (token válido mas foi inativado entre o login e a venda) → 400, nenhuma baixa

**Caixa via PDV**
- abrir caixa como vendedor → sucesso, `responsavelNome` = nome do vendedor
- abrir caixa quando já existe um aberto → 409
- `GET /pdv/caixa/atual` sem nenhum aberto → 404
- `GET /pdv/caixa/atual` não expõe `resumo` financeiro completo

**Estoque/concorrência**
- reaproveitar o teste já existente "duas vendas concorrentes disputando a última unidade" (já passa hoje) — replicar chamando através da nova rota `POST /pdv/vendas` via HTTP real (não só o service) para confirmar que a camada HTTP não introduz nenhuma regressão de concorrência (ex.: um `await` faltando no controller que serializasse as chamadas incorretamente também seria um bug a pegar aqui).

**Idempotência**
- mesma `idempotencyKey` enviada duas vezes sequencialmente → uma única venda, mesma resposta
- mesma `idempotencyKey` enviada duas vezes CONCORRENTEMENTE (`Promise.allSettled`) → uma única venda persistida (teste do ajuste pontual da seção M — captura do erro 11000)
- `idempotencyKey` ausente no payload do PDV → 400 (obrigatória nesta rota, diferente do uso interno)

**Falhas diversas**
- timeout simulado + retry com mesma chave → mesmo resultado
- estoque alterado entre pré-checagem e baixa (dois itens do carrinho, um deles vendido por outro PDV no meio do processamento) → erro claro, nenhum item "meio baixado" (rollback compensatório)
- caixa fechado no meio de uma tentativa de venda → 400
- vendedor desativado no meio da sessão (token ainda válido) → próxima venda falha com mensagem clara
- produto desativado (soft delete) entre a busca e a tentativa de venda → 404 no item

### R.2 Integração (MongoDB real, banco de teste isolado — nunca `mariela_dev`)
Mesmo padrão já estabelecido no projeto (`mongooseModuloDeTeste()`, `mariela_test`): criar vendedor/produto/caixa reais via os services, autenticar de verdade via `PdvAuthService`, criar venda de verdade via `POST /pdv/vendas` (agora que a rota existe), validar efeitos em `produtos` (estoque baixado), `caixas`/`movimentos_caixa` (lançamento correto), `vendedores` (agregados atualizados), `vendedor_refresh_tokens` (rotação real). Cleanup **estritamente limitado aos documentos criados pela própria suíte** — nunca `deleteMany({})` fora do banco de teste isolado, mesma disciplina já seguida em todo o projeto.

### R.3 E2E (servidor HTTP real, banco de teste isolado)
Fluxo completo ponta-a-ponta: login → abrir caixa → buscar produto → criar cliente → criar venda → confirmar estoque baixado via `GET /produtos/:id` (rota ADMIN, usada só para verificação no teste) → confirmar lançamento no caixa via `GET /caixas/:id` (ADMIN). Testar explicitamente: sem token → 401 em toda rota `/pdv/*` protegida; token de ADMIN não serve em `/pdv/*` (payload incompatível, guard rejeita); token de vendedor não serve em rotas `/vendas`/`/produtos` administrativas (guard `RolesGuard` rejeita por falta de `role`).

### R.4 Concorrência (obrigatório antes de considerar a v1 pronta)
Teste de carga leve com `Promise.allSettled` simulando N "PDVs" (chamadas HTTP reais concorrentes) vendendo a última unidade de um mesmo tamanho — resultado esperado: exatamente 1 sucesso, N-1 falhas de estoque, **zero** vendas com itens negativos, **zero** vendas "fantasma" (criadas mas sem baixa correspondente).

---

## S. Plano de implementação (ordem revisada após a auditoria)

```text
01 — Fundação de autenticação PDV
     VendedoresService.autenticar() + encontrarPorCodigoOuTelefone()
     schemas novos: vendedor-refresh-token, evento-pdv
     PdvAuthModule: login/refresh/logout, PdvJwtAuthGuard, PdvLoginThrottleService
     testes unitários de autenticação (R.1)

02 — Sessão
     GET /pdv/me
     testes

03 — Caixa no PDV
     GET /pdv/caixa/atual, POST /pdv/caixa/abertura (reaproveitando CaixasService)
     testes

04 — Catálogo (somente leitura)
     GET /pdv/produtos, GET /pdv/produtos/:id — projeção restrita (sem custo/margem)
     testes (inclusive o assert de campos ausentes)

05 — Clientes no PDV
     GET /pdv/clientes, POST /pdv/clientes (reaproveitando ClientesService)
     testes

06 — Bugfix pontual de idempotência (pré-requisito do passo 07)
     VendasRepository.criar captura erro 11000 de idempotencyKey e devolve a venda vencedora da corrida
     teste de concorrência de idempotência (R.1)

07 — Criação de venda via PDV
     POST /pdv/vendas — DTO restrito (sem vendedorId, sem valores calculados; idempotencyKey obrigatória)
     controller resolve vendedorId do token, delega a VendasService.criar (inalterado)
     testes de criação (R.1) + reexecução do teste de concorrência de estoque via HTTP real

08 — Consulta de vendas próprias
     GET /pdv/vendas/minhas
     testes

09 — Testes de integração completos (R.2) contra mariela_test

10 — Testes E2E HTTP completos (R.3) + concorrência de carga (R.4)

11 — Frontend do PDV (Q) — login, catálogo, carrinho, cliente, pagamento, confirmação
     (esta etapa é grande o suficiente para merecer sua própria auditoria/especificação de UI
     antes da implementação — recomenda-se um PROMPT 02 dedicado ao frontend quando chegar a vez)

12 — Segurança: revisão final de N (nenhum dado administrativo vazando, rate limit, throttle)

13 — Validação real: backend compilado contra mariela_dev, vendedor de teste temporário
     criado via mecanismo interno e removido ao final (mesma disciplina de limpeza já
     seguida nesta sessão — nunca deleteMany({}) irrestrito), smoke test do fluxo completo

14 — Documentação/relatório final do PDV (mesmo formato de relatório usado nos módulos
     anteriores: Auditoria, Decisões, Backend, Frontend, API, Contrato, Banco, Regras,
     Testes, Validação real, Problemas encontrados, Pendências, Próximo passo)
```

Cada etapa acima deve seguir o mesmo ciclo já usado em todos os módulos anteriores desta sessão: implementar → testar (unit + integração real) → validar contra `mariela_dev` de forma não-destrutiva → não avançar para a etapa seguinte sem o passo anterior completamente verde.

---

## Resumo das decisões arquiteturais mais importantes (para referência rápida)

1. Autenticação de Vendedor **totalmente separada** da de ADMIN: novo módulo `PdvAuthModule`, novo `JwtPayload` (`tipo: "VENDEDOR"`), novo segredo JWT, nova coleção de refresh token (`vendedor_refresh_tokens`). Nunca um `role: "VENDEDOR"` dentro de `Usuario`.
2. Namespace HTTP: **`/pdv/*`**, não `/vendedores/auth/*`.
3. Caixa: **Modelo D** — vendedor OU ADMIN abrem; qualquer vendedor vende contra o único caixa aberto; **só ADMIN fecha**.
4. `VendasService.criar()` existente **não é reescrito nem duplicado** — só ganha uma nova via de entrada HTTP (`POST /pdv/vendas`) com `vendedorId` resolvido do token, nunca do payload.
5. Cancelamento e baixa de parcela **continuam exclusivos do Backoffice/ADMIN** nesta v1.
6. Estoque sob concorrência: mecanismo de retry otimista **já existente é suficiente e comprovado** — nenhuma reescrita de `ProdutosService` nesta v1 (só registrado como possível otimização futura isolada).
7. Idempotência: **obrigatória** em `POST /pdv/vendas` (diferente do uso interno atual, onde é opcional); um bugfix pontual (captura de erro 11000) é necessário em `VendasRepository.criar` para cobrir concorrência real da mesma chave.
8. Nenhuma transação multi-documento — ambiente sem replica set confirmado; rollback compensatório manual (já existente) é o padrão aceito.
9. Sem modo offline, sem WebSocket, sem microserviços novos — tudo dentro do mesmo monolito NestJS, um módulo novo (`PdvModule`) entre os já existentes.
10. Projeção de dados do PDV **nunca** inclui `precoCusto`, `margemLucro`, `senhaHash`, resumo financeiro de caixa, ou dados de outros vendedores.
