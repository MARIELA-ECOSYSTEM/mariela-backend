<#
.SYNOPSIS
  Testes de INTEGRAÇÃO LOCAIS do backup/restore (Fase 60.4.3.4.21.2). Dados sintéticos; nunca o Atlas.

.DESCRIPTION
  Pré-requisitos (verificados): origem sintética MongoDB 8.0.37 em 127.0.0.1:27119 (dbPath descartável) e a
  instância isolada de restore em 127.0.0.1:27118 (ops/backup/mongod-isolado.ps1 -Acao Iniciar), mongodump/
  mongorestore 100.x no PATH, 7-Zip, Bun. Cria pastas temporárias em %TEMP% com ACL restrita e as remove ao final.
  Senha de cifra: DESCARTÁVEL, gerada aleatoriamente a cada execução, nunca gravada.
#>
param([switch]$ManterArtefatos)

$ErrorActionPreference = "Stop"
$ops = Split-Path -Parent $PSScriptRoot
. (Join-Path $ops "comum.ps1")

$resultados = New-Object System.Collections.ArrayList
function Caso([string]$Id, [string]$Nome, [scriptblock]$Corpo) {
  $t = Get-Date
  try {
    $detalhe = & $Corpo
    [void]$resultados.Add([pscustomobject]@{ Id = $Id; Caso = $Nome; Resultado = "PASSOU"; Detalhe = "$detalhe"; Segundos = [math]::Round(((Get-Date) - $t).TotalSeconds, 1) })
  } catch {
    [void]$resultados.Add([pscustomobject]@{ Id = $Id; Caso = $Nome; Resultado = "FALHOU"; Detalhe = $_.Exception.Message; Segundos = [math]::Round(((Get-Date) - $t).TotalSeconds, 1) })
  }
}
function Exigir([bool]$Condicao, [string]$Mensagem) { if (-not $Condicao) { throw $Mensagem } }

$bun = Get-CaminhoBun
function Semear([string]$Cenario) {
  $r = Invoke-Nativo -Programa $bun -Argumentos @("--no-env-file", (Join-Path $PSScriptRoot "origem-sintetica.ts"), $Cenario)
  if ($r.Codigo -ne 0) { throw "semeadura '$Cenario' falhou: $($r.Erro)" }
  return $r.Saida.Trim()
}

$raiz = Join-Path $env:TEMP ("mariela-testes-backup-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Path $raiz | Out-Null
function NovaPasta([string]$Nome) { $p = Join-Path $raiz $Nome; New-Item -ItemType Directory -Path $p | Out-Null; Set-AclRestrita $p; return $p }
function NovoConfig([string]$Nome, [string]$Banco) {
  $arq = Join-Path $raiz "cfg\$Nome.yaml"
  if (-not (Test-Path (Join-Path $raiz "cfg"))) { New-Item -ItemType Directory -Path (Join-Path $raiz "cfg") | Out-Null }
  [System.IO.File]::WriteAllText($arq, "uri: `"mongodb://127.0.0.1:27119/$Banco`?directConnection=true`"`n", (New-Object System.Text.UTF8Encoding($false)))
  Set-AclRestrita $arq
  return $arq
}
function Backup([string]$Dir, [string]$Cfg, [string[]]$Extra = @(), [string]$Shell = "powershell.exe") {
  $script = Join-Path $ops "backup-mongo.ps1"
  $r = Invoke-Nativo -Programa $Shell -Argumentos (@("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $script, "-BackupDir", $Dir, "-ConfigMongo", $Cfg) + $Extra)
  $log = @(Get-ChildItem -LiteralPath (Join-Path $Dir "logs") -Filter "backup_*.jsonl" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 1)
  $ultimo = if ($log.Count) { (Get-Content -LiteralPath $log[0].FullName -Encoding UTF8 | Select-Object -Last 1) | ConvertFrom-Json } else { $null }
  return [pscustomobject]@{ Codigo = $r.Codigo; Log = $ultimo; Saida = $r.Saida; Erro = $r.Erro }
}
function Restore([string]$Archive, [string[]]$Extra = @(), [string]$Shell = "powershell.exe") {
  $script = Join-Path $ops "restore-test.ps1"
  $r = Invoke-Nativo -Programa $Shell -Argumentos (@("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $script, "-ArquivoBackup", $Archive, "-DiretorioRelatorio", (Join-Path $raiz "relatorios")) + $Extra)
  return [pscustomobject]@{ Codigo = $r.Codigo; Saida = $r.Saida; Erro = $r.Erro }
}
# Fase 21.2.6: a instância isolada exige credencial (DPAPI; só pelo stdin).
$credRestore = Get-CredencialIsolada (Join-Path $env:USERPROFILE "mariela-restore-isolado") 'restore'
function BancosNoRestore { $r = Invoke-CliBackup -Argumentos @("listar-bancos", "--porta", "27118") -Credencial $credRestore; if (-not $r.ok) { throw "listar-bancos: $($r.mensagem)" }; return @($r.resultado.bancos) }
# Fase 21.2.8 (A21-7-02): a remoção exige o archive e o manifesto do backup escolhido pelo operador.
function RemoverRestore([string]$Banco, [string]$ExecucaoId, [string]$Arquivo, [string]$Shell = "powershell.exe") {
  $r = Invoke-Nativo -Programa $Shell -Argumentos @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $ops "gerir-restore.ps1"), "-Acao", "Remover", "-BancoDestino", $Banco, "-ExecucaoId", $ExecucaoId, "-ArquivoBackup", $Arquivo, "-Manifesto", ($Arquivo -replace '\.archive\.gz$', '.manifest.json'), "-DiretorioRelatorio", (Join-Path $raiz "relatorios"))
  return $r.Codigo
}
function SemArchiveValido([string]$Dir) { return @(Get-ChildItem -LiteralPath $Dir -File | Where-Object { $_.Name -match '^mariela_(prod|extra)_.*\.archive\.gz$' }).Count -eq 0 }

try {
  # --- Pré-requisitos -------------------------------------------------------------------------------------------
  $estado27118 = Invoke-CliBackup -Argumentos @("local-estado", "--porta", "27118") -Credencial $credRestore
  Exigir ($estado27118.ok -and $estado27118.resultado.versao -eq "8.0.37" -and $estado27118.resultado.bindIp -eq "127.0.0.1" -and $estado27118.resultado.primario -and $estado27118.resultado.autenticacao) "instância isolada 27118 indisponível ou sem autenticação"
  $estado27119 = Invoke-CliBackup -Argumentos @("local-estado", "--porta", "27119")
  Exigir ($estado27119.ok -and $estado27119.resultado.bindIp -eq "127.0.0.1") "origem sintética 27119 indisponível"
  Semear "base" | Out-Null
  $cfg = NovoConfig "valido" "marielaDB"
  $senhaTexto = "teste-descartavel-" + [guid]::NewGuid().ToString("N")
  $agora = Get-Date

  # --- Backup principal (PS 5.1) ---------------------------------------------------------------------------------
  $dirA = NovaPasta "A"
  $b = $null
  Caso "T01" "assert marielaDB + backup válido (Windows PowerShell 5.1)" {
    $script:b = Backup $dirA $cfg
    Exigir ($b.Codigo -eq 0 -and $b.Log.resultado -eq "VALIDO_LOCAL") "esperado VALIDO_LOCAL/0; obtido $($b.Log.resultado)/$($b.Codigo): $($b.Log.motivo)"
    "arquivo=$($b.Log.arquivo)"
  }
  $archiveA = Join-Path $dirA $b.Log.arquivo
  $manA = Get-Content -LiteralPath ($archiveA -replace '\.archive\.gz$', '.manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json

  Caso "T02" "rejeita banco diferente (URI com outroDB e com test)" {
    $dirX = NovaPasta "X"
    foreach ($banco in @("outroDB", "test")) {
      $r = Backup $dirX (NovoConfig "banco-$banco" $banco) @("-Extraordinario")
      Exigir ($r.Codigo -eq 1 -and $r.Log.resultado -eq "FALHA" -and $r.Log.motivo -match "BANCO_DIVERGENTE") "banco $banco não foi recusado: $($r.Log.resultado) $($r.Log.motivo)"
    }
    Exigir (SemArchiveValido $dirX) "algum archive foi criado"
    "outroDB e test recusados antes do dump (BANCO_DIVERGENTE); nenhum archive"
  }

  Caso "T03" "lista positiva: exatamente as 27 coleções no archive" {
    $v = Invoke-CliBackup -Argumentos @("validar-para-restore", "--arquivo", $archiveA, "--manifesto", ($archiveA -replace '\.archive\.gz$', '.manifest.json'))
    Exigir $v.resultado.ok "validação do archive falhou"
    $exatas = $v.resultado.verificacoes | Where-Object { $_.id -eq "archive.colecoes_exatas" }
    Exigir ($exatas.ok -and $exatas.detalhe -match "^27 coleções") "não são 27: $($exatas.detalhe)"
    $exatas.detalhe
  }

  Caso "T04" "tokens excluídos (refresh_tokens e vendedor_refresh_tokens fora do archive; existiam na origem)" {
    $nomes = @($manA.archive.documentosPorColecao.PSObject.Properties.Name)
    Exigir ($nomes.Count -eq 27 -and $nomes -notcontains "refresh_tokens" -and $nomes -notcontains "vendedor_refresh_tokens") "tokens presentes"
    Exigir (@($manA.politica.colecoesExcluidas) -join "," -eq "refresh_tokens,vendedor_refresh_tokens") "política divergente"
    "origem tinha 29 coleções (com 1 documento em cada token); archive tem 27"
  }

  Caso "T05" "manifesto completo e coerente" {
    Exigir ($manA.estado -eq "VALIDO_LOCAL" -and $manA.formato -eq "mariela-backup-manifesto/1") "estado/formato"
    Exigir ($manA.iniciadoEm -match '[+-]\d{2}:\d{2}$') "data/hora sem fuso: $($manA.iniciadoEm)"
    Exigir ($manA.ferramentas.mongodump -eq "100.17.0" -and $manA.servidor.versao -eq "8.0.37" -and $manA.archive.versaoServidor -eq "8.0.37") "versões"
    Exigir ($manA.origem.banco -eq "marielaDB" -and $manA.indices.total -gt 27) "origem/índices"
    Exigir ($manA.consistencia -match "não é snapshot transacional") "declaração de consistência ausente"
    Exigir (@($manA.validacoes | Where-Object { -not $_.ok }).Count -eq 0) "validação com falha"
    $proibidos = Select-String -LiteralPath ($archiveA -replace '\.archive\.gz$', '.manifest.json') -Pattern 'mongodb://|127\.0\.0\.1|password|senha' -SimpleMatch:$false
    Exigir (-not $proibidos) "manifesto contém URI/host/senha"
    "execucaoId=$($manA.execucaoId); $($manA.indices.total) índices; $(@($manA.validacoes).Count) validações OK; sem URI/host"
  }

  Caso "T06" "SHA-256 (arquivo = manifesto = .sha256)" {
    $sha = Get-Sha256 $archiveA
    $arq = ((Get-Content -LiteralPath "$archiveA.sha256" -Raw).Trim() -split '\s+')[0]
    Exigir ($sha -eq $manA.archive.sha256 -and $sha -eq $arq) "hashes divergem"
    $sha
  }

  # --- Arquivos defeituosos (cópias numa pasta à parte) -------------------------------------------------------
  $dirD = NovaPasta "D"
  function CopiaDefeituosa([string]$Nome, [byte[]]$Bytes) {
    $alvo = Join-Path $dirD "$Nome.archive.gz"
    [System.IO.File]::WriteAllBytes($alvo, $Bytes)
    $sha = if ($Bytes.Length) { (Get-Sha256 $alvo) } else { "E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855" }
    [System.IO.File]::WriteAllText("$alvo.sha256", "$sha  x`n")
    $m = Get-Content -LiteralPath ($archiveA -replace '\.archive\.gz$', '.manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $m.archive.sha256 = $sha
    [System.IO.File]::WriteAllText((Join-Path $dirD "$Nome.manifest.json"), ($m | ConvertTo-Json -Depth 20))
    return $alvo
  }
  $bytesA = [System.IO.File]::ReadAllBytes($archiveA)
  Caso "T07" "archive vazio ou truncado é rejeitado (mesmo com SHA coerente)" {
    foreach ($caso in @(@{ n = "vazio"; b = [byte[]]@() }, @{ n = "truncado"; b = [byte[]]($bytesA[0..([int]($bytesA.Length / 2))]) })) {
      $alvo = CopiaDefeituosa $caso.n $caso.b
      $v = Invoke-CliBackup -Argumentos @("validar-para-restore", "--arquivo", $alvo, "--manifesto", ($alvo -replace '\.archive\.gz$', '.manifest.json'))
      Exigir ($v.ok -and -not $v.resultado.ok) "$($caso.n) não foi rejeitado"
    }
    "vazio e truncado: archive.legivel=false"
  }
  Caso "T08" "gzip inválido rejeitado" {
    $alvo = CopiaDefeituosa "naogzip" ([System.Text.Encoding]::ASCII.GetBytes("isto nao e gzip"))
    $v = Invoke-CliBackup -Argumentos @("validar-para-restore", "--arquivo", $alvo, "--manifesto", ($alvo -replace '\.archive\.gz$', '.manifest.json'))
    $leg = $v.resultado.verificacoes | Where-Object { $_.id -eq "archive.legivel" }
    Exigir (-not $v.resultado.ok -and $leg.detalhe -eq "GZIP_INVALIDO") "não rejeitou como GZIP_INVALIDO"
    "GZIP_INVALIDO"
  }

  Caso "T09" "namespace inesperado (archive de outroDB, SHA coerente) rejeitado ANTES de escrever" {
    $alvo = Join-Path $dirD "outrobanco.archive.gz"
    $r = Invoke-Nativo -Programa $bun -Argumentos @("--no-env-file", (Join-Path $PSScriptRoot "forjar-archive.ts"), "banco", ($archiveA -replace '\.archive\.gz$', '.manifest.json'), $alvo, ($alvo -replace '\.archive\.gz$', '.manifest.json'))
    Exigir ($r.Codigo -eq 0) "forja falhou"
    $antes = BancosNoRestore
    $rr = Restore $alvo @("-BancoDestino", "mariela_restore_20260101_000001")
    $depois = BancosNoRestore
    Exigir ($rr.Codigo -eq 1) "restore não recusou"
    Exigir ((@($depois) -join ",") -eq (@($antes) -join ",")) "o destino foi alterado"
    "recusado em validar-archive (banco_unico/colecoes); nenhum banco criado"
  }

  Caso "T10" "falha do mongodump nunca vira sucesso" {
    $dirM = NovaPasta "M"
    $stub = Join-Path $raiz "mongodump-falha.cmd"
    [System.IO.File]::WriteAllText($stub, "@echo off`r`nif `"%~1`"==`"--version`" (echo mongodump version: 100.17.0& exit /b 0)`r`nexit /b 3`r`n")
    $r = Backup $dirM $cfg @("-Extraordinario", "-Mongodump", $stub)
    Exigir ($r.Codigo -eq 1 -and $r.Log.resultado -eq "INVALIDO") "esperado INVALIDO/1; obtido $($r.Log.resultado)/$($r.Codigo)"
    Exigir (SemArchiveValido $dirM) "archive classificado como válido"
    $man = @(Get-ChildItem -LiteralPath $dirM -Filter "mariela_invalido_*.manifest.json")
    Exigir ($man.Count -eq 1 -and ((Get-Content -LiteralPath $man[0].FullName -Raw -Encoding UTF8 | ConvertFrom-Json).estado -eq "INVALIDO")) "manifesto de falha ausente"
    Exigir (@(Get-ChildItem -LiteralPath $dirM -Filter "*.tmp").Count -eq 0) "temporário não removido"
    "INVALIDO; manifesto de falha; sem .tmp"
  }

  Caso "T11" "colisão sem sobrescrita e trava contra execução concorrente" {
    $a = Join-Path $dirD "colisao_a.bin"; $c = Join-Path $dirD "colisao_b.bin"
    Set-Content -LiteralPath $a -Value "A"; Set-Content -LiteralPath $c -Value "B"
    $p = Invoke-CliBackup -Argumentos @("promover", "--origem", $a, "--destino", $c)
    Exigir (-not $p.ok -and $p.mensagem -match "COLISAO") "promover sobrescreveu"
    Exigir ((Get-Content -LiteralPath $c) -eq "B" -and (Test-Path -LiteralPath $a)) "arquivos alterados"
    $dirL = NovaPasta "L"
    $trava = [System.IO.File]::Open((Join-Path $dirL ".backup.lock"), [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    try { $r = Backup $dirL $cfg @("-Extraordinario") } finally { $trava.Close() }
    Exigir ($r.Codigo -eq 1 -and $r.Log.motivo -match "trava") "trava ignorada"
    "COLISAO recusada; segunda execução barrada pela trava"
  }

  # --- Retenção com backups sintéticos antigos + um backup real ------------------------------------------------
  Caso "T12-T14" "retenção 14/8/12 + 5 extras + inválidos 7 dias + piso, aplicada após backup real válido" {
    $dirR = NovaPasta "R"
    function Falso([string]$Base, [string]$Estado, [string]$Tipo, [datetime]$Quando, [bool]$ComArchive) {
      if ($ComArchive) { Set-Content -LiteralPath (Join-Path $dirR "$Base.archive.gz") -Value "x" }
      $m = @{ estado = $Estado; tipo = $Tipo; dataLocal = $Quando.ToString("yyyy-MM-dd"); iniciadoEm = $Quando.ToString("o") }
      [System.IO.File]::WriteAllText((Join-Path $dirR "$Base.manifest.json"), ($m | ConvertTo-Json))
    }
    # 22:00 (antes do horário-alvo de 23:45): o backup real de hoje continua DEVIDO.
    for ($i = 1; $i -le 60; $i++) { $d = $agora.Date.AddDays(-$i).AddHours(22); Falso ("mariela_prod_" + $d.ToString("yyyyMMdd_HHmmss")) "VALIDO_LOCAL" "diario" $d $true }
    for ($i = 1; $i -le 7; $i++) { $d = $agora.Date.AddDays(-2 * $i).AddHours(12); Falso ("mariela_extra_" + $d.ToString("yyyyMMdd_HHmmss")) "VALIDO_LOCAL" "extraordinario" $d $true }
    foreach ($dias in @(3, 10)) { $d = $agora.AddDays(-$dias); Falso ("mariela_invalido_" + $d.ToString("yyyyMMdd_HHmmss")) "INVALIDO" "diario" $d $false }
    Set-Content -LiteralPath (Join-Path $dirR "mariela_prod_20260921_1357.archive.gz") -Value "legado"
    $r = Backup $dirR $cfg
    Exigir ($r.Log.resultado -eq "VALIDO_LOCAL") "backup real não foi válido: $($r.Log.motivo)"
    $removidos = @($r.Log.retencao.removidos)
    $arqs = Get-ChildItem -LiteralPath $dirR -File
    $extras = @($arqs | Where-Object { $_.Name -match '^mariela_extra_.*\.archive\.gz$' })
    $diarios = @($arqs | Where-Object { $_.Name -match '^mariela_prod_\d{8}_\d{6}\.archive\.gz$' })
    $inval = @($arqs | Where-Object { $_.Name -match '^mariela_invalido_' } | ForEach-Object { $_.Name })
    Exigir ($extras.Count -eq 5) "extras mantidos = $($extras.Count) (esperado 5)"
    Exigir ($diarios.Count -ge 14 -and $diarios.Count -le 34) "diários mantidos = $($diarios.Count)"
    Exigir ($inval.Count -eq 1 -and $inval[0] -match ("^mariela_invalido_" + $agora.AddDays(-3).ToString("yyyyMMdd"))) "inválidos: $($inval -join ',')"
    Exigir (Test-Path -LiteralPath (Join-Path $dirR "mariela_prod_20260921_1357.archive.gz")) "legado removido"
    Exigir (@(Get-ChildItem -LiteralPath (Join-Path $dirR "logs") -Filter "retencao_*.json").Count -eq 1) "log de retenção ausente"
    "diários mantidos=$($diarios.Count) (14 dias + semanas + meses), extras=5, inválidos: 10 dias removido / 3 dias mantido, legado preservado, $($removidos.Count) arquivos removidos"
  }

  Caso "T15" "cifra 7-Zip AES-256: cria, testa, recusa senha errada, decifra e confere SHA" {
    $script = Join-Path $ops "cifrar-backup.ps1"
    $base = $archiveA -replace '\.archive\.gz$', ''
    # Senha DESCARTÁVEL deste teste: entra no PowerShell filho (convertida para SecureString lá dentro) e chega ao
    # 7-Zip SÓ pelo stdin. Ela aparece na linha de comando do PowerShell filho — aceitável só por ser descartável.
    # Processos filhos via Invoke-Nativo: no 5.1, `& exe 2>&1` com ErrorActionPreference=Stop transforma o stderr de
    # uma falha ESPERADA (senha errada) em exceção do runner.
    function Cifra([string]$Shell, [string]$SenhaTeste, [string]$Resto) {
      $comando = "& { `$sen = ConvertTo-SecureString '$SenhaTeste' -AsPlainText -Force; & '$script' $Resto -Senha `$sen; exit `$LASTEXITCODE }"
      $argumentos = if ($Shell -eq "pwsh") { @("-NoProfile", "-Command", $comando) } else { @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $comando) }
      return Invoke-Nativo -Programa $Shell -Argumentos $argumentos
    }
    $r = Cifra "powershell.exe" $senhaTexto "-Acao Cifrar -Arquivo '$archiveA'"
    Exigir ($r.Codigo -eq 0) "cifrar falhou: $($r.Erro)"
    Exigir ((Test-Path "$base.7z") -and (Test-Path "$base.7z.sha256")) "pacote ausente"
    $reg = Get-Content -LiteralPath "$base.segunda-copia.json" -Raw -Encoding UTF8 | ConvertFrom-Json
    Exigir ($reg.estado -eq "CIFRADO" -and $reg.sha256Cifrado -eq (Get-Sha256 "$base.7z") -and $reg.sha256Original -eq $manA.archive.sha256) "registro CIFRADO incoerente"
    $lista = Invoke-Nativo -Programa "C:\Program Files\7-Zip\7z.exe" -Argumentos @("l", "$base.7z") -Entrada "`n"
    Exigir ($lista.Codigo -ne 0) "cabeçalho legível sem senha (-mhe deveria impedir)"
    $errada = Cifra "powershell.exe" "senha-errada-descartavel" "-Acao Verificar -Arquivo '$base.7z'"
    Exigir ($errada.Codigo -eq 2 -and $errada.Erro -match "Wrong password") "senha errada não foi recusada (código $($errada.Codigo))"
    # Portabilidade da chave: cifrado no 5.1, verificado no 7 e direto no 7-Zip (bytes da senha idênticos).
    $no7 = Cifra "pwsh" $senhaTexto "-Acao Verificar -Arquivo '$base.7z'"
    Exigir ($no7.Codigo -eq 0) "pacote cifrado no 5.1 não abre no PowerShell 7 com a mesma senha: $($no7.Erro)"
    $direto = Invoke-Nativo -Programa "C:\Program Files\7-Zip\7z.exe" -Argumentos @("t", "$base.7z") -Entrada "$senhaTexto`n"
    Exigir ($direto.Codigo -eq 0) "pacote não abre no 7-Zip direto com a mesma senha"
    $acentuada = Cifra "powershell.exe" "senhacomacentuação123" "-Acao Verificar -Arquivo '$base.7z'"
    Exigir ($acentuada.Codigo -eq 1 -and $acentuada.Erro -match "ASCII") "senha não ASCII deveria ser recusada (código $($acentuada.Codigo))"
    $destino = Join-Path $raiz "decifrado"
    $dec = Cifra "pwsh" $senhaTexto "-Acao Decifrar -Arquivo '$base.7z' -Destino '$destino'"
    Exigir ($dec.Codigo -eq 0) "decifrar falhou: $($dec.Erro)"
    Exigir ((Get-Sha256 (Join-Path $destino (Split-Path -Leaf $archiveA))) -eq $manA.archive.sha256) "SHA do archive recuperado diverge"
    $vazou = Select-String -Path (Join-Path $dirA "*"), (Join-Path $dirA "logs\*") -Pattern $senhaTexto -SimpleMatch -ErrorAction SilentlyContinue
    Exigir (-not $vazou) "a senha aparece em algum arquivo"
    "pacote $((Get-Item "$base.7z").Length) bytes; cabeçalho cifrado; senha errada → código 2; senha não-ASCII recusada; cifrado no 5.1 abre no 7 e no 7-Zip direto; decifrado com SHA igual; senha em nenhum arquivo"
  }

  Caso "T16" "segunda cópia não avança sem upload + download + hash (estado parado em CIFRADO)" {
    $reg = Get-Content -LiteralPath (($archiveA -replace '\.archive\.gz$', '') + ".segunda-copia.json") -Raw -Encoding UTF8 | ConvertFrom-Json
    Exigir ($reg.estado -eq "CIFRADO" -and -not $reg.idRemoto -and -not $reg.sha256Baixado) "estado avançou sem evidência"
    "CIFRADO (sem upload: transporte Google Drive não implementado; máquina de estados coberta pelos testes unitários)"
  }

  Caso "T17" "janela: escrita recente, caixa aberto e reconciliação pendente → ADIADO; 15 min completos → elegível" {
    $dirQ = NovaPasta "Q"
    Semear "escrita-recente" | Out-Null
    $r = Backup $dirQ $cfg @("-Extraordinario")
    Exigir ($r.Codigo -eq 0 -and $r.Log.resultado -eq "ADIADO" -and $r.Log.motivo -match "janela.sem_escrita") "escrita recente: $($r.Log.resultado) $($r.Log.motivo)"
    $r14 = Backup $dirQ $cfg @("-Extraordinario", "-Agora", (Get-Date).AddMinutes(14).ToString("o"))
    Exigir ($r14.Log.resultado -eq "ADIADO") "14 min não deveria bastar"
    $r16 = Backup $dirQ $cfg @("-Extraordinario", "-Agora", (Get-Date).AddMinutes(16).ToString("o"))
    Exigir ($r16.Log.resultado -eq "VALIDO_LOCAL") "16 min deveria bastar: $($r16.Log.resultado) $($r16.Log.motivo)"
    Semear "base" | Out-Null; Semear "caixa-aberto" | Out-Null
    $rc = Backup $dirQ $cfg @("-Extraordinario")
    Exigir ($rc.Log.resultado -eq "ADIADO" -and $rc.Log.motivo -match "caixas_fechados") "caixa aberto: $($rc.Log.motivo)"
    Semear "base" | Out-Null; Semear "reconciliacao-pendente" | Out-Null
    $rr = Backup $dirQ $cfg @("-Extraordinario", "-Agora", (Get-Date).AddMinutes(16).ToString("o"))
    Exigir ($rr.Log.resultado -eq "ADIADO" -and $rr.Log.motivo -match "reconciliacao") "reconciliação: $($rr.Log.motivo)"
    Semear "base" | Out-Null; Semear "colecao-desconhecida" | Out-Null
    $rd = Backup $dirQ $cfg @("-Extraordinario")
    Exigir ($rd.Codigo -eq 1 -and $rd.Log.resultado -eq "BLOQUEADO") "coleção desconhecida: $($rd.Log.resultado)"
    Semear "base" | Out-Null
    "ADIADO (escrita, 14 min, caixa aberto, reconciliação); elegível com 16 min; BLOQUEADO com coleção não prevista"
  }

  Caso "T18" "retomada: já feito hoje → JA_REALIZADO; computador ligado no dia seguinte às 09:00 → coleta (após verificações)" {
    $r = Backup $dirA $cfg
    Exigir ($r.Codigo -eq 0 -and $r.Log.resultado -eq "JA_REALIZADO") "esperado JA_REALIZADO: $($r.Log.resultado)"
    $amanha9 = $agora.Date.AddDays(1).AddHours(9).ToString("o")
    $r2 = Backup $dirA $cfg @("-Agora", $amanha9)
    Exigir ($r2.Log.resultado -eq "VALIDO_LOCAL") "retomada não coletou: $($r2.Log.resultado) $($r2.Log.motivo)"
    Exigir (@($r2.Log.verificacoes | Where-Object { $_.id -eq "janela.sem_escrita" -and $_.ok }).Count -eq 1) "retomada sem a verificação de janela"
    "JA_REALIZADO; retomada às 09:00 do dia seguinte coletou só depois das verificações"
  }

  Caso "T19" "restore sintético isolado (27118): 27 coleções, índices, contagens, referências, sequências" {
    $r = Restore $archiveA @("-BancoDestino", "mariela_restore_20260101_000002")
    Exigir ($r.Codigo -eq 0) "restore falhou: $($r.Saida) $($r.Erro)"
    $rel = Get-Content -LiteralPath (Join-Path $raiz "relatorios\restore_mariela_restore_20260101_000002.json") -Raw -Encoding UTF8 | ConvertFrom-Json
    Exigir ($rel.resultado -eq "PASSOU") "relatório: $($rel.resultado)"
    $mr = $rel.etapas | Where-Object { $_.etapa -eq "mongorestore" }
    Exigir ($mr.documentosComFalha -eq 0 -and -not $mr.avisoCrossVersion) "mongorestore com falhas/cross-version"
    $vr = $rel.etapas | Where-Object { $_.etapa -eq "congelar-e-verificar" }
    Exigir ($vr.ok -and @($vr.verificacoes | Where-Object { -not $_.ok }).Count -eq 0) "verificação integral pós-restore"
    Exigir ($rel.estadoDestino -eq "VERIFICADO") "estado do destino: $($rel.estadoDestino)"
    Exigir ((BancosNoRestore) -contains "mariela_restore_20260101_000002" -and (BancosNoRestore) -notcontains "marielaDB") "banco de destino"
    Exigir ((RemoverRestore "mariela_restore_20260101_000002" $rel.execucaoId $archiveA) -eq 0 -and (BancosNoRestore) -notcontains "mariela_restore_20260101_000002") "remoção comprovada"
    "PASSOU (VERIFICADO) em $($rel.duracaoSegundos)s; $($mr.documentosRestaurados) documentos; " + (($vr.verificacoes | ForEach-Object { $_.detalhe }) -join " | ")
  }

  Caso "T20" "restore recusa destino marielaDB, nome fora do padrão e porta ≠ 27118" {
    $antes = BancosNoRestore
    foreach ($extra in @(@("-BancoDestino", "marielaDB"), @("-BancoDestino", "qualquer"), @("-Porta", "27017"))) {
      $r = Restore $archiveA $extra
      Exigir ($r.Codigo -eq 1) "não recusou: $($extra -join ' ')"
    }
    Exigir ((@(BancosNoRestore) -join ",") -eq (@($antes) -join ",")) "destino alterado"
    "3 recusas antes de qualquer escrita"
  }

  Caso "T21" "restore recusa archive de versão incompatível (8.2.1 → destino 8.0.37)" {
    $alvo = Join-Path $dirD "versao.archive.gz"
    $f = Invoke-Nativo -Programa $bun -Argumentos @("--no-env-file", (Join-Path $PSScriptRoot "forjar-archive.ts"), "versao", ($archiveA -replace '\.archive\.gz$', '.manifest.json'), $alvo, ($alvo -replace '\.archive\.gz$', '.manifest.json'))
    Exigir ($f.Codigo -eq 0) "forja falhou"
    $antes = BancosNoRestore
    $r = Restore $alvo @("-BancoDestino", "mariela_restore_20260101_000003")
    Exigir ($r.Codigo -eq 1) "não recusou"
    $rel = Get-Content -LiteralPath (Join-Path $raiz "relatorios\restore_mariela_restore_20260101_000003.json") -Raw -Encoding UTF8 | ConvertFrom-Json
    $prep = $rel.etapas | Where-Object { $_.etapa -eq "preparar-destino" }
    Exigir ($prep -and -not $prep.ok -and (@($prep.verificacoes | Where-Object { $_.id -eq "restore.versao_compativel" -and -not $_.ok }).Count -eq 1)) "recusa não foi pela versão"
    Exigir ((@(BancosNoRestore) -join ",") -eq (@($antes) -join ",")) "destino alterado"
    "recusado em preparar-destino: " + (($prep.verificacoes | Where-Object { $_.id -eq "restore.versao_compativel" }).detalhe)
  }

  Caso "T22" "PowerShell 7: backup válido + restore PASSOU" {
    $dir7 = NovaPasta "PS7"
    $r = Backup $dir7 $cfg @("-Extraordinario") "pwsh"
    Exigir ($r.Codigo -eq 0 -and $r.Log.resultado -eq "VALIDO_LOCAL") "backup pwsh: $($r.Log.resultado) $($r.Log.motivo)"
    $arq = Join-Path $dir7 $r.Log.arquivo
    $rr = Restore $arq @("-BancoDestino", "mariela_restore_20260101_000004") "pwsh"
    Exigir ($rr.Codigo -eq 0) "restore pwsh falhou"
    $rel4 = Get-Content -LiteralPath (Join-Path $raiz "relatorios\restore_mariela_restore_20260101_000004.json") -Raw -Encoding UTF8 | ConvertFrom-Json
    Exigir ((RemoverRestore "mariela_restore_20260101_000004" $rel4.execucaoId $arq "pwsh") -eq 0 -and (BancosNoRestore) -notcontains "mariela_restore_20260101_000004") "remoção comprovada (pwsh) não removeu"
    "backup e restore no PowerShell $(pwsh -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'); 5.1 coberto nos demais casos"
  }

  Caso "T23" "ACL aberta no config ou na pasta → BLOQUEADO" {
    $dirO = Join-Path $raiz "aberta"; New-Item -ItemType Directory -Path $dirO | Out-Null
    $r = Backup $dirO $cfg @("-Extraordinario")
    Exigir ($r.Codigo -eq 1 -and $r.Saida -match "BLOQUEADO") "pasta com ACL herdada não bloqueou"
    "pasta com herança/Usuários → BLOQUEADO antes de conectar"
  }
} finally {
  $resultados | Format-Table -AutoSize -Wrap | Out-String -Width 220 | Write-Host
  $falhas = @($resultados | Where-Object { $_.Resultado -ne "PASSOU" }).Count
  Write-Host ("TOTAL: {0} casos, {1} PASSOU, {2} FALHOU" -f $resultados.Count, ($resultados.Count - $falhas), $falhas)
  if (-not $ManterArtefatos) { Remove-Item -LiteralPath $raiz -Recurse -Force -ErrorAction SilentlyContinue }
}
if ($falhas) { exit 1 } else { exit 0 }
