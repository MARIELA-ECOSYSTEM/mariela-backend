# Cores, tamanhos, categorias e formas de pagamento: cadastro central, unicidade e vínculo

> Fases 54.0, 54.1, 54.2, 55.1 e 55.2. Este documento descreve a arquitetura
> vigente — não um registro histórico de decisões revisadas em cada fase.

## 1. `configuracoes` como fonte central de valores disponíveis

`cores`, `tamanhos`, `categorias` e `formasPagamento` são listas simples de
string dentro do documento singleton `configuracoes` (`_id` fixo, uma única
collection, um único documento — ver `configuracoes.constants.ts`). Desde a
Fase 54.2 (cor/tamanho), a Fase 55.1 (categoria) e a Fase 55.2 (forma de
pagamento), esse cadastro deixou de ser apenas sugestão de preenchimento
para o Backoffice: **toda criação de um novo vínculo cor/tamanho/categoria/
forma de pagamento exige que o valor já exista em
`configuracoes.cores`/`.tamanhos`/`.categorias`/`.formasPagamento`**.

Isso é verificado inteiramente no backend (`ProdutosService` para cor/
tamanho/categoria; `VendasService`/`CaixasService` para forma de pagamento)
— nunca confiado ao frontend, mesmo que o Backoffice só ofereça ao usuário
os valores já cadastrados.

**Distinção importante (Fase 55.2): `forma` não é `modalidade`.** `forma` é
o rótulo configurável desta lista (`"Dinheiro"`, `"Pix"`, `"Cartão de
crédito"`, texto livre). `modalidade` é uma classificação técnica fechada e
totalmente independente (`dinheiro`/`pix`/`debito`/`credito`,
`vendas.constants.ts`), usada só para regras de tarifa de adquirente
(`PagamentoVenda.modalidade`, `AdquirentesService`). As duas nunca são
comparadas uma com a outra, nunca compartilham validação, e esta fase nunca
vinculou automaticamente uma forma cadastrada a uma modalidade.

## 2. Normalização case-insensitive (única fonte, nunca duplicada)

Cores, tamanhos, categorias e formas de pagamento equivalentes
(`Preto`/`preto`/`PRETO`, `P`/`p`/`  P  `, `Calçados`/`calcados`,
`Débito`/`Debito`/`  DÉBITO  `) são tratados como o mesmo valor. A
normalização usa **sempre** as mesmas quatro funções, em
`src/modules/produtos/utils/normalizacao.util.ts`:

- `normalizarCor`: remove diacríticos (NFD + filtro de marcas combinantes),
  `trim`, minúsculas, espaços internos colapsados.
- `normalizarTamanho`: `trim` + maiúsculas.
- `normalizarCategoria` (Fase 55.1): mesma regra de `normalizarCor` — texto
  livre, nunca sigla curta como tamanho.
- `normalizarFormaPagamento` (Fase 55.2): mesma regra de `normalizarCor` —
  texto livre, nunca compara com `modalidade` (ver seção 1).

Nenhum outro módulo implementa uma segunda versão dessas regras —
`ConfiguracoesRepository`, `ProdutosService`, `VendasService` e
`CaixasService` importam as mesmas funções.

A **apresentação original** do valor nunca é reescrita:
`configuracoes.cores`/`.tamanhos`/`.categorias`/`.formasPagamento` guardam o
texto exatamente como cadastrado; a forma normalizada vive só em
campos-espelho internos (`coresNormalizadas`/`tamanhosNormalizados`/
`categoriasNormalizadas`/`formasPagamentoNormalizadas`, nunca expostos na
API — fora da lista explícita de campos serializados em
`configuracao.schema.ts`), usados apenas para a checagem atômica de
duplicidade (`findOneAndUpdate` com `$ne`/`$push` num único comando Mongo).

Um documento `configuracoes` criado antes da Fase 54.0/55.1/55.2 (sem os
campos-espelho) se autocorrige de forma idempotente e aditiva (`$addToSet`)
na primeira chamada de cadastro após o deploy — nenhuma migração manual é
necessária.

## 3. Validação nas novas operações (Fase 54.2 — cor/tamanho; Fase 55.1 — categoria; Fase 55.2 — forma de pagamento)

`ProdutosService` valida cor/tamanho/categoria; `VendasService` e
`CaixasService` validam forma de pagamento — todos exatamente nos pontos em
que um vínculo **novo** está sendo criado:

| Operação | Quando valida |
|---|---|
| `ProdutosService.criar` | Sempre — toda criação introduz a categoria. |
| `ProdutosService.atualizar` | Só quando a categoria está realmente mudando (comparação por valor normalizado) — editar preço/descrição/etc. reenviando a mesma categoria nunca revalida. |
| `ProdutosService.adicionarVariante` | Sempre — toda variante nova introduz uma cor. |
| `ProdutosService.atualizarVariante` | Só quando a cor está realmente mudando (comparação por valor normalizado) — editar foto/vídeo reenviando a mesma cor nunca revalida. |
| `ProdutosService.adicionarTamanho` | Sempre — por definição, é sempre um tamanho novo na variante. |
| `EstoqueService.entrada` (via `ajustarQuantidadeTamanho`) | Só quando informa um `tamanho` (nome) que ainda não existe NAQUELA variante — ver seção 5. Ajustar quantidade de um tamanho já existente nunca revalida. |
| `VendasService.criar` | Sempre, para CADA `forma` em `pagamentos[]` — toda venda nova introduz a(s) forma(s) pela primeira vez. |
| `VendasService.baixarParcela` | Só quando a forma informada (`dto.formaPagamento`) difere, por valor normalizado, da forma já registrada na venda (`venda.formaPagamento`) — omitir o campo (cai no fallback para a forma da venda) ou reenviar a mesma forma nunca revalida. |
| `VendasService.receberPagamento` | Sempre — `dados.forma` é sempre um valor explicitamente informado para um pagamento novo, nunca um fallback de valor histórico. |
| `CaixasService.registrarMovimento` (entrada/saída manual) | Sempre, antes de qualquer gravação. |
| `CaixasService.registrarMovimentoDeVenda` | **Nunca revalida** — só repassa uma forma que já passou pela validação de `VendasService` (confirmado pelos 4 chamadores reais: `garantirMovimentosDeCaixa`, `garantirMovimentoDeRecebimento`, `garantirMovimentoDeBaixaParcela`, `garantirMovimentoDeCancelamento`, todos usando um `pagamento.forma`/`venda.formaPagamento` já persistido). |
| PDV (`PdvVendasService`) | Herda integralmente a validação de `VendasService.criar` — nenhuma implementação própria. |

Mensagens de erro (`ApiException.validation`, 400), idênticas no nível
superior e em `errors[]` — o Backoffice só lê `error.message`:

- Cor: *"Esta cor não está cadastrada nas configurações da loja. Cadastre a
  cor antes de utilizá-la em um produto."*
- Tamanho: *"Este tamanho não está cadastrado nas configurações da loja.
  Cadastre o tamanho antes de utilizá-lo em um produto."*
- Categoria: *"Esta categoria não está cadastrada nas configurações da loja.
  Cadastre a categoria antes de utilizá-la em um produto."*
- Forma de pagamento: *"Esta forma de pagamento não está cadastrada nas
  configurações da loja. Cadastre a forma de pagamento antes de utilizá-la
  em uma operação financeira."* (idêntica em `VendasService` e
  `CaixasService` — duplicada deliberadamente entre os dois serviços, nunca
  extraída para um util compartilhado, mesmo princípio já aplicado a
  `validarCorCadastrada`/`validarTamanhoCadastrado`/`validarCategoriaCadastrada`
  dentro de `ProdutosService`.)

Produtos/vendas/movimentos com valores históricos que não existem mais em
`configuracoes` **nunca são alterados automaticamente** — eles continuam
funcionando normalmente (ajustar quantidade, editar outros campos, baixar
parcela reenviando a mesma forma, consultar histórico) até que alguém
explicitamente tente criar um **novo** vínculo com um valor não cadastrado.

## 4. Proteção de exclusão (Fase 54.0 — cor/tamanho; Fase 55.1 — categoria; Fase 55.2 — forma de pagamento)

Excluir uma cor/tamanho/categoria de `configuracoes` verifica se algum
produto ATIVO (`excluidoEm: null`) usa aquele valor; excluir uma forma de
pagamento verifica se QUALQUER venda ou movimento de caixa a usa, **sem
distinção de status/estado** (ver seção 4.3). Se houver vínculo, a exclusão
é bloqueada (mensagem de negócio específica por lista) e **nada é
modificado** — nem a configuração, nem o produto/venda/movimento.

A verificação em si usa três estratégias diferentes, por uma diferença real
de modelo de dados entre `Variante`, `Produto` e os documentos financeiros:

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
- **Forma de pagamento** (Fase 55.2): ver seção 4.1-4.3 — estratégia própria,
  por ser a mais ampla (duas collections, nenhuma delas de baixo volume
  garantido no longo prazo).

Estratégia de concorrência (igual para as quatro listas): verificar → agir →
**reconferir depois** → se um vínculo apareceu na janela entre as duas
checagens, desfazer por compensação (readicionar o valor) e responder o
mesmo erro. Isso estreita a janela de corrida, mas **não a fecha
matematicamente** — ver seção 6.

### 4.1 Caminhos de vínculo de forma de pagamento

Diferente de cor/tamanho/categoria (sempre dentro de `produtos`), uma forma
de pagamento pode estar referenciada em QUATRO campos, espalhados em DUAS
collections:

| Collection | Campo | Observação |
|---|---|---|
| `vendas` | `formaPagamento` | Campo raiz — a forma do primeiro/único pagamento. |
| `vendas` | `pagamentos[].forma` | Array — cada pagamento recebido na criação ou depois. |
| `vendas` | `parcelas[].formaPagamento` | Array — preenchido só quando a parcela é baixada (`null` até lá). |
| `movimentos_caixa` | `formaPagamento` | Campo raiz — inclusive em entradas/saídas MANUAIS, sem venda associada. |

`existeVinculo("formasPagamento", valor)` consulta as duas collections em
paralelo (`Promise.all`), uma consulta por collection, cada uma já cobrindo
os campos múltiplos daquela collection com um único `$or` (ver
`VendasRepository.existeVinculoFormaPagamento`/
`MovimentosCaixaRepository.existeVinculoFormaPagamento`).

### 4.2 Estratégia de consulta e custo (sem campo-espelho nos documentos financeiros)

Alterar o formato de `Venda`/`MovimentoCaixa` (um campo-espelho normalizado,
como existe para cor/tamanho em `Variante`) foi deliberadamente rejeitado —
são documentos financeiros/históricos, e a Fase 55.2 exige explicitamente
não alterar seu formato.

**Fase 55.2 (versão inicial, substituída) — `.collation()`:** as duas
consultas usavam `.collation({ locale: "pt", strength: 1 })` do próprio
MongoDB, resolvendo caixa/acentuação na comparação dentro do próprio banco,
sem carregar nenhum documento inteiro. **Confirmado incorreto na revisão da
Fase 55.2.1**: `collation` nunca colapsa espaços periféricos/internos
(`"Dinheiro"` não casa com `"  Dinheiro  "` nem com `"Dinheiro  Especial"`
via collation, confirmado empiricamente) — não reproduzia integralmente
`normalizarFormaPagamento`, violando a exigência de que a checagem de
vínculo use a MESMA normalização do cadastro.

**Fase 55.2.1 (estratégia final) — comparação em memória com projeção
estrita:** `VendasRepository.existeVinculoFormaPagamento` e
`MovimentosCaixaRepository.existeVinculoFormaPagamento` buscam os
documentos com `.find({}, { <só os campos de forma de pagamento> }).lean()`
— nunca `itens`, `pagamentos` inteiros, `historico`, `cancelamentos` ou
qualquer campo irrelevante — e comparam cada candidato com
`normalizarFormaPagamento` nos dois lados, em memória. Não existe operador
nativo do MongoDB (aggregation ou `$regex`) que combine remoção de
diacríticos com colapso de espaços consecutivos num único comando — por
isso a comparação final acontece em código, usando exclusivamente a mesma
função já usada no cadastro, nunca uma segunda regra.

**Custo**: um full scan de `vendas`/`movimentos_caixa`, com projeção
estrita (nunca os documentos inteiros) — proporcional ao volume atual (zero
vendas em produção na auditoria da Fase 55.0). Nenhum índice dedicado foi
criado nos quatro campos — a checagem de vínculo é uma operação
administrativa rara (excluir uma forma de pagamento), e essas são
collections de alto volume de ESCRITA; um índice que serve só a essa
consulta rara pagaria um custo de manutenção em toda escrita,
desproporcional ao benefício hoje. Se o volume de transações crescer
substancialmente a ponto de tornar o full scan (mesmo projetado) inaceitável,
a alternativa é um job de reconciliação assíncrono mantendo um campo-espelho
— não implementado agora, por decisão proporcional ao volume atual, não por
omissão.

### 4.3 Sem exclusão lógica: todo histórico financeiro bloqueia, permanentemente

Diferente de produto (que pode ser soft-deleted, liberando sua cor/tamanho/
categoria), **vendas e movimentos de caixa não têm — e nunca tiveram —
qualquer forma de exclusão lógica**: são histórico financeiro imutável e
append-only por desenho, muito antes desta fase. Por isso, a checagem de
vínculo de forma de pagamento **não filtra por status/estado de nenhum
tipo**:

- Uma venda **cancelada** continua bloqueando a exclusão da forma usada nela
  — `status: "cancelada"` não é removida nem ignorada.
- Um movimento de um caixa **fechado** continua bloqueando a exclusão —
  `MovimentoCaixa` nunca referencia (nem precisa resolver) o status do Caixa
  ao que pertence.

Isso é uma diferença de semântica real em relação a cor/tamanho/categoria
(onde só produto ATIVO bloqueia): uma forma de pagamento usada uma única vez,
mesmo há anos, em qualquer venda ou movimento, nunca mais poderá ser
excluída. Decisão de negócio explícita desta fase, consistente com
"preservar registros históricos" sendo tratado como permanente para dados
financeiros.

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
projeto, não introduzida aqui. `configuracoes` e `produtos`/`vendas`/
`movimentos_caixa` são collections diferentes; não existe mecanismo que
torne atômica, entre elas, a sequência "verificar que o valor existe" →
"gravar o produto/variante/pagamento/movimento", nem o inverso ("verificar
que não há vínculo" → "excluir o valor").

**Isto não é uma garantia absoluta de integridade referencial.** Existe uma
janela de concorrência genuína (documentada e demonstrada na auditoria da
Fase 54.1, reafirmada para categoria na Fase 55.0/55.1 e para forma de
pagamento na Fase 55.0/55.2): se a exclusão de uma cor/tamanho/categoria/
forma de pagamento e a criação de um produto/variante/venda/movimento
usando esse mesmo valor acontecerem quase simultaneamente, é possível — em
casos raros, não eliminados por nenhuma quantidade de reconferências
sequenciais — que a configuração fique sem o valor enquanto um registro
ainda o referencia, ou vice-versa. Para forma de pagamento especificamente,
a superfície dessa janela é um pouco maior (duas collections reconferidas,
`vendas` e `movimentos_caixa`, em vez de uma) — mesma natureza de risco, não
uma categoria nova de problema.

Decisão explícita do projeto ("Alternativa A", Fase 54.2, mantida nas Fases
55.1 e 55.2): aceitar esse risco residual, documentá-lo abertamente, e não
introduzir locks distribuídos, transações multi-documento, soft-delete de
configurações nem jobs de reconciliação para fechá-lo — complexidade
desproporcional ao impacto real (ferramenta administrativa interna, baixo
volume de requisições concorrentes, janela medida em milissegundos). Se o
risco se tornar inaceitável no futuro, a Fase 54.1 já descreve a solução
recomendada (soft-delete das listas + reconciliação assíncrona) — não
implementada, por decisão própria desta fase.
