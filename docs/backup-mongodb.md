# Backup e restore do MongoDB — procedimento operacional

Política aprovada nas Fases 60.4.3.4.21.1/21.1.2; implementação e validação **locais** na Fase 60.4.3.4.21.2.
Fonte de verdade dos parâmetros: [`ops/backup/lib/politica.ts`](../ops/backup/lib/politica.ts).

## Estado atual (09/11/2026) — leia primeiro

| Item | Situação |
| --- | --- |
| Scripts de backup, cifra, restore e instância isolada | **Implementados e validados localmente**, só com dados SINTÉTICOS (49 testes unitários + 21 casos de integração, Windows PowerShell 5.1 e PowerShell 7) |
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
| `ops/backup/cifrar-backup.ps1` | Cifrar / Verificar / Decifrar com 7-Zip |
| `ops/backup/mongod-isolado.ps1` | Iniciar / Parar / Estado da instância 8.0.37 isolada |
| `ops/backup/comum.ps1` | Funções compartilhadas (processo sem segredo em argumento, ACL, log) |
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
| Rede | **só `127.0.0.1:27118`** (conferido por `getCmdLineOpts`); sem autenticação — nunca exponha em outra interface |
| Replica set | 1 nó, `rs-restore` |

```powershell
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
   script se recusa a rodar (BLOQUEADO) sem isso:
   ```powershell
   icacls "C:\caminho\mongodump-config.yaml" /inheritance:r /grant:r "$env:USERDOMAIN\$env:USERNAME:F" /grant:r "*S-1-5-18:F"
   icacls "M:\Backup-sistema-mariela" /inheritance:r /grant:r "$env:USERDOMAIN\$env:USERNAME:(OI)(CI)F" /grant:r "*S-1-5-18:(OI)(CI)F"
   ```
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
namespaces, contagens = origem, índices = origem, versão, SHA-256, manifesto) → nome definitivo **sem sobrescrever** →
retenção. A saída do `mongodump` **não** é registrada (mensagens de conexão podem conter host).

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
2), verificações da janela, **assinaturas antes e depois** (por coleção: contagem, maior `atualizadoEm`/`criadoEm`,
SHA-256 do conteúdo para coleções sem timestamp — `sequencias`, `configuracoes`), índices normalizados por coleção,
referências (número de ids órfãos por regra), sequências (`valor` × maior código emitido), dados do archive (SHA-256,
tamanho, documentos por coleção), validações e avisos. **Limite declarado no próprio manifesto:** a consistência é
OPERACIONAL — o `mongodump` de um banco lê uma coleção por vez (não é snapshot transacional); a coerência depende da
janela sem escrita e das assinaturas iguais antes/depois. Não há prova matemática de ausência de escrita (ex.: uma
escrita feita e desfeita durante o dump não seria detectada).

Limite técnico: a leitura estrutural descompacta o archive em memória até **1 GiB** (acima disso, falha fechada).

## Janela sem escrita e retomada

- **Devido:** a partir do último 23:45. Já existe diário VÁLIDO depois dele → `JA_REALIZADO`.
- **Computador ligado depois das 23:45** (ou execução perdida): continua devido, mas **só coleta se a janela passar** —
  nunca "imediatamente".
- **Verificações (todas leituras; qualquer falha → ADIADO):** caixas abertos = 0; maior timestamp de **todas** as 27
  coleções ≥ 15 min atrás (timestamp no futuro também adia); nenhuma linha de reconciliação `pendente`/
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
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ops\backup\restore-test.ps1 -ArquivoBackup "<base>.archive.gz" [-RemoverAoFinal]
```

1. **Antes de qualquer escrita:** SHA-256 = manifesto = `.sha256`; manifesto `VALIDO_LOCAL`; archive com exatamente os 27
   namespaces de `marielaDB` e as contagens do manifesto; destino **só** `127.0.0.1:27118`, mesma série de versão da
   origem (8.0; correção diferente é registrada); banco `mariela_restore_yyyyMMdd_HHmmss` **inexistente** (nunca
   `marielaDB`, nunca sobrescreve).
2. `mongorestore --nsInclude marielaDB.<cada uma das 27> --nsFrom "marielaDB.*" --nsTo "<destino>.*" --stopOnError`
   (**sem `--drop`**). Aviso `Cross-version` ou documento com falha → FALHOU.
3. **Depois:** coleções exatas, contagens, índices, referências (órfãos iguais aos da origem) e sequências idênticos ao
   manifesto. Relatório: `%USERPROFILE%\mariela-restore-isolado\relatorios\restore_<destino>.json` (com duração).

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
bun test ops/backup/lib                                                    # 49 unitários (também no CI)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ops\backup\testes\executar-testes-integracao.ps1   # 21 casos
```

A integração exige a origem SINTÉTICA `127.0.0.1:27119` (MongoDB 8.0.37 com `dbPath` descartável; dados criados por
`testes/origem-sintetica.ts`, que só aceita essa porta) e a instância isolada `27118`. Cobre: banco `marielaDB`/recusa
de `outroDB` e `test`, 27 namespaces, exclusão dos tokens, manifesto, SHA-256, archive vazio/truncado/não-gzip/de outro
banco, falha do mongodump, colisão e trava, retenção com 60 diários + 7 extras + inválidos + legado, cifra (senha
errada, não-ASCII, portabilidade 5.1↔7), segunda cópia parada em `CIFRADO`, janela (escrita recente, 14 × 16 min, caixa
aberto, reconciliação pendente, coleção não prevista), retomada, restore isolado completo, recusas de destino/porta/
versão (archive forjado 8.2.1), ACL aberta, PowerShell 7.

## Operações que exigem autorização posterior (proibidas por padrão)

Backup real contra o Atlas · restore de archive real · upload para o Google Drive · criação de credencial/OAuth ·
agendamento contra produção · mudanças no Atlas (usuários, roles, IP Access List, tier) · mudanças no Render ·
homologação integrada. Nunca: restaurar no Atlas, em `marielaDB` ou em `test`; usar `--drop`; passar URI ou senha por
argumento; gravar senha em arquivo.

## Histórico

- Fases 29–35 (09/2026): primeiro `mongodump` real (`mariela_prod_20260921_1357.archive.gz`, SHA-256
  `A4BDFF21…5A9E`, servidor 8.0.32) com o banco **vazio**; restore da mecânica num 8.2.1 local (aviso de versão).
  A pasta `M:\Backup-sistema-mariela\marielaDB` é um artefato histórico (dump parcial), não é backup.
- Fase 60.4.3.4.21.2 (09/11/2026): política 21.1 implementada; MongoDB 8.0.37 isolado; validação local completa.
