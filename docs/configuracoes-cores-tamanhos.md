# Cores e tamanhos: cadastro central, unicidade e vínculo com produtos

> Fases 54.0, 54.1 e 54.2. Este documento descreve a arquitetura vigente —
> não um registro histórico de decisões revisadas em cada fase.

## 1. `configuracoes` como fonte central de valores disponíveis

`cores` e `tamanhos` são listas simples de string dentro do documento
singleton `configuracoes` (`_id` fixo, uma única collection, um único
documento — ver `configuracoes.constants.ts`). Desde a Fase 54.2, esse
cadastro deixou de ser apenas sugestão de preenchimento para o Backoffice:
**toda criação de um novo vínculo cor/tamanho em uma variante de produto
exige que o valor já exista em `configuracoes.cores`/`configuracoes.tamanhos`**.

Isso é verificado inteiramente no backend (`ProdutosService`) — nunca
confiado ao frontend, mesmo que o Backoffice só ofereça ao usuário os
valores já cadastrados.

## 2. Normalização case-insensitive (única fonte, nunca duplicada)

Cores e tamanhos equivalentes (`Preto`/`preto`/`PRETO`, `P`/`p`/`  P  `) são
tratados como o mesmo valor. A normalização usa **sempre** as mesmas duas
funções, já estabelecidas em `src/modules/produtos/utils/normalizacao.util.ts`
antes da Fase 54.0 (usadas pela unicidade de cor dentro de uma variante):

- `normalizarCor`: remove diacríticos (NFD + filtro de marcas combinantes),
  `trim`, minúsculas, espaços internos colapsados.
- `normalizarTamanho`: `trim` + maiúsculas.

Nenhum outro módulo implementa uma segunda versão dessas regras —
`ConfiguracoesRepository` e `ProdutosService` importam as mesmas funções.

A **apresentação original** do valor nunca é reescrita: `configuracoes.cores`/
`tamanhos` guardam o texto exatamente como cadastrado; a forma normalizada
vive só em campos-espelho internos (`coresNormalizadas`/`tamanhosNormalizados`,
nunca expostos na API — fora da lista explícita de campos serializados em
`configuracao.schema.ts`), usados apenas para a checagem atômica de
duplicidade (`findOneAndUpdate` com `$ne`/`$push` num único comando Mongo).

Um documento `configuracoes` criado antes da Fase 54.0 (sem os campos-espelho)
se autocorrige de forma idempotente e aditiva (`$addToSet`) na primeira
chamada de cadastro após o deploy — nenhuma migração manual é necessária.

## 3. Validação nos serviços de produtos (Fase 54.2)

`ProdutosService` valida contra `configuracoes.cores`/`tamanhos` exatamente
nos pontos em que um vínculo **novo** está sendo criado:

| Operação | Quando valida |
|---|---|
| `adicionarVariante` | Sempre — toda variante nova introduz uma cor. |
| `atualizarVariante` | Só quando a cor está realmente mudando (comparação por valor normalizado) — editar foto/vídeo reenviando a mesma cor nunca revalida. |
| `adicionarTamanho` | Sempre — por definição, é sempre um tamanho novo na variante. |
| `ajustarQuantidadeTamanho` (módulo Estoque) | Só quando `POST /estoque/entrada` informa um `tamanho` (nome) que ainda não existe NAQUELA variante — ver seção 5. Ajustar quantidade de um tamanho já existente nunca revalida. |

Mensagens de erro (`ApiException.validation`, 400), idênticas no nível
superior e em `errors[]` — o Backoffice só lê `error.message`:

- Cor: *"Esta cor não está cadastrada nas configurações da loja. Cadastre a
  cor antes de utilizá-la em um produto."*
- Tamanho: *"Este tamanho não está cadastrado nas configurações da loja.
  Cadastre o tamanho antes de utilizá-lo em um produto."*

Produtos com valores históricos que não existem mais em `configuracoes`
**nunca são alterados automaticamente** — eles continuam funcionando
normalmente (ajustar quantidade, editar outros campos) até que alguém
explicitamente tente criar um **novo** vínculo com um valor não cadastrado.

## 4. Proteção de exclusão (Fase 54.0, preservada integralmente)

Excluir uma cor/tamanho de `configuracoes` verifica se algum produto ATIVO
(`excluidoEm: null`) tem uma variante usando aquele valor
(`variantes.corNormalizada` / `variantes.tamanhos.tamanho`). Se houver,
a exclusão é bloqueada (mesmas mensagens de negócio da Fase 54.0) e **nada é
modificado** — nem a configuração, nem o produto.

Estratégia de concorrência: verificar → agir → **reconferir depois** → se um
vínculo apareceu na janela entre as duas checagens, desfazer por compensação
(readicionar o valor) e responder o mesmo erro. Isso estreita a janela de
corrida, mas **não a fecha matematicamente** — ver seção 6.

## 5. Módulo de Estoque: criação implícita de tamanho (legítima, agora gated)

`POST /estoque/entrada` permite informar um `tamanho` (nome, texto livre) em
vez de um `tamanhoId`, criando-o na variante na hora — recurso legítimo e
documentado (`EntradaEstoqueDto.tamanho`: *"Informe para criar um novo
tamanho na variante"*), não removido pela Fase 54.2. Desde a Fase 54.2, esse
tamanho só pode ser criado dessa forma se já existir em
`configuracoes.tamanhos`.

Esse gate é intencionalmente **restrito a essa única chamada**
(`EstoqueService.entrada`, via o parâmetro `exigirTamanhoCadastrado: true` de
`ajustarQuantidadeTamanho`). Outros chamadores do mesmo método — a
restauração de estoque de uma venda cancelada (`VendasService.devolverAoEstoque`,
que precisa conseguir recriar um tamanho histórico mesmo que ele já tenha
sido removido de `configuracoes`, para nunca perder uma compensação
financeira pendente) e fixtures de teste de outros módulos — nunca passam
essa flag e permanecem exatamente como antes.

## 6. Risco residual de concorrência (decisão arquitetural explícita)

A arquitetura usa MongoDB **standalone, sem replica set, sem transações
multi-documento** — restrição de infraestrutura já vigente em todo o
projeto, não introduzida aqui. `configuracoes` e `produtos` são collections
diferentes; não existe mecanismo que torne atômica, entre as duas, a
sequência "verificar que a cor existe" → "gravar a variante", nem o inverso
("verificar que não há vínculo" → "excluir a cor").

**Isto não é uma garantia absoluta de integridade referencial.** Existe uma
janela de concorrência genuína (documentada e demonstrada na auditoria da
Fase 54.1): se a exclusão de uma cor e a criação de uma variante usando essa
mesma cor acontecerem quase simultaneamente, é possível — em casos raros,
não eliminados por nenhuma quantidade de reconferências sequenciais — que a
configuração fique sem a cor enquanto uma variante ainda a referencia, ou
vice-versa.

Decisão explícita do projeto ("Alternativa A", Fase 54.2): aceitar esse
risco residual, documentá-lo abertamente, e não introduzir locks
distribuídos, transações multi-documento, soft-delete de configurações nem
jobs de reconciliação para fechá-lo — complexidade desproporcional ao
impacto real (ferramenta administrativa interna, baixo volume de requisições
concorrentes, janela medida em milissegundos). Se o risco se tornar
inaceitável no futuro, a Fase 54.1 já descreve a solução recomendada
(soft-delete de cores/tamanhos + reconciliação assíncrona) — não
implementada, por decisão própria desta fase.
