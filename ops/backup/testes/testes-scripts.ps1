<#
.SYNOPSIS
  Testes dos SCRIPTS PowerShell de backup/restore SEM MongoDB, SEM rede e SEM alterar ACL (Fase 60.4.3.4.21.2.2).

.DESCRIPTION
  Roda no PowerShell que o executar (rode no 5.1 E no 7). Cobre:
    R21-2.1-02  expansão dos comandos icacls da documentação (variáveis FICTÍCIAS, num processo filho);
    R21-2.1-04  Invoke-Nativo: entrada nula × vazia × texto; stdin sem BOM; senha não-ASCII recusada;
    R21-2.1-05  backup-mongo.ps1 com falhas injetadas (promoção, hash, manifesto, log, I/O inesperado);
    R21-2.1-07  restore-test.ps1: falha antes/depois da escrita, falha na limpeza, destino não exclusivo, marielaDB;
    R21-2.1-11  identidade do processo da porta (fixtures) e recusa antes de qualquer operação.
  backup-mongo.ps1/restore-test.ps1 rodam numa CÓPIA temporária de ops/backup cujo comum.ps1 recebe, no fim,
  substitutos (stubs) de Test-AclRestrita, Invoke-CliBackup e Get-EvidenciaPorta; mongodump/mongorestore são stubs.
  Tudo em %TEMP%\mariela-testes-scripts-<id>, removido ao final.
#>
param([switch]$ManterArtefatos)

$ErrorActionPreference = "Stop"
$ops = Split-Path -Parent $PSScriptRoot
. (Join-Path $ops "comum.ps1")
$shell = (Get-Process -Id $PID).Path
$versaoPs = $PSVersionTable.PSVersion.ToString()

$resultados = New-Object System.Collections.ArrayList
function Caso([string]$Id, [string]$Nome, [scriptblock]$Corpo) {
  try {
    $detalhe = & $Corpo
    [void]$resultados.Add([pscustomobject]@{ Id = $Id; Caso = $Nome; Resultado = "PASSOU"; Detalhe = "$detalhe" })
  } catch {
    [void]$resultados.Add([pscustomobject]@{ Id = $Id; Caso = $Nome; Resultado = "FALHOU"; Detalhe = $_.Exception.Message })
  }
}
function Exigir([bool]$Condicao, [string]$Mensagem) { if (-not $Condicao) { throw $Mensagem } }

$raiz = Join-Path $env:TEMP ("mariela-testes-scripts-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Path $raiz | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding($false)
function Escrever([string]$Caminho, [string]$Texto) { [System.IO.File]::WriteAllText($Caminho, $Texto, $utf8) }

# ---------------------------------------------------------------------------------------------------------------
# Cópia temporária de ops/backup com STUBS (só nesta cópia)
# ---------------------------------------------------------------------------------------------------------------
$copia = Join-Path $raiz "ops"
New-Item -ItemType Directory -Path $copia | Out-Null
foreach ($f in "backup-mongo.ps1", "restore-test.ps1", "comum.ps1", "gerir-restore.ps1", "recuperar-destino.ps1") { Copy-Item -LiteralPath (Join-Path $ops $f) -Destination $copia }
$stubs = @'

# ===================== STUBS DE TESTE (somente nesta cópia temporária) =====================
function Test-AclRestrita([string]$Caminho) { return [pscustomobject]@{ Ok = $true; Detalhe = "" } }
function Get-CenarioTeste { return (Get-Content -LiteralPath $env:MARIELA_TESTE_CENARIO -Raw -Encoding UTF8 | ConvertFrom-Json) }
function Get-EvidenciaPorta([int]$Porta) { return (Get-CenarioTeste).evidencia }
# Credencial FICTÍCIA (nunca existiu fora deste teste) — serve para provar que a senha não vaza em argumentos.
function Get-CredencialIsolada([string]$Raiz, [string]$Papel) {
  if ((Get-CenarioTeste).semCredencial) { throw "credencial '$Papel' da instância isolada ausente" }
  return [pscustomobject]@{ Papel = $Papel; Usuario = "usuario_$Papel"; Senha = (ConvertTo-SecureString "senha-ficticia-de-teste-$Papel" -AsPlainText -Force) }
}
# Pasta de evidências: no stub, só cria a pasta (sem icacls).
function Initialize-PastaEvidencias([string]$Raiz) { $d = Join-Path $Raiz "evidencias"; if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d | Out-Null }; return $d }
function UltimaChamada([string]$Cmd) { return @(Get-Content -LiteralPath $env:MARIELA_TESTE_CHAMADAS -Encoding UTF8 | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { $_.cmd -eq $Cmd }) | Select-Object -Last 1 }
function Invoke-CliBackup {
  param([string[]]$Argumentos, $Credencial = $null)
  $c = Get-CenarioTeste
  $cmd = $Argumentos[0]
  $o = @{}
  for ($i = 1; $i -lt $Argumentos.Count; $i += 2) { $o[$Argumentos[$i].TrimStart('-')] = $(if ($i + 1 -lt $Argumentos.Count) { $Argumentos[$i + 1] } else { $null }) }
  # A trava do restore (se houver -raiz) está SEGURA no momento desta chamada? (abrir para escrita tem de falhar)
  $travaSegura = $null
  if ($o["raiz"]) {
    $tp = Join-Path $o["raiz"] "locks\restore.lock"
    try { $fs = [System.IO.File]::Open($tp, "Open", "ReadWrite", "ReadWrite"); $fs.Close(); $travaSegura = $false } catch { $travaSegura = $true }
  }
  [System.IO.File]::AppendAllText($env:MARIELA_TESTE_CHAMADAS, (@{ cmd = $cmd; o = $o; travaSegura = $travaSegura; credencial = $(if ($Credencial) { $Credencial.Papel } else { $null }); argumentos = ($Argumentos -join ' ') } | ConvertTo-Json -Compress -Depth 4) + "`n")
  if ($c.lancarEm -eq $cmd) { throw "falha de I/O simulada em mongodb+srv://usuario:senha@cluster0.abcde.mongodb.net/marielaDB via 10.1.2.3:27017" }
  $json = switch ($cmd) {
    "pre-backup" { [System.IO.File]::WriteAllText($o["saida"], "{}"); '{"ok":true,"resultado":{"elegivel":true,"motivo":"ELEGIVEL","verificacoes":[],"exclusoes":["refresh_tokens","vendedor_refresh_tokens"]}}' }
    "pos-backup" { [System.IO.File]::WriteAllText($o["saida"], '{"estado":"VALIDO_LOCAL"}'); '{"ok":true,"resultado":{"estado":"' + $(if ($c.estadoPos) { $c.estadoPos } else { "VALIDO_LOCAL" }) + '","sha256":"' + ("A" * 64) + '","falhas":[],"avisos":[]}}' }
    "manifesto-falha" { [System.IO.File]::WriteAllText($o["saida"], '{"estado":"INVALIDO"}'); '{"ok":true,"resultado":{"estado":"INVALIDO"}}' }
    "promover" {
      $ehManifesto = $o["destino"] -like "*.manifest.json"
      if ($ehManifesto -and $c.falharPromocaoManifesto) { '{"ok":false,"codigo":"X","mensagem":"falha simulada na promoção do manifesto"}' }
      elseif (-not $ehManifesto -and $c.falharPromocaoArchive) { '{"ok":false,"codigo":"X","mensagem":"falha simulada na promoção do archive"}' }
      else {
        if ($ehManifesto) { [System.IO.File]::AppendAllText($env:MARIELA_TESTE_CHAMADAS, (@{ cmd = "ordem"; shaExistiaAntesDoManifesto = (Test-Path -LiteralPath ($o["destino"] -replace '\.manifest\.json$', '.archive.gz.sha256')) } | ConvertTo-Json -Compress) + "`n") }
        Move-Item -LiteralPath $o["origem"] -Destination $o["destino"]
        if (-not $ehManifesto -and $c.bloquearHash) { New-Item -ItemType Directory -Path ($o["destino"] + ".sha256") | Out-Null }
        '{"ok":true,"resultado":{"promovido":"x"}}'
      }
    }
    "retencao" { '{"ok":true,"resultado":{"apagados":[]}}' }
    "validar-para-restore" { if ($c.validarArchiveOk -eq $false) { '{"ok":true,"resultado":{"ok":false,"verificacoes":[{"id":"archive.legivel","ok":false,"detalhe":"GZIP_INVALIDO"}]}}' } else { '{"ok":true,"resultado":{"ok":true,"verificacoes":[]}}' } }
    "preparar-restore" { '{"ok":true,"resultado":' + ($c.preparar | ConvertTo-Json -Compress -Depth 5) + '}' }
    "politica" { '{"ok":true,"resultado":{"colecoesIncluidas":[' + ((1..27 | ForEach-Object { '"c' + $_ + '"' }) -join ",") + ']}}' }
    "validar-restaurado" { if ($c.validarRestauradoOk -eq $false) { '{"ok":true,"resultado":{"ok":false,"verificacoes":[{"id":"restaurado.contagens","ok":false,"detalhe":"x"}]}}' } else { '{"ok":true,"resultado":{"ok":true,"verificacoes":[]}}' } }
    "adquirir-posse" { if ($c.posseFalha) { '{"ok":true,"resultado":{"ok":false,"adquirida":false,"motivo":"' + $c.posseFalha + '","colecoesAlheias":["x"],"controleRemovido":true}}' } else { '{"ok":true,"resultado":{"ok":true,"adquirida":true}}' } }
    "marcar-estado" { if ($c.marcarFalha -eq $o["para"]) { '{"ok":true,"resultado":{"ok":false,"de":"PREPARANDO","detalhe":"transição recusada"}}' } else { '{"ok":true,"resultado":{"ok":true,"de":"X","detalhe":"ok"}}' } }
    "congelar-e-verificar" {
      switch ("$($c.verificar)") {
        "reprovado" { '{"ok":true,"resultado":{"ok":false,"estado":"VALIDANDO","motivo":"verificação de integridade reprovada","verificacoes":[{"id":"integridade.conteudo","ok":false,"detalhe":"eventos_auth(divergentes=1)"}]}}' }
        "intervencao" { '{"ok":true,"resultado":{"ok":false,"estado":"INTERVENCAO_NECESSARIA","motivo":"o destino mudou entre a verificação e o registro de VERIFICADO","verificacoes":[]}}' }
        default { '{"ok":true,"resultado":{"ok":true,"estado":"VERIFICADO","verificacoes":[],"evidencias":{"documentos":41,"hashesPorColecao":{"c1":"ab"}}}}' }
      }
    }
    "inspecionar-destino" {
      $ad = UltimaChamada "adquirir-posse"
      $posse = if ($c.posseGestao) { $c.posseGestao } elseif ($ad) {
        @{ execucaoId = $ad.o.execucao; estado = $(if ($c.estadoInspecao) { $c.estadoInspecao } else { "VERIFICADO" }); archive = $ad.o.arquivo; manifesto = $ad.o.manifesto
           archiveSha256 = $(if ($c.shaDivergente) { "0" * 64 } else { Get-Sha256 $ad.o.arquivo }); manifestoSha256 = Get-Sha256 $ad.o.manifesto }
      } else { $null }
      '{"ok":true,"resultado":' + (@{ ok = $true; existe = $true; colecoes = @("c1", "_mariela_restore_posse"); posse = $posse; documentosDePosse = $(if ($posse) { 1 } else { 0 }) } | ConvertTo-Json -Compress -Depth 6) + '}'
    }
    "verificar-integridade" {
      $prot = $c.protecaoOk -ne $false
      $okI = $c.integridadeOk -ne $false
      $okA = $c.ancoraOk -ne $false
      $anc = @("ancora.cadeia", "ancora.execucao", "ancora.banco", "ancora.instancia", "ancora.archive", "ancora.manifesto", "ancora.caminhos", "ancora.estado") | ForEach-Object { @{ id = $_; ok = $(if ($_ -eq "ancora.archive") { $okA } else { $true }); detalhe = "x" } }
      '{"ok":true,"resultado":' + (@{ ok = ($okI -and $prot -and $okA); estado = "VERIFICADO"; verificacoes = @($anc) + @(@{ id = "destino.protegido"; ok = $prot; detalhe = "x" }, @{ id = "integridade.conteudo"; ok = $okI; detalhe = "x" }); divergencias = @($(if (-not $okI) { @{ colecao = "c1"; divergentes = 1 } })) } | ConvertTo-Json -Compress -Depth 6) + '}'
    }
    "conferir-trava" { if ($c.travaOk -eq $false) { '{"ok":true,"resultado":{"ok":false,"verificacoes":[{"id":"trava.dono_inicio","ok":false}]}}' } else { '{"ok":true,"resultado":{"ok":true,"verificacoes":[]}}' } }
    "iniciar-uso" { if ($c.usoOk -eq $false) { '{"ok":true,"resultado":{"ok":false,"estado":"INTERVENCAO_NECESSARIA","detalhe":"o destino não confere com o VERIFICADO"}}' } else { '{"ok":true,"resultado":{"ok":true,"estado":"EM_USO","detalhe":"EM_USO: 27 coleções descongeladas","descongeladas":["c1"]}}' } }
    "liberar-restore" { if ($c.liberarOk -eq $false) { '{"ok":true,"resultado":{"ok":false,"estado":"INTERVENCAO_NECESSARIA","motivo":"o destino não é mais idêntico ao VERIFICADO"}}' } else { '{"ok":true,"resultado":{"ok":true,"estado":"LIBERACAO_AUTORIZADA","motivo":"VERIFICADO → LIBERACAO_AUTORIZADA"}}' } }
    "limpar-destino" {
      if ($c.limparOk -eq $false) { '{"ok":true,"resultado":{"ok":false,"limpo":false,"motivo":"DADOS_ALHEIOS","detalhe":"produtos: 1 documento fora do archive","removidas":[],"preservadas":["produtos"],"estadoFinal":"INTERVENCAO_NECESSARIA"}}' }
      elseif ($c.lancarEmLimpeza) { '{"ok":false,"codigo":"UsoInvalidoErro","mensagem":"trava de restore não comprovada"}' }
      else { '{"ok":true,"resultado":{"ok":true,"limpo":true,"removidas":["c1","_mariela_restore_posse"],"estadoFinal":"' + $(if ($o["modo"] -eq "descarte") { "DESCARTADO" } else { "CANCELADO_COM_LIMPEZA_COMPROVADA" }) + '","bancoRemovido":true,"restantes":[]}}' }
    }
    "derrubar-restore" { '{"ok":false,"codigo":"USO_INVALIDO","mensagem":"derrubar-restore foi removido"}' }
    default { throw "stub: comando inesperado $cmd" }
  }
  return ($json | ConvertFrom-Json)
}
'@
[System.IO.File]::AppendAllText((Join-Path $copia "comum.ps1"), $stubs, (New-Object System.Text.UTF8Encoding($true)))

# Stubs de mongodump/mongorestore (.cmd → PowerShell), dirigidos pelo mesmo cenário.
Escrever (Join-Path $raiz "mongodump-stub.ps1") @'
$c = Get-Content -LiteralPath $env:MARIELA_TESTE_CENARIO -Raw -Encoding UTF8 | ConvertFrom-Json
if ($args -contains "--version") { "mongodump version: 100.17.0"; exit 0 }
$arquivo = ($args | Where-Object { $_ -like "--archive=*" } | Select-Object -First 1) -replace '^--archive=', ''
[System.IO.File]::WriteAllBytes($arquivo, [byte[]](1..64))
if ($c.dumpCodigo) { exit [int]$c.dumpCodigo }
exit 0
'@
Escrever (Join-Path $raiz "mongorestore-stub.ps1") @'
$c = Get-Content -LiteralPath $env:MARIELA_TESTE_CENARIO -Raw -Encoding UTF8 | ConvertFrom-Json
# A senha chega pelo stdin (nunca por argumento): registra o que veio por cada canal.
$stdin = if ([Console]::IsInputRedirected) { [Console]::In.ReadLine() } else { $null }
[System.IO.File]::AppendAllText($env:MARIELA_TESTE_CHAMADAS, (@{ cmd = "mongorestore"; stdin = $stdin; argumentos = ($args -join ' ') } | ConvertTo-Json -Compress) + "`n")
if ($c.restoreDormir) { Start-Sleep -Seconds ([int]$c.restoreDormir) }
if ($c.restoreCrossVersion) { [Console]::Error.WriteLine("Cross-version dump & restore is unsupported") }
$falhas = if ($c.restoreFalhados) { [int]$c.restoreFalhados } else { 0 }
[Console]::Error.WriteLine("41 document(s) restored successfully. $falhas document(s) failed to restore.")
if ($c.restoreCodigo) { exit [int]$c.restoreCodigo }
exit 0
'@
foreach ($n in "mongodump", "mongorestore") { Escrever (Join-Path $raiz "$n-stub.cmd") "@echo off`r`npowershell.exe -NoProfile -ExecutionPolicy Bypass -File `"%~dp0$n-stub.ps1`" %*`r`nexit /b %ERRORLEVEL%`r`n" }

$script:n = 0
function Rodar([string]$Script, [hashtable]$Cenario, [string[]]$Argumentos) {
  $script:n++
  $env:MARIELA_TESTE_CENARIO = Join-Path $raiz "cenario-$($script:n).json"
  $env:MARIELA_TESTE_CHAMADAS = Join-Path $raiz "chamadas-$($script:n).jsonl"
  Escrever $env:MARIELA_TESTE_CENARIO ($Cenario | ConvertTo-Json -Depth 6)
  Escrever $env:MARIELA_TESTE_CHAMADAS ""
  $r = Invoke-Nativo -Programa $shell -Argumentos (@("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $copia $Script)) + $Argumentos)
  $chamadas = @(Get-Content -LiteralPath $env:MARIELA_TESTE_CHAMADAS -Encoding UTF8 | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json })
  return [pscustomobject]@{ Codigo = $r.Codigo; Saida = $r.Saida; Erro = $r.Erro; Chamadas = $chamadas }
}
function UltimoLog([string]$Dir) {
  $log = @(Get-ChildItem -LiteralPath (Join-Path $Dir "logs") -Filter "backup_*.jsonl" -ErrorAction SilentlyContinue | Select-Object -First 1)
  if (-not $log.Count) { return $null }
  return ((Get-Content -LiteralPath $log[0].FullName -Encoding UTF8 | Where-Object { $_ } | Select-Object -Last 1) | ConvertFrom-Json)
}
function NovoBackupDir([string]$Nome) { $d = Join-Path $raiz $Nome; New-Item -ItemType Directory -Path $d | Out-Null; return $d }
$cfg = Join-Path $raiz "config-ficticio.yaml"
Escrever $cfg "uri: `"mongodb://127.0.0.1:1/marielaDB`"`n"   # nunca usado: a CLI é stub
function Backup([string]$Dir, [hashtable]$Cenario) { return Rodar "backup-mongo.ps1" $Cenario @("-BackupDir", $Dir, "-ConfigMongo", $cfg, "-Mongodump", (Join-Path $raiz "mongodump-stub.cmd")) }

try {
  # ===================================== R21-2.1-02 =========================================================
  Caso "R02-a" "doc: icacls expande para DOMINIO\usuario (variáveis fictícias, processo filho)" {
    $doc = Get-Content -LiteralPath (Join-Path (Split-Path -Parent (Split-Path -Parent $ops)) "docs\backup-mongodb.md") -Encoding UTF8
    $linhas = @($doc | Where-Object { $_ -match '^\s*icacls ' -and $_ -match '/grant' })
    Exigir ($linhas.Count -ge 2) "comandos icacls não encontrados na doc"
    Exigir (@($doc | Where-Object { $_ -match '"\$env:USERDOMAIN\\\$env:USERNAME:' }).Count -eq 0) "a forma QUEBRADA ainda está na doc"
    $concessoes = @($linhas | ForEach-Object { [regex]::Matches($_, '/grant:r ("\$\{env:[^"]+")') | ForEach-Object { $_.Groups[1].Value } })
    Exigir ($concessoes.Count -ge 2) "concessões com `${env:...} não encontradas"
    $sonda = Join-Path $raiz "expandir.ps1"
    Escrever $sonda ("`$env:USERDOMAIN = 'DOMINIO-FICTICIO'; `$env:USERNAME = 'usuario-ficticio'`n" + (($concessoes | ForEach-Object { "Write-Output $_" }) -join "`n") + "`nWrite-Output `"`$env:USERDOMAIN\`$env:USERNAME:F`"")
    $r = Invoke-Nativo -Programa $shell -Argumentos @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $sonda)
    $saida = @($r.Saida -split "`r?`n" | Where-Object { $_ })
    $novas = $saida[0..($saida.Count - 2)]
    foreach ($s in $novas) { Exigir ($s -like "DOMINIO-FICTICIO\usuario-ficticio:*") "expansão incorreta: '$s'" }
    Exigir ($saida[-1] -eq "DOMINIO-FICTICIO\") "a forma antiga deveria expandir errado (evidência do defeito): '$($saida[-1])'"
    "corrigidas: $($novas -join ' | ') ; forma antiga → '$($saida[-1])'"
  }

  # ===================================== R21-2.1-04 =========================================================
  $sondaStdin = Join-Path $raiz "stdin.ps1"
  Escrever $sondaStdin @'
$redir = [Console]::IsInputRedirected
if ($redir) { $s = [Console]::OpenStandardInput(); $b = New-Object byte[] 256; $n = $s.Read($b, 0, 256); $hex = if ($n -gt 0) { ($b[0..($n - 1)] | ForEach-Object { '{0:X2}' -f $_ }) -join ' ' } else { "" } } else { $hex = "-" }
Write-Output "redirecionado=$redir bytes=[$hex]"
'@
  Caso "R04-a" "Invoke-Nativo sem -Entrada (e com -Entrada `$null): stdin NÃO redirecionado" {
    # O filho HERDA o stdin do pai quando não há redirecionamento — por isso a prova é a decisão do Invoke-Nativo.
    $r = Invoke-Nativo -Programa $shell -Argumentos @("-NoProfile", "-Command", "exit 0")
    Exigir (-not $r.StdinRedirecionado) "redirecionou sem entrada (defeito R21-2.1-04)"
    $r2 = Invoke-Nativo -Programa $shell -Argumentos @("-NoProfile", "-Command", "exit 0") -Entrada $null
    Exigir (-not $r2.StdinRedirecionado) "redirecionou com -Entrada `$null"
    "StdinRedirecionado=False (omitida e `$null)"
  }
  Caso "R04-b" "Invoke-Nativo com -Entrada '' : redirecionado e VAZIO (distinto de nulo)" {
    $r = Invoke-Nativo -Programa $shell -Argumentos @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $sondaStdin) -Entrada ""
    Exigir ($r.StdinRedirecionado -and $r.Saida -match "redirecionado=True bytes=\[\]") "esperado redirecionado e vazio: $($r.Saida)"
    $r.Saida.Trim()
  }
  Caso "R04-c" "Invoke-Nativo com texto ASCII: bytes EXATOS, sem BOM, mesmo com console em UTF-8" {
    $anterior = $null
    try { $anterior = [Console]::InputEncoding; [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch { $anterior = $null }
    try { $r = Invoke-Nativo -Programa $shell -Argumentos @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $sondaStdin) -Entrada "abc`n" }
    finally { if ($anterior) { try { [Console]::InputEncoding = $anterior } catch { } } }
    Exigir ($r.Saida -match "bytes=\[61 62 63 0A\]") "bytes diferentes de 61 62 63 0A (BOM?): $($r.Saida)"
    "console UTF-8 (preâmbulo $([System.Text.Encoding]::UTF8.GetPreamble().Length) bytes) → $($r.Saida.Trim())"
  }
  Caso "R04-d" "Invoke-Nativo recusa -Entrada que não seja texto" {
    $lancou = $false
    try { $null = Invoke-Nativo -Programa $shell -Argumentos @("-NoProfile", "-Command", "exit 0") -Entrada 123 } catch { $lancou = $true }
    Exigir $lancou "aceitou entrada numérica"
    "recusada"
  }
  Caso "R04-e" "cifrar-backup: senha não-ASCII e curta recusadas; ASCII aceita (sem chegar ao 7-Zip)" {
    $dummy = Join-Path $raiz "qualquer.txt"; Escrever $dummy "x"
    $script = Join-Path $ops "cifrar-backup.ps1"
    $roda = { param($senha) Invoke-Nativo -Programa $shell -Argumentos @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "& { `$s = ConvertTo-SecureString '$senha' -AsPlainText -Force; & '$script' -Acao Cifrar -Arquivo '$dummy' -Senha `$s; exit `$LASTEXITCODE }") }
    $na = & $roda "senhacomacentuação123"; Exigir ($na.Codigo -eq 1 -and $na.Erro -match "ASCII") "não-ASCII: código $($na.Codigo) $($na.Erro)"
    $curta = & $roda "curta"; Exigir ($curta.Codigo -eq 1 -and $curta.Erro -match "12") "curta: código $($curta.Codigo)"
    $ascii = & $roda "senha-ascii-descartavel-1"; Exigir ($ascii.Codigo -eq 1 -and $ascii.Erro -match "Cifrar exige o .archive.gz") "ASCII deveria passar pelas checagens de senha: $($ascii.Erro)"
    "não-ASCII → 1 (ASCII); curta → 1 (12); ASCII → passou da senha (parou no tipo do arquivo)"
  }

  # ===================================== R21-2.1-05 =========================================================
  Caso "R05-0" "controle: sucesso → VALIDO_LOCAL, ordem archive → .sha256 → manifesto" {
    $d = NovoBackupDir "b-ok"
    $r = Backup $d @{}
    $log = UltimoLog $d
    Exigir ($r.Codigo -eq 0 -and $log.resultado -eq "VALIDO_LOCAL" -and $log.etapa -eq "conclusao") "esperado VALIDO_LOCAL/0: $($r.Codigo) $($log.resultado)"
    $ordem = @($r.Chamadas | Where-Object { $_.cmd -eq "ordem" })
    Exigir ($ordem.Count -eq 1 -and $ordem[0].shaExistiaAntesDoManifesto) ".sha256 não existia quando o manifesto foi promovido"
    "VALIDO_LOCAL; .sha256 gravado ANTES da promoção do manifesto"
  }
  $casosFalha = @(
    @{ id = "R05-1"; nome = "falha na promoção do MANIFESTO"; cen = @{ falharPromocaoManifesto = $true }; etapa = "promocao-manifesto"; semManifesto = $true },
    @{ id = "R05-2"; nome = "falha na gravação do HASH (I/O)"; cen = @{ bloquearHash = $true }; etapa = "hash"; semManifesto = $true },
    @{ id = "R05-3"; nome = "falha na promoção do TEMPORÁRIO"; cen = @{ falharPromocaoArchive = $true }; etapa = "promocao-archive"; semManifesto = $true },
    @{ id = "R05-4"; nome = "exceção inesperada (I/O) no pós-backup, mensagem com URI/host/IP"; cen = @{ lancarEm = "pos-backup" }; etapa = "pos-backup"; semManifesto = $true }
  )
  foreach ($k in $casosFalha) {
    $kk = $k
    Caso $kk.id $kk.nome {
      $d = NovoBackupDir ("b-" + $kk.id)
      $r = Backup $d $kk.cen
      $log = UltimoLog $d
      Exigir ($r.Codigo -eq 1) "código $($r.Codigo) (esperado 1)"
      Exigir ($log -and $log.resultado -eq "FALHA" -and $log.etapa -eq $kk.etapa) "registro: $($log.resultado)/$($log.etapa) (esperado FALHA/$($kk.etapa))"
      Exigir (@(Get-ChildItem -LiteralPath $d -Filter "*.manifest.json").Count -eq 0) "um manifesto válido ficou na pasta"
      Exigir (@(Get-ChildItem -LiteralPath $d -Filter "*.tmp").Count -eq 0) "temporário não removido"
      Exigir (@(Get-ChildItem -LiteralPath $d -Filter "trabalho_*").Count -eq 0) "arquivos de trabalho não removidos"
      $texto = (Get-ChildItem -LiteralPath (Join-Path $d "logs") -Filter "*.jsonl" | ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8 }) -join "`n"
      Exigir ($texto -notmatch "VALIDO_LOCAL") "registrou sucesso"
      foreach ($proibido in "mongodb+srv", "senha", "abcde", "10.1.2.3") { Exigir ($texto -notmatch [regex]::Escape($proibido)) "log contém '$proibido'" }
      "FALHA na etapa '$($log.etapa)': $($log.motivo)"
    }
  }
  Caso "R05-5" "falha na GRAVAÇÃO DO LOG: sucesso vira código 1, mensagem sanitizada no stderr" {
    $d = NovoBackupDir "b-logfalha"
    Escrever (Join-Path $d "logs") "isto é um arquivo, não uma pasta"   # impede gravar logs\backup_*.jsonl
    $r = Backup $d @{}
    Exigir ($r.Codigo -eq 1) "código $($r.Codigo) (log falhou: nunca 0)"
    Exigir ($r.Erro -match "\[LOG\]") "sem aviso no stderr"
    $r2 = Backup $d @{ lancarEm = "pos-backup" }
    Exigir ($r2.Codigo -eq 1 -and $r2.Erro -match "\[LOG\]" -and $r2.Erro -notmatch "abcde|senha") "falha + log falhando: código $($r2.Codigo)"
    "sucesso com log falhando → 1; falha com log falhando → 1; stderr sanitizado"
  }
  Caso "R05-6" "pasta de backup inexistente: FALHA (1) e a pasta NÃO é criada pelo log" {
    $d = Join-Path $raiz "nao-existe"
    $r = Backup $d @{}
    Exigir ($r.Codigo -eq 1 -and -not (Test-Path -LiteralPath $d)) "código $($r.Codigo); pasta criada? $(Test-Path $d)"
    "1; pasta não criada"
  }
  Caso "R05-7" "mongodump com falha → INVALIDO (controle de regressão)" {
    $d = NovoBackupDir "b-dump"
    $r = Backup $d @{ dumpCodigo = 3 }
    $log = UltimoLog $d
    Exigir ($r.Codigo -eq 1 -and $log.resultado -eq "INVALIDO") "$($r.Codigo) $($log.resultado)"
    "INVALIDO"
  }

  # ============================== R21-2.1-11 (puro) e R21-2.1-07 / R-11 (restore) ==========================
  $raizIsolada = Join-Path $raiz "isolado"
  $mongodEsperado = Join-Path $raizIsolada "mongodb-8.0.37\bin\mongod.exe"
  Caso "R11-a" "Test-EvidenciaInstancia (fixtures): correto, desconhecido, bind aberto, dois processos, parado" {
    $ok = Test-EvidenciaInstancia ([pscustomobject]@{ Enderecos = @("127.0.0.1"); Processos = @([pscustomobject]@{ Pid = 1; Caminho = $mongodEsperado }) }) $mongodEsperado
    Exigir $ok.Ok "correto recusado: $($ok.Detalhe)"
    $casos = @(
      @{ e = @{ Enderecos = @("127.0.0.1"); Processos = @(@{ Pid = 1; Caminho = "C:\outro\mongod.exe" }) }; t = "não é o mongod" },
      @{ e = @{ Enderecos = @("0.0.0.0"); Processos = @(@{ Pid = 1; Caminho = $mongodEsperado }) }; t = "fora de 127.0.0.1" },
      @{ e = @{ Enderecos = @("127.0.0.1", "::"); Processos = @(@{ Pid = 1; Caminho = $mongodEsperado }) }; t = "fora de 127.0.0.1" },
      @{ e = @{ Enderecos = @("127.0.0.1"); Processos = @(@{ Pid = 1; Caminho = $mongodEsperado }, @{ Pid = 2; Caminho = $mongodEsperado }) }; t = "mais de um processo" },
      @{ e = @{ Enderecos = @(); Processos = @() }; t = "nenhum processo" },
      @{ e = @{ Enderecos = @("127.0.0.1"); Processos = @(@{ Pid = 1; Caminho = $null }) }; t = "sem caminho" }
    )
    foreach ($c in $casos) {
      $ev = [pscustomobject]@{ Enderecos = $c.e.Enderecos; Processos = @($c.e.Processos | ForEach-Object { [pscustomobject]$_ }) }
      $v = Test-EvidenciaInstancia $ev $mongodEsperado
      Exigir (-not $v.Ok -and $v.Detalhe -match [regex]::Escape($c.t)) "não recusou '$($c.t)': $($v.Detalhe)"
    }
    "1 aceito, 6 recusados"
  }

  $arq = Join-Path $raiz "mariela_prod_20261109_234500.archive.gz"; Escrever $arq "x"; Escrever ($arq -replace '\.archive\.gz$', '.manifest.json') "{}"
  $evOk = @{ Enderecos = @("127.0.0.1"); Processos = @(@{ Pid = 1; Caminho = $mongodEsperado }) }
  $prepOk = @{ ok = $true; destinoExclusivo = $true; verificacoes = @() }
  function Restore([hashtable]$Cenario, [string]$Banco = "mariela_restore_20260101_000001", [string[]]$Extra = @()) {
    if (-not $Cenario.ContainsKey("evidencia")) { $Cenario.evidencia = $evOk }
    if (-not $Cenario.ContainsKey("preparar")) { $Cenario.preparar = $prepOk }
    $r = Rodar "restore-test.ps1" $Cenario (@("-ArquivoBackup", $arq, "-BancoDestino", $Banco, "-Raiz", $raizIsolada, "-Mongorestore", (Join-Path $raiz "mongorestore-stub.cmd"), "-DiretorioRelatorio", (Join-Path $raiz "relatorios")) + $Extra)
    $relArq = Join-Path $raiz "relatorios\restore_$Banco.json"
    $rel = if (Test-Path -LiteralPath $relArq) { Get-Content -LiteralPath $relArq -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
    if (Test-Path -LiteralPath $relArq) { Remove-Item -LiteralPath $relArq }
    $cmds = @($r.Chamadas | ForEach-Object { $_.cmd })
    # "Derrubadas" = destinos para os quais a LIMPEZA SEGURA foi pedida (limpar-destino; derrubar-restore nunca é usado pelo restore).
    return [pscustomobject]@{ Codigo = $r.Codigo; Rel = $rel; Cmds = $cmds; Derrubadas = @($r.Chamadas | Where-Object { $_.cmd -eq "limpar-destino" -or $_.cmd -eq "derrubar-restore" } | ForEach-Object { $_.o.banco }); Chamadas = $r.Chamadas; Erro = $r.Erro }
  }
  $travaArq = Join-Path $raizIsolada "locks\restore.lock"

  Caso "R11-b" "restore: processo desconhecido, bind aberto ou instância parada → recusa ANTES de qualquer operação" {
    foreach ($ev in @(@{ Enderecos = @("127.0.0.1"); Processos = @(@{ Pid = 9; Caminho = "C:\Program Files\MongoDB\Server\8.2\bin\mongod.exe" }) }, @{ Enderecos = @("0.0.0.0"); Processos = @(@{ Pid = 1; Caminho = $mongodEsperado }) }, @{ Enderecos = @(); Processos = @() })) {
      $x = Restore @{ evidencia = $ev }
      Exigir ($x.Codigo -eq 1 -and $x.Rel.etapas[0].etapa -eq "identidade-processo" -and -not $x.Rel.etapas[0].ok) "não recusou na identidade"
      Exigir ($x.Cmds.Count -eq 0) "houve chamadas depois da recusa: $($x.Cmds -join ',')"
    }
    "3 recusas; nenhuma chamada à CLI nem ao mongorestore"
  }
  Caso "R11-c" "restore: identidade da INSTÂNCIA divergente (dbPath/marcador/bind/replica set, vinda da CLI) → nada escrito" {
    $x = Restore @{ preparar = @{ ok = $false; destinoExclusivo = $false; verificacoes = @(@{ id = "instancia.dbpath"; ok = $false; detalhe = "dbPath diferente" }) } }
    Exigir ($x.Codigo -eq 1 -and $x.Cmds -notcontains "mongorestore" -and $x.Derrubadas.Count -eq 0 -and -not $x.Rel.escritaIniciada) "escreveu ou removeu"
    "recusado em preparar-destino; sem mongorestore; sem remoção"
  }
  Caso "R07-a" "destino marielaDB / fora do padrão → recusa sem nenhuma chamada" {
    foreach ($b in "marielaDB", "qualquer") {
      $x = Restore @{} $b
      Exigir ($x.Codigo -eq 1 -and $x.Cmds.Count -eq 0 -and -not $x.Rel) "não recusou $b"
    }
    "2 recusas"
  }
  Caso "R07-b" "falha ANTES da escrita (archive inválido) → nada removido" {
    $x = Restore @{ validarArchiveOk = $false }
    Exigir ($x.Codigo -eq 1 -and $x.Cmds -notcontains "mongorestore" -and $x.Derrubadas.Count -eq 0 -and -not $x.Rel.escritaIniciada -and $x.Rel.resultado -eq "FALHOU") "falha antes da escrita tratada errado"
    "FALHOU; escritaIniciada=false; nenhuma remoção"
  }
  Caso "R07-c" "destino PRÉ-EXISTENTE (não pertence à execução) → nada escrito, nada removido" {
    $x = Restore @{ preparar = @{ ok = $false; destinoExclusivo = $false; verificacoes = @(@{ id = "restore.destino_inexistente"; ok = $false; detalhe = "já existe" }) } }
    Exigir ($x.Codigo -eq 1 -and $x.Cmds -notcontains "mongorestore" -and $x.Derrubadas.Count -eq 0) "mexeu em banco alheio"
    "preservado"
  }
  Caso "R07-d" "falha DEPOIS de iniciar a escrita (mongorestore código 1; documentos com falha; Cross-version) → remove SÓ o destino desta execução" {
    foreach ($cen in @(@{ restoreCodigo = 1 }, @{ restoreFalhados = 3 }, @{ restoreCrossVersion = $true })) {
      $x = Restore $cen
      Exigir ($x.Codigo -eq 1 -and $x.Rel.escritaIniciada -and $x.Rel.resultado -eq "FALHOU") "resultado $($x.Rel.resultado)"
      Exigir (($x.Derrubadas -join ",") -eq "mariela_restore_20260101_000001") "removeu: '$($x.Derrubadas -join ',')'"
      Exigir ($x.Rel.limpeza.executada -and -not $x.Rel.exigeIntervencao) "limpeza não registrada"
    }
    "3 cenários: FALHOU, destino removido e confirmado, sem intervenção"
  }
  Caso "R07-e" "verificação de integridade reprovada e exceção pós-escrita → FALHOU_DESTINO_PARCIAL marcado e limpeza comprovada" {
    $x = Restore @{ verificar = "reprovado" }
    Exigir ($x.Codigo -eq 1 -and ($x.Derrubadas -join ",") -eq "mariela_restore_20260101_000001" -and $x.Rel.resultado -eq "FALHOU" -and $x.Rel.estadoDestino -eq "CANCELADO_COM_LIMPEZA_COMPROVADA") "validação: $($x.Rel.resultado)"
    $mf = @($x.Chamadas | Where-Object { $_.cmd -eq "marcar-estado" -and $_.o.para -eq "FALHOU_DESTINO_PARCIAL" })
    $li = @($x.Chamadas | Where-Object { $_.cmd -eq "limpar-destino" })
    Exigir ($mf.Count -eq 1 -and $li.Count -eq 1 -and $li[0].o.modo -eq "falha") "não marcou FALHOU antes de limpar (modo falha)"
    $y = Restore @{ lancarEm = "congelar-e-verificar" }
    Exigir ($y.Codigo -eq 1 -and ($y.Derrubadas -join ",") -eq "mariela_restore_20260101_000001" -and @($y.Rel.etapas | Where-Object { $_.etapa -eq "excecao" }).Count -eq 1) "exceção: $($y.Rel.resultado)"
    Exigir (($y.Rel | ConvertTo-Json -Depth 8) -notmatch "abcde|senha|10\.1\.2\.3") "relatório com dado sensível"
    "ambos FALHOU com remoção; relatório sanitizado"
  }
  Caso "R07-f" "falha NA LIMPEZA → FALHOU_DESTINO_PARCIAL, exige intervenção, nunca PASSOU" {
    $x = Restore @{ restoreCodigo = 1; limparOk = $false }
    Exigir ($x.Codigo -eq 1 -and $x.Rel.resultado -eq "FALHOU_DESTINO_PARCIAL" -and $x.Rel.exigeIntervencao -and $x.Rel.limpeza.recusa -eq "DADOS_ALHEIOS") "resultado $($x.Rel.resultado)"
    $y = Restore @{ restoreCodigo = 1; lancarEmLimpeza = $true }
    Exigir ($y.Codigo -eq 1 -and $y.Rel.resultado -eq "FALHOU_DESTINO_PARCIAL" -and $y.Rel.exigeIntervencao) "erro da CLI: $($y.Rel.resultado)"
    "recusa (DADOS_ALHEIOS) e erro da CLI → FALHOU_DESTINO_PARCIAL; exigeIntervencao=true"
  }
  Caso "R07-g" "controle: PASSOU = VERIFICADO; nada removido, nada liberado, as 8 condições registradas" {
    $x = Restore @{}
    Exigir ($x.Codigo -eq 0 -and $x.Rel.resultado -eq "PASSOU" -and $x.Derrubadas.Count -eq 0) "resultado $($x.Rel.resultado) código $($x.Codigo)"
    Exigir ($x.Rel.estadoDestino -eq "VERIFICADO" -and $x.Cmds -notcontains "liberar-restore" -and $x.Cmds -notcontains "finalizar-posse") "estado $($x.Rel.estadoDestino)"
    $cond = $x.Rel.condicoesPassou
    Exigir (@($cond.PSObject.Properties).Count -eq 8 -and @($cond.PSObject.Properties | Where-Object { -not $_.Value }).Count -eq 0) "condições: $($cond | ConvertTo-Json -Compress)"
    Exigir ($x.Rel.controleDeProcessos -eq "job-kill-on-close") "sem controle de processos"
    "PASSOU; destino VERIFICADO (posse e proteção mantidas); 8/8 condições; job kill-on-close"
  }

  # ================================ R21-2.3-01 (Fase 21.2.4): trava e posse ================================
  Caso "P-a" "trava OCUPADA por outro detentor → recusa sem NENHUMA chamada e sem relatório" {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $travaArq) | Out-Null
    $fs = [System.IO.File]::Open($travaArq, "OpenOrCreate", "ReadWrite", "Read")
    try { $x = Restore @{} } finally { $fs.Close() }
    Exigir ($x.Codigo -eq 1 -and $x.Cmds.Count -eq 0 -and -not $x.Rel -and $x.Erro -match "Trava") "não recusou: $($x.Codigo) $($x.Erro)"
    "recusado (1); 0 chamadas"
  }
  Caso "P-b" "caminho da trava é um DIRETÓRIO → recusa sem chamadas" {
    $alt = Join-Path $raiz "isolado-dir"; New-Item -ItemType Directory -Force -Path (Join-Path $alt "locks\restore.lock") | Out-Null
    $r = Rodar "restore-test.ps1" @{ evidencia = $evOk; preparar = $prepOk } @("-ArquivoBackup", $arq, "-BancoDestino", "mariela_restore_20260101_000009", "-Raiz", $alt, "-Mongorestore", (Join-Path $raiz "mongorestore-stub.cmd"), "-DiretorioRelatorio", (Join-Path $raiz "relatorios"))
    Exigir ($r.Codigo -eq 1 -and @($r.Chamadas).Count -eq 0) "não recusou: $($r.Codigo)"
    "recusado (1); 0 chamadas"
  }
  Caso "P-c" "posse NÃO adquirida (destino com dados / posse de outra execução) → FALHOU, sem mongorestore, sem limpeza" {
    foreach ($m in "DESTINO_COM_DADOS", "POSSE_JA_EXISTE") {
      $x = Restore @{ posseFalha = $m }
      Exigir ($x.Codigo -eq 1 -and $x.Rel.resultado -eq "FALHOU" -and $x.Cmds -notcontains "mongorestore" -and $x.Derrubadas.Count -eq 0 -and -not $x.Rel.posseAdquirida) "$m : $($x.Rel.resultado)"
    }
    "2 motivos: FALHOU; nada escrito; nada removido"
  }
  Caso "P-d" "toda operação de destino ocorre COM a trava segura; mesma execução na posse e na limpeza; trava liberada ao fim" {
    $x = Restore @{ restoreCodigo = 1 }
    $comRaiz = @($x.Chamadas | Where-Object { $null -ne $_.travaSegura })
    Exigir ($comRaiz.Count -ge 3 -and @($comRaiz | Where-Object { -not $_.travaSegura }).Count -eq 0) "chamada sem trava segura"
    $ad = @($x.Chamadas | Where-Object { $_.cmd -eq "adquirir-posse" })[0]
    $li = @($x.Chamadas | Where-Object { $_.cmd -eq "limpar-destino" })[0]
    Exigir ($ad.o.execucao -eq $x.Rel.execucaoId -and $li.o.'trava-execucao' -eq $x.Rel.execucaoId -and $li.o.'posse-execucao' -eq $x.Rel.execucaoId) "execucaoId divergente"
    $conteudo = Get-Content -LiteralPath $travaArq -Raw -Encoding UTF8 | ConvertFrom-Json
    Exigir ($conteudo.livre -eq $true -and $conteudo.ultimaExecucao -eq $x.Rel.execucaoId) "trava não liberada: $($conteudo | ConvertTo-Json -Compress)"
    $fs = [System.IO.File]::Open($travaArq, "Open", "ReadWrite", "None"); $fs.Close()
    "$($comRaiz.Count) chamadas com trava segura; execucaoId único; trava 'livre' e abrível"
  }
  Caso "P-e" "trava deixada por execução INTERROMPIDA → registrada; o destino antigo NÃO é tocado" {
    Escrever $travaArq '{"execucaoId":"11111111-2222-3333-4444-555555555555","pid":999999,"banco":"mariela_restore_20200101_000000"}'
    $x = Restore @{}
    Exigir ($x.Codigo -eq 0 -and $x.Rel.execucaoAnteriorInterrompida.execucaoId -eq "11111111-2222-3333-4444-555555555555") "não registrou a interrompida"
    Exigir (@($x.Chamadas | Where-Object { $_.o.banco -eq "mariela_restore_20200101_000000" }).Count -eq 0) "tocou o destino antigo"
    "registrada; 0 chamadas para o destino antigo"
  }
  Caso "P-f" "-RemoverAoFinal não existe mais (remoção é decisão do operador) → parâmetro recusado" {
    $x = Restore @{} "mariela_restore_20260101_000001" @("-RemoverAoFinal")
    Exigir ($x.Codigo -ne 0 -and $x.Cmds.Count -eq 0) "aceitou -RemoverAoFinal"
    "recusado pelo PowerShell; 0 chamadas"
  }
  Caso "P-g" "segunda verificação divergente (destino mudou após VERIFICADO) → INTERVENCAO, FALHOU_DESTINO_PARCIAL, nada removido" {
    $x = Restore @{ verificar = "intervencao" }
    Exigir ($x.Codigo -eq 1 -and $x.Rel.resultado -eq "FALHOU_DESTINO_PARCIAL" -and $x.Derrubadas.Count -eq 0 -and $x.Rel.estadoDestino -eq "INTERVENCAO_NECESSARIA" -and $x.Rel.exigeIntervencao) "resultado $($x.Rel.resultado) estado $($x.Rel.estadoDestino)"
    "FALHOU_DESTINO_PARCIAL; INTERVENCAO_NECESSARIA; nada removido"
  }

  # ======================= Fase 21.2.6: PASSOU estrito, credencial, processos e operador =======================
  Caso "A01-a" "qualquer condição de PASSOU falhando ⇒ nunca PASSOU (integridade, proteção, posse, vínculo SHA, trava)" {
    $casos = @(@{ integridadeOk = $false; c = "conteudoIntegral" }, @{ protecaoOk = $false; c = "protecaoAtiva" }, @{ estadoInspecao = "VALIDANDO"; c = "posseVerificado" }, @{ shaDivergente = $true; c = "archiveEManifestoVinculados" }, @{ ancoraOk = $false; c = "archiveEManifestoVinculados" }, @{ travaOk = $false; c = "travaEIdentidade" })
    $out = @()
    foreach ($k in $casos) {
      $cen = @{}; foreach ($ch in $k.Keys) { if ($ch -ne "c") { $cen[$ch] = $k[$ch] } }
      $x = Restore $cen
      Exigir ($x.Codigo -eq 1 -and $x.Rel.resultado -ne "PASSOU" -and $x.Rel.exigeIntervencao -and $x.Derrubadas.Count -eq 0) "$($k.c): $($x.Rel.resultado)"
      Exigir ($x.Rel.condicoesPassou.($k.c) -eq $false) "condição $($k.c) não registrada como falsa"
      $out += $k.c
    }
    "$($out.Count) cenários (5 condições + âncora externa divergente) → FALHOU_DESTINO_PARCIAL, nada removido"
  }
  Caso "A03-a" "credenciais SEPARADAS (21.2.8): leituras com RESTORE, transições com GUARDIÃO; a senha nunca aparece em argumento/relatório" {
    $x = Restore @{}
    $leituras = @($x.Chamadas | Where-Object { $_.cmd -in @("preparar-restore", "inspecionar-destino", "verificar-integridade") })
    $transicoes = @($x.Chamadas | Where-Object { $_.cmd -in @("adquirir-posse", "marcar-estado", "congelar-e-verificar") })
    Exigir ($leituras.Count -ge 3 -and @($leituras | Where-Object { $_.credencial -ne "restore" }).Count -eq 0) "leitura sem credencial de restore"
    Exigir ($transicoes.Count -ge 3 -and @($transicoes | Where-Object { $_.credencial -ne "guardiao" }).Count -eq 0) "transição sem credencial de guardião"
    Exigir (@($transicoes | Where-Object { -not $_.o.arquivo -or -not $_.o.manifesto }).Count -eq 0) "transição sem archive/manifesto (âncora externa)"
    $isoladas = $leituras + $transicoes
    $todas = ($x.Chamadas | ConvertTo-Json -Depth 6 -Compress)
    $mr = @($x.Chamadas | Where-Object { $_.cmd -eq "mongorestore" })[0]
    Exigir ($mr.stdin -eq "senha-ficticia-de-teste-restore") "mongorestore não recebeu a senha pelo stdin"
    Exigir ($mr.argumentos -notmatch "senha-ficticia" -and $mr.argumentos -match "--username=usuario_restore") "senha em argumento do mongorestore"
    Exigir (@($x.Chamadas | Where-Object { $_.cmd -ne "mongorestore" -and $_.argumentos -match "senha-ficticia" }).Count -eq 0) "senha em argumento da CLI"
    Exigir (($x.Rel | ConvertTo-Json -Depth 10) -notmatch "senha-ficticia") "senha no relatório"
    $y = Restore @{ semCredencial = $true }
    Exigir ($y.Codigo -eq 1 -and $y.Cmds -notcontains "adquirir-posse" -and $y.Cmds -notcontains "mongorestore") "seguiu sem credencial"
    "$($leituras.Count) leituras (restore) + $($transicoes.Count) transições (guardião, com archive/manifesto); senha só no stdin do mongorestore; sem credencial → recusa antes de escrever"
  }
  Caso "A06-a" "Job Object: matar SÓ o PowerShell do restore durante o mongorestore mata o mongorestore (PS $versaoPs)" {
    $script:n++
    $env:MARIELA_TESTE_CENARIO = Join-Path $raiz "cenario-$($script:n).json"
    $env:MARIELA_TESTE_CHAMADAS = Join-Path $raiz "chamadas-$($script:n).jsonl"
    Escrever $env:MARIELA_TESTE_CENARIO (@{ evidencia = $evOk; preparar = $prepOk; restoreDormir = 60 } | ConvertTo-Json -Depth 6)
    Escrever $env:MARIELA_TESTE_CHAMADAS ""
    $linha = (@("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $copia "restore-test.ps1"), "-ArquivoBackup", $arq, "-BancoDestino", "mariela_restore_20260101_000077", "-Raiz", $raizIsolada, "-Mongorestore", (Join-Path $raiz "mongorestore-stub.cmd"), "-DiretorioRelatorio", (Join-Path $raiz "relatorios")) | ForEach-Object { ConvertTo-ArgumentoProcesso $_ }) -join " "
    $p = Start-Process -FilePath $shell -ArgumentList $linha -WindowStyle Hidden -PassThru
    $filhos = @()
    for ($i = 0; $i -lt 120 -and $filhos.Count -eq 0; $i++) {
      Start-Sleep -Milliseconds 250
      $filhos = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like "*mongorestore-stub.ps1*" -and $_.CommandLine -like "*mariela_restore_20260101_000077*" })
    }
    Exigir ($filhos.Count -eq 1) "o mongorestore (stub) não começou"
    Stop-Process -Id $p.Id -Force
    Start-Sleep -Seconds 2
    $vivo = [bool](Get-Process -Id $filhos[0].ProcessId -ErrorAction SilentlyContinue)
    Exigir (-not $vivo) "o mongorestore SOBREVIVEU à morte do PowerShell"
    "PowerShell $($p.Id) morto com Stop-Process -Force; mongorestore $($filhos[0].ProcessId) encerrado pelo Job Object"
  }
  Caso "A06-b" "Test-DonoVivo (fixtures): inexistente, PID reutilizado, mesmo processo, sem acesso" {
    Exigir (-not (Test-DonoVivo "100" $null)) "inexistente deveria ser encerrado"
    Exigir (-not (Test-DonoVivo "100" "101")) "PID reutilizado (outro horário) deveria ser encerrado"
    Exigir (Test-DonoVivo "100" "100") "mesmo processo deveria estar vivo"
    Exigir (Test-DonoVivo "100" "SEM_ACESSO") "sem acesso deveria ser tratado como vivo"
    Exigir (Test-DonoVivo "" "100") "sem horário registrado deveria ser tratado como vivo"
    $meu = Get-InicioProcesso $PID
    Exigir (Test-DonoVivo $meu (Get-InicioProcesso $PID)) "o próprio processo não foi reconhecido"
    "5 fixtures + processo real"
  }
  Caso "A06-c" "Get-ProcessosDaExecucao encontra processo de QUALQUER nome que cite o destino; ignora a si e aos ancestrais" {
    $marca = "mariela_restore_20260101_000088"
    $dummy = Start-Process -FilePath "cmd.exe" -ArgumentList "/c ping -n 30 127.0.0.1 >nul & rem $marca" -WindowStyle Hidden -PassThru
    try {
      Start-Sleep -Milliseconds 800
      $achados = @(Get-ProcessosDaExecucao @($marca))
      Exigir (@($achados | Where-Object { $_.Pid -eq $dummy.Id }).Count -eq 1) "não encontrou o processo que cita o destino"
      Exigir (@($achados | Where-Object { $_.Pid -eq $PID }).Count -eq 0) "contou a si mesmo"
    } finally { Stop-Process -Id $dummy.Id -Force -ErrorAction SilentlyContinue }
    $depois = @(Get-ProcessosDaExecucao @($marca) | Where-Object { $_.Pid -eq $dummy.Id })
    Exigir ($depois.Count -eq 0) "processo encerrado ainda listado"
    "processo cmd.exe citando o destino encontrado; encerrado → não listado"
  }
  $posseG = @{ execucaoId = "11111111-2222-3333-4444-555555555555"; estado = "VERIFICADO"; archive = $arq; manifesto = ($arq -replace '\.archive\.gz$', '.manifest.json') }
  function ComEstado([string]$E) { $h = $posseG.Clone(); $h.estado = $E; return $h }
  function Gerir([string]$Acao, [hashtable]$Cenario, [string[]]$Extra = @()) {
    if (-not $Cenario.ContainsKey("evidencia")) { $Cenario.evidencia = $evOk }
    $arqs = if ($Acao -ne "Inspecionar" -and -not $Cenario.semArquivos) { @("-ArquivoBackup", $arq, "-Manifesto", ($arq -replace '\.archive\.gz$', '.manifest.json')) } else { @() }
    $r = Rodar "gerir-restore.ps1" $Cenario (@("-Acao", $Acao, "-BancoDestino", "mariela_restore_20260101_000001", "-Raiz", $raizIsolada, "-DiretorioRelatorio", (Join-Path $raiz "relatorios")) + $arqs + $Extra)
    $relArq = Join-Path $raiz ("relatorios\gestao_mariela_restore_20260101_000001_{0}.json" -f $Acao.ToLowerInvariant())
    $rel = if (Test-Path -LiteralPath $relArq) { Get-Content -LiteralPath $relArq -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
    if (Test-Path -LiteralPath $relArq) { Remove-Item -LiteralPath $relArq }
    return [pscustomobject]@{ Codigo = $r.Codigo; Rel = $rel; Chamadas = $r.Chamadas; Cmds = @($r.Chamadas | ForEach-Object { $_.cmd }) }
  }
  Caso "A01-b" "gerir-restore: Liberar exige comando explícito + execucaoId da posse; não remove nada; reprovação vira INTERVENCAO" {
    $sem = Gerir "Liberar" @{ posseGestao = $posseG }
    Exigir ($sem.Codigo -eq 1 -and $sem.Cmds.Count -eq 0) "liberou sem -ExecucaoId"
    $outra = Gerir "Liberar" @{ posseGestao = $posseG } @("-ExecucaoId", "99999999-2222-3333-4444-555555555555")
    Exigir ($outra.Codigo -eq 1 -and $outra.Cmds -notcontains "liberar-restore") "liberou posse de outra execução"
    $ok = Gerir "Liberar" @{ posseGestao = $posseG } @("-ExecucaoId", $posseG.execucaoId)
    Exigir ($ok.Codigo -eq 0 -and $ok.Rel.resultado -eq "LIBERACAO_AUTORIZADA" -and $ok.Cmds -notcontains "limpar-destino") "liberação: $($ok.Rel.resultado)"
    $l = @($ok.Chamadas | Where-Object { $_.cmd -eq "liberar-restore" })[0]
    Exigir ($l.o.'posse-execucao' -eq $posseG.execucaoId -and $l.o.'trava-execucao' -ne $posseG.execucaoId -and $l.credencial -eq "guardiao" -and $l.o.arquivo -eq $arq) "liberar-restore com parâmetros errados"
    $div = Gerir "Liberar" @{ posseGestao = $posseG; liberarOk = $false } @("-ExecucaoId", $posseG.execucaoId)
    Exigir ($div.Codigo -eq 1 -and $div.Rel.estadoDepois -eq "INTERVENCAO_NECESSARIA") "divergência não virou INTERVENCAO"
    "sem/errado -ExecucaoId → recusado; ok → LIBERACAO_AUTORIZADA sem remoção; divergente → INTERVENCAO_NECESSARIA"
  }
  Caso "A02-a" "gerir-restore: Remover usa a limpeza comprovada (modo remocao), nunca derrubar-restore; recusa → INTERVENCAO" {
    $ok = Gerir "Remover" @{ posseGestao = $posseG } @("-ExecucaoId", $posseG.execucaoId)
    $l = @($ok.Chamadas | Where-Object { $_.cmd -eq "limpar-destino" })
    Exigir ($ok.Codigo -eq 0 -and $ok.Rel.resultado -eq "CANCELADO_COM_LIMPEZA_COMPROVADA" -and $l.Count -eq 1 -and $l[0].o.modo -eq "remocao" -and $ok.Cmds -notcontains "derrubar-restore") "remoção: $($ok.Rel.resultado)"
    $rec = Gerir "Remover" @{ posseGestao = $posseG; limparOk = $false } @("-ExecucaoId", $posseG.execucaoId)
    Exigir ($rec.Codigo -eq 1 -and $rec.Rel.resultado -eq "INTERVENCAO_NECESSARIA") "recusa: $($rec.Rel.resultado)"
    $mdb = Rodar "gerir-restore.ps1" @{ evidencia = $evOk } @("-Acao", "Remover", "-BancoDestino", "marielaDB", "-ExecucaoId", $posseG.execucaoId, "-Raiz", $raizIsolada)
    Exigir ($mdb.Codigo -eq 1 -and @($mdb.Chamadas).Count -eq 0) "aceitou marielaDB"
    "Remover → limpar-destino --modo remocao → CANCELADO_COM_LIMPEZA_COMPROVADA; recusa → INTERVENCAO_NECESSARIA; marielaDB recusado sem chamadas"
  }
  Caso "A21-7-02" "âncora externa: Verificar/Liberar/IniciarUso/Remover/Descartar SEM archive+manifesto do operador → recusados sem nenhuma chamada" {
    $out = @()
    foreach ($ac in "Verificar", "Liberar", "IniciarUso", "Remover", "Descartar") {
      $x = Gerir $ac @{ posseGestao = $posseG; semArquivos = $true } @("-ExecucaoId", $posseG.execucaoId, "-ConfirmarBanco", "mariela_restore_20260101_000001")
      Exigir ($x.Codigo -eq 1 -and $x.Cmds.Count -eq 0) "$ac aceitou sem archive/manifesto"
      $out += $ac
    }
    $insp = Gerir "Inspecionar" @{ posseGestao = $posseG }
    Exigir ($insp.Codigo -eq 0) "Inspecionar (só leitura) deveria dispensar os arquivos"
    "$($out -join ', ') → recusados; Inspecionar (só leitura) dispensa"
  }
  Caso "A21-7-05" "ciclo de vida: IniciarUso exige -ConfirmarBanco e o guardião; Descartar usa o modo 'descarte'; nenhum descongela sem comando explícito" {
    $sem = Gerir "IniciarUso" @{ posseGestao = $posseG } @("-ExecucaoId", $posseG.execucaoId)
    Exigir ($sem.Codigo -eq 1 -and $sem.Cmds.Count -eq 0) "IniciarUso sem -ConfirmarBanco aceito"
    $errado = Gerir "IniciarUso" @{ posseGestao = $posseG } @("-ExecucaoId", $posseG.execucaoId, "-ConfirmarBanco", "mariela_restore_20260101_000002")
    Exigir ($errado.Codigo -eq 1 -and $errado.Cmds.Count -eq 0) "IniciarUso com -ConfirmarBanco errado aceito"
    $ok = Gerir "IniciarUso" @{ posseGestao = (ComEstado "LIBERACAO_AUTORIZADA") } @("-ExecucaoId", $posseG.execucaoId, "-ConfirmarBanco", "mariela_restore_20260101_000001")
    $u = @($ok.Chamadas | Where-Object { $_.cmd -eq "iniciar-uso" })
    Exigir ($ok.Codigo -eq 0 -and $ok.Rel.resultado -eq "EM_USO" -and $u.Count -eq 1 -and $u[0].credencial -eq "guardiao" -and $u[0].o.'confirmar-banco' -eq "mariela_restore_20260101_000001") "IniciarUso: $($ok.Rel.resultado)"
    $lib = Gerir "Liberar" @{ posseGestao = $posseG } @("-ExecucaoId", $posseG.execucaoId)
    Exigir ($lib.Cmds -notcontains "iniciar-uso") "Liberar disparou descongelamento"
    $semD = Gerir "Descartar" @{ posseGestao = (ComEstado "EM_USO") } @("-ExecucaoId", $posseG.execucaoId)
    Exigir ($semD.Codigo -eq 1 -and $semD.Cmds.Count -eq 0) "Descartar sem -ConfirmarBanco aceito"
    $d = Gerir "Descartar" @{ posseGestao = (ComEstado "EM_USO") } @("-ExecucaoId", $posseG.execucaoId, "-ConfirmarBanco", "mariela_restore_20260101_000001")
    $l = @($d.Chamadas | Where-Object { $_.cmd -eq "limpar-destino" })
    Exigir ($d.Codigo -eq 0 -and $d.Rel.resultado -eq "DESCARTADO" -and $l.Count -eq 1 -and $l[0].o.modo -eq "descarte" -and $l[0].credencial -eq "guardiao") "Descartar: $($d.Rel.resultado)"
    "IniciarUso: sem/errado -ConfirmarBanco → recusado; ok → EM_USO (guardião); Liberar não descongela; Descartar → modo 'descarte' → DESCARTADO"
  }
  Caso "A06-d" "recuperar-destino: recusa VERIFICADO, dono vivo e processo que cita o destino; só então limpa (modo recuperacao)" {
    $base = @{ execucaoId = "11111111-2222-3333-4444-555555555555"; archive = $arq; manifesto = ($arq -replace '\.archive\.gz$', '.manifest.json'); archiveSha256 = (Get-Sha256 $arq); manifestoSha256 = (Get-Sha256 ($arq -replace '\.archive\.gz$', '.manifest.json')) }
    $rodar = { param($posse, [switch]$Remover, [switch]$SemArquivos) $a = @("-BancoDestino", "mariela_restore_20260101_000001", "-Raiz", $raizIsolada, "-DiretorioRelatorio", (Join-Path $raiz "relatorios")); if ($Remover) { $a += "-Remover"; if (-not $SemArquivos) { $a += @("-ArquivoBackup", $arq, "-Manifesto", ($arq -replace '\.archive\.gz$', '.manifest.json')) } }; Rodar "recuperar-destino.ps1" @{ evidencia = $evOk; posseGestao = $posse } $a }
    $v = & $rodar ($base + @{ estado = "VERIFICADO"; pid = 999999; processoInicioTicks = "1" }) -Remover
    Exigir ($v.Codigo -eq 1 -and @($v.Chamadas | Where-Object { $_.cmd -eq "limpar-destino" }).Count -eq 0) "limpou VERIFICADO"
    $vivo = & $rodar ($base + @{ estado = "RESTAURANDO"; pid = $PID; processoInicioTicks = (Get-InicioProcesso $PID) }) -Remover
    Exigir ($vivo.Codigo -eq 1 -and @($vivo.Chamadas | Where-Object { $_.cmd -eq "limpar-destino" }).Count -eq 0) "limpou com o dono vivo"
    $reuso = & $rodar ($base + @{ estado = "RESTAURANDO"; pid = $PID; processoInicioTicks = "12345" }) -Remover
    Exigir ($reuso.Codigo -eq 0 -and @($reuso.Chamadas | Where-Object { $_.cmd -eq "limpar-destino" -and $_.o.modo -eq "recuperacao" }).Count -eq 1) "PID reutilizado deveria contar como encerrado"
    $dummy = Start-Process -FilePath "cmd.exe" -ArgumentList "/c ping -n 30 127.0.0.1 >nul & rem mariela_restore_20260101_000001" -WindowStyle Hidden -PassThru
    try {
      Start-Sleep -Milliseconds 800
      $orfao = & $rodar ($base + @{ estado = "RESTAURANDO"; pid = 999999; processoInicioTicks = "1" }) -Remover
    } finally { Stop-Process -Id $dummy.Id -Force -ErrorAction SilentlyContinue }
    Exigir ($orfao.Codigo -eq 1 -and @($orfao.Chamadas | Where-Object { $_.cmd -eq "limpar-destino" }).Count -eq 0) "limpou com processo órfão citando o destino"
    $semArq = & $rodar ($base + @{ estado = "RESTAURANDO"; pid = 999999; processoInicioTicks = "1" }) -Remover -SemArquivos
    Exigir ($semArq.Codigo -eq 1 -and @($semArq.Chamadas).Count -eq 0) "-Remover sem archive/manifesto do operador foi aceito"
    foreach ($e in "REMOVENDO", "CANCELADO_COM_LIMPEZA_COMPROVADA") {
      $rr = & $rodar ($base + @{ estado = $e; pid = 999999; processoInicioTicks = "1" }) -Remover
      $li = @($rr.Chamadas | Where-Object { $_.cmd -eq "limpar-destino" })
      Exigir ($rr.Codigo -eq 0 -and $li.Count -eq 1 -and $li[0].o.modo -eq "recuperacao" -and $li[0].credencial -eq "guardiao" -and $li[0].o.arquivo -eq $arq) "estado $e não retomado pela recuperação"
    }
    "VERIFICADO → recusado; dono vivo → recusado; PID reutilizado → limpeza; órfão citando o destino → recusado; sem archive do operador → recusado; REMOVENDO e CANCELADO órfão → retomados (guardião, archive do operador)"
  }
} finally {
  Remove-Item Env:MARIELA_TESTE_CENARIO, Env:MARIELA_TESTE_CHAMADAS -ErrorAction SilentlyContinue
  $resultados | Format-Table -AutoSize -Wrap | Out-String -Width 220 | Write-Host
  $falhas = @($resultados | Where-Object { $_.Resultado -ne "PASSOU" }).Count
  Write-Host ("PowerShell {0}: {1} casos, {2} PASSOU, {3} FALHOU" -f $versaoPs, $resultados.Count, ($resultados.Count - $falhas), $falhas)
  if (-not $ManterArtefatos) { Remove-Item -LiteralPath $raiz -Recurse -Force -ErrorAction SilentlyContinue }
}
if ($falhas) { exit 1 } else { exit 0 }
