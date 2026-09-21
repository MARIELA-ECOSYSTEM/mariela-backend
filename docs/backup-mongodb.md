# Backup e restore do MongoDB Atlas — procedimento operacional

Origem: Fase 29-FI.1 (auditoria) e 29-FI.2 (execução/validação da mecânica). Este documento é a referência operacional; não repete a análise completa de alternativas — isso fica no histórico das fases.

## Por que `mongodump`/`mongorestore`

O cluster de produção roda no MongoDB Atlas, plano **Free (M0)**. Segundo a documentação oficial (docs.mongodb.com/atlas/backup-restore-cluster, consultada em 09/2026), **clusters Free não suportam Cloud Backup/snapshots nativos**. O mecanismo oficialmente recomendado pela MongoDB para este tier é `mongodump`/`mongorestore`.

## Ferramenta

MongoDB Database Tools (versão 100.x, oficial: https://www.mongodb.com/try/download/database-tools). **Não é uma dependência do backend** — nunca deve entrar no `package.json`; é uma ferramenta operacional instalada separadamente na máquina/CI que roda o backup.

Instalação recomendada (Windows, com privilégio de administrador):
```powershell
choco install mongodb-database-tools
```
Ou baixe o `.zip`/`.msi` oficial e adicione `bin/` ao PATH.

## Rotina diária de backup

Script: `ops/backup/backup-mongo.ps1`.

1. Defina a variável de ambiente `MONGODB_BACKUP_URI` com a connection string do usuário **dedicado de backup** (ver seção "Credenciais" abaixo) — nunca como argumento de linha de comando, nunca em arquivo versionado.
2. Rode: `powershell -File ops/backup/backup-mongo.ps1 -BackupDir "M:\Backup-sistema-mariela"`
3. O script: executa `mongodump --uri=<MONGODB_BACKUP_URI> --gzip --archive=<temporário>`, confere exit code e tamanho do arquivo, e só então renomeia o dump para o nome definitivo `mariela_prod_yyyyMMdd_HHmm.archive.gz`; por fim aplica a retenção (remove backups com mais de 30 dias, nunca deixando menos de 2 cópias válidas).
4. Agende via **Task Scheduler do Windows** (máquina do operador) ou cron (se rodar num servidor Linux/CI) — nenhuma infraestrutura nova foi introduzida para isso.

### Banco dumpado
- O banco de produção é **`marielaDB`**. O script **não passa `--db`**: o banco é o definido pela própria `MONGODB_BACKUP_URI` (`mongodb+srv://.../marielaDB?...`), e o `mongodump` recusa uma URI e um `--db` que divirjam.
- Se a URI não definir nenhum banco, o script aborta (sem banco na URI o `mongodump` dumparia todos os bancos acessíveis ao usuário).
- No archive, os namespaces ficam como `marielaDB.<collection>` — é a origem usada no restore de teste.

### Arquivo temporário e falhas
O dump é gravado primeiro como `mariela_prod_yyyyMMdd_HHmm.archive.gz.tmp`. Esse nome não casa com o padrão da retenção. Se o `mongodump` falhar, ou o arquivo não existir ou vier vazio, o temporário é apagado e o script termina com erro **sem rotacionar nada** — um dump parcial nunca vira "cópia válida".

### Local de armazenamento
O destino definido pelo operador é **`M:\Backup-sistema-mariela`** (passar sempre `-BackupDir`; o padrão do script, `%USERPROFILE%\mariela-backups`, é apenas um exemplo). Deve ser um local privado fora da infraestrutura de produção (não o mesmo ambiente Render da aplicação), idealmente com pelo menos uma segunda cópia num local privado adicional (ex.: pasta de nuvem pessoal/corporativa já em uso, sem contratar serviço novo).

## Credenciais necessárias (nunca solicitadas/expostas neste repositório)

- **Credencial**: connection string de um usuário Atlas dedicado ao backup.
- **Permissão**: papel `read` no banco `marielaDB` — nunca o usuário de aplicação (read-write), nunca um usuário admin da organização.
- **Configuração**: o IP de onde o backup roda precisa estar na IP Access List do projeto Atlas.

Se o usuário dedicado ainda não existir: **ação manual do operador** — criar no console do Atlas (Database Access → Add New Database User → papel `Read` restrito ao banco `marielaDB`).

## Restore de teste

Script: `ops/backup/restore-test.ps1 -ArquivoBackup <caminho do .archive.gz>` (ex.: `M:\Backup-sistema-mariela\mariela_prod_yyyyMMdd_HHmm.archive.gz`).

- Restaura **sempre** contra `127.0.0.1:27017` (MongoDB local — o mesmo usado em desenvolvimento), num banco novo e descartável (`mariela_restore_test_<timestamp>`) — o script não aceita um host remoto nem uma URI como destino, por segurança.
- Namespace de origem: `marielaDB.*` (o nome do banco de produção), mapeado para `mariela_restore_test_<timestamp>.*` via `--nsFrom`/`--nsTo`.
- **Nunca** aponta para produção.

### Validação pós-restore (checklist)
1. **Collections presentes** — as 27 abaixo, nenhuma faltando:

   CRÍTICAS: `vendas`, `caixas`, `movimentos_caixa`, `clientes`, `fornecedores`, `vendedores`, `produtos`, `adquirentes`, `configuracoes`, `usuarios`, `sequencias`
   IMPORTANTES: `colecoes`, `campanhas`
   RECONSTRUÍVEIS: `eventos_auth`, `eventos_pdv_auth`, `eventos_produto`, `eventos_venda`, `eventos_caixa`, `eventos_cliente`, `eventos_fornecedor`, `eventos_vendedor`, `eventos_colecao`, `eventos_campanha`, `eventos_adquirente`, `movimentacoes_estoque`, `refresh_tokens`, `vendedor_refresh_tokens`

2. **Contagem de documentos** por collection — igual à origem (ou explicavelmente diferente, se houve escrita em produção entre o dump e a checagem).
3. **Índices críticos** presentes no restaurado: `vendas.idempotencyKey` (único, parcial), `caixas.status` (único, parcial), `*.telefoneNormalizado` (único, parcial — fornecedores/clientes/vendedores), `adquirentes.nomeNormalizado` (único, parcial).
4. **Documentos críticos** — pelo menos um documento de referência de cada collection crítica presente no restaurado.
5. **Backend conecta** — apontar um `.env` local (NUNCA versionado) para o banco restaurado e confirmar `GET /health` → `database.status: "up"`.
6. **Leituras básicas funcionam** — login administrativo e pelo menos uma consulta de leitura em produtos/clientes/vendas/caixas retornando sem erro.

**PASSOU**: todos os itens acima conferem. **FALHOU**: qualquer collection/índice/documento crítico ausente, ou o backend não conseguir operar contra o banco restaurado.

Ao terminar, sempre derrubar o banco de teste (`mongosh --eval "db.getSiblingDB('<nome>').dropDatabase()"` ou equivalente) — nunca deixar cópias de dados de produção acumulando no ambiente local.

## Retenção

- 30 backups diários.
- Nunca menos de 2 cópias válidas simultâneas, mesmo que isso signifique manter um backup além dos 30 dias. A contagem desconta as remoções já feitas na mesma rotina, e, se o mínimo barrar uma remoção, ficam as cópias mais recentes.
- Só arquivos `mariela_prod_*.archive.gz` são considerados; qualquer outro arquivo no diretório é ignorado e nunca removido.

## Restore periódico (não apenas o de validação inicial)

Depois do primeiro restore de teste (obrigatório antes de considerar este procedimento operacional), repetir o mesmo checklist **trimestralmente** — um backup nunca testado não é um backup confiável.

## RPO/RTO (metas iniciais, estágio atual do projeto)

- **RPO**: até 24h (consequência da frequência diária).
- **RTO**: poucas horas (procedimento manual, sem automação de failover).

Ambos são metas iniciais para o estágio de desenvolvimento atual, não SLAs formais — revisar quando o volume de vendas/operação justificar.
