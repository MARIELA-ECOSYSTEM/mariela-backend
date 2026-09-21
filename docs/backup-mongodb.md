# Backup e restore do MongoDB Atlas — procedimento operacional

Origem: Fase 29-FI.1 (auditoria), 29-FI.2 (execução/validação da mecânica), Fase 32 (primeiro backup real), Fase 33 (restore local do archive real) e Fase 34 (auditoria final e esta atualização). Este documento é a referência operacional; não repete a análise completa de alternativas — isso fica no histórico das fases.

## Estado atual e limitações (leia primeiro)

Situação verificada em 21/09/2026:

- **Banco de produção:** `marielaDB` (definido pela `MONGODB_BACKUP_URI`).
- **Primeiro backup real:** `M:\Backup-sistema-mariela\mariela_prod_20260921_1357.archive.gz` — 311 bytes, SHA256 `A4BDFF21DDDBE23F453B5AE824246BDC89088E7BAE75537175FA3CEA915B5A9E`. Nesse momento o banco continha **apenas a collection `produtos`, com 0 documentos e só o índice `_id_`**: o backend ainda não tinha criado as demais collections e índices em produção.
- **Provado (Fase 33):** o archive é legível (gzip íntegro, header e blocos lidos); o restore local (executado duas vezes, resultado idêntico) em `127.0.0.1:27017`, no banco descartável `mariela_restore_test_<timestamp>`, terminou com 0 documentos e 0 falhas; o backend iniciou contra o banco restaurado e respondeu (`GET /health` 200 com `database.status: "up"`, login e leituras 200).
- **NÃO provado:**
  1. **Restore de dados reais.** Como a produção estava vazia, a validação cobre só a mecânica — não equivale a restaurar uma produção populada. O checklist de collections/índices/documentos críticos (abaixo) só pode ser aplicado de verdade a um archive de um banco com dados.
  2. **Compatibilidade entre versões do MongoDB.** O archive registra `server_version 8.0.32`; o único servidor local disponível é o **8.2.1**. O `mongorestore` emite em todo restore: *"This archive came from MongoDB `8.0.32`, but you are restoring to `8.2.1`. Cross-version dump & restore is unsupported. The restored data may be corrupted."* Por isso o restore local atual **não pode ser considerado uma validação compatível**, apenas da mecânica (ver "Compatibilidade de versões").
  3. Agendamento diário (nenhuma tarefa criada no Task Scheduler), segunda cópia do backup, e a restrição do usuário de backup ao papel `read` / a IP Access List do Atlas (o backup funcionou com a credencial configurada, mas isso não foi auditado no console do Atlas).
- **Pendências:** ver a seção "Pendências e limitações conhecidas" no fim deste documento.

## Por que `mongodump`/`mongorestore`

O cluster de produção roda no MongoDB Atlas, plano **Free (M0)**. Segundo a documentação oficial (docs.mongodb.com/atlas/backup-restore-cluster, consultada em 09/2026), **clusters Free não suportam Cloud Backup/snapshots nativos**. O mecanismo oficialmente recomendado pela MongoDB para este tier é `mongodump`/`mongorestore`. (O tier não foi reconferido no console do Atlas nas Fases 32–34.)

## Ferramenta

MongoDB Database Tools (versão 100.x, oficial: https://www.mongodb.com/try/download/database-tools). Nas Fases 32–34 foi usada a **100.17.0**. **Não é uma dependência do backend** — nunca deve entrar no `package.json`; é uma ferramenta operacional instalada separadamente na máquina/CI que roda o backup.

Instalação recomendada (Windows, com privilégio de administrador):
```powershell
choco install mongodb-database-tools
```
Ou baixe o `.zip`/`.msi` oficial e adicione `bin/` ao PATH.

O **`mongosh` não é requisito** deste procedimento e não está instalado na máquina do operador. Onde antes se usava `mongosh` (inspecionar/derrubar o banco de teste), use o driver MongoDB que o próprio projeto já tem — ver "Alternativa ao `mongosh`".

## Rotina diária de backup

Script: `ops/backup/backup-mongo.ps1`.

1. Defina a variável de ambiente `MONGODB_BACKUP_URI` (escopo do usuário) com a connection string do usuário **dedicado de backup** (ver seção "Credenciais" abaixo) — nunca como argumento do script, nunca em arquivo versionado, nunca impressa. Um PowerShell novo herda a variável; uma sessão já aberta antes de defini-la, não.
2. Rode (sempre passando o destino):
   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<repositório>\ops\backup\backup-mongo.ps1" -BackupDir "M:\Backup-sistema-mariela"
   ```
3. O script: executa `mongodump --uri=<MONGODB_BACKUP_URI> --gzip --archive=<temporário>`, confere exit code e tamanho do arquivo, e só então renomeia o dump para o nome definitivo `mariela_prod_yyyyMMdd_HHmm.archive.gz`; por fim aplica a retenção (remove backups com mais de 30 dias, nunca deixando menos de 2 cópias válidas).
4. **Agendamento: ainda não existe.** Agende via **Task Scheduler do Windows** (máquina do operador) ou cron (se rodar num servidor Linux/CI) — nenhuma infraestrutura nova foi introduzida para isso. A tarefa precisa rodar como um usuário que enxergue a variável `MONGODB_BACKUP_URI` e o drive `M:`.

### Banco dumpado
- O banco de produção é **`marielaDB`**. O script **não passa `--db`**: o banco é o definido pela própria `MONGODB_BACKUP_URI` (`mongodb+srv://.../marielaDB?...`), e o `mongodump` recusa uma URI e um `--db` que divirjam.
- Se a URI não definir nenhum banco, o script aborta (sem banco na URI o `mongodump` dumparia todos os bancos acessíveis ao usuário).
- No archive, os namespaces ficam como `marielaDB.<collection>` — é a origem usada no restore de teste.

### Arquivo temporário e falhas
O dump é gravado primeiro como `mariela_prod_yyyyMMdd_HHmm.archive.gz.tmp`. Esse nome não casa com o padrão da retenção. Se o `mongodump` falhar, ou o arquivo não existir ou vier vazio, o temporário é apagado e o script termina com erro **sem rotacionar nada** — um dump parcial nunca vira "cópia válida".

**Colisão no mesmo minuto** (já existe `mariela_prod_yyyyMMdd_HHmm.archive.gz` com o nome que esta execução usaria): o backup definitivo existente **nunca é sobrescrito nem apagado**.
- Se ele já existe ao começar, o script sai com erro (exit ≠ 0) **antes do dump**: nada é criado e o `mongodump` nem é chamado.
- Se ele aparecer durante o dump (duas execuções concorrentes), o script descarta **só o `.tmp` desta execução**, sai com erro (exit ≠ 0) e **não executa a retenção**. O mesmo vale se a promoção do `.tmp` para o nome definitivo falhar por qualquer motivo (o `Move-Item` não usa `-Force`).

**Limpeza de `.tmp` órfão** (execução interrompida: processo morto, queda de energia), executada só depois de um backup bem-sucedido, com a seguinte regra:
- Só entram arquivos (nunca pastas) cujo nome case com `mariela_prod_*.archive.gz.tmp`, neste diretório, sem recursão. Qualquer outro `.tmp`, ou um nome com sufixo diferente (ex.: `.tmpold`), nunca é tocado.
- O arquivo precisa estar **sem escrita e sem ter sido criado há mais de 24 horas** (`-TmpOrfaoHoras`, padrão 24; `LastWriteTime` **e** `CreationTime`). O `.tmp` da própria execução é sempre excluído.
- Antes de apagar, o script tenta abrir o arquivo com acesso exclusivo: se outro processo (por exemplo, um `mongodump` ainda em curso) o mantém aberto, a abertura falha e o arquivo é mantido; uma falha ao remover só gera uma mensagem, sem derrubar o backup.
- Não há limpeza quando o backup falha.
- A proteção contra remover um dump em andamento foi validada com um gravador simulado que mantém o arquivo aberto (não com um `mongodump` real); ela pressupõe que o gravador mantém o arquivo aberto enquanto escreve, como o `mongodump` faz.

### Local de armazenamento
O destino definido pelo operador é **`M:\Backup-sistema-mariela`** (passar sempre `-BackupDir`; o padrão do script, `%USERPROFILE%\mariela-backups`, é apenas um exemplo). Deve ser um local privado fora da infraestrutura de produção (não o mesmo ambiente Render da aplicação), idealmente com pelo menos uma segunda cópia num local privado adicional (ex.: pasta de nuvem pessoal/corporativa já em uso, sem contratar serviço novo). **A segunda cópia ainda não existe.**

A subpasta `M:\Backup-sistema-mariela\marielaDB` (3 arquivos: `prelude.json`, `produtos.metadata.json`, `produtos.bson` de 0 bytes) é um **artefato histórico** — um dump parcial de `produtos`, anterior ao script atual. **Não é um backup válido**, não segue o padrão da retenção (nunca é considerada nem removida) e não deve ser usada em restore.

### Codificação dos scripts (PowerShell 5.1)
Os scripts `ops/backup/*.ps1` são UTF-8 **com BOM** — e devem continuar assim. Sem BOM, o Windows PowerShell 5.1 lê o arquivo como Windows-1252: o travessão `—` vira `â€”`, cujo último byte é uma aspa tipográfica que o PowerShell trata como fim de string, gerando `ParserError` em pontos aparentemente sem relação. O PowerShell 7 não reproduz o erro. Ao editar um `.ps1`, valide nos dois:
```powershell
[System.Management.Automation.Language.Parser]::ParseFile($caminho, [ref]$null, [ref]$erros)   # $erros deve ficar vazio no 5.1 e no 7
```

### Limitação: a URI aparece na linha de comando do `mongodump`
O script recebe a URI só por variável de ambiente, mas a repassa ao `mongodump` como `--uri=...`; durante a execução ela fica visível na linha de comando do processo para quem tiver acesso à máquina. O `mongodump` 100.17.0 aceita `--config <arquivo>` (arquivo de configuração); trocar o `--uri=` por ele é uma alternativa **ainda não implementada** (exige um arquivo com permissões restritas). A opção `--password` sem valor pede a senha de forma interativa e não serve para execução agendada.

## Credenciais necessárias (nunca solicitadas/expostas neste repositório)

- **Credencial**: connection string de um usuário Atlas dedicado ao backup.
- **Permissão**: papel `read` no banco `marielaDB` — nunca o usuário de aplicação (read-write), nunca um usuário admin da organização.
- **Configuração**: o IP de onde o backup roda precisa estar na IP Access List do projeto Atlas.

Se o usuário dedicado ainda não existir: **ação manual do operador** — criar no console do Atlas (Database Access → Add New Database User → papel `Read` restrito ao banco `marielaDB`).

## Restore de teste

Script: `ops/backup/restore-test.ps1 -ArquivoBackup <caminho do .archive.gz>`. Exemplo:
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<repositório>\ops\backup\restore-test.ps1" -ArquivoBackup "M:\Backup-sistema-mariela\mariela_prod_yyyyMMdd_HHmm.archive.gz"
```

- Restaura **sempre** contra `127.0.0.1:27017` (MongoDB local — o mesmo servidor usado em desenvolvimento, mas num banco novo), num banco descartável (`mariela_restore_test_<timestamp>`) — o script só aceita o caminho do archive como parâmetro: não aceita host remoto nem URI como destino, por segurança.
- Namespace de origem: `marielaDB.*` (o nome do banco de produção), mapeado para `mariela_restore_test_<timestamp>.*` via `--nsFrom`/`--nsTo`.
- **Validação do namespace antes de qualquer escrita.** O `mongorestore` **não avisa** quando o archive é válido mas de outro banco: sai com exit 0 e "0 document(s) restored successfully" (o mesmo resumo de um archive correto vazio), e o `--nsFrom` só renomeia o que casa — o restante seria restaurado sob o **nome original** do banco de origem, fora do banco de teste (verificado com `--dryRun` local sobre uma cópia sintética do archive real, sem gravar nada). Por isso o script primeiro descompacta o começo do archive (até 1 MiB; o prelude com os namespaces vem primeiro) e procura o elemento BSON `db = "marielaDB"` — checagem binária, sem interpretar texto de log. Se o archive é um gzip legível e **não** tem esse namespace, o script sai com erro e **não chama o `mongorestore`**. Um arquivo que não é gzip legível não é julgado pelo script: o `mongorestore` o recusa sozinho (exit 1, `gzip: invalid header`, verificado com `--dryRun`).
- A checagem só confirma a **presença** do namespace `marielaDB` no archive; ela não valida a integridade dos dados nem a compatibilidade de versão. O passo 1 do checklist (conferir que as collections esperadas apareceram) continua obrigatório.
- **Nunca** aponta para produção. Não sobrescreve nada existente: o banco de destino é novo a cada execução, e o archive é só lido.

### Compatibilidade de versões (MongoDB 8.0.32 → 8.2.1)
- O header do archive registra o servidor de origem (`server_version`); o `mongorestore` o compara com o servidor de destino e, se forem diferentes, avisa: *"Cross-version dump & restore is unsupported. The restored data may be corrupted."*
- Hoje o único servidor local é o **8.2.1** (serviço do Windows, `M:\Program Files\MongoDB\Server\8.2`); não há Docker, e o `docker-compose.yml` do projeto usa `mongo:7`, que também difere de 8.0.
- Consequência: os restores da Fase 33 provam a mecânica e a estrutura do archive (que só continha `produtos` vazia), **mas não a compatibilidade** entre as versões. Não trate o warning como resolvido. Um restore local **sem** o warning foi observado apenas num teste sintético 8.2.1 → 8.2.1 (dados fictícios, banco removido depois), o que mostra que o aviso decorre da diferença de versão, não do script.
- **Forma tecnicamente correta de validar:** restaurar o archive num `mongod` **8.0.x, preferencialmente 8.0.32** (a versão registrada no archive), numa instância separada (outra porta e outro diretório de dados). **Pendente — não feito**, e não deve ser feito sem decisão explícita do operador (envolve instalar um servidor; este script continua restrito a `127.0.0.1:27017`).

### Alternativa ao `mongosh`
Com o driver `mongodb` do projeto (7.5.0, dependência do Mongoose) e o Bun, a partir do diretório do repositório. Somente `127.0.0.1:27017`.

Listar collections, contagens e índices de um banco (somente leitura):
```powershell
$listar = @'
import { MongoClient } from 'mongodb';
const c = new MongoClient('mongodb://127.0.0.1:27017');
const db = c.db(process.argv[1]);
for (const col of await db.listCollections().toArray()) {
  const x = db.collection(col.name);
  console.log(col.name, await x.countDocuments({}), (await x.indexes()).map((i) => i.name).join(','));
}
await c.close();
'@
bun -e $listar mariela_restore_test_<timestamp>
```

Derrubar o banco de teste (a expressão regular recusa qualquer nome que não seja `mariela_restore_test_<yyyyMMdd_HHmmss>` — nunca use isto em outro banco):
```powershell
$dropar = @'
import { MongoClient } from 'mongodb';
const nome = process.argv[1];
if (!/^mariela_restore_test_\d{8}_\d{6}$/.test(nome)) throw new Error('recusado: ' + nome);
const c = new MongoClient('mongodb://127.0.0.1:27017');
await c.db(nome).dropDatabase();
await c.close();
'@
bun -e $dropar mariela_restore_test_<timestamp>
```
Testados no PowerShell 5.1 e no 7: a listagem (contra um banco local existente, somente leitura) e a guarda de nome do trecho de remoção (recusa um nome fora do padrão antes de conectar). Não é preciso instalar o `mongosh`; se ele estiver disponível, `db.getSiblingDB('<nome>').dropDatabase()` continua sendo equivalente.

### Validação pós-restore (checklist)
Aplicável de verdade a um archive de produção **com dados**. Para o archive de 21/09/2026 (só `produtos`, vazia), apenas os itens 1 (parcial), 2, 3, 5 e 6 tiveram sentido.

1. **Collections presentes** — o sistema define **28 collections** (27 do desenho original + `eventos_configuracao`, criada na Fase 30.1). O número está comprovado no código (`collection:` de cada schema) e no boot do backend contra um banco vazio (Fase 33: 28 collections criadas). Nenhuma faltando:

   CRÍTICAS: `vendas`, `caixas`, `movimentos_caixa`, `clientes`, `fornecedores`, `vendedores`, `produtos`, `adquirentes`, `configuracoes`, `usuarios`, `sequencias`
   IMPORTANTES: `colecoes`, `campanhas`
   RECONSTRUÍVEIS: `eventos_auth`, `eventos_pdv_auth`, `eventos_produto`, `eventos_venda`, `eventos_caixa`, `eventos_cliente`, `eventos_fornecedor`, `eventos_vendedor`, `eventos_colecao`, `eventos_campanha`, `eventos_adquirente`, `eventos_configuracao`, `movimentacoes_estoque`, `refresh_tokens`, `vendedor_refresh_tokens`

   (Os `eventos_*` são trilhas de auditoria append-only: perdê-los significa perder o histórico, e não dá para "reconstruí-los" a partir dos demais dados — o agrupamento acima segue o desenho original.) Um archive **anterior** ao primeiro boot do backend em produção, como o de 21/09/2026, não terá todas elas: o backend as cria ao iniciar (ver "Índices criados pelo sistema").
2. **Contagem de documentos** por collection — igual à origem (ou explicavelmente diferente, se houve escrita em produção entre o dump e a checagem). `refresh_tokens` e `vendedor_refresh_tokens` têm índice TTL (`expiresAt`): o MongoDB remove tokens expirados em segundo plano, então a contagem restaurada pode cair pouco depois do restore.
3. **Índices críticos** presentes no restaurado — ver a tabela em "Índices criados pelo sistema". No mínimo: `vendas.idempotencyKey`, `movimentos_caixa.idempotencyKey`, `caixas.status`, `*.telefoneNormalizado` (clientes/fornecedores/vendedores) e `adquirentes.nomeNormalizado`, todos únicos e parciais. O `mongorestore` recria os índices a partir dos metadados do archive: um archive de banco que ainda não tinha os índices (caso de 21/09/2026) restaura só `_id_`.
4. **Documentos críticos** — pelo menos um documento de referência de cada collection crítica presente no restaurado (evidência sanitizada: contagem e campos estruturais, nunca senhas, hashes, tokens ou dados pessoais).
5. **Backend conecta** — sem tocar no `.env` do projeto: defina, **só no processo**, `MONGODB_URI=mongodb://127.0.0.1:27017/<banco_restaurado>` e valores **descartáveis e aleatórios** para `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `PDV_JWT_ACCESS_SECRET` e `PDV_JWT_REFRESH_SECRET` (nunca os de produção), mais `PORT` livre; rode `bun "<repositório>\dist\main.js"` **a partir de um diretório fora do repositório** (ou use `bun --no-env-file`), para que o Bun/Nest não carreguem o `.env` real. Confirme `GET /health` → `database.status: "up"`. **O backend cria collections e índices no banco ao iniciar**: rode o smoke test num banco restaurado *extra* e mantenha o primeiro intacto como evidência.
6. **Leituras básicas funcionam** — o banco restaurado não terá usuário administrativo se o archive não o contiver; para testar login, crie um admin **fictício só nesse banco descartável** com o script existente, a partir do diretório do repositório: `ADMIN_EMAIL`, `ADMIN_NAME` e `ADMIN_PASSWORD` (fictícios, no ambiente do processo) e `bun --no-env-file src\scripts\seed-admin.ts`. Depois, login e ao menos uma leitura em produtos/clientes/vendas/caixas retornando sem erro, sem executar nenhuma operação de escrita de negócio (venda, estoque, caixa).

**PASSOU**: todos os itens aplicáveis conferem. **FALHOU**: qualquer collection/índice/documento crítico ausente, ou o backend não conseguir operar contra o banco restaurado. **Ressalva permanente enquanto o restore for feito em servidor de versão diferente da origem:** registrar o warning de versão no resultado.

Ao terminar, sempre derrubar o banco de teste (trecho "Alternativa ao `mongosh`" acima) — nunca deixar cópias de dados de produção acumulando no ambiente local.

## Índices criados pelo sistema

Não há migração nem script de índices. Todos são criados pelo **próprio backend, ao iniciar contra o banco**: pelo Mongoose (`autoIndex`, comportamento padrão — o código não o desativa) a partir da definição dos schemas em `src/modules/*/schemas/`. Dois repositórios ainda rodam `syncIndexes()` em `onModuleInit`: `caixas` e `movimentos_caixa` (cria os que faltam **e remove índices que não constem mais no schema**; falha é só logada, não derruba o boot).

| Tipo | Índices |
|---|---|
| **Únicos e parciais** | `adquirentes.nomeNormalizado` (`excluidoEm: null`); `caixas.status` (`status: "aberto"` — no máximo um caixa aberto); `clientes.telefoneNormalizado` e `vendedores.telefoneNormalizado` (`excluidoEm: null`); `fornecedores.telefoneNormalizado` (`excluidoEm: null` e `telefoneNormalizado > ""`); `vendas.idempotencyKey` e `movimentos_caixa.idempotencyKey` (`idempotencyKey` do tipo string) |
| **Único e esparso** | `produtos.variantes.codVariante` |
| **Únicos simples** | `codigo` em `usuarios`, `caixas`, `campanhas`, `clientes`, `colecoes`, `fornecedores`, `produtos`, `vendas`, `vendedores`; `usuarios.email`; `vendas.numero`; `tokenHash` em `refresh_tokens` e `vendedor_refresh_tokens` |
| **TTL** (`expireAfterSeconds: 0`) | `refresh_tokens.expiresAt`, `vendedor_refresh_tokens.expiresAt` |
| **Comuns** | `excluidoEm` (adquirentes, campanhas, clientes, colecoes, fornecedores, produtos, vendedores); `criadoEm` (campanhas, clientes, colecoes, fornecedores, produtos, vendas, vendedores); `caixas.dataAbertura`; `movimentos_caixa` (`{caixaId, dataHora}`, `{caixaId, tipo}`, `dataHora`, `caixaId`); `produtos` (`categoria`, `colecaoId`, `campanhaId`, `fornecedorId`, `quantidadeTotal`); `vendas` (`status`, `dataVenda`, `vendedorId`, `clienteId`, `caixaId`); chaves das trilhas `eventos_*` (id da entidade e `tipo`); `movimentacoes_estoque.produtoId`; `refresh_tokens.usuarioId`, `vendedor_refresh_tokens.vendedorId` |

`sequencias` e `configuracoes` só têm o índice padrão de `_id`. Consequência operacional: o **primeiro boot** do backend contra o `marielaDB` de produção é o que cria os índices únicos e parciais dos quais dependem a exclusividade de caixa aberto, a idempotência e as chaves de negócio — confirme isso no primeiro deploy.

## Retenção

- 30 backups diários.
- Nunca menos de 2 cópias válidas simultâneas, mesmo que isso signifique manter um backup além dos 30 dias. A contagem desconta as remoções já feitas na mesma rotina, e, se o mínimo barrar uma remoção, ficam as cópias mais recentes.
- O padrão considerado é `mariela_prod_*.archive.gz`, **apenas arquivos reais, no diretório informado (não recursivo)**. Qualquer outro nome — `.tmp`, `.bak`, outras extensões, `mariela_dev_*`, a pasta histórica `marielaDB`, subpastas — é ignorado e nunca removido; uma **pasta** com nome parecido (vazia ou com conteúdo) não é cópia, não conta para o piso de 2 e nunca é removida (comportamento verificado com um `mongodump` simulado). Os `.tmp` do backup têm regra própria de limpeza (ver "Arquivo temporário e falhas").
- A retenção remove primeiro os mais antigos.

## Restore periódico (não apenas o de validação inicial)

Depois do primeiro restore de teste (obrigatório antes de considerar este procedimento operacional), repetir o mesmo checklist **trimestralmente** — um backup nunca testado não é um backup confiável. O primeiro restore (Fase 33) só cobriu um banco vazio e um servidor de versão diferente; **o restore com dados reais e num `mongod` 8.0.x continua pendente**.

## RPO/RTO (metas iniciais, estágio atual do projeto)

- **RPO**: até 24h (consequência da frequência diária) — **não comprovado**: não há agendamento diário em execução.
- **RTO**: poucas horas (procedimento manual, sem automação de failover) — **não comprovado**: o único restore medido (0,69 s) foi de um archive de 311 bytes e não é representativo de uma produção com dados.

Ambos são metas iniciais para o estágio de desenvolvimento atual, não SLAs formais — revisar quando o volume de vendas/operação justificar e depois de medir um backup/restore com dados reais.

## Pendências e limitações conhecidas

Pendências operacionais:
1. **Validar o restore num `mongod` 8.0.x (preferencialmente 8.0.32)** — sem isso o warning de versão continua aberto.
2. **Repetir backup e restore com produção populada** e aplicar o checklist completo (collections, contagens, índices únicos/parciais, documentos críticos).
3. Criar a **tarefa agendada** (Task Scheduler) do backup diário.
4. Definir a **segunda cópia** do backup.
5. Decidir sobre `--config` para tirar a URI da linha de comando do `mongodump`.
6. Confirmar no Atlas o papel `read` do usuário de backup e a IP Access List.
7. Confirmar no primeiro boot em produção a criação dos índices críticos.

Endurecimentos já aplicados aos scripts (Fase 35): retenção só sobre arquivos, limpeza segura de `.tmp` órfão, colisão no mesmo minuto sem lixo temporário, validação do namespace `marielaDB` no restore e mensagem final sem `mongosh`.

Limitações que permanecem (documentadas, não corrigidas):
- O `--uri=` continua na linha de comando do `mongodump` (ver acima).
- O `.tmp` órfão só é limpo depois de um backup bem-sucedido e só depois de 24 horas; até lá ele ocupa espaço no destino.
- A validação de namespace do restore lê só o primeiro 1 MiB do archive descompactado e exige apenas que o namespace `marielaDB` **exista** nele. Um archive que misture `marielaDB` com **outros** bancos passaria, e os outros seriam restaurados sob o nome original. O `backup-mongo.ps1` nunca gera um archive assim (a URI define um único banco), mas o `--nsInclude "marielaDB.*"` no `mongorestore` eliminaria o risco; **recomendado, não implementado** (verificado com `--dryRun` que ele impede a restauração dos namespaces não casados).
- O restore continua sendo a checagem de mecânica descrita acima; a compatibilidade de versão (8.0.32 → 8.2.1) e o restore de dados reais seguem pendentes.
