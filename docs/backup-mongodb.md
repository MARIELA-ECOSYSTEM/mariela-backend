# Backup e restore do MongoDB — procedimento operacional

Política aprovada nas Fases 60.4.3.4.21.1/21.1.2; implementação e validação **locais** na Fase 60.4.3.4.21.2.
Fonte de verdade dos parâmetros: [`ops/backup/lib/politica.ts`](../ops/backup/lib/politica.ts).

## Estado atual (09/11/2026) — leia primeiro

| Item | Situação |
| --- | --- |
| Scripts de backup, cifra, restore e instância isolada | **Implementados e validados localmente**, só com dados SINTÉTICOS (ver "Testes"; Windows PowerShell 5.1 e PowerShell 7) |
| Posse exclusiva do destino de restore (R21-2.3-01) | **Corrigida na Fase 21.2.4** — trava local + posse atômica + limpeza sem `dropDatabase` |
| Integridade final, posse persistente, autenticação e processos (A-01…A-10, auditoria 21.2.5) | **Implementados na Fase 21.2.6** — `PASSOU` = VERIFICADO com prova byte a byte; liberação/remoção só pelo operador; instância com `--auth`; Job Object (ver "Restore de teste") |
| Auditoria 21.2.7 (A21-7-01…08: congelamento completo, âncora externa, índices/opções completos, REMOVENDO, EM_USO/descarte, identidade da instância) | **Implementado na Fase 21.2.8 — validado SÓ sem MongoDB** (unitários e scripts); validação integrada com MongoDB descartável **pendente** |
| MongoDB 8.0.37 isolado (`127.0.0.1:27118`) | **Instalado e validado** (ver "Instância isolada") |
| Backup real de produção (`marielaDB`) | **NÃO executado** — exige autorização da Fase 21.3 |
| Restore de backup real | **NÃO executado** — Fase 21.4 |
| Segunda cópia no Google Drive | **NÃO implementada** (transporte bloqueado) — nenhum arquivo enviado |
| Agendamento (Task Scheduler) | **NÃO criado** — só o procedimento está documentado |
| Atlas (usuário `read@marielaDB`, IP Access List, tier) | **Nada alterado** — pendências do operador |
| Único archive existente | `mariela_prod_20260921_1357.archive.gz` (21/09/2026, 311 bytes, banco vazio) — **legado, sem dados, nunca removido automaticamente** |
| RPO ≤ 24 h / RTO ≤ 4 h | **Metas, não comprovadas** |

## Política (resumo)

- **Banco:** só `marielaDB`. Qualquer outro (inclusive `test`) aborta antes do dump (`BANCO_DIVERGENTE`).
- **Coleções:** o banco tem **29**; o backup leva **27** (lista positiva em `politica.ts`). Excluídas: `refresh_tokens` e
  `vendedor_refresh_tokens` — o backend recria as coleções e os índices (inclusive TTL) no boot; **todos fazem login de
  novo** após um restore.
- **Lista positiva aplicada:** o `mongodump` 100.17.0 **não tem `--nsInclude`**. Por isso o backup (1) recusa a origem
  (BLOQUEADO) se ela tiver coleção fora de 27+2 ou se faltar alguma das 27, (2) passa `--excludeCollection` só para as 2
  excluídas e (3) confere no archive que os namespaces são **exatamente** os 27 de `marielaDB`. Um teste unitário
  (`politica.spec.ts`) quebra se o código ganhar uma coleção nova sem revisão da política.
- **Índices:** 103 nas 27 coleções em 09/11/2026 (referência informativa). A validação usa os índices **reais** lidos
  da origem no momento do backup; o archive precisa trazê-los idênticos.
- **Janela:** horário-alvo **23:45**; **15 min** sem escrita; retomada quando o computador for ligado.
- **Retenção (local):** 14 diários · 8 semanais · 12 mensais · 5 extraordinários · inválidos por 7 dias · nunca menos de
  2 válidos · nunca o válido mais novo · só depois de um backup novo VÁLIDO.
- **Cifra:** 7-Zip, AES-256, cabeçalho cifrado. **Segunda cópia:** Google Drive (estados verificados).
- **Mídia** (imagens/vídeos) fica no **Cloudflare R2**, **fora** do `mongodump`: o backup preserva só as referências
  (`uploads_midia`, URLs). Proteção do R2 = fase própria.

## Componentes

| Arquivo | Papel |
| --- | --- |
| `ops/backup/backup-mongo.ps1` | Backup (diário ou `-Extraordinario`) |
| `ops/backup/restore-test.ps1` | Restore de TESTE isolado (só `127.0.0.1:27118`) |
| `ops/backup/gerir-restore.ps1` | Decisões do operador: Inspecionar / Verificar / Liberar / IniciarUso / Remover / Descartar (Fases 21.2.6 e 21.2.8) |
| `ops/backup/recuperar-destino.ps1` | Recuperação MANUAL de destino deixado por restore interrompido (inspeção; remoção só com provas) |
| `ops/backup/lib/trava.ts`, `lib/posse.ts` | Trava local (PID + horário de criação), posse persistente com máquina de estados, verificação e limpeza comprovada |
| `ops/backup/lib/integridade.ts` | Comparação canônica (bytes BSON) archive × destino (Fase 21.2.6) |
| `ops/backup/lib/ancora.ts` | Âncora EXTERNA ao banco: registro local de evidências encadeado por hash (Fase 21.2.8) |
| `ops/backup/cifrar-backup.ps1` | Cifrar / Verificar / Decifrar com 7-Zip |
| `ops/backup/mongod-isolado.ps1` | ConfigurarAutenticacao / Iniciar / Parar / Estado da instância 8.0.37 isolada |
| `ops/backup/comum.ps1` | Funções compartilhadas (processo sem segredo em argumento, ACL, log, credenciais DPAPI, Job Object) |
| `ops/backup/lib/*.ts` | Lógica (Bun): leitura do archive, janela, manifesto, retenção, segunda cópia, CLI |
| `ops/backup/lib/*.spec.ts` | Testes unitários (rodam no `bun test`/CI, sem dependências externas) |
| `ops/backup/testes/` | Testes de integração locais (origem sintética + restore isolado) |

Todos os `.ps1` são **UTF-8 com BOM** (sem BOM o Windows PowerShell 5.1 lê acentos/travessões como Windows-1252 e
quebra o parser). Ao editar, valide nos dois: `[System.Management.Automation.Language.Parser]::ParseFile(...)`.
A CLI é sempre chamada com `bun --no-env-file` (nunca carrega o `.env` do repositório).

## Instância isolada (MongoDB 8.0.37)

Instalada na Fase 21.2 (autorizada):

| Item | Valor |
| --- | --- |
| Origem | `https://fastdl.mongodb.org/windows/mongodb-windows-x86_64-8.0.37.zip` (ZIP oficial, sem MSI, **sem serviço do Windows**) |
| SHA-256 do zip | `EB4D358EC2D67EF707D0864CC7DCD8C3720A1F1F947E01C156A24BAF494E21C8` (= `.sha256` oficial do mesmo servidor) |
| `mongod.exe` | SHA-256 `60CFE52905D211BF5BF64373637CA116AF08A23A07DB5C10C614D00F148F1249`; **sem assinatura Authenticode** (normal no zip; a garantia é o SHA-256 oficial via HTTPS) |
| Versão | 8.0.37 — a mesma observada no Atlas (Fase 60.4.3.4.20) |
| Diretórios | `%USERPROFILE%\mariela-restore-isolado\` → `mongodb-8.0.37\bin`, `data-27118\` (com marcador `.mariela-restore-isolado`), `logs\`, `relatorios\`, `downloads\` |
| Rede | **só `127.0.0.1:27118`** (conferido por `getCmdLineOpts`) — nunca exponha em outra interface |
| Autenticação | **`--auth --keyFile`** desde a Fase 21.2.6; usuários `mariela_bootstrap` (root), `mariela_restore` (escrita/leitura, sem collMod/drop), `mariela_guardiao` (posse/congelamento/limpeza, sem escrita em dados — Fase 21.2.8), `mariela_leitor`; credenciais sintéticas DPAPI em `seguranca\`; identidade da instância em `mariela_isolada_meta.identidade` + `seguranca\instancia.json` |
| Replica set | 1 nó, `rs-restore` |

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ops\backup\mongod-isolado.ps1 -Acao ConfigurarAutenticacao   # 1ª vez (idempotente)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ops\backup\mongod-isolado.ps1 -Acao Iniciar   # idempotente
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ops\backup\mongod-isolado.ps1 -Acao Estado
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ops\backup\mongod-isolado.ps1 -Acao Parar
```

O script recusa: porta 27118 ocupada por outro processo (não escolhe outra porta), `dbPath` com dados sem o marcador,
qualquer outra porta. Um restore de produção deixará **dados pessoais reais** nesse disco: derrube o banco restaurado
ao fim de cada teste e mantenha o BitLocker do disco ativo.

## Backup

### Pré-condições (uma vez, pelo operador)

1. **Usuário de backup de privilégio mínimo** — pendência de infraestrutura: criar no Atlas um usuário dedicado só com
   `read` em `marielaDB` (a credencial atual tem `readAnyDatabase@admin` + `backup@admin`, ampla demais). IP de onde o
   backup roda na IP Access List. **Nada disso foi feito pelo Claude.**
2. **Arquivo de configuração do `mongodump`** (fora do repositório; a URI nunca vai para a linha de comando):
   ```yaml
   uri: "mongodb+srv://<usuario>:<senha>@<cluster>/marielaDB?retryWrites=true&w=majority"
   ```
   O banco **tem** de estar no caminho e ser `marielaDB`.
3. **ACL restrita** (conta Windows atual + SYSTEM, sem herança) no arquivo de configuração **e** na pasta de backup — o
   script se recusa a rodar (BLOQUEADO) sem isso. **Revise os comandos antes de executar** (eles removem a herança;
   um erro de digitação pode deixar a conta sem acesso). Forma recomendada — a mesma função usada e testada pelos
   scripts (remove a herança e concede à conta atual e a SYSTEM na MESMA chamada do `icacls`, com o nome da conta
obtido do Windows — sem expansão de variável de ambiente):
   ```powershell
   . "<repositório>\ops\backup\comum.ps1"
   Set-AclRestrita "C:\caminho\mongodump-config.yaml"
   Set-AclRestrita "M:\Backup-sistema-mariela"
   Test-AclRestrita "M:\Backup-sistema-mariela"      # Ok = True
   ```
   Equivalente com `icacls` — as variáveis PRECISAM de chaves (`${env:USERNAME}`): sem elas o PowerShell lê
   `$env:USERNAME:F` como OUTRA variável (vazia) e o comando concede acesso a `DOMINIO\` em vez da conta (defeito
   R21-2.1-02, corrigido aqui):
   ```powershell
   icacls "C:\caminho\mongodump-config.yaml" /inheritance:r /grant:r "${env:USERDOMAIN}\${env:USERNAME}:F" /grant:r "*S-1-5-18:F"
   icacls "M:\Backup-sistema-mariela" /inheritance:r /grant:r "${env:USERDOMAIN}\${env:USERNAME}:(OI)(CI)F" /grant:r "*S-1-5-18:(OI)(CI)F"
   icacls "M:\Backup-sistema-mariela"                 # conferir: só a conta e SYSTEM, sem "(I)" (herdado)
   ```
   **Recuperar o acesso** (se a conta ficou de fora): o dono do objeto sempre pode reescrever a ACL —
   `icacls "<caminho>" /grant:r "${env:USERDOMAIN}\${env:USERNAME}:F"` (pasta: `:(OI)(CI)F`); se a conta não for a
   dona, um administrador assume a posse com `takeown /F "<caminho>"` e concede de novo.
   A pasta `M:\Backup-sistema-mariela` hoje **herda** "Usuários autenticados: Modificar" e "Usuários: Leitura" — precisa
   ser restringida antes do primeiro backup real. **BitLocker** em `M:` precisa ser confirmado (exige administrador).

### Execução

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ops\backup\backup-mongo.ps1 -BackupDir "M:\Backup-sistema-mariela" -ConfigMongo "C:\caminho\mongodump-config.yaml"
# antes de manutenção:
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ops\backup\backup-mongo.ps1 -BackupDir "..." -ConfigMongo "..." -Extraordinario
```

Fluxo (falha FECHADA em cada etapa): ACL e trava → **pré-backup só de leitura** (banco, coleções, devido, janela,
assinaturas, índices, referências, sequências) → `mongodump --config --db=marielaDB --readPreference=primary --gzip
--archive=<tmp> --excludeCollection=…` → **pós-backup** (assinaturas de novo, leitura estrutural do archive, 27
namespaces, contagens = origem, índices = origem, versão, SHA-256, manifesto) → nome definitivo **sem sobrescrever**,
na ordem archive → `.sha256` → **manifesto por último** (o manifesto é o "commit": sem ele a cópia nunca é válida) →
retenção. A saída do `mongodump` **não** é registrada (mensagens de conexão podem conter host).

Falhas (Fase 21.2.2, R21-2.1-05): toda execução registra a **etapa** em que terminou. Uma exceção inesperada vira
`FALHA` com a etapa e a mensagem **sanitizada** (sem URI, host, IP; truncada) — nunca sucesso. Se o próprio log não
puder ser gravado, a mensagem vai para o stderr e o código de saída nunca é 0. Temporário não promovido é apagado.

| Resultado | Código | Significado |
| --- | --- | --- |
| `VALIDO_LOCAL` | 0 | `mariela_prod_…` / `mariela_extra_…` + `.archive.gz.sha256` + `.manifest.json`; retenção executada |
| `ADIADO` | 0 | janela não satisfeita — nada coletado (a tarefa tenta de novo depois) |
| `JA_REALIZADO` | 0 | já existe diário válido depois do último 23:45 |
| `INVALIDO` | 1 | archive/manifesto com prefixo `mariela_invalido_` (evidência, 7 dias); **sem retenção** |
| `BLOQUEADO` | 1 | ACL aberta ou coleções da origem fora da política — revisar antes de qualquer backup |
| `FALHA` | 1 | pré-condição (configuração, ferramenta, trava, conexão, colisão) |

Log: `<BackupDir>\logs\backup_yyyyMM.jsonl` (uma linha JSON por execução: resultado, motivo, verificações, arquivo,
SHA-256, tamanho, retenção). Retenção: `<BackupDir>\logs\retencao_<carimbo>.json`. Nunca URI, senha ou documento.

### Manifesto (`<base>.manifest.json`)

Execução (`execucaoId`, tipo, início/fim com fuso, `dataLocal`), versões (mongodump, servidor), banco, política (27 +
2), verificações da janela, **assinaturas antes e depois** (por coleção, conforme a estratégia — ver "Assinatura por
coleção"), índices normalizados por coleção,
referências (número de ids órfãos por regra), sequências (`valor` × maior código emitido), dados do archive (SHA-256,
tamanho, documentos por coleção), validações e avisos. **Limite declarado no próprio manifesto:** a consistência é
OPERACIONAL — o `mongodump` de um banco lê uma coleção por vez (não é snapshot transacional); a coerência depende da
janela sem escrita e das assinaturas iguais antes/depois. Não há prova matemática de ausência de escrita (ex.: uma
escrita feita e desfeita durante o dump não seria detectada).

Limite técnico: a leitura estrutural descompacta o archive em memória até **1 GiB** (acima disso, falha fechada).

### Assinatura por coleção (Fase 21.2.2, R21-2.1-01)

A estratégia de cada uma das 27 coleções é **declarada** em `ASSINATURA_POR_COLECAO` (`politica.ts`), conferida contra
os schemas por teste unitário — nunca deduzida só pela presença de um timestamp:

| Estratégia | Coleções | Assinatura |
| --- | --- | --- |
| `timestamp` | adquirentes, caixas, campanhas, clientes, colecoes, configuracoes, fornecedores, produtos, usuarios, vendas, vendedores (schema com `atualizadoEm`) | contagem + maior `atualizadoEm`/`criadoEm` |
| `insercao` | os 12 `eventos_*`, movimentacoes_estoque, movimentos_caixa (só `criadoEm`, sem atualização no código) | contagem + maior `criadoEm` |
| `conteudo` | **uploads_midia** (reservar/descartar/limpar alteram `estado`/`tokenReserva` sem tocar em data), sequencias (sem data) | contagem + maior data disponível + **SHA-256 do conteúdo inteiro** |

O hash é determinístico (ordem por `_id`, EJSON canônico), calculado **em fluxo** (memória constante) e limitado a
**5.000 documentos** por coleção: acima disso, ou se a contagem mudar durante a leitura, a assinatura é **não
confiável** e o backup FALHA (nunca "estável" presumido). Custo: uma leitura completa de cada coleção `conteudo` por
assinatura (duas por backup). Quando `uploads_midia` se aproximar do limite, a política precisa ser revista.
**Limite da janela:** atualizações SEM data (ex.: descartar um upload pendente) não podem ser datadas — a verificação
`janela.sem_escrita` declara isso no detalhe; elas são detectadas pela comparação **antes/depois** do dump (hash), que
invalida o backup se houver mudança durante a coleta. Escritores que gravam direto no driver sem atualizar
`atualizadoEm` numa coleção `timestamp` continuam fora do alcance da assinatura (nenhum conhecido no código).

## Janela sem escrita e retomada

- **Devido:** a partir do último 23:45. Já existe diário VÁLIDO depois dele → `JA_REALIZADO`.
- **Computador ligado depois das 23:45** (ou execução perdida): continua devido, mas **só coleta se a janela passar** —
  nunca "imediatamente".
- **Verificações (todas leituras; qualquer falha → ADIADO; erro de leitura ou assinatura não confiável → FALHA):**
  caixas abertos = 0; maior data **registrada** das 27 coleções ≥ 15 min atrás (data no futuro também adia; atualizações
  sem data — estratégia `conteudo` — são cobertas pela comparação antes/depois, ver "Assinatura por coleção"); nenhuma linha de reconciliação `pendente`/
  `falha_recuperavel` com retry vencido ou em até 60 min (o worker poderia escrever durante o dump); vendas
  `em_pagamento` e linhas `requer_intervencao` são registradas.
- **O backup não desliga o worker, não para a API e não bloqueia nada.** Scripts administrativos (`seed-admin`,
  `desativar-admin`, `reset-admin-password`, `limpar-uploads-abandonados`, `processar-remocoes-pendentes`,
  `migrar-midias-legadas`) e integrações não podem rodar na janela — responsabilidade do operador (o backup só detecta
  as escritas que eles deixarem).

## Retenção

Implementada em `lib/retencao.ts` (vagas por período, sem dupla contagem): a cópia válida mais recente de cada um dos
**14 dias**, **8 semanas ISO** e **12 meses** mais recentes que têm cópia (uma mesma cópia pode ocupar as três vagas,
existindo uma vez só) + **5 extraordinários** mais recentes + inválidos com menos de **7 dias** + o válido mais novo;
piso de **2** válidos. Classe vem do **manifesto**; nome e manifesto divergentes → `conflito` (preservado). Arquivos
fora do padrão, pastas e o **legado** de 21/09 nunca são tocados. Só apaga artefatos conhecidos da base
(`.archive.gz`, `.sha256`, `.manifest.json`, `.7z`, `.7z.sha256`, `.segunda-copia.json`). A retenção **não considera** o
estado da nuvem (upload não verificado nunca libera nem apaga cópia local).

## Cifra (7-Zip AES-256)

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ops\backup\cifrar-backup.ps1 -Acao Cifrar   -Arquivo "<base>.archive.gz"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ops\backup\cifrar-backup.ps1 -Acao Verificar -Arquivo "<base>.7z"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ops\backup\cifrar-backup.ps1 -Acao Decifrar  -Arquivo "<base>.7z" -Destino "<pasta nova>"
```

- 7-Zip **26.03** (`C:\Program Files\7-Zip`, instalação existente). Pacote `<base>.7z` = archive + `.sha256` + manifesto,
  `-mhe=on` (sem a senha nem os nomes são visíveis), `-mx=0` (o archive já é gzip).
- **A senha nunca é argumento de processo:** vai pelo stdin do 7-Zip, em bytes exatos (UTF-8 sem BOM). Conferido no 26.03:
  na criação, `-p` sem valor pede a senha; no teste/extração, **sem** `-p`, ele pede a senha (com `-p` vazio ele usaria
  senha vazia).
- **Defeito encontrado e corrigido nos testes:** no Windows PowerShell 5.1 com console em UTF-8, o `Process` do .NET
  Framework gravava o preâmbulo UTF-8 (BOM) no stdin; o pacote só abria no mesmo ambiente. Hoje a codificação de
  entrada é forçada sem BOM; o teste T15 prova que o pacote cifrado no 5.1 abre no PowerShell 7 e no 7-Zip direto.
- Senha: **mínimo 12 caracteres, só ASCII imprimível** (bytes idênticos em qualquer máquina/página de código).
- Cifrar: exige manifesto `VALIDO_LOCAL` e SHA-256 do archive igual ao manifesto; grava `<base>.7z.sha256`; testa o pacote
  com a senha; **decifra numa pasta temporária e confere o SHA-256 do archive recuperado**; registra a segunda cópia em
  `CIFRADO`. Códigos: 0 ok; 1 uso/integridade; **2 senha incorreta ou pacote corrompido**.
- **Chave:** gerenciada **pelo operador** (gerenciador de senhas + cópia offline). Nunca em arquivo, script, log,
  repositório ou na mesma conta de nuvem. Sem a chave as cópias da nuvem são inúteis: testar a decifragem a cada
  trimestre.
- **Execução não interativa (agendada): BLOQUEADA.** Sem `-Senha`, o script pede a senha com `Read-Host` — numa sessão
  não interativa isso falha (falha fechada). Não há mecanismo de chave aprovado para automação (ex.: DPAPI da conta
  Windows) — decisão pendente do operador. Até lá, a cifra é um passo manual.

## Segunda cópia (Google Drive)

Estados (`<base>.segunda-copia.json`, só avançam com evidência — `lib/segunda-copia.ts`):
`VALIDO_LOCAL` → `CIFRADO` (pacote + SHA-256) → `ENVIADO` (id remoto + existência + **tamanho remoto igual**) →
`VERIFICADO_NUVEM` (**download de verificação** com SHA-256 igual ao do pacote local). Resposta de upload não é prova.
Falha em qualquer passo mantém o último estado comprovado. Na recuperação: SHA-256 do pacote → decifrar → SHA-256 do
archive (= manifesto).

**Transporte Google Drive NÃO implementado** (a fábrica recusa com `BLOQUEADO`): falta decidir o mecanismo (API com
OAuth, ou cliente de sincronização — que exigiria verificação por download real, não pela cópia local em cache) e
autorizar a credencial. O Google Drive for desktop está instalado nesta máquina, mas **não foi usado**. Nenhum arquivo
foi enviado. A máquina de estados está coberta por testes com transportes falsos (inexistente, tamanho errado,
download corrompido, erro de upload).

## Restore de teste (isolado)

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ops\backup\mongod-isolado.ps1 -Acao Iniciar
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ops\backup\restore-test.ps1 -ArquivoBackup "<base>.archive.gz"
# decisões do operador, cada uma por comando separado (execucaoId = o do relatório do restore).
# Fora de Inspecionar, -ArquivoBackup e -Manifesto são OBRIGATÓRIOS: os do backup escolhido pelo operador.
$a = @("-ArquivoBackup", "<base>.archive.gz", "-Manifesto", "<base>.manifest.json")
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ops\backup\gerir-restore.ps1 -Acao Inspecionar -BancoDestino <destino>
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ops\backup\gerir-restore.ps1 -Acao Verificar  -BancoDestino <destino> -ExecucaoId <id> @a
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ops\backup\gerir-restore.ps1 -Acao Liberar    -BancoDestino <destino> -ExecucaoId <id> @a
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ops\backup\gerir-restore.ps1 -Acao IniciarUso -BancoDestino <destino> -ExecucaoId <id> @a -ConfirmarBanco <destino>
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ops\backup\gerir-restore.ps1 -Acao Remover    -BancoDestino <destino> -ExecucaoId <id> @a
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ops\backup\gerir-restore.ps1 -Acao Descartar  -BancoDestino <destino> -ExecucaoId <id> @a -ConfirmarBanco <destino>
```

> **Fase 21.2.8:** a implementação abaixo foi validada com testes unitários e de scripts **sem** MongoDB. O
> comportamento do servidor (o que `listCollections` devolve para o trio de validação, os privilégios efetivos dos papéis
> separados, `collectionUUID`, a âncora sob queda real) **ainda precisa** da validação integrada com MongoDB descartável
> (lista em "Testes pendentes"). Até lá, nada aqui libera restore real.

Fluxo do `restore-test.ps1` (Fases 21.2.2, 21.2.4, 21.2.6 e 21.2.8):

- **T. Trava local**, antes de qualquer conexão: `<Raiz>\locks\restore.lock` aberta com compartilhamento só-leitura e
  mantida até o fim; `execucaoId` (GUID) próprio. Ocupada ⇒ recusa imediata. "Ocupada" = violação de
  compartilhamento (`EBUSY`); erro de permissão **não** conta como trava segura.
- **J. Controle de processos:** o PowerShell entra num **Job Object** kill-on-close; todo processo criado depois
  (bun/CLI, mongorestore) morre com ele. Sem o job, nada prossegue. (O `backup-mongo.ps1` também usa o job desde a 21.2.8.)
- **0. Identidade:** processo da porta = `mongod.exe` da raiz, só `127.0.0.1`; já conectado: `dbPath`, marcador, bind,
  replica set **e `instanciaId`** (documento na instância = cópia local `seguranca\instancia.json`).
- **1. Antes de qualquer escrita:** SHA-256 = manifesto = `.sha256`; manifesto `VALIDO_LOCAL`; 27 namespaces e
  contagens; mesma série de versão; banco `mariela_restore_yyyyMMdd_HHmmss` **inexistente** (nunca `marielaDB`).
- **2. PREPARANDO:** âncora externa criada (`<Raiz>\evidencias\<destino>__<execucaoId>.jsonl`) e então a posse atômica
  (`_id:"posse"`) com `execucaoId`, **nome do banco**, **`instanciaId`**, processo, SHA-256 e caminhos de archive e manifesto.
- **3. RESTAURANDO:** `mongorestore` com o usuário **restore** (sem `--drop`, sem bypass), senha só pelo stdin.
- **4. VALIDANDO:** o **guardião** congela as 27 coleções (validador + `strict` + `error`) e só então declara VALIDANDO;
  verificação integral (abaixo).
- **5. VERIFICADO:** evidências gravadas na posse **e** na âncora externa; segunda verificação com o destino já
  VERIFICADO tem de dar as mesmas evidências (senão `INTERVENCAO_NECESSARIA`).

### Definição de PASSOU

`PASSOU` ⇔ todas, conferidas no fim da execução e registradas em `condicoesPassou`:

1. o restore terminou (código 0, 0 documentos com falha, sem `Cross-version`);
2. comparação integral archive × destino aprovada (conteúdo byte a byte, índices completos, opções de coleção);
3. nenhum documento, coleção (inclusive `system.*`) ou índice alheio;
4. proteção **completa** ativa: as 27 coleções com validador de congelamento **e** `validationLevel: "strict"` **e**
   `validationAction: "error"` (A21-7-01 — sem os três, a coleção não está protegida);
5. posse persistida como **VERIFICADO**, desta execução, deste banco e desta instância;
6. archive e manifesto vinculados por SHA-256 **e âncora externa conferida** (registro local íntegro e coerente);
7. nenhum processo filho ativo no Job Object;
8. trava e identidade da execução ainda válidas (PID + horário de criação).

`PASSOU` vale **no instante das verificações**. Não é liberação.

### O que cada estado garante

| Estado | Igual ao archive | Protegido contra escrita | Utilizável | Observação |
| --- | --- | --- | --- | --- |
| `VERIFICADO` | **sim** (na última verificação) | **sim** (congelamento completo) | não | integridade comprovada; aguarda o operador |
| `LIBERACAO_AUTORIZADA` | **sim** (reverificado ao liberar) | **sim** — **não descongela** | não | o operador autorizou o uso, mas o destino continua congelado |
| `EM_USO` | **não** | **não** | sim | descongelado por `IniciarUso`; a igualdade com o archive **deixa de valer** a partir daqui |
| `REMOVENDO` | não | parcial | não | remoção em curso (ou interrompida); recuperável |
| `CANCELADO_COM_LIMPEZA_COMPROVADA` / `DESCARTADO` | — | — | — | finais; o banco removido (ou só a coleção de controle órfã, que a recuperação conclui) |
| `INTERVENCAO_NECESSARIA` | não | não garantido | não | algo não pôde ser provado; nada mais é removido automaticamente |

Os comandos de reverificação (`Verificar`, `Liberar`, `IniciarUso`, `Remover`) refazem **toda** a comparação; qualquer
divergência num destino que se dizia íntegro o leva a `INTERVENCAO_NECESSARIA`.

### Máquina de estados do destino

| De | Para | Quem | Pré-condição / efeito |
| --- | --- | --- | --- |
| — | PREPARANDO | restore-test (guardião) | âncora criada; posse atômica; banco só com a coleção de controle |
| PREPARANDO | RESTAURANDO | restore-test (guardião) | trava + posse + âncora; então o mongorestore (restore) |
| RESTAURANDO | VALIDANDO | restore-test (guardião) | **depois** de congelar (completo) as 27 coleções |
| VALIDANDO | VERIFICADO | restore-test (guardião) | verificação integral aprovada; evidências na posse e na âncora; 2ª verificação igual |
| PREPARANDO/RESTAURANDO/VALIDANDO | FALHOU_DESTINO_PARCIAL | restore-test | falha depois de adquirir a posse |
| VERIFICADO | LIBERACAO_AUTORIZADA | operador (`Liberar`) | reverificação integral = evidências + âncora; **não descongela** |
| LIBERACAO_AUTORIZADA | EM_USO | operador (`IniciarUso -ConfirmarBanco`) | reverifica; registra data/operador/UUIDs; **transição primeiro, depois descongela** |
| FALHOU/VERIFICADO/LIBERACAO/interrompidos | REMOVENDO | restore-test / operador (`Remover`) / recuperação | conteúdo ⊆ archive provado; **antes do primeiro drop** |
| EM_USO | REMOVENDO | operador (`Descartar -ConfirmarBanco`) | só coleções da política com o MESMO UUID do início do uso |
| REMOVENDO | CANCELADO_COM_LIMPEZA_COMPROVADA / DESCARTADO | quem iniciou a remoção (ou a recuperação) | todas as coleções do alvo removidas; depois a coleção de controle |
| qualquer não final | INTERVENCAO_NECESSARIA | qualquer etapa | segurança de seguir/remover não provada |
| INTERVENCAO_NECESSARIA | REMOVENDO | recuperação | dono encerrado + provas completas |

Transições por compare-and-set (`updateOne` filtrando `execucaoId`, banco, `instanciaId` **e** estado atual) com
**intenção** gravada na âncora antes e **confirmação** depois. Atalhos (RESTAURANDO → VERIFICADO, VERIFICADO → EM_USO,
qualquer → estado final sem REMOVENDO, EM_USO → VERIFICADO) são recusados (`TRANSICOES_DESTINO`, `politica.ts`).

### Integridade BSON, índices e opções

- **Documentos:** bytes BSON (archive × `find` com `raw: true`), lidos **em fluxo** (só chaves e hashes ficam na
  memória; o archive é lido inteiro, limitado a 1 GiB descompactado). Chave = bytes do elemento `_id` (tipo + valor).
- **Índices (A21-7-03):** especificação **completa** vinda do **archive** — `key` (ordem preservada), `unique`,
  `partialFilterExpression`, `sparse`, TTL, **collation**, **hidden**, opções textuais (`weights`, `default_language`,
  `language_override`, `textIndexVersion`), geoespaciais (`2dsphereIndexVersion`, `bits`, `min`, `max`…), wildcard etc.
  Ignorados só os sem efeito semântico: `v` (versão interna), `ns` (redundante) e `background` (ignorado pelo servidor
  desde o 4.2). Números de direção comparados por valor (1 = 1.0 = Int32(1)).
- **Opções de coleção (A21-7-03):** comparadas com as do archive (collation padrão, etc.), exceto o trio de validação,
  conferido à parte pelo congelamento. Archive que traga validador próprio é **recusado** (a política não tem validadores
  e o congelamento sobrescreveria o original).
- O manifesto continua com o formato **legado** de índices (compatibilidade com backups existentes); a referência
  completa vem do archive, cujo SHA-256 está no manifesto.

### Autenticação e papéis (A-03, A21-7-01)

`--auth --keyFile`; credenciais **sintéticas** com DPAPI em `<Raiz>\seguranca\*.cred` (ACL restrita), só pelo stdin.
**DPAPI não impede que outro processo da mesma conta Windows use as credenciais.**

| Usuário | Papel | Pode | Não pode |
| --- | --- | --- | --- |
| sem autenticação | — | nada | tudo |
| `mariela_leitor` | `readAnyDatabase` | ler | qualquer escrita, `collMod`, `drop`, rename, bypass, posse |
| `mariela_restore` | `marielaRestore` | insert, createCollection, createIndex, find, listagens | **collMod**, **dropCollection** (logo, rename), update, remove, bypass, `dropDatabase`, escrita na posse |
| `mariela_guardiao` | `marielaGuardiao` | find, listagens, **collMod**, **dropCollection** (sempre com `collectionUUID`), create/insert/update/remove **só** na coleção de controle | insert/update/remove/createIndex em dados, bypass, `dropDatabase` |
| `mariela_bootstrap` | `root` | tudo | — (só `mongod-isolado.ps1`: configurar, identidade, desligar) |

Nenhum usuário do fluxo consegue, **sozinho**, descongelar **e** escrever dados. O restore ainda consegue criar
coleções/índices e inserir em coleção não congelada; o guardião consegue descongelar (`collMod`). Essas ações não são
impedidas — são **detectadas** pela reverificação completa (proteção com os três campos, coleções, índices, opções,
conteúdo). Quem tem a conta Windows tem todas as credenciais: contra esse adversário a defesa é detecção, não prevenção.

### Âncora externa (A21-7-02)

- `<Raiz>\evidencias\<destino>__<execucaoId>.jsonl` (pasta com ACL restrita), criado com `wx` antes da posse, só com
  acréscimos; cada linha tem `seq` e o SHA-256 da linha anterior (cadeia). Eventos: POSSE (banco, execução, instância,
  caminhos e SHA-256 de archive e manifesto), INTENÇÃO/CONFIRMAÇÃO de cada transição, EVIDÊNCIAS do VERIFICADO.
- Toda operação que muda estado ou remove confere: arquivos **informados pelo operador** (nunca os caminhos da posse) ⇒
  SHA-256 do archive = `.sha256` do diretório de backup = `archive.sha256` do manifesto = registro = posse; SHA-256 do
  manifesto = registro = posse; caminhos da posse = registrados; banco, execução e instância iguais; cadeia íntegra;
  estado da posse admitido pelo registro (o confirmado, ou `de`/`para` de uma intenção pendente); evidências da posse =
  registradas. Qualquer divergência ⇒ recusa.
- **Limite:** tamper-*evident*, não tamper-*proof*. Não há chave secreta (exigiria aprovação do operador). Um processo da
  **mesma conta** que reescreva de forma coerente o registro inteiro, a posse e os arquivos do backup não é detectado.

### Limpeza, remoção e descarte (A-02, A21-7-04/05/07)

Nunca `dropDatabase`. Uma função para tudo (`limpar-destino --modo falha|recuperacao|remocao|descarte`):

1. trava desta operação; identidade; âncora externa; posse desta execução/banco/instância em estado do modo;
2. nenhuma coleção fora das 27 + controle (**inclusive `system.*`**) — senão `INTERVENCAO_NECESSARIA`;
3. congela (as não congeladas); prova: conteúdo ⊆ archive, índices ⊆ archive, opções iguais (falha/recuperação/
   remoção) — ou, no **descarte**, UUID = o registrado no início do uso;
4. **CAS para REMOVENDO** antes do primeiro drop (nunca VERIFICADO/LIBERACAO com o destino parcial);
5. antes de **cada** coleção: trava, posse em REMOVENDO, coleção congelada **por completo** e com o mesmo UUID; `drop`
   com `collectionUUID`;
6. todas removidas ⇒ estado final ⇒ remoção da coleção de controle (por UUID); `removidas`/`bancoRemovido` só
   refletem o que de fato aconteceu;
7. qualquer divergência ⇒ nada (mais) é removido, `INTERVENCAO_NECESSARIA` com a lista do que já saiu. O congelamento
   aplicado **pela própria limpeza** é desfeito em `finally`; proteção prévia nunca é removida.

**Descarte de destino usado (EM_USO):** a igualdade com o archive deixou de valer no uso — não é exigida. Removem-se só
as coleções da política com o **mesmo UUID** registrado em `IniciarUso`; coleção criada/recriada durante o uso ou fora
da política ⇒ nada é removido (`INTERVENCAO_NECESSARIA`). Os **documentos** dentro dessas coleções são do uso autorizado
pelo operador e saem com elas — o descarte exige `-ConfirmarBanco`.

### Execução interrompida e recuperação

`recuperar-destino.ps1` (sem `-Remover`: só inspeção). Com `-Remover` exige `-ArquivoBackup` e `-Manifesto` do
operador e: trava; Job Object; identidade; credencial do guardião; exatamente um documento de posse em estado
interrompível (PREPARANDO, RESTAURANDO, VALIDANDO, FALHOU_DESTINO_PARCIAL, INTERVENCAO_NECESSARIA, **REMOVENDO**) ou
final com **só** a coleção de controle órfã (que é concluída); dono encerrado (PID + horário de criação); nenhum
processo citando o destino ou a execução; âncora externa; limpeza comprovada sem divergência. Destinos
`VERIFICADO`/`LIBERACAO_AUTORIZADA`/`EM_USO` são do `gerir-restore.ps1`.

### Limites (o que NÃO é garantido)

- **Distribuição:** a trava é local e a instância só escuta em `127.0.0.1`; duas máquinas e redirecionamento de porta
  (`netsh portproxy`, túnel, WSL/Docker) não são cobertos. Exposta, a instância invalida este modelo.
- **Conta Windows:** todas as credenciais, a âncora e os arquivos do backup são alcançáveis pela conta do operador e
  por administradores do host. Contra eles a proteção é detecção (âncora encadeada + reverificação), não prevenção.
- **Instante:** `PASSOU`/`VERIFICADO` valem no momento da verificação; uma escrita posterior (possível só com o bootstrap
  ou com `collMod` do guardião + escrita do restore) é detectada na próxima reverificação, não impedida.
- **Lease:** não há expiração de posse; a recuperação depende do dono comprovadamente encerrado.
- **Coleções `system.*`:** nenhum usuário do fluxo as cria nem as remove; se aparecerem (só o root), o destino é
  recusado (`INTERVENCAO_NECESSARIA`) — nunca se declara "banco removido" com elas presentes.
- **Archive:** lido inteiro na memória (limite 1 GiB descompactado).

O smoke test do backend sobre uma cópia restaurada (e a recriação das 2 coleções de token) é de fase posterior, com
autorização própria. **Recuperação real** (incidente): restaurar num banco/cluster NOVO, validar como acima, trocar a
`MONGODB_URI` do Render — runbook a escrever e ensaiar (Fase 21.5); nunca por cima do banco danificado.

## Agendamento (procedimento — NÃO criado)

Quando autorizado (Fase 21.6), no Task Scheduler, na conta Windows do operador:
- Gatilho diário às **23:45**; **"Executar a tarefa assim que possível após uma inicialização agendada ser perdida"**;
  repetir a cada 30 min por 8 h (o script sai em segundos com `ADIADO`/`JA_REALIZADO` quando não há o que fazer).
- Ação: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<repo>\ops\backup\backup-mongo.ps1" -BackupDir "M:\Backup-sistema-mariela" -ConfigMongo "<config>"`.
- A cifra/segunda cópia **não** entra na tarefa enquanto não houver mecanismo de chave aprovado.
- Monitoramento: o operador confere semanalmente o `backup_yyyyMM.jsonl` (último `VALIDO_LOCAL` com menos de 26 h).

## Testes

```powershell
bun test ops/backup/lib                                                    # 156 unitários (também no CI)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ops\backup\testes\testes-scripts.ps1              # 41 (sem MongoDB; rodar também no pwsh)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ops\backup\testes\executar-testes-integracao.ps1   # 21 casos
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ops\backup\testes\testes-posse.ps1                 # concorrência + integridade + autenticação + processos (rodar também no pwsh)
```

`testes-posse.ps1` (Fases 21.2.4 e 21.2.6) usa processos **independentes**, MongoDB real com autenticação e as
credenciais sintéticas (só stdin):
- **T01–T12** concorrência: restores simultâneos, 8 aquisições na mesma barreira, escrita alheia antes do mongorestore /
  durante / durante a validação (credencial de restore → 121; bootstrap com bypass → nunca PASSOU sem detecção) /
  depois do PASSOU, limpeza com ganchos (após congelar, após verificar, coleção recriada com outro UUID, `_id` esperado
  com outro conteúdo), queda + recuperação, execução antiga × nova, posse adulterada, trava/credencial ausentes, fluxo
  normal Liberar → Remover, e a conferência de que todo dado alheio continua no banco;
- **I00–I21** integridade: cada divergência (campo, tipo, Binary, Decimal128, Date, Timestamp, UUID, embutido, array,
  null/ausente, delete+insert, `_id` esperado com outro conteúdo, documento adicional, índice, sequência) dá
  `Verificar = DIVERGENTE` e a reversão exata volta a `INTEGRO`; Liberar com divergência → `INTERVENCAO_NECESSARIA`;
- **AU01–AU06** autenticação: sem auth, leitor, restore, bootstrap; senha nunca em relatório/log/linha de comando;
- **PR01–PR08** processos: fim normal, `Stop-Process -Force` só no PowerShell durante mongorestore / validação / limpeza,
  recuperação com processo vivo citando o destino, PID reutilizado, mesmo PID+horário com executável diferente.
Só cria/remove bancos `mariela_restore_20260103_*` (`testes/posse-auxiliar.ts` recusa outro nome).

A integração exige a origem SINTÉTICA `127.0.0.1:27119` (MongoDB 8.0.37 com `dbPath` descartável; dados criados por
`testes/origem-sintetica.ts`, que só aceita essa porta) e a instância isolada `27118`. Cobre: banco `marielaDB`/recusa
de `outroDB` e `test`, 27 namespaces, exclusão dos tokens, manifesto, SHA-256, archive vazio/truncado/não-gzip/de outro
banco, falha do mongodump, colisão e trava, retenção com 60 diários + 7 extras + inválidos + legado, cifra (senha
errada, não-ASCII, portabilidade 5.1↔7), segunda cópia parada em `CIFRADO`, janela (escrita recente, 14 × 16 min, caixa
aberto, reconciliação pendente, coleção não prevista), retomada, restore isolado completo, recusas de destino/porta/
versão (archive forjado 8.2.1), ACL aberta, PowerShell 7.

### Testes pendentes (validação integrada com MongoDB descartável — fase seguinte à 21.2.8)

A Fase 21.2.8 não iniciou MongoDB. Antes de qualquer decisão sobre restore real, executar com a instância descartável
(e nos dois PowerShell):

1. **Migração:** `ConfigurarAutenticacao` sobre a instância da 21.2.6 → papel `marielaRestore` reduzido, `marielaGuardiao`
   e `mariela_guardiao` criados, identidade da instância criada (documento + `instancia.json`), idempotência.
2. **Servidor × congelamento (A21-7-01):** confirmar que `listCollections` devolve `validationLevel`/`validationAction`
   depois do `collMod` de congelamento (senão TODO destino é recusado — falha fechada); `collMod` só com
   `validationAction: "warn"` e só com `validationLevel: "off"` → `Verificar` DIVERGENTE, `Liberar` → INTERVENCAO,
   limpeza com o gancho `warn`/`nivel-off` (posse-auxiliar) → a coleção desprotegida não é removida.
3. **Privilégios efetivos:** matriz AU com os papéis separados (restore sem collMod/drop/rename/posse; guardião sem
   insert/update/remove/createIndex em dados; ambos sem bypass/dropDatabase); confirmar que o mongorestore funciona só
   com `marielaRestore` e a CLI de transições só com `marielaGuardiao`.
4. **Âncora externa (A21-7-02):** adulterar na posse (com o bootstrap) SHA, caminhos, estado, banco, `instanciaId` e
   evidências → Liberar/Remover/IniciarUso recusam; editar uma linha do registro → recusa; apagar o registro → recusa;
   informar outro archive/manifesto → recusa; queda entre INTENÇÃO e CONFIRMAÇÃO (matar o processo) → retomada admitida.
5. **Índices e opções (A21-7-03):** com o bootstrap, tornar um índice `hidden`, recriá-lo com outra collation, mudar a
   collation padrão de uma coleção → `Verificar` DIVERGENTE; restore de archive com índices text/2dsphere/TTL/parcial →
   PASSOU (sem falso positivo de normalização).
6. **REMOVENDO (A21-7-04):** matar o `gerir-restore -Acao Remover` ENTRE dois drops (gancho) → estado REMOVENDO; nova
   remoção e `recuperar-destino -Remover` concluem; nunca VERIFICADO com destino parcial.
7. **EM_USO e descarte (A21-7-05):** Liberar (continua congelado) → IniciarUso (descongela, registra UUIDs) → escrita de
   uso → Descartar → DESCARTADO; descarte com coleção recriada durante o uso → INTERVENCAO, nada removido.
8. **Identidade (A21-7-06):** copiar a posse para outro banco → recusa; trocar `instancia.json` ou o documento de
   identidade → todas as operações recusam.
9. **Órfão (A21-7-07):** matar entre a transição final e o drop da coleção de controle → `recuperar-destino -Remover`
   conclui; `system.js` criado pelo root → destino recusado, nunca "banco removido".
10. **Regressão:** `executar-testes-integracao.ps1` (21) e `testes-posse.ps1` completos nos dois PowerShell.

## Operações que exigem autorização posterior (proibidas por padrão)

Backup real contra o Atlas · restore de archive real · upload para o Google Drive · criação de credencial/OAuth ·
agendamento contra produção · mudanças no Atlas (usuários, roles, IP Access List, tier) · mudanças no Render ·
homologação integrada. Nunca: restaurar no Atlas, em `marielaDB` ou em `test`; usar `--drop`; passar URI ou senha por
argumento; gravar senha em texto em arquivo (as credenciais sintéticas da instância isolada ficam só cifradas com DPAPI).

## Histórico

- Fases 29–35 (09/2026): primeiro `mongodump` real (`mariela_prod_20260921_1357.archive.gz`, SHA-256
  `A4BDFF21…5A9E`, servidor 8.0.32) com o banco **vazio**; restore da mecânica num 8.2.1 local (aviso de versão).
  A pasta `M:\Backup-sistema-mariela\marielaDB` é um artefato histórico (dump parcial), não é backup.
- Fase 60.4.3.4.21.2 (09/11/2026): política 21.1 implementada; MongoDB 8.0.37 isolado; validação local completa.
- Fase 60.4.3.4.21.2.4 (09/11/2026): R21-2.3-01 (TOCTOU na limpeza do restore) corrigido — trava local, posse atômica,
  limpeza segura sem `dropDatabase`, recuperação manual de execução interrompida; 16 testes de concorrência.
- Fase 60.4.3.4.21.2.6 (09/11/2026): achados A-01…A-10 da auditoria 21.2.5 — PASSOU = VERIFICADO com comparação byte a
  byte e 8 condições; posse persistente com máquina de estados; liberação/remoção só por comando do operador;
  `derrubar-restore` removido; instância com `--auth` e papel mínimo; `drop` com `collectionUUID`; Job Object
  kill-on-close; horário de criação do processo na trava e na recuperação.
- Fase 60.4.3.4.21.2.8 (10/11/2026): achados A21-7-01…08 da auditoria 21.2.7 — congelamento completo (validador +
  `strict` + `error`) numa única função; papéis separados (restore sem `collMod`/drop; guardião sem escrita em dados);
  âncora externa encadeada com archive/manifesto do operador; índices e opções de coleção completos vindos do archive;
  estados REMOVENDO, EM_USO e DESCARTADO; identidade da instância e banco na posse; conclusão da coleção de controle
  órfã; `system.*` como alheio; comparação em fluxo; Job Object no backup e sem limite de PIDs; trava só com `EBUSY`.
  **Validado sem MongoDB; validação integrada pendente.**
