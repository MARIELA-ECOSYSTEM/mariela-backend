<#
.SYNOPSIS
  Backup lógico do banco marielaDB (mongodump) conforme a política aprovada nas Fases 60.4.3.4.21.1/21.2.

.DESCRIPTION
  Ferramenta OPERACIONAL (fora do backend). Fluxo — falha FECHADA em todas as etapas:
    1. Pré-condições locais: config do mongodump e pasta de destino com ACL restrita (conta atual + SYSTEM),
       trava contra execução concorrente.
    2. Pré-backup (só leitura na origem): banco exatamente marielaDB; coleções da origem = lista positiva
       (27) + excluídas (refresh_tokens, vendedor_refresh_tokens), nada a mais/a menos; backup diário devido
       (23:45; retomada quando o computador for ligado); janela sem escrita (15 min), caixas fechados,
       nenhuma reconciliação de estoque com retry vencido/próximo; assinaturas, índices, referências, sequências.
       Não elegível ⇒ nada é coletado (ADIADO / JA_REALIZADO) ou o backup é BLOQUEADO (política divergente).
    3. mongodump --config (URI nunca na linha de comando) --db marielaDB --excludeCollection (2) --gzip --archive
       para um temporário.
    4. Pós-backup: assinaturas de novo (escrita durante o dump ⇒ INVALIDO), leitura estrutural do archive
       (exatamente os 27 namespaces de marielaDB, contagens = origem, índices = origem, versão), SHA-256, manifesto.
    5. VALIDO_LOCAL ⇒ nome definitivo (sem sobrescrever) + .sha256 + manifesto + retenção (14/8/12, 5 extras,
       inválidos 7 dias, piso de 2). INVALIDO ⇒ prefixo mariela_invalido_ (evidência), SEM retenção.
  A consistência é OPERACIONAL (janela sem escrita + assinaturas antes/depois), não um snapshot transacional.
  O script NÃO para nem bloqueia a API, o worker ou o banco.

.PARAMETER BackupDir
  Pasta de destino (ACL restrita obrigatória).
.PARAMETER ConfigMongo
  Arquivo YAML do mongodump (--config) com a chave `uri:` (banco marielaDB no caminho). ACL restrita obrigatória.
.PARAMETER Extraordinario
  Backup extraordinário (antes de manutenção): prefixo mariela_extra_, fora da rotação diária. Mesmas verificações.
.PARAMETER Mongodump
  Caminho do mongodump (padrão: PATH).
.PARAMETER Agora
  SOMENTE PARA TESTES: instante de referência (ISO) das decisões de janela.

.NOTES
  Saída: 0 = VALIDO_LOCAL, ADIADO ou JA_REALIZADO; 1 = INVALIDO, BLOQUEADO ou falha. Log: <BackupDir>\logs\backup_yyyyMM.jsonl.
#>
param(
  [Parameter(Mandatory = $true)][string]$BackupDir,
  [Parameter(Mandatory = $true)][string]$ConfigMongo,
  [switch]$Extraordinario,
  [string]$Mongodump = "",
  [string]$Agora = ""
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "comum.ps1")

$tipo = if ($Extraordinario) { "extraordinario" } else { "diario" }
$prefixo = if ($Extraordinario) { "mariela_extra_" } else { "mariela_prod_" }
$inicio = Get-Date
$execucaoId = [guid]::NewGuid().ToString()
$carimbo = $inicio.ToString("yyyyMMdd_HHmmss")
$logArquivo = Join-Path $BackupDir ("logs\backup_" + $inicio.ToString("yyyyMM") + ".jsonl")
$registro = @{ execucaoId = $execucaoId; tipo = $tipo; inicio = $inicio.ToString("o"); resultado = "FALHA"; motivo = ""; arquivo = $null; sha256 = $null; tamanhoBytes = $null; retencao = $null }
$trava = $null
$preJson = $null
$manifestoTmp = $null

function Finalizar([string]$Resultado, [string]$Motivo, [int]$Codigo) {
  $registro.resultado = $Resultado
  $registro.motivo = $Motivo
  $registro.fim = (Get-Date).ToString("o")
  try { Write-LogJson -Arquivo $logArquivo -Dados $registro } catch { Write-Warning "não foi possível gravar o log: $($_.Exception.Message)" }
  Write-Host "[$Resultado] $Motivo"
  exit $Codigo
}

try {
  # --- 1. Pré-condições locais ---------------------------------------------------------------------------------
  if (-not (Test-Path -LiteralPath $BackupDir -PathType Container)) { Finalizar "FALHA" "pasta de destino inexistente" 1 }
  if (-not (Test-Path -LiteralPath $ConfigMongo -PathType Leaf)) { Finalizar "FALHA" "arquivo de configuração do mongodump inexistente" 1 }
  $aclConfig = Test-AclRestrita $ConfigMongo
  if (-not $aclConfig.Ok) { Finalizar "BLOQUEADO" "ACL do arquivo de configuração não é restrita: $($aclConfig.Detalhe)" 1 }
  $aclPasta = Test-AclRestrita $BackupDir
  if (-not $aclPasta.Ok) { Finalizar "BLOQUEADO" "ACL da pasta de backup não é restrita: $($aclPasta.Detalhe)" 1 }

  if (-not $Mongodump) {
    $cmd = Get-Command mongodump -ErrorAction SilentlyContinue
    if (-not $cmd) { Finalizar "FALHA" "mongodump não encontrado no PATH" 1 }
    $Mongodump = $cmd.Source
  }
  $versaoDump = Invoke-Nativo -Programa $Mongodump -Argumentos @("--version")
  $mongodumpVersao = if ($versaoDump.Saida -match 'mongodump version:\s*(\S+)') { $Matches[1] } else { $null }

  try {
    $trava = [System.IO.File]::Open((Join-Path $BackupDir ".backup.lock"), [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  } catch {
    Finalizar "FALHA" "outro backup está em execução nesta pasta (trava ocupada)" 1
  }

  # --- 2. Pré-backup (somente leitura na origem) ---------------------------------------------------------------
  $preJson = Join-Path $BackupDir "trabalho_$execucaoId.pre.json"
  $argsPre = @("pre-backup", "--config", $ConfigMongo, "--dir", $BackupDir, "--tipo", $tipo, "--saida", $preJson)
  if ($Agora) { $argsPre += @("--agora", $Agora) }
  $pre = Invoke-CliBackup -Argumentos $argsPre
  if (-not $pre.ok) { Finalizar "FALHA" "pré-backup falhou: $($pre.codigo) $($pre.mensagem)" 1 }
  $registro.verificacoes = @($pre.resultado.verificacoes | ForEach-Object { @{ id = $_.id; ok = $_.ok; detalhe = $_.detalhe } })
  if (-not $pre.resultado.elegivel) {
    if ($pre.resultado.motivo -like "BLOQUEADO*") { Finalizar "BLOQUEADO" $pre.resultado.motivo 1 }
    if ($pre.resultado.motivo -like "JA_REALIZADO*") { Finalizar "JA_REALIZADO" $pre.resultado.motivo 0 }
    Finalizar "ADIADO" $pre.resultado.motivo 0
  }
  if (-not (Test-Path -LiteralPath $preJson)) { Finalizar "FALHA" "pré-backup elegível sem arquivo de trabalho" 1 }

  # --- 3. Dump para um temporário --------------------------------------------------------------------------------
  $base = "$prefixo$carimbo"
  $baseInvalido = "mariela_invalido_$carimbo"
  $final = Join-Path $BackupDir "$base.archive.gz"
  $finalInvalido = Join-Path $BackupDir "$baseInvalido.archive.gz"
  $temporario = "$final.tmp"
  foreach ($c in @($final, $temporario, $finalInvalido, (Join-Path $BackupDir "$base.manifest.json"), (Join-Path $BackupDir "$baseInvalido.manifest.json"))) {
    if (Test-Path -LiteralPath $c) { Finalizar "FALHA" "COLISAO: $(Split-Path -Leaf $c) já existe — nada foi feito nem sobrescrito" 1 }
  }

  $argsDump = @("--config=$ConfigMongo", "--db=marielaDB", "--readPreference=primary", "--gzip", "--archive=$temporario")
  foreach ($excluida in @($pre.resultado.exclusoes)) { $argsDump += "--excludeCollection=$excluida" }
  $dump = Invoke-Nativo -Programa $Mongodump -Argumentos $argsDump
  # A saída do mongodump NÃO é registrada (mensagens de erro de conexão podem conter host).
  if ($dump.Codigo -ne 0) {
    Remove-Item -LiteralPath $temporario -Force -ErrorAction SilentlyContinue
    $null = Invoke-CliBackup -Argumentos @("manifesto-falha", "--execucao-id", $execucaoId, "--tipo", $tipo, "--iniciado-em", $inicio.ToString("o"), "--data-local", $inicio.ToString("yyyy-MM-dd"), "--fuso", [TimeZoneInfo]::Local.Id, "--motivo", "mongodump terminou com código $($dump.Codigo)", "--saida", (Join-Path $BackupDir "$baseInvalido.manifest.json"))
    Finalizar "INVALIDO" "mongodump terminou com código $($dump.Codigo) — nenhum archive classificado como válido" 1
  }

  # --- 4. Pós-backup: assinaturas, estrutura, contagens, índices, SHA-256, manifesto -----------------------------
  $manifestoTmp = Join-Path $BackupDir "trabalho_$execucaoId.manifest.json"
  $pos = Invoke-CliBackup -Argumentos @(
    "pos-backup", "--config", $ConfigMongo, "--pre", $preJson, "--tmp", $temporario, "--saida", $manifestoTmp,
    "--tipo", $tipo, "--execucao-id", $execucaoId, "--iniciado-em", $inicio.ToString("o"), "--data-local", $inicio.ToString("yyyy-MM-dd"),
    "--fuso", [TimeZoneInfo]::Local.Id, "--mongodump-versao", "$mongodumpVersao", "--nome-final", "$base.archive.gz", "--nome-invalido", "$baseInvalido.archive.gz")
  if (-not $pos.ok) {
    Remove-Item -LiteralPath $temporario -Force -ErrorAction SilentlyContinue
    Finalizar "FALHA" "pós-backup falhou: $($pos.codigo) $($pos.mensagem) — archive descartado" 1
  }
  $valido = ($pos.resultado.estado -eq "VALIDO_LOCAL")
  $alvoBase = if ($valido) { $base } else { $baseInvalido }
  $alvoArchive = Join-Path $BackupDir "$alvoBase.archive.gz"

  # --- 5. Promoção sem sobrescrita ----------------------------------------------------------------------------
  $prom = Invoke-CliBackup -Argumentos @("promover", "--origem", $temporario, "--destino", $alvoArchive)
  if (-not $prom.ok) {
    Remove-Item -LiteralPath $temporario -Force -ErrorAction SilentlyContinue
    Finalizar "FALHA" "não foi possível dar o nome definitivo: $($prom.mensagem) — temporário descartado, retenção NÃO executada" 1
  }
  $promMan = Invoke-CliBackup -Argumentos @("promover", "--origem", $manifestoTmp, "--destino", (Join-Path $BackupDir "$alvoBase.manifest.json"))
  if (-not $promMan.ok) { Finalizar "FALHA" "manifesto não pôde ser promovido: $($promMan.mensagem)" 1 }
  $manifestoTmp = $null
  [System.IO.File]::WriteAllText("$alvoArchive.sha256", "$($pos.resultado.sha256)  $alvoBase.archive.gz`n", (New-Object System.Text.UTF8Encoding($false)))
  $registro.arquivo = "$alvoBase.archive.gz"
  $registro.sha256 = $pos.resultado.sha256
  $registro.tamanhoBytes = (Get-Item -LiteralPath $alvoArchive).Length
  $registro.avisos = @($pos.resultado.avisos)

  if (-not $valido) {
    $registro.falhas = @($pos.resultado.falhas)
    Finalizar "INVALIDO" ("validação falhou: " + (@($pos.resultado.falhas) -join " | ")) 1
  }

  # --- 6. Retenção (só depois de um backup novo VÁLIDO) -------------------------------------------------------
  $ret = Invoke-CliBackup -Argumentos @("retencao", "--dir", $BackupDir, "--novo", $base, "--aplicar")
  if ($ret.ok) {
    $registro.retencao = @{ removidos = @($ret.resultado.apagados) }
  } else {
    $registro.retencao = @{ erro = $ret.mensagem }
  }

  # Limpeza de .tmp órfão (execução interrompida): só o padrão do backup, sem escrita E sem criação há > 24 h, e só
  # se ninguém mantém o arquivo aberto.
  $limite = (Get-Date).AddHours(-24)
  foreach ($orfao in @(Get-ChildItem -LiteralPath $BackupDir -File | Where-Object { $_.Name -match '^mariela_(prod|extra)_\d{8}_\d{6}\.archive\.gz\.tmp$' -and $_.FullName -ne $temporario -and $_.LastWriteTime -lt $limite -and $_.CreationTime -lt $limite })) {
    try {
      $sonda = [System.IO.File]::Open($orfao.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
      $sonda.Close()
      Remove-Item -LiteralPath $orfao.FullName -Force
    } catch { }
  }

  Finalizar "VALIDO_LOCAL" "backup $base.archive.gz validado (SHA-256 $($pos.resultado.sha256))" 0
} finally {
  if ($preJson -and (Test-Path -LiteralPath $preJson)) { Remove-Item -LiteralPath $preJson -Force -ErrorAction SilentlyContinue }
  if ($manifestoTmp -and (Test-Path -LiteralPath $manifestoTmp)) { Remove-Item -LiteralPath $manifestoTmp -Force -ErrorAction SilentlyContinue }
  if ($trava) { $trava.Close() }
}
