# Reconciliação de estoque em cancelamentos (Fase 60.4.3.4.18)

Cancelar uma venda (ou devolver itens) faz duas coisas:

1. registra o cancelamento na venda;
2. devolve o estoque de cada item.

O passo 2 roda **item a item, numa transação própria**: devolução física, entrada no ledger
(`movimentacoes_estoque`) e marcação da linha são confirmadas juntas ou desfeitas juntas.
Se o passo 2 falhar, o cancelamento continua válido e a linha fica **registrada no banco como pendente**.
Depois disso, a devolução pode ser concluída pelo worker interno (quando habilitado), pela repetição do
cancelamento com a mesma chave ou pela rota ADMIN de reconciliação.

## Classificação de cada linha (`vendas.cancelamentos[].itens[]`)

A regra é única (`classificarRestauracao`, Fase 60.4.3.4.18.3) e vale para **todos** os caminhos.

| Classificação | Como é derivada | O que acontece |
| --- | --- | --- |
| `concluida` | `restaurado: true` | nada mais a fazer |
| `pendente` | `estadoRestauracao: "pendente"` e `restaurado ≠ true` | worker, repetição e operador podem devolver |
| `falha_recuperavel` | `estadoRestauracao: "falha_recuperavel"` | o worker tenta de novo a partir de `proximaTentativaEm` |
| `requer_intervencao` | limite de tentativas atingido **ou referência ausente** | o worker **não** tenta; só a rota ADMIN, depois de corrigir a causa |
| `indeterminado` | qualquer outro caso: `estadoRestauracao` ausente ou inválido, `restaurado` ausente, ou `"concluida"` sem `restaurado: true` | **nenhum** caminho devolve, marca ou altera; só aparece nas consultas |

### Por que `indeterminado`

Só o código a partir de `78194a7` grava `estadoRestauracao`.
Entre `b3a3367` (15/09/2026) e `76042f8` (07/11/2026), a devolução era feita em duas fases. Uma falha ao marcar **depois**
de devolver o estoque deixava `restaurado:false` com o estoque **já devolvido**. Por isso `restaurado:false` sem estado
explícito não prova que falta devolver: devolver automaticamente poderia duplicar estoque.
A resolução dessas linhas exige uma fase própria, com auditoria e confirmação explícita. Esta versão **não** oferece ação
para concluí-las ou devolvê-las.

### Referência ausente (vai direto para `requer_intervencao`)

A transação confere o destino **antes** de mexer no estoque. Nenhum destes casos é marcado como concluído:

| `ultimaFalha.codigo` | Situação |
| --- | --- |
| `ITEM_VENDA_INEXISTENTE` | a linha aponta para um item que não existe na venda |
| `ITEM_SEM_VARIANTE` | o item da venda não tem variante |
| `PRODUTO_EXCLUIDO_OU_INEXISTENTE` | o produto foi excluído (`excluidoEm`) ou não existe |
| `VARIANTE_INEXISTENTE` | a variante foi removida do produto |
| `TAMANHO_INEXISTENTE` | o tamanho foi removido da variante; ele **não** é recriado automaticamente |

Corrigida a causa (ex.: produto reativado, tamanho recadastrado), o operador usa a rota de reconciliação.

Outros campos da linha:

- `tentativas`;
- `ultimaTentativaEm`;
- `proximaTentativaEm`;
- `restauradoEm`;
- `ultimaFalha` — classe, código e mensagem curta do erro, sem stack, URI ou dado pessoal.

Eventos antigos só têm `restaurado`. Nenhuma migração é feita:

- `true` é lido como concluído;
- `false` ou ausente é lido como **indeterminado** (ver acima), nunca como pendente.

## Worker (`ReconciliacaoEstoqueWorker`)

- **Descoberta:** busca no banco, nunca em memória. Por isso sobrevive a restart e deploy.
- **Várias instâncias:** pode rodar em várias ao mesmo tempo.
  - Duas transações na mesma linha conflitam no MongoDB, e só uma confirma.
  - A marcação é condicional, então o estoque volta **uma vez só**.
- **Intervalo:** `RECONCILIACAO_ESTOQUE_INTERVALO_MS`, padrão 60 s.
  - Um ciclo nunca se sobrepõe ao anterior na mesma instância.
- **Limites por ciclo:**
  - até `RECONCILIACAO_ESTOQUE_LOTE` vendas (padrão 20);
  - até `RECONCILIACAO_ESTOQUE_MAX_ITENS_POR_CICLO` linhas (padrão 50).
- **Espera entre tentativas:** `BACKOFF_BASE_MS × 2^(tentativas−1)`, limitada a `BACKOFF_MAX_MS`.
  - Os padrões são 30 s e 1 h.
- **Limite de tentativas:** `RECONCILIACAO_ESTOQUE_MAX_TENTATIVAS`, padrão 8. Depois disso a linha vira `requer_intervencao`.
- **Liga/desliga:** `RECONCILIACAO_ESTOQUE_HABILITADA`. O padrão é **desligado em qualquer ambiente, inclusive
  produção**; só `true` liga. Desligado, não cria timer e não roda nenhum ciclo — só registra
  `reconciliacao_estoque.worker_desabilitado`. O primeiro ciclo, quando ligado, roda depois de um intervalo, nunca no boot.
- **Mesmo desligado**, a proteção de linhas indeterminadas continua valendo no cancelamento, na repetição e na rota ADMIN.

## Logs (JSON na mensagem, contexto `VendasService` / `ReconciliacaoEstoqueWorker`)

| `evento` | Nível | Quando |
| --- | --- | --- |
| `restauracao_estoque.concluida` | log | uma linha teve o estoque devolvido |
| `restauracao_estoque.falha` | warn | falhou; há nova tentativa agendada |
| `restauracao_estoque.requer_intervencao` | error | esgotou as tentativas automáticas |
| `reconciliacao_estoque.ciclo` | log | resumo de um ciclo que tentou algo |
| `reconciliacao_estoque.ciclo_falhou` | warn | o ciclo não conseguiu nem ler as pendências (ex.: banco indisponível) |

Os campos de cada log são:

- `vendaId`, `vendaCodigo`, `eventoId`, `itemId`, `quantidade`;
- `tentativa`, `estadoAnterior`, `estadoNovo`;
- `erroClasse`, `erroCodigo`, `erroMensagem` (já sanitizada);
- `proximaTentativaEm`;
- `falhaRegistrada`.

## Procedimento do operador

Todas as rotas exigem login **ADMIN**.

1. **Ver o que está pendente**

   `GET /api/v1/vendas/restauracoes-estoque/pendentes`

   Lista cada linha não restaurada com:

   - venda, item e quantidade;
   - `estado` e `tentativas`;
   - `proximaTentativaEm`;
   - `ultimaFalha`.

   `totalVendas` mostra quantas vendas estão afetadas. A consulta lista até 100.

   Na tela da venda, o campo `restauracaoEstoque.status` indica:

   - `pendente`: o sistema ainda vai tentar;
   - `requer_intervencao`: precisa do operador;
   - `indeterminado`: há linha histórica sem prova do estado do estoque — **não** use a reconciliação para ela
     (ela é ignorada); registre para a fase de auditoria própria.

2. **Entender a causa** pela `ultimaFalha` e pelos logs `restauracao_estoque.*`. Exemplos:

   - saldo do produto inconsistente;
   - tamanho removido;
   - banco indisponível.

   Corrija a causa no cadastro ou no estoque **antes** de pedir nova tentativa.

3. **Pedir nova tentativa**

   `POST /api/v1/vendas/:id/restauracao-estoque/reconciliacao`

   - Tenta **agora** as linhas `pendente`, `falha_recuperavel` e `requer_intervencao` da venda. Linhas `indeterminado`
     são ignoradas.
   - **Não** repete o cancelamento, **não** pede chave e **não** mexe em caixa nem em agregados.
   - É seguro repetir.
   - A resposta é a venda atualizada. Confira `restauracaoEstoque.status`.

4. **Não** cancele de novo com outra chave. A venda já está cancelada e o pedido será recusado.
   Um novo cancelamento também não é o caminho para devolver o estoque.

## Backoffice

O diálogo de cancelamento usa **uma chave por operação** e a reusa em toda nova tentativa da mesma operação.
A chave muda quando:

- muda o tipo ou os itens;
- ou a venda registra um novo evento.

Quando a resposta indica estoque pendente ou `requer_intervencao`, a tela mostra um **aviso**, não um sucesso.
O aviso pede para não repetir a operação.
