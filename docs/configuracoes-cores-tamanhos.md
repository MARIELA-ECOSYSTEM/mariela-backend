# Cores, tamanhos e categorias: cadastro central, unicidade e vínculo com produtos

> Fases 54.0, 54.1, 54.2 e 55.1. Este documento descreve a arquitetura
> vigente — não um registro histórico de decisões revisadas em cada fase.
> `formasPagamento` permanece deliberadamente fora deste documento — não
> tem nenhuma das proteções descritas aqui (ver auditoria da Fase 55.0).

## 1. `configuracoes` como fonte central de valores disponíveis

`cores`, `tamanhos` e `categorias` são listas simples de string dentro do
documento singleton `configuracoes` (`_id` fixo, uma única collection, um
único documento — ver `configuracoes.constants.ts`). Desde a Fase 54.2 (cor/
tamanho) e a Fase 55.1 (categoria), esse cadastro deixou de ser apenas
sugestão de preenchimento para o Backoffice: **toda criação de um novo
vínculo cor/tamanho/categoria exige que o valor já exista em
`configuracoes.cores`/`configuracoes.tamanhos`/`configuracoes.categorias`**.

Isso é verificado inteiramente no backend (`ProdutosService`) — nunca
confiado ao frontend, mesmo que o Backoffice só ofereça ao usuário os
valores já cadastrados.

## 2. Normalização case-insensitive (única fonte, nunca duplicada)

Cores, tamanhos e categorias equivalentes (`Preto`/`preto`/`PRETO`,
`P`/`p`/`  P  `, `Calçados`/`calcados`) são tratados como o mesmo valor. A
normalização usa **sempre** as mesmas três funções, em
`src/modules/produtos/utils/normalizacao.util.ts`:

- `normalizarCor`: remove diacríticos (NFD + filtro de marcas combinantes),
  `trim`, minúsculas, espaços internos colapsados.
- `normalizarTamanho`: `trim` + maiúsculas.
- `normalizarCategoria` (Fase 55.1): mesma regra de `normalizarCor` — texto
  livre, nunca sigla curta como tamanho.

Nenhum outro módulo implementa uma segunda versão dessas regras —
`ConfiguracoesRepository` e `ProdutosService` importam as mesmas funções.

A **apresentação original** do valor nunca é reescrita: `configuracoes.cores`/
`tamanhos`/`categorias` guardam o texto exatamente como cadastrado; a forma
normalizada vive só em campos-espelho internos (`coresNormalizadas`/
`tamanhosNormalizados`/`categoriasNormalizadas`, nunca expostos na API — fora
da lista explícita de campos serializados em `configuracao.schema.ts`),
usados apenas para a checagem atômica de duplicidade (`findOneAndUpdate` com
`$ne`/`$push` num único comando Mongo).

Um documento `configuracoes` criado antes da Fase 54.0/55.1 (sem os
campos-espelho) se autocorrige de forma idempotente e aditiva (`$addToSet`)
na primeira chamada de cadastro após o deploy — nenhuma migração manual é
necessária.

## 3. Validação nos serviços de produtos (Fase 54.2 — cor/tamanho; Fase 55.1 — categoria)

`ProdutosService` valida contra `configuracoes.cores`/`tamanhos`/`categorias`
exatamente nos pontos em que um vínculo **novo** está sendo criado:

| Operação | Quando valida |
|---|---|
| `criar` (produto) | Sempre — toda criação introduz a categoria. |
| `atualizar` (produto) | Só quando a categoria está realmente mudando (comparação por valor normalizado) — editar preço/descrição/etc. reenviando a mesma categoria nunca revalida. |
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
- Categoria: *"Esta categoria não está cadastrada nas configurações da loja.
  Cadastre a categoria antes de utilizá-la em um produto."*

Produtos com valores históricos que não existem mais em `configuracoes`
**nunca são alterados automaticamente** — eles continuam funcionando
normalmente (ajustar quantidade, editar outros campos) até que alguém
explicitamente tente criar um **novo** vínculo com um valor não cadastrado.

## 4. Proteção de exclusão (Fase 54.0 — cor/tamanho; Fase 55.1 — categoria)

Excluir uma cor/tamanho/categoria de `configuracoes` verifica se algum
produto ATIVO (`excluidoEm: null`) usa aquele valor. Se houver, a exclusão é
bloqueada (mensagem de negócio específica por lista) e **nada é
modificado** — nem a configuração, nem o produto.

A verificação em si usa duas estratégias diferentes, por uma diferença real
de modelo de dados entre `Variante` e `Produto`:

- **Cor/tamanho**: filtro direto no Mongo contra o campo-espelho normalizado
  já persistido em cada variante (`variantes.corNormalizada` /
  `variantes.tamanhos.tamanho`) — `produtosRepository.listarTodosAtivos(filtro)`
  já devolve só os produtos vinculados.
- **Categoria** (Fase 55.1): `Produto.categoria` é um campo raiz simples,
  **sem** campo-espelho normalizado equivalente (ao contrário de
  `Variante.corNormalizada`, que já existia antes da Fase 54.0 para outro
  propósito). Em vez de introduzir um campo novo em `Produto` só para este
  uso, `existeVinculo` busca todos os produtos ativos
  (`listarTodosAtivos()`, sem filtro) e compara `categoria` normalizada em
  memória — mesmo padrão já usado por `ProdutosService.validarCorCadastrada`
  para comparar contra a lista de `configuracoes`. Proporcional ao volume
  real do sistema (ferramenta administrativa interna, baixo volume de
  produtos cadastrados) e evita uma alteração de schema fora do escopo
  mínimo necessário.

Estratégia de concorrência (igual para as três listas): verificar → agir →
**reconferir depois** → se um vínculo apareceu na janela entre as duas
checagens, desfazer por compensação (readicionar o valor) e responder o
mesmo erro. Isso estreita a janela de corrida, mas **não a fecha
matematicamente** — ver seção 6.

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
sequência "verificar que o valor existe" → "gravar o produto/variante", nem
o inverso ("verificar que não há vínculo" → "excluir o valor").

**Isto não é uma garantia absoluta de integridade referencial.** Existe uma
janela de concorrência genuína (documentada e demonstrada na auditoria da
Fase 54.1, e reafirmada para categoria na Fase 55.0/55.1): se a exclusão de
uma cor/tamanho/categoria e a criação de um produto/variante usando esse
mesmo valor acontecerem quase simultaneamente, é possível — em casos raros,
não eliminados por nenhuma quantidade de reconferências sequenciais — que a
configuração fique sem o valor enquanto um produto/variante ainda o
referencia, ou vice-versa.

Decisão explícita do projeto ("Alternativa A", Fase 54.2, mantida na Fase
55.1): aceitar esse risco residual, documentá-lo abertamente, e não
introduzir locks distribuídos, transações multi-documento, soft-delete de
configurações nem jobs de reconciliação para fechá-lo — complexidade
desproporcional ao impacto real (ferramenta administrativa interna, baixo
volume de requisições concorrentes, janela medida em milissegundos). Se o
risco se tornar inaceitável no futuro, a Fase 54.1 já descreve a solução
recomendada (soft-delete das listas + reconciliação assíncrona) — não
implementada, por decisão própria desta fase.
