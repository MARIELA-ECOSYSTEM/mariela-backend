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

## Logs e observabilidade (Fase 60.4.3.4.19.5)

Cada log é uma linha JSON do `StructuredLoggerService` (`timestamp`, `level`, `context`, `message`); o evento em si é
um JSON dentro de `message`. Contextos: `ReconciliacaoEstoqueWorker` (ciclo de vida e ciclos) e `VendasService`
(desfecho de cada linha). Toda emissão é **protegida**: uma falha do logger nunca altera o resultado de um ciclo, nunca
interrompe a reconciliação e nunca transforma um ciclo concluído em `ciclo_falhou`.

### Identidades

- `execucaoId` — UUID gerado **uma vez por processo** (por instância do worker). Um `execucaoId` novo nos logs significa
  que **outro processo** começou (deploy, restart ou retomada do Render Free).
- `cicloId` — `${execucaoId}:${n}`, com `n` começando em 1 e crescendo a cada ciclo **efetivamente iniciado**. O mesmo
  `cicloId` aparece no `ciclo_iniciado` e no desfecho (`ciclo_concluido` ou `ciclo_falhou`).
- `commit` / `instancia` (só em `worker_iniciado`) — lidos **exclusivamente** de `RENDER_GIT_COMMIT` ("The commit SHA for
  a service or deploy") e `RENDER_INSTANCE_ID` ("The unique identifier of the current service instance"), variáveis
  documentadas pelo Render para todos os runtimes. `null` fora do Render ou se o valor não tiver o formato esperado.
  Nenhuma outra variável de ambiente é registrada.

### Eventos do worker (contexto `ReconciliacaoEstoqueWorker`)

| `evento` | Nível | Quando | Campos |
| --- | --- | --- | --- |
| `reconciliacao_estoque.worker_desabilitado` | log | boot com a variável ≠ `"true"` | `execucaoId` |
| `reconciliacao_estoque.worker_iniciado` | log | boot com a variável `"true"` (timer agendado) | `execucaoId`, `commit`, `instancia`, `intervaloMs`, `loteVendas`, `maxItensPorCiclo`, `maxTentativas` |
| `reconciliacao_estoque.ciclo_iniciado` | log | um ciclo começa (antes da consulta) | `execucaoId`, `cicloId`, `iniciadoEm`, `intervaloMs`, `loteVendas`, `maxItensPorCiclo` |
| `reconciliacao_estoque.ciclo_concluido` | log; **warn** se `resultado = processado_com_falhas` | o ciclo terminou normalmente — **inclusive vazio** | `execucaoId`, `cicloId`, `iniciadoEm`, `concluidoEm`, `duracaoMs`, contadores (abaixo), `resultado` |
| `reconciliacao_estoque.ciclo_falhou` | warn | erro geral: o ciclo nem conseguiu consultar as pendências | `execucaoId`, `cicloId`, `iniciadoEm`, `falhouEm`, `duracaoMs`, `categoriaErro`, `erroClasse`, `erroCodigo`, `novaOportunidade` |
| `reconciliacao_estoque.worker_parando` | log | início do encerramento gracioso, **antes** de esperar o ciclo em andamento | `execucaoId`, `cicloEmAndamento` |
| `reconciliacao_estoque.worker_parado` | log | timer parado **e** ciclo em andamento terminado | `execucaoId`, `ciclosExecutados` |

- Todo ciclo iniciado termina com **exatamente um** `ciclo_concluido` **ou** `ciclo_falhou`. Um `ciclo_iniciado` sem
  desfecho correspondente indica um ciclo interrompido (processo encerrado no meio).
- Um tick do timer que encontra um ciclo em andamento **não** cria ciclo novo nem emite `ciclo_iniciado`: é somado em
  `ticksSobrepostos` do ciclo em andamento.
- `ciclo_falhou` **não** traz mensagem do erro (pode conter host/URI): só `erroClasse`, `erroCodigo` e
  `categoriaErro` — `banco_indisponivel` (seleção de servidor/rede), `conflito_transacao` (erro transitório de
  transação, `WriteConflict`, `NoSuchTransaction` ou `CONFLICT` da API), `erro_banco` (outros erros do driver) ou
  `desconhecido`. `novaOportunidade` diz apenas se o timer continua agendado — **não** promete sucesso.
- O antigo `reconciliacao_estoque.ciclo` (só emitido quando o ciclo tentava algo) foi **substituído** por
  `ciclo_concluido`. Não havia consumidor conhecido do nome antigo.
- `worker_parando`/`worker_parado` só são emitidos se o worker estava ligado ou com ciclo em andamento.

### Contadores de `ciclo_concluido`

Métricas **por ciclo**. Cada linha de cancelamento é visitada no máximo uma vez por ciclo.

| Campo | Significado |
| --- | --- |
| `vendasConsultadas` | vendas devolvidas pela consulta inicial (no máximo `loteVendas`) |
| `vendasProcessadas` | vendas efetivamente percorridas (menor que `vendasConsultadas` se `maxItensPorCiclo` interromper o laço) |
| `itensElegiveis` | linhas que passaram na pré-checagem e foram submetidas a **uma** tentativa lógica; o retry interno da transação **não** conta de novo |
| `itensConcluidos` | linhas cujo commit **neste ciclo** confirmou a devolução |
| `jaConcluidos` | linhas encontradas já concluídas (por outra execução) na releitura transacional |
| `falhasRecuperaveis` | linhas que **passaram** a `falha_recuperavel` neste ciclo (registro aplicado) |
| `requeremIntervencao` | linhas que **passaram** a `requer_intervencao` neste ciclo (registro aplicado) |
| `falhasNaoRegistradas` | falhas cujo registro (CAS) **não** foi aplicado — outra execução alterou a linha antes; nunca contadas como recuperáveis |
| `adiados` | linhas restauráveis **não tentadas** na pré-checagem: agenda futura ou já em `requer_intervencao` |
| `indeterminados` | linhas históricas indeterminadas deixadas intactas na pré-checagem |
| `adiadosNaTransacao` | linhas tentadas que a releitura transacional adiou (outra execução gravou nova agenda) |
| `indeterminadosNaTransacao` | linhas tentadas que a releitura transacional encontrou indeterminadas |
| `vendasComErro` | vendas cuja leitura/processamento lançou erro (as demais seguem no mesmo ciclo) |
| `ticksSobrepostos` | ticks que encontraram este ciclo em andamento |

Relação garantida (cada linha tentada tem exatamente um desfecho):

```
itensElegiveis = itensConcluidos + jaConcluidos + falhasRecuperaveis + requeremIntervencao
               + falhasNaoRegistradas + adiadosNaTransacao + indeterminadosNaTransacao
```

`adiados` e `indeterminados` ficam **fora** dessa soma (linhas não tentadas). Observação: a consulta só devolve vendas
com ao menos uma linha elegível; uma venda cujas linhas estão **todas** em `requer_intervencao` não é consultada, então
suas linhas não aparecem em `adiados`.

### `resultado`

| Valor | Quando |
| --- | --- |
| `sem_itens_elegiveis` | nenhuma linha foi submetida a tentativa (pode haver `adiados`/`indeterminados`) e nenhuma venda deu erro |
| `processado` | houve itens elegíveis e nenhuma falha |
| `processado_com_falhas` | `falhasRecuperaveis`, `requeremIntervencao`, `falhasNaoRegistradas` ou `vendasComErro` > 0 |

Falha de uma **linha** ou de uma **venda** não é falha do **ciclo**: o ciclo termina com `ciclo_concluido` (`warn`).

### Exemplos (conteúdo de `message`; ids ilustrativos)

Ciclo vazio (o caso normal sem pendências — agora comprovável):

```json
{"evento":"reconciliacao_estoque.ciclo_concluido","execucaoId":"6f1c…","cicloId":"6f1c…:42","iniciadoEm":"2026-11-09T18:00:00.000Z","concluidoEm":"2026-11-09T18:00:00.031Z","duracaoMs":31,"vendasConsultadas":0,"vendasProcessadas":0,"itensElegiveis":0,"itensConcluidos":0,"jaConcluidos":0,"falhasRecuperaveis":0,"requeremIntervencao":0,"adiados":0,"indeterminados":0,"adiadosNaTransacao":0,"indeterminadosNaTransacao":0,"falhasNaoRegistradas":0,"vendasComErro":0,"ticksSobrepostos":0,"resultado":"sem_itens_elegiveis"}
```

Ciclo com processamento:

```json
{"evento":"reconciliacao_estoque.ciclo_concluido","cicloId":"6f1c…:43","vendasConsultadas":1,"vendasProcessadas":1,"itensElegiveis":1,"itensConcluidos":1,"falhasRecuperaveis":0,"requeremIntervencao":0,"resultado":"processado","…":"…"}
```

Ciclo com falhas (nível `warn`):

```json
{"evento":"reconciliacao_estoque.ciclo_concluido","cicloId":"6f1c…:44","itensElegiveis":2,"itensConcluidos":1,"falhasRecuperaveis":1,"requeremIntervencao":0,"resultado":"processado_com_falhas","…":"…"}
```

### Eventos por linha (contexto `VendasService`)

| `evento` | Nível | Quando |
| --- | --- | --- |
| `restauracao_estoque.concluida` | log | uma linha teve o estoque devolvido (emitido **depois** do commit) |
| `restauracao_estoque.falha` | warn | falhou; há nova tentativa agendada |
| `restauracao_estoque.requer_intervencao` | error | esgotou as tentativas automáticas ou referência ausente |
| `restauracao_estoque.erro_venda` | warn | erro ao ler/processar **uma venda** no ciclo automático; as demais seguem (`vendaId`, `erroClasse`, `erroCodigo`) |

Campos dos três primeiros:

- `modo` (`automatico`/`manual`), `vendaId`, `vendaCodigo`, `eventoId`, `itemId`, `quantidade`;
- `tentativa`, `estadoAnterior`, `estadoNovo`;
- `erroClasse`, `erroCodigo`, `erroMensagem` (sanitizada — ver limitação abaixo);
- `proximaTentativaEm`;
- `falhaRegistrada`.

**Limitação conhecida (R1, fora do escopo da 19.5):** a sanitização de `erroMensagem` remove URIs com esquema
(`mongodb://…`), mas não um `host:porta` solto que algumas mensagens de rede do driver podem conter. Os eventos novos
do worker não registram mensagem de erro.

### Limitações (leia antes de interpretar os logs)

- **SIGTERM:** `worker_parando`/`worker_parado` só aparecem em encerramento gracioso (SIGTERM com tempo para os hooks
  do Nest). Em SIGKILL, falta de memória ou suspensão abrupta eles **não** são emitidos — a ausência deles não prova
  nada. O sinal confiável de reinício é um `worker_iniciado` com `execucaoId` novo.
- **Render Free:** a instância é suspensa sem tráfego HTTP; o timer do worker não gera tráfego, então o worker só roda
  com o processo acordado. Pendências continuam no banco e são retomadas depois do boot (primeiro ciclo após
  `intervaloMs`).
- **Ausência de logs não prova suspensão nem falha.** Um intervalo maior que 2 × `intervaloMs` sem eventos significa
  apenas "execução não observável"; a causa (suspensão, travamento, perda de logs) precisa ser cruzada com a aba
  *Events* do Render.
- **Múltiplas instâncias** executam ciclos simultaneamente (cada uma com seu `execucaoId`). A instrumentação **mostra**
  ciclos sobrepostos entre instâncias e colisões (`jaConcluidos`, `falhasNaoRegistradas`), mas **não** fornece
  exclusividade distribuída: a garantia de devolução única continua sendo só a transação por linha e a marcação
  condicional.

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
