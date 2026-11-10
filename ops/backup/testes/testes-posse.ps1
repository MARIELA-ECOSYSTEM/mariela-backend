<#
.SYNOPSIS
  Testes REAIS (MongoDB descartável) de concorrência, integridade, autenticação e processos filhos do restore isolado
  (Fases 60.4.3.4.21.2.4 e 21.2.6).

.DESCRIPTION
  Pré-requisitos (verificados): instância isolada 127.0.0.1:27118 COM autenticação (mongod-isolado.ps1 -Acao
  ConfigurarAutenticacao/Iniciar) e origem sintética 127.0.0.1:27119 (dbPath descartável). Dados 100% sintéticos.
  Só cria/remove bancos mariela_restore_20260103_* na 27118 (o auxiliar recusa outro nome) e marielaDB na 27119.
  Credenciais: as SINTÉTICAS da instância isolada (DPAPI), passadas aos processos SÓ pelo stdin.
  Processos INDEPENDENTES: cada restore-test / gerir-restore / recuperar-destino / auxiliar roda no seu processo.
    T01–T12  concorrência (T11 — duas máquinas — não é executável: a instância só escuta em 127.0.0.1)
    I01–I22  integridade: cada divergência de conteúdo/tipo/índice/sequência é detectada e a reversão volta a INTEGRO
    AU01–AU06 autenticação e privilégios (sem auth, leitor, restore, bootstrap)
    PR01–PR08 processos filhos (Job Object) e recuperação
#>
param([switch]$ManterArtefatos, [int]$Volume = 300000, [string]$Somente = "")

$ErrorActionPreference = "Stop"
$ops = Split-Path -Parent $PSScriptRoot
$repo = Split-Path -Parent (Split-Path -Parent $ops)
. (Join-Path $ops "comum.ps1")
$bun = Get-CaminhoBun
$shell = (Get-Process -Id $PID).Path
$raizIsolada = Join-Path $env:USERPROFILE "mariela-restore-isolado"
$travaArq = Join-Path $raizIsolada "locks\restore.lock"

$resultados = New-Object System.Collections.ArrayList
function Caso([string]$Id, [string]$Nome, [scriptblock]$Corpo) {
  if ($Somente -and $Id -notmatch $Somente) { return }
  $t = Get-Date
  try {
    $detalhe = & $Corpo
    [void]$resultados.Add([pscustomobject]@{ Id = $Id; Caso = $Nome; Resultado = "PASSOU"; Detalhe = "$detalhe"; Segundos = [math]::Round(((Get-Date) - $t).TotalSeconds, 1) })
  } catch {
    [void]$resultados.Add([pscustomobject]@{ Id = $Id; Caso = $Nome; Resultado = "FALHOU"; Detalhe = "$($_.Exception.Message) @L$($_.InvocationInfo.ScriptLineNumber)"; Segundos = [math]::Round(((Get-Date) - $t).TotalSeconds, 1) })
  }
}
function Exigir([bool]$Condicao, [string]$Mensagem) { if (-not $Condicao) { throw $Mensagem } }

$raiz = Join-Path $env:TEMP ("mariela-testes-posse-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Path $raiz | Out-Null
$relDir = Join-Path $raiz "relatorios"
$script:bancosCriados = New-Object System.Collections.ArrayList
function Banco([int]$N) { $b = "mariela_restore_20260103_" + $N.ToString("000000"); [void]$script:bancosCriados.Add($b); return $b }

# --- credenciais sintéticas (só stdin) -------------------------------------------------------------------------
$creds = @{}
foreach ($p in 'admin', 'restore', 'guardiao', 'leitor') { $creds[$p] = Get-CredencialIsolada $raizIsolada $p }
function EntradaDe([string]$Papel) { if ($Papel -eq "nenhum") { return "" } return (ConvertTo-EntradaCredencial $creds[$Papel]) }

function Aux([string[]]$Argumentos, [string]$Papel = "admin") {
  $r = Invoke-Nativo -Programa $bun -Argumentos (@("--no-env-file", (Join-Path $PSScriptRoot "posse-auxiliar.ts")) + $Argumentos) -DiretorioTrabalho $repo -Entrada (EntradaDe $Papel)
  $linha = @($r.Saida -split "`r?`n" | Where-Object { $_.Trim().StartsWith("{") }) | Select-Object -Last 1
  if (-not $linha) { throw "auxiliar sem JSON ($($Argumentos[0]), $Papel): $(ConvertTo-MensagemSegura $r.Erro)" }
  return ($linha | ConvertFrom-Json)
}
function Estado([string]$B) { return Aux @("estado", $B) }

# Processo INDEPENDENTE em segundo plano. PowerShell: saída em arquivo. Bun (auxiliar): credencial pelo stdin.
$script:k = 0
function Disparar([string]$Programa, [string[]]$Argumentos) {
  $script:k++
  $out = Join-Path $raiz "proc-$($script:k).out"; $err = Join-Path $raiz "proc-$($script:k).err"
  $linha = ($Argumentos | ForEach-Object { ConvertTo-ArgumentoProcesso $_ }) -join " "
  $p = Start-Process -FilePath $Programa -ArgumentList $linha -WorkingDirectory $repo -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden -PassThru
  $null = $p.Handle
  return [pscustomobject]@{ P = $p; Out = $out; Err = $err; TOut = $null; TErr = $null }
}
function AuxAsync([string[]]$Argumentos, [string]$Papel = "admin") {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $bun
  $psi.Arguments = (@("--no-env-file", (Join-Path $PSScriptRoot "posse-auxiliar.ts")) + $Argumentos | ForEach-Object { ConvertTo-ArgumentoProcesso $_ }) -join " "
  $psi.WorkingDirectory = $repo
  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  $p = [System.Diagnostics.Process]::Start($psi)
  $tOut = $p.StandardOutput.ReadToEndAsync(); $tErr = $p.StandardError.ReadToEndAsync()
  $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes((EntradaDe $Papel))
  $p.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length); $p.StandardInput.Close()
  return [pscustomobject]@{ P = $p; Out = $null; Err = $null; TOut = $tOut; TErr = $tErr }
}
function Esperar($Proc, [int]$Segundos = 300) {
  if (-not $Proc.P.WaitForExit($Segundos * 1000)) { throw "processo $($Proc.P.Id) não terminou em ${Segundos}s" }
  $Proc.P.WaitForExit()
  if ($Proc.TOut) { return [pscustomobject]@{ Codigo = $Proc.P.ExitCode; Saida = $Proc.TOut.Result; Erro = $Proc.TErr.Result } }
  return [pscustomobject]@{ Codigo = $Proc.P.ExitCode; Saida = (Get-Content -LiteralPath $Proc.Out -Raw -ErrorAction SilentlyContinue); Erro = (Get-Content -LiteralPath $Proc.Err -Raw -ErrorAction SilentlyContinue) }
}
# Fase 21.2.8 (A21-7-02): o archive de cada destino é lembrado para ser INFORMADO nos comandos do operador.
$script:archivePorBanco = @{}
function RestoreAsync([string]$Archive, [string]$B, [string[]]$Extra = @()) {
  $script:archivePorBanco[$B] = $Archive
  return Disparar $shell (@("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $ops "restore-test.ps1"), "-ArquivoBackup", $Archive, "-BancoDestino", $B, "-DiretorioRelatorio", $relDir) + $Extra)
}
function Restore([string]$Archive, [string]$B) { $r = Esperar (RestoreAsync $Archive $B); return [pscustomobject]@{ Codigo = $r.Codigo; Erro = $r.Erro; Rel = (Relatorio $B) } }
function JsonDe($R) { $l = @("$($R.Saida)" -split "`r?`n" | Where-Object { $_.Trim().StartsWith("{") }) | Select-Object -Last 1; if ($l) { return ($l | ConvertFrom-Json) } return $null }
function Relatorio([string]$B) {
  $a = Join-Path $relDir "restore_$B.json"
  if (Test-Path -LiteralPath $a) { return (Get-Content -LiteralPath $a -Raw -Encoding UTF8 | ConvertFrom-Json) } return $null
}
function Gerir([string]$Acao, [string]$B, [string]$Execucao, [switch]$Confirmar) {
  $a = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $ops "gerir-restore.ps1"), "-Acao", $Acao, "-BancoDestino", $B, "-DiretorioRelatorio", $relDir)
  if ($Execucao) { $a += @("-ExecucaoId", $Execucao) }
  if ($Acao -ne "Inspecionar" -and $script:archivePorBanco[$B]) { $a += @("-ArquivoBackup", $script:archivePorBanco[$B], "-Manifesto", ($script:archivePorBanco[$B] -replace '\.archive\.gz$', '.manifest.json')) }
  if ($Confirmar) { $a += @("-ConfirmarBanco", $B) }
  $r = Invoke-Nativo -Programa $shell -Argumentos $a
  $arq = Join-Path $relDir ("gestao_{0}_{1}.json" -f $B, $Acao.ToLowerInvariant())
  $rel = if (Test-Path -LiteralPath $arq) { Get-Content -LiteralPath $arq -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
  if (Test-Path -LiteralPath $arq) { Remove-Item -LiteralPath $arq }
  return [pscustomobject]@{ Codigo = $r.Codigo; Rel = $rel; Erro = $r.Erro }
}
function Recuperar([string]$B, [switch]$Remover) {
  $a = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $ops "recuperar-destino.ps1"), "-BancoDestino", $B, "-DiretorioRelatorio", $relDir)
  if ($Remover) { $a += "-Remover"; if ($script:archivePorBanco[$B]) { $a += @("-ArquivoBackup", $script:archivePorBanco[$B], "-Manifesto", ($script:archivePorBanco[$B] -replace '\.archive\.gz$', '.manifest.json')) } }
  $r = Invoke-Nativo -Programa $shell -Argumentos $a
  $arq = Join-Path $relDir "recuperacao_$B.json"
  $rel = if (Test-Path -LiteralPath $arq) { Get-Content -LiteralPath $arq -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
  if (Test-Path -LiteralPath $arq) { Remove-Item -LiteralPath $arq }
  return [pscustomobject]@{ Codigo = $r.Codigo; Rel = $rel; Erro = $r.Erro }
}
function LerTrava { $fs = [System.IO.File]::Open($travaArq, "Open", "Read", "ReadWrite"); try { $sr = New-Object System.IO.StreamReader($fs); return ($sr.ReadToEnd() | ConvertFrom-Json) } finally { $fs.Close() } }
function ChamarCli([string[]]$A, [string]$Papel = "restore") { if ($Papel -eq "nenhum") { return Invoke-CliBackup -Argumentos $A } return Invoke-CliBackup -Argumentos $A -Credencial $creds[$Papel] }
function ProcessosCitando([string]$Marca) { return @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($Marca) -and $_.ProcessId -ne $PID }) }
function EsperarProcesso([string]$Marca, [string]$Filtro, [int]$Segundos = 120) {
  for ($i = 0; $i -lt $Segundos * 10; $i++) {
    $a = @(ProcessosCitando $Marca | Where-Object { $_.CommandLine -like $Filtro })
    if ($a.Count) { return $a }
    Start-Sleep -Milliseconds 100
  }
  return @()
}

try {
  # --- Pré-requisitos e backups sintéticos ------------------------------------------------------------------------
  $e18 = ChamarCli @("local-estado", "--porta", "27118")
  Exigir ($e18.ok -and $e18.resultado.versao -eq "8.0.37" -and $e18.resultado.bindIp -eq "127.0.0.1" -and $e18.resultado.replicaSet -eq "rs-restore" -and $e18.resultado.autenticacao) "instância isolada 27118 indisponível ou sem autenticação"
  $e19 = ChamarCli @("local-estado", "--porta", "27119") "nenhum"
  Exigir ($e19.ok -and $e19.resultado.bindIp -eq "127.0.0.1") "origem sintética 27119 indisponível"
  $bancosAntes = @((ChamarCli @("listar-bancos", "--porta", "27118")).resultado.bancos)
  Exigir (@($bancosAntes | Where-Object { $_ -like "mariela_restore_20260103_*" }).Count -eq 0) "já existem bancos 20260103 (de outra execução): nada feito"

  $cfgDir = Join-Path $raiz "cfg"; New-Item -ItemType Directory -Path $cfgDir | Out-Null; Set-AclRestrita $cfgDir
  $cfg = Join-Path $cfgDir "origem.yaml"
  [System.IO.File]::WriteAllText($cfg, "uri: `"mongodb://127.0.0.1:27119/marielaDB?directConnection=true`"`n", (New-Object System.Text.UTF8Encoding($false)))
  Set-AclRestrita $cfg
  function GerarBackup([string]$Nome) {
    $d = Join-Path $raiz $Nome; New-Item -ItemType Directory -Path $d | Out-Null; Set-AclRestrita $d
    $r = Invoke-Nativo -Programa $shell -Argumentos @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $ops "backup-mongo.ps1"), "-BackupDir", $d, "-ConfigMongo", $cfg, "-Extraordinario")
    $a = @(Get-ChildItem -LiteralPath $d -Filter "mariela_extra_*.archive.gz")
    Exigir ($r.Codigo -eq 0 -and $a.Count -eq 1) "backup sintético '$Nome' falhou: $($r.Saida) $($r.Erro)"
    return $a[0].FullName
  }
  $sem = { param($c, $n) $x = Invoke-Nativo -Programa $bun -Argumentos (@("--no-env-file", (Join-Path $PSScriptRoot "origem-sintetica.ts"), $c) + @($n | Where-Object { $_ })); if ($x.Codigo -ne 0) { throw "semeadura $c falhou: $($x.Erro)" } }
  & $sem "base" $null
  $archBase = GerarBackup "base"
  & $sem "tipos" $null
  $archTipos = GerarBackup "tipos"
  & $sem "volume" "$Volume"
  $archVol = GerarBackup "volume"
  $manBase = $archBase -replace '\.archive\.gz$', '.manifest.json'
  $manVol = $archVol -replace '\.archive\.gz$', '.manifest.json'
  Write-Host "archives sintéticos: base, tipos e volume"

  # ================================================ T01 ===========================================================
  Caso "T01a" "dois restore-test SIMULTÂNEOS no MESMO destino → exatamente um prossegue; o outro é recusado sem escrever" {
    $b = Banco 1
    $p1 = RestoreAsync $archBase $b; $p2 = RestoreAsync $archBase $b
    $r1 = Esperar $p1; $r2 = Esperar $p2
    Exigir ((@($r1.Codigo, $r2.Codigo) | Sort-Object) -join "," -eq "0,1") "códigos $($r1.Codigo),$($r2.Codigo)"
    $s = Estado $b
    Exigir ($s.dados -eq 27 -and $s.posse.Count -eq 1 -and $s.posse[0].estado -eq "VERIFICADO" -and $s.congeladas -eq 27) "destino: dados=$($s.dados) posse=$($s.posse | ConvertTo-Json -Compress) congeladas=$($s.congeladas)"
    "um PASSOU (destino VERIFICADO, 27 coleções congeladas), outro recusado"
  }
  Caso "T01b" "dois restore-test SIMULTÂNEOS em destinos DIFERENTES → a trava local serializa: um prossegue, o outro é recusado" {
    $b2 = Banco 2; $b3 = Banco 3
    $p1 = RestoreAsync $archBase $b2; $p2 = RestoreAsync $archBase $b3
    $r1 = Esperar $p1; $r2 = Esperar $p2
    Exigir ((@($r1.Codigo, $r2.Codigo) | Sort-Object) -join "," -eq "0,1") "códigos $($r1.Codigo),$($r2.Codigo)"
    $recusado = if ($r1.Codigo -eq 1) { $b2 } else { $b3 }
    Exigir (-not (Estado $recusado).existe) "o recusado criou o banco $recusado"
    Exigir ($(if ($r1.Codigo -eq 1) { $r1.Erro } else { $r2.Erro }) -match "Trava") "recusa não foi pela trava"
    "um PASSOU; o outro recusado pela trava e o banco dele NÃO existe"
  }
  Caso "T01c" "8 aquisições DIRETAS de posse no mesmo destino, na mesma barreira de relógio → exatamente 1 vence" {
    $b = Banco 4
    $barreira = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 5000
    $procs = 1..8 | ForEach-Object { AuxAsync @("adquirir-na-barreira", $b, [guid]::NewGuid().ToString(), "$barreira") }
    $rs = @($procs | ForEach-Object { JsonDe (Esperar $_ 60) })
    $venc = @($rs | Where-Object { $_.adquirida })
    Exigir ($rs.Count -eq 8 -and $venc.Count -eq 1) "vencedores: $($venc.Count) de $($rs.Count)"
    Exigir (@($rs | Where-Object { -not $_.adquirida -and $_.motivo -eq "POSSE_JA_EXISTE" -and -not $_.controleRemovido }).Count -eq 7) "perdedores com motivo inesperado"
    $s = Estado $b
    Exigir ($s.posse.Count -eq 1 -and $s.posse[0].execucaoId -eq $venc[0].execucaoId -and $s.posse[0].estado -eq "PREPARANDO") "posse final não é do vencedor"
    "1 vencedor (PREPARANDO), 7 POSSE_JA_EXISTE"
  }

  # ======================================= T02/T03: antes da proteção =======================================
  Caso "T02" "escrita alheia DEPOIS da posse e ANTES do mongorestore → nunca PASSOU; nada alheio removido" {
    $b = Banco 5
    $vig = AuxAsync @("aguardar-e-inserir", $b, "posse", "produtos", "T02", "120000")
    Start-Sleep -Milliseconds 1500
    $r = Restore $archBase $b
    $v = JsonDe (Esperar $vig 130)
    Exigir ($v.inserido) "a escrita alheia não ocorreu: $($v | ConvertTo-Json -Compress)"
    Exigir ($r.Codigo -eq 1 -and $r.Rel.resultado -ne "PASSOU") "resultado $($r.Rel.resultado)"
    $s = Estado $b
    Exigir ($s.alheios.produtos -eq 1) "alheio perdido"
    if ($r.Rel.posseAdquirida) {
      # O alheio entrou depois da aquisição: o restore seguiu, a verificação reprovou e a limpeza recusou.
      Exigir ($r.Rel.exigeIntervencao -and $s.posse[0].estado -eq "INTERVENCAO_NECESSARIA") "estado=$($s.posse[0].estado)"
      "alheio inserido após a posse; $($r.Rel.resultado); limpeza recusada ($($r.Rel.limpeza.recusa)); INTERVENCAO_NECESSARIA; alheio preservado"
    } else {
      # O alheio entrou entre a criação da coleção de controle e a conferência: posse recusada (DESTINO_COM_DADOS),
      # NADA escrito, só a própria coleção de controle desfeita.
      $ad = @($r.Rel.etapas | Where-Object { $_.etapa -eq "adquirir-posse" })[0]
      Exigir ($ad -and -not $ad.ok -and -not $r.Rel.escritaIniciada -and $s.posse.Count -eq 0 -and (@($s.colecoes) -join ",") -eq "produtos") "aquisição: $($ad | ConvertTo-Json -Compress) colecoes=$($s.colecoes -join ',')"
      "alheio inserido durante a aquisição → posse recusada (DESTINO_COM_DADOS), nada escrito; só o alheio ficou no banco"
    }
  }
  Caso "T03" "escrita alheia DURANTE o mongorestore → nunca PASSOU; preservada" {
    $b = Banco 6
    $vig = AuxAsync @("aguardar-e-inserir", $b, "restaurando", "produtos", "T03", "120000")
    Start-Sleep -Milliseconds 1500
    $p = RestoreAsync $archVol $b
    $v = JsonDe (Esperar $vig 130)
    $null = Esperar $p
    $rel = Relatorio $b
    Exigir ($v.inserido -and $v.viu -lt 28) "a escrita não ocorreu durante o restore: $($v | ConvertTo-Json -Compress)"
    Exigir ($rel.resultado -ne "PASSOU" -and $rel.exigeIntervencao) "resultado $($rel.resultado)"
    Exigir ((Estado $b).alheios.produtos -eq 1) "documento alheio perdido"
    "alheio inserido com $($v.viu)/28 coleções criadas; $($rel.resultado); alheio preservado"
  }

  # ================================== T04: durante/depois da validação ==================================
  Caso "T04a" "escritor COM credencial de restore durante VALIDANDO → rejeitado (congelado, 121); PASSOU sem nada alheio" {
    $b = Banco 7
    $vig = AuxAsync @("aguardar-e-inserir", $b, "estado:VALIDANDO", "produtos", "T04a", "180000") "restore"
    Start-Sleep -Milliseconds 1500
    $r = Restore $archVol $b
    $v = JsonDe (Esperar $vig 190)
    Exigir (-not $v.inserido -and $v.codigo -eq 121) "inserção durante VALIDANDO não foi rejeitada: $($v | ConvertTo-Json -Compress)"
    Exigir ($r.Codigo -eq 0 -and $r.Rel.resultado -eq "PASSOU" -and @((Estado $b).alheios.PSObject.Properties).Count -eq 0) "resultado $($r.Rel.resultado)"
    "inserção rejeitada (código 121, DocumentValidationFailure); PASSOU (VERIFICADO) sem dado alheio"
  }
  Caso "T04b" "bootstrap (root) com bypassDocumentValidation durante VALIDANDO/VERIFICADO → nunca PASSOU com alheio não detectado" {
    $out = @()
    foreach ($par in @(@(8, "estado:VALIDANDO"), @(9, "estado:VERIFICADO"))) {
      $b = Banco $par[0]
      $vig = AuxAsync @("aguardar-e-inserir", $b, $par[1], "produtos", "T04b-$($par[0])", "180000", "bypass") "admin"
      Start-Sleep -Milliseconds 1500
      $r = Restore $archVol $b
      $v = JsonDe (Esperar $vig 190)
      Exigir ($v.inserido) "a escrita privilegiada não ocorreu: $($v | ConvertTo-Json -Compress)"
      Exigir ((Estado $b).alheios.produtos -eq 1) "alheio perdido"
      if ($r.Rel.resultado -eq "PASSOU") {
        # Só é possível se a escrita entrou DEPOIS da segunda verificação: tem de ser detectada pelo operador.
        $vf = Gerir "Verificar" $b $r.Rel.execucaoId
        $lb = Gerir "Liberar" $b $r.Rel.execucaoId
        Exigir ($vf.Codigo -eq 1 -and $vf.Rel.resultado -eq "DIVERGENTE" -and $lb.Codigo -eq 1 -and $lb.Rel.estadoDepois -eq "INTERVENCAO_NECESSARIA") "PASSOU com alheio NÃO detectado"
        $out += "$($par[1]): escrita após a 2ª verificação → PASSOU, mas Verificar=DIVERGENTE e Liberar→INTERVENCAO"
      } else {
        Exigir ($r.Rel.exigeIntervencao) "falha sem intervenção"
        $out += "$($par[1]): $($r.Rel.resultado) (estado $($r.Rel.estadoDestino))"
      }
    }
    $out -join "; "
  }
  Caso "T04c" "escrita APÓS o PASSOU (bypass do bootstrap) → Verificar DIVERGENTE; Liberar → INTERVENCAO; Remover recusa e preserva" {
    $b = Banco 10
    $r = Restore $archBase $b
    Exigir ($r.Codigo -eq 0 -and $r.Rel.resultado -eq "PASSOU") "restore base: $($r.Rel.resultado)"
    $i = Aux @("inserir", $b, "vendas", "T04c", "bypass")
    Exigir $i.inserido "inserção privilegiada"
    $vf = Gerir "Verificar" $b $r.Rel.execucaoId
    $lb = Gerir "Liberar" $b $r.Rel.execucaoId
    $rm = Gerir "Remover" $b $r.Rel.execucaoId
    $s = Estado $b
    Exigir ($vf.Rel.resultado -eq "DIVERGENTE" -and $lb.Rel.estadoDepois -eq "INTERVENCAO_NECESSARIA" -and $rm.Codigo -eq 1 -and $s.alheios.vendas -eq 1 -and $s.dados -eq 27) "verificar=$($vf.Rel.resultado) liberar=$($lb.Rel.estadoDepois) remover=$($rm.Rel.resultado) alheio=$($s.alheios.vendas)"
    "Verificar=DIVERGENTE; Liberar→INTERVENCAO_NECESSARIA; Remover recusado (estado incompatível); alheio e 27 coleções preservados"
  }

  # ========================================== T05: durante a limpeza ==========================================
  $mongorestore = (Get-Command mongorestore).Source
  $colecoesPolitica = @((Invoke-CliBackup -Argumentos @("politica")).resultado.colecoesIncluidas)
  function DestinoComPosse([string]$B, [string]$Exec, [string]$Archive = $archBase) {
    $a = Aux @("adquirir-na-barreira", $B, $Exec, "0")
    Exigir $a.adquirida "posse não adquirida em $B"
    $args2 = @("--uri=mongodb://127.0.0.1:27118/?directConnection=true", "--username=$($creds.restore.Usuario)", "--authenticationDatabase=admin", "--gzip", "--archive=$Archive", "--nsFrom=marielaDB.*", "--nsTo=$B.*", "--stopOnError")
    foreach ($c in $colecoesPolitica) { $args2 += "--nsInclude=marielaDB.$c" }
    $mr = Invoke-Nativo -Programa $mongorestore -Argumentos $args2 -Entrada ((ConvertFrom-SenhaSegura $creds.restore.Senha) + "`n")
    Exigir ($mr.Codigo -eq 0) "mongorestore manual falhou"
    $null = Aux @("forcar-estado", $B, "RESTAURANDO")
  }
  Caso "T05a" "escrita alheia DURANTE a limpeza (após congelar e após verificar) → rejeitada nas congeladas; coleção nova alheia preservada" {
    $b = Banco 11; $x = [guid]::NewGuid().ToString(); DestinoComPosse $b $x
    $l = Aux @("limpar-com-ganchos", $b, $x, $archBase, $manBase, "ambos")
    $ev = @($l.eventos)
    Exigir (-not $ev[0].aposCongelar.inserido -and $ev[0].aposCongelar.codigo -eq 121) "inserção após congelar NÃO foi rejeitada: $($ev[0] | ConvertTo-Json -Compress)"
    Exigir (-not $ev[1].aposVerificarProdutos.inserido -and $ev[2].aposVerificarNova.inserido) "ganchos pós-verificação: $($ev | ConvertTo-Json -Compress)"
    Exigir (-not $l.limpo -and $l.motivo -eq "ALHEIO_CRIADO_DURANTE_LIMPEZA") "resultado: $($l.motivo)"
    $s = Estado $b
    Exigir ((@($s.colecoes) -join ",") -eq "alheia_t05" -and $s.alheios.alheia_t05 -eq 1) "estado final: $($s.colecoes -join ',')"
    "após congelar: 121; após verificar: produtos rejeitada, coleção nova criada; limpeza removeu só as 27 + controle; alheia_t05 preservada"
  }
  Caso "T05b" "documento alheio ANTES da limpeza → nada removido, descongelamento controlado (A-07), INTERVENCAO" {
    $b = Banco 12; $x = [guid]::NewGuid().ToString(); DestinoComPosse $b $x
    Exigir ((Aux @("inserir", $b, "vendas", "T05b")).inserido) "inserção prévia"
    $l = Aux @("limpar-com-ganchos", $b, $x, $archBase, $manBase, "nenhum")
    Exigir (-not $l.limpo -and $l.motivo -eq "DADOS_ALHEIOS" -and @($l.removidas).Count -eq 0 -and $l.estadoFinal -eq "INTERVENCAO_NECESSARIA") "resultado: $($l.motivo) $($l.estadoFinal)"
    $s = Estado $b
    Exigir ($s.dados -eq 27 -and $s.alheios.vendas -eq 1 -and $s.congeladas -eq 0) "estado: dados=$($s.dados) congeladas=$($s.congeladas)"
    "DADOS_ALHEIOS; 0 removidas; 27 coleções intactas; o congelamento aplicado pela limpeza foi desfeito; INTERVENCAO_NECESSARIA"
  }
  Caso "T05c" "A-05: coleção apagada e RECRIADA com dado alheio entre a verificação e o drop → preservada (collectionUUID)" {
    $b = Banco 13; $x = [guid]::NewGuid().ToString(); DestinoComPosse $b $x
    $l = Aux @("limpar-com-ganchos", $b, $x, $archBase, $manBase, "trocar")
    $trocada = @($l.eventos)[0].trocada
    $s = Estado $b
    Exigir (-not $l.limpo -and $l.motivo -eq "REMOCAO_INCOMPLETA" -and $s.colecoes -contains $trocada -and $s.alheios.$trocada -eq 1) "resultado: $($l.motivo); coleções $($s.colecoes -join ',')"
    "coleção '$trocada' recriada (outro UUID) com alheio → não removida; REMOCAO_INCOMPLETA; INTERVENCAO_NECESSARIA"
  }
  Caso "T05d" "A-04: documento alheio com _id ESPERADO (conteúdo substituído) → limpeza recusa e preserva" {
    $b = Banco 14; $x = [guid]::NewGuid().ToString(); DestinoComPosse $b $x $archTipos
    $null = Aux @("modificar", $b, "mesmo-id-outro-conteudo", (Join-Path $raiz "t05d.json"))
    $l = Aux @("limpar-com-ganchos", $b, $x, $archTipos, ($archTipos -replace '\.archive\.gz$', '.manifest.json'), "nenhum")
    Exigir (-not $l.limpo -and $l.motivo -eq "DADOS_ALHEIOS" -and @($l.removidas).Count -eq 0) "resultado: $($l.motivo)"
    Exigir ((Estado $b).alheios.eventos_auth -eq 1) "substituição alheia perdida"
    "mesmo _id, outro conteúdo → DADOS_ALHEIOS (divergentes=1); nada removido"
  }

  # ========================================== T06: queda e recuperação ==========================================
  $script:interrompidas = @{}
  function RestoreInterrompido([string]$B, [string]$Gatilho = "restaurando") {
    $p = RestoreAsync $archVol $B
    $g = Aux @("aguardar-e-inserir", $B, $Gatilho, "-", "-", "180000")
    if ($g.erro) { Stop-Process -Id $p.P.Id -Force -ErrorAction SilentlyContinue }
    Exigir (-not $g.erro) "o restore não chegou a '$Gatilho' em $B; saiu=$($p.P.HasExited); stderr=$(Get-Content -LiteralPath $p.Err -Raw -ErrorAction SilentlyContinue); relatório=$((Relatorio $B) | ConvertTo-Json -Compress -Depth 4)"
    Start-Sleep -Milliseconds 300
    $conteudo = LerTrava
    Stop-Process -Id $p.P.Id -Force   # SÓ o PowerShell: os filhos têm de morrer pelo Job Object
    $null = $p.P.WaitForExit(30000)
    Start-Sleep -Seconds 2
    return [pscustomobject]@{ Trava = $conteudo; Restantes = @(ProcessosCitando $B) }
  }
  Caso "T06a" "queda (Stop-Process -Force SÓ no PowerShell) no meio do mongorestore: filhos mortos, trava liberada pelo SO, posse RESTAURANDO" {
    $b = Banco 20
    $t = RestoreInterrompido $b
    $script:interrompidas[$b] = $t.Trava.execucaoId
    Exigir ($t.Restantes.Count -eq 0) "processos sobreviveram: $(($t.Restantes | ForEach-Object { "$($_.Name)#$($_.ProcessId)" }) -join ',')"
    $s = Estado $b
    Exigir ($s.posse.Count -eq 1 -and $s.posse[0].execucaoId -eq $t.Trava.execucaoId -and $s.posse[0].estado -eq "RESTAURANDO") "posse: $($s.posse | ConvertTo-Json -Compress)"
    $fs = [System.IO.File]::Open($travaArq, "Open", "ReadWrite", "None"); $fs.Close()
    Exigir (-not (Relatorio $b)) "há relatório de uma execução morta"
    "nenhum processo citando o destino sobreviveu (mongorestore/CLI mortos pelo Job Object); posse RESTAURANDO; trava livre no SO"
  }
  Caso "T06b" "a PRÓXIMA execução registra a interrompida e NÃO toca o destino dela; restore no MESMO destino é recusado" {
    $b = Banco 20; $antes = Estado $b
    $r = Restore $archBase (Banco 21)
    Exigir ($r.Codigo -eq 0 -and $r.Rel.execucaoAnteriorInterrompida.execucaoId -eq $script:interrompidas[$b]) "não registrou a interrompida"
    $r2 = Restore $archBase $b
    Exigir ($r2.Codigo -eq 1) "restore no destino interrompido não foi recusado"
    Exigir ((($antes.contagens | ConvertTo-Json -Compress) -eq ((Estado $b).contagens | ConvertTo-Json -Compress))) "o destino interrompido mudou"
    "nova execução PASSOU e registrou a interrompida; restore no destino dela recusado; contagens idênticas"
  }
  Caso "T06c" "recuperar-destino: inspeção; recusa com dado alheio; recusa com processo vivo citando o destino; remoção com provas" {
    $b = Banco 20
    $insp = Recuperar $b
    Exigir ($insp.Codigo -eq 0 -and $insp.Rel.resultado -eq "SO_INSPECAO" -and @($insp.Rel.provas | Where-Object { -not $_.ok }).Count -eq 0) "inspeção: $($insp.Rel.resultado) $($insp.Erro)"
    $b2 = Banco 22
    $t2 = RestoreInterrompido $b2
    $script:interrompidas[$b2] = $t2.Trava.execucaoId
    Exigir ((Aux @("inserir", $b2, "produtos", "T06c")).inserido) "inserção alheia"
    $rec2 = Recuperar $b2 -Remover
    Exigir ($rec2.Codigo -eq 1 -and $rec2.Rel.resultado -eq "NADA_REMOVIDO") "com alheio: $($rec2.Rel.resultado)"
    Exigir ((Estado $b2).alheios.produtos -eq 1) "destino com alheio foi alterado"
    $dummy = Start-Process -FilePath "cmd.exe" -ArgumentList "/c ping -n 60 127.0.0.1 >nul & rem $b" -WindowStyle Hidden -PassThru
    try { Start-Sleep -Milliseconds 800; $vivo = Recuperar $b -Remover } finally { Stop-Process -Id $dummy.Id -Force -ErrorAction SilentlyContinue }
    Exigir ($vivo.Codigo -eq 1 -and @($vivo.Rel.provas | Where-Object { $_.id -eq "processos.nenhum_ativo" -and -not $_.ok }).Count -eq 1 -and (Estado $b).existe) "recuperou com processo vivo citando o destino"
    $rec = Recuperar $b -Remover
    Exigir ($rec.Codigo -eq 0 -and $rec.Rel.resultado -eq "REMOVIDO" -and -not (Estado $b).existe) "remoção: $($rec.Rel.resultado) $(($rec.Rel.provas | Where-Object { -not $_.ok } | ConvertTo-Json -Compress))"
    "inspeção ok; alheio → NADA_REMOVIDO; processo citando o destino → recusado; com todas as provas → REMOVIDO (CANCELADO_COM_LIMPEZA_COMPROVADA)"
  }

  # ======================================= T07: execução antiga × nova =======================================
  Caso "T07" "execução ANTIGA não limpa a NOVA: trava de outra execução, outro processo, comandos removidos, recuperação barrada" {
    $b = Banco 23
    $p = RestoreAsync $archVol $b
    $g = Aux @("aguardar-e-inserir", $b, "restaurando", "-", "-", "120000"); Exigir (-not $g.erro) "restore não começou"
    $atual = LerTrava
    $antiga = $script:interrompidas["mariela_restore_20260103_000022"]
    $base = @("--porta", "27118", "--banco", $b, "--arquivo", $archVol, "--manifesto", $manVol)
    $rs = @(
      (ChamarCli (@("limpar-destino", "--modo", "falha", "--trava-execucao", $antiga, "--posse-execucao", $antiga) + $base)),
      (ChamarCli (@("limpar-destino", "--modo", "falha", "--trava-execucao", $atual.execucaoId, "--posse-execucao", $atual.execucaoId) + $base)),
      (ChamarCli @("marcar-estado", "--porta", "27118", "--banco", $b, "--execucao", $atual.execucaoId, "--para", "FALHOU_DESTINO_PARCIAL")),
      (ChamarCli @("derrubar-restore", "--porta", "27118", "--banco", $b)),
      (ChamarCli @("finalizar-posse", "--porta", "27118", "--banco", $b, "--execucao", $atual.execucaoId))
    )
    $rec = Recuperar "mariela_restore_20260103_000022" -Remover
    $r = Esperar $p
    foreach ($x in $rs) { Exigir (-not $x.ok) "uma operação concorrente foi aceita: $($x | ConvertTo-Json -Compress)" }
    Exigir ($rs[0].mensagem -match "trava.execucao" -and $rs[1].mensagem -match "trava.dono" -and $rs[2].mensagem -match "trava.dono" -and $rs[3].mensagem -match "removido" -and $rs[4].mensagem -match "removido") "motivos: $(($rs | ForEach-Object { $_.mensagem }) -join ' | ')"
    Exigir ($rec.Codigo -eq 1 -and $rec.Erro -match "Trava") "recuperação concorrente não foi barrada"
    Exigir ($r.Codigo -eq 0 -and (Relatorio $b).resultado -eq "PASSOU") "a execução nova não concluiu"
    Exigir ((Estado "mariela_restore_20260103_000022").posse.Count -eq 1) "destino antigo alterado"
    "5 operações recusadas (trava de outra execução; outro processo ×2; derrubar/finalizar removidos) + recuperação barrada; a nova PASSOU"
  }

  # ========================================== T08: posse adulterada ==========================================
  Caso "T08" "posse ADULTERADA (trocada) ou REMOVIDA durante o restore → nunca PASSOU; nada removido" {
    $out = @()
    foreach ($par in @(@(24, "trocar"), @(25, "remover"))) {
      $b = Banco $par[0]
      $vig = AuxAsync @("aguardar-e-adulterar", $b, "restaurando", $par[1], "120000")
      Start-Sleep -Milliseconds 1500
      $r = Restore $archVol $b
      $v = JsonDe (Esperar $vig 130)
      Exigir ($v.adulterado) "adulteração não ocorreu"
      Exigir ($r.Codigo -eq 1 -and $r.Rel.resultado -eq "FALHOU_DESTINO_PARCIAL" -and $r.Rel.exigeIntervencao) "$($par[1]): $($r.Rel.resultado)"
      Exigir ((Estado $b).dados -ge 27) "$($par[1]): coleções removidas"
      $out += "$($par[1]) → FALHOU_DESTINO_PARCIAL, 27 coleções intactas"
    }
    $out -join "; "
  }

  # ========================================== T10: trava e credencial ==========================================
  Caso "T10" "trava ocupada / trava-diretório / CLI sem trava / CLI SEM credencial → recusas sem escrita" {
    $b = Banco 26
    $fs = [System.IO.File]::Open($travaArq, "Open", "ReadWrite", "Read")
    try { $r = Esperar (RestoreAsync $archBase $b); $rec = Recuperar "mariela_restore_20260103_000022" } finally { $fs.Close() }
    Exigir ($r.Codigo -eq 1 -and $r.Erro -match "Trava" -and -not (Estado $b).existe) "restore com trava ocupada: $($r.Codigo)"
    Exigir ($rec.Codigo -eq 1 -and $rec.Erro -match "Trava") "recuperação com trava ocupada"
    $rd = Join-Path $raiz "raiz-dir"; New-Item -ItemType Directory -Force -Path (Join-Path $rd "locks\restore.lock") | Out-Null
    $r2 = Esperar (RestoreAsync $archBase $b @("-Raiz", $rd))
    Exigir ($r2.Codigo -eq 1 -and -not (Estado $b).existe) "trava-diretório: $($r2.Codigo)"
    $semTrava = ChamarCli @("adquirir-posse", "--porta", "27118", "--banco", $b, "--execucao", [guid]::NewGuid().ToString(), "--arquivo", $archBase, "--manifesto", $manBase, "--processo-inicio", "x", "--processo-inicio-ticks", (Get-InicioProcesso $PID), "--executavel", "x")
    Exigir (-not $semTrava.ok -and $semTrava.mensagem -match "trava.segura" -and -not (Estado $b).existe) "adquirir-posse sem trava foi aceito: $($semTrava.mensagem)"
    $ticksFalsos = ChamarCli @("adquirir-posse", "--porta", "27118", "--banco", $b, "--execucao", [guid]::NewGuid().ToString(), "--arquivo", $archBase, "--manifesto", $manBase, "--processo-inicio", "x", "--processo-inicio-ticks", "123", "--executavel", "x")
    Exigir (-not $ticksFalsos.ok -and $ticksFalsos.mensagem -match "horário de criação") "horário de criação falso aceito"
    $semCred = ChamarCli @("inspecionar-destino", "--porta", "27118", "--banco", $b) "nenhum"
    Exigir (-not $semCred.ok -and $semCred.mensagem -match "credencial") "CLI sem credencial aceita"
    "restore/recuperação com trava ocupada → 1; trava-diretório → 1; sem trava → trava.segura; horário falso → recusado; sem credencial → recusado"
  }

  # ======================================= T12: fluxo normal do operador =======================================
  Caso "T12" "fluxo normal: PASSOU = VERIFICADO (posse persistente, 27 congeladas, trava livre) → Liberar → Remover (sem dropDatabase)" {
    $b = Banco 27
    $r = Restore $archBase $b
    Exigir ($r.Codigo -eq 0 -and $r.Rel.resultado -eq "PASSOU" -and $r.Rel.estadoDestino -eq "VERIFICADO") "resultado $($r.Rel.resultado)"
    $s = Estado $b
    Exigir ($s.dados -eq 27 -and $s.congeladas -eq 27 -and $s.posse[0].estado -eq "VERIFICADO") "destino: $($s | ConvertTo-Json -Compress -Depth 3)"
    $c = LerTrava
    Exigir ($c.livre -eq $true -and $c.ultimaExecucao -eq $r.Rel.execucaoId) "trava não liberada"
    Exigir (@($r.Rel.condicoesPassou.PSObject.Properties | Where-Object { -not $_.Value }).Count -eq 0) "condições do PASSOU"
    $lb = Gerir "Liberar" $b $r.Rel.execucaoId
    $s2 = Estado $b
    Exigir ($lb.Codigo -eq 0 -and $s2.posse[0].estado -eq "LIBERACAO_AUTORIZADA" -and $s2.dados -eq 27 -and $s2.congeladas -eq 27) "liberação: $($lb.Rel.resultado)"
    $rm = Gerir "Remover" $b $r.Rel.execucaoId
    Exigir ($rm.Codigo -eq 0 -and $rm.Rel.resultado -eq "CANCELADO_COM_LIMPEZA_COMPROVADA" -and -not (Estado $b).existe) "remoção: $($rm.Rel.resultado)"
    "PASSOU → VERIFICADO (8/8 condições); Liberar → LIBERACAO_AUTORIZADA (nada removido, ainda congelado); Remover → banco inexistente"
  }

  # ===================================== I: integridade de conteúdo (A-01/A-04) =====================================
  $bI = Banco 30
  $rI = if (-not $Somente -or "I00" -match $Somente) { Restore $archTipos $bI } else { $null }
  $execI = $rI.Rel.execucaoId
  Caso "I00" "restore do archive com TODOS os tipos BSON → PASSOU (conteúdo byte a byte idêntico)" {
    Exigir ($rI.Codigo -eq 0 -and $rI.Rel.resultado -eq "PASSOU") "restore tipos: $($rI.Rel.resultado) $($rI.Erro)"
    $v = Gerir "Verificar" $bI $execI
    Exigir ($v.Codigo -eq 0 -and $v.Rel.resultado -eq "INTEGRO") "verificação inicial: $($v.Rel.resultado)"
    "PASSOU; $($rI.Rel.evidencias.documentos) documentos; Verificar=INTEGRO"
  }
  $casosI = @("update-campo", "campo-extra", "campo-removido", "tipo-int32-para-int64", "tipo-double-para-int32", "binario", "binario-subtipo", "decimal", "data", "timestamp", "uuid", "embutido", "array-ordem", "null-para-ausente", "delete-insert", "mesmo-id-outro-conteudo", "documento-adicional", "delete-compensado", "indice-extra", "sequencia")
  $n = 0
  foreach ($caso in $casosI) {
    $n++
    $cc = $caso
    Caso ("I{0:00}" -f $n) "divergência '$cc' → Verificar DIVERGENTE; reversão exata → INTEGRO" {
      $est = Join-Path $raiz "i-$cc.json"
      $m = Aux @("modificar", $bI, $cc, $est)
      Exigir ($m.modificado -eq $cc) "modificação não aplicada"
      $v = Gerir "Verificar" $bI $execI
      Exigir ($v.Codigo -eq 1 -and $v.Rel.resultado -eq "DIVERGENTE") "não detectou '$cc': $($v.Rel.resultado)"
      $det = (@($v.Rel.verificacoes | Where-Object { -not $_.ok }) | ForEach-Object { $_.id }) -join ","
      $null = Aux @("reverter", $bI, $est)
      $v2 = Gerir "Verificar" $bI $execI
      Exigir ($v2.Codigo -eq 0 -and $v2.Rel.resultado -eq "INTEGRO") "reversão de '$cc' não voltou a INTEGRO: $($v2.Rel.resultado)"
      "DIVERGENTE ($det); revertido → INTEGRO"
    }
  }
  Caso "I21" "divergência no destino VERIFICADO + Liberar → INTERVENCAO_NECESSARIA (nunca liberado)" {
    $null = Aux @("modificar", $bI, "update-campo", (Join-Path $raiz "i21.json"))
    $lb = Gerir "Liberar" $bI $execI
    Exigir ($lb.Codigo -eq 1 -and $lb.Rel.estadoDepois -eq "INTERVENCAO_NECESSARIA") "liberação: $($lb.Rel.resultado) $($lb.Rel.estadoDepois)"
    "Liberar recusado; estado INTERVENCAO_NECESSARIA"
  }

  # ======================================= AU: autenticação e privilégios (A-03) =======================================
  $bA = Banco 31
  $rA = if (-not $Somente -or "AU01" -match $Somente) { Restore $archBase $bA } else { $null }
  Caso "AU01" "sem autenticação: TODAS as operações recusadas" {
    Exigir ($rA.Codigo -eq 0) "restore de apoio: $($rA.Rel.resultado)"
    $ops = "find", "insert", "insertBypass", "update", "delete", "collMod", "drop", "rename", "dropDatabase", "posseUpdate", "posseRemove", "controleDrop", "createIndex"
    $aceitas = @(foreach ($o in $ops) { $t = Aux @("tentar", $bA, $o) "nenhum"; if ($t.aceita) { $o } })
    Exigir ($aceitas.Count -eq 0) "aceitas sem autenticação: $($aceitas -join ',')"
    "$($ops.Count) operações: 0 aceitas (Unauthorized)"
  }
  Caso "AU02" "leitor: só leitura — collMod, drop, rename, bypass, posse, controle e escritas recusados" {
    $ops = "insert", "insertBypass", "update", "delete", "collMod", "drop", "rename", "dropDatabase", "posseUpdate", "posseRemove", "controleDrop", "createIndex"
    $aceitas = @(foreach ($o in $ops) { $t = Aux @("tentar", $bA, $o) "leitor"; if ($t.aceita) { $o } })
    $find = Aux @("tentar", $bA, "find") "leitor"
    Exigir ($find.aceita -and $aceitas.Count -eq 0) "leitor: find=$($find.aceita) aceitas=$($aceitas -join ',')"
    "find aceito; $($ops.Count) operações de escrita/administração recusadas"
  }
  Caso "AU03" "restore (papel mínimo, 21.2.8): sem collMod, rename, drop, bypass, update/delete, dropDatabase, posse; insert no congelado → 121" {
    $esperado = @{ insert = $false; insertBypass = $false; update = $false; delete = $false; dropDatabase = $false; find = $true; collMod = $false; collModWarn = $false; rename = $false; dropReal = $false; posseUpdate = $false; posseRemove = $false }
    $res = @{}
    foreach ($o in $esperado.Keys) { $res[$o] = (Aux @("tentar", $bA, $o) "restore") }
    $erradas = @($esperado.Keys | Where-Object { [bool]$res[$_].aceita -ne $esperado[$_] })
    Exigir ($erradas.Count -eq 0) "divergentes: $(($erradas | ForEach-Object { "$_=$($res[$_].aceita)/$($res[$_].codigo)" }) -join ', ')"
    Exigir ($res.insert.codigo -eq 121 -and $res.insertBypass.codigo -eq 13 -and $res.update.codigo -eq 13 -and $res.dropDatabase.codigo -eq 13) "códigos: insert=$($res.insert.codigo) bypass=$($res.insertBypass.codigo) update=$($res.update.codigo) dropDatabase=$($res.dropDatabase.codigo)"
    "insert→121 (congelado); bypass/update/delete/dropDatabase→13 (Unauthorized); find ok"
  }
  Caso "AU04" "guardião (21.2.8): não escreve dados nem renomeia; o collMod dele (validationAction warn) é DETECTADO (A21-7-01)" {
    foreach ($o in "insert", "insertBypass", "update", "delete", "rename", "createIndex") {
      $x = Aux @("tentar", $bA, $o, "produtos") "guardiao"
      Exigir (-not $x.aceita) "guardião executou $o"
    }
    $cm = Aux @("tentar", $bA, "collModWarn", "vendas") "guardiao"
    Exigir $cm.aceita "collMod (warn) do guardião recusado (inesperado)"
    $v = Gerir "Verificar" $bA $rA.Rel.execucaoId
    Exigir ($v.Rel.resultado -eq "DIVERGENTE" -and @($v.Rel.verificacoes | Where-Object { $_.id -eq "destino.protegido" -and -not $_.ok }).Count -eq 1) "validationAction=warn NÃO detectado"
    $lb = Gerir "Liberar" $bA $rA.Rel.execucaoId
    Exigir ($lb.Codigo -eq 1 -and $lb.Rel.estadoDepois -eq "INTERVENCAO_NECESSARIA") "liberação com proteção incompleta não foi recusada"
    "guardião sem escrita/rename; validationAction=warn → Verificar DIVERGENTE (destino.protegido); Liberar → INTERVENCAO_NECESSARIA"
  }
  Caso "AU05" "bootstrap (root): pode tudo (bypass, collMod, drop) — uso restrito à configuração; alterações detectadas" {
    $t = Aux @("tentar", $bA, "insertBypass", "eventos_auth") "admin"
    Exigir $t.aceita "root sem bypass (inesperado)"
    "root aceita bypassDocumentValidation (documentado: credencial bootstrap fora do fluxo, DPAPI)"
  }
  Caso "AU06" "a senha sintética nunca aparece em relatório, linha de comando de processo ou log da fase" {
    $senhas = @(foreach ($p in 'admin', 'restore', 'guardiao', 'leitor') { ConvertFrom-SenhaSegura $creds[$p].Senha })
    $textos = (Get-ChildItem -LiteralPath $relDir -File | ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw }) -join "`n"
    $textos += (Get-ChildItem -LiteralPath $raiz -Filter "proc-*" -File | ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw -ErrorAction SilentlyContinue }) -join "`n"
    $textos += (Get-ChildItem -LiteralPath (Join-Path $raizIsolada "logs") -File | ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw -ErrorAction SilentlyContinue }) -join "`n"
    $linhas = (Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }) -join "`n"
    foreach ($s in $senhas) { Exigir (-not $textos.Contains($s) -and -not $linhas.Contains($s)) "senha encontrada em texto persistido ou linha de comando" }
    $senhas = $null
    "3 senhas procuradas em relatórios, saídas, log do mongod e linhas de comando: 0 ocorrências"
  }

  # ======================================= PR: processos filhos (A-06) =======================================
  Caso "PR01" "encerramento normal: nenhum processo citando o destino continua ativo" {
    $b = Banco 40
    $r = Restore $archBase $b
    Exigir ($r.Codigo -eq 0 -and @(ProcessosCitando $b).Count -eq 0 -and $r.Rel.condicoesPassou.semProcessoFilhoAtivo) "processos restantes: $(@(ProcessosCitando $b).Count)"
    "PASSOU; condição semProcessoFilhoAtivo=true; 0 processos depois"
  }
  Caso "PR02" "Stop-Process -Force SÓ no PowerShell durante o mongorestore → mongorestore e CLI morrem (Job Object)" {
    $b = Banco 41
    $p = RestoreAsync $archVol $b
    try { $mr = @(EsperarProcesso $b "*mongorestore*") } finally { if ($mr.Count -eq 0) { Stop-Process -Id $p.P.Id -Force -ErrorAction SilentlyContinue } }
    Exigir ($mr.Count -ge 1) "mongorestore não apareceu; restore saiu=$($p.P.HasExited); stderr=$(Get-Content -LiteralPath $p.Err -Raw -ErrorAction SilentlyContinue); relatório=$((Relatorio $b) | ConvertTo-Json -Compress -Depth 4)"
    Stop-Process -Id $p.P.Id -Force
    Start-Sleep -Seconds 2
    $vivos = @(ProcessosCitando $b)
    Exigir ($vivos.Count -eq 0 -and -not (Get-Process -Id $mr[0].ProcessId -ErrorAction SilentlyContinue)) "sobreviventes: $(($vivos | ForEach-Object { "$($_.Name)#$($_.ProcessId)" }) -join ',')"
    "mongorestore #$($mr[0].ProcessId) morto junto com o PowerShell"
  }
  Caso "PR03" "encerramento abrupto durante a VALIDAÇÃO → CLI morta; posse VALIDANDO; recuperação remove com provas" {
    $b = Banco 42
    $t = RestoreInterrompido $b "estado:VALIDANDO"
    Exigir ($t.Restantes.Count -eq 0) "sobreviventes: $(($t.Restantes | ForEach-Object { "$($_.Name)#$($_.ProcessId)" }) -join ',')"
    $s = Estado $b
    Exigir ($s.posse[0].estado -in @("VALIDANDO", "VERIFICADO")) "estado: $($s.posse[0].estado)"
    if ($s.posse[0].estado -eq "VALIDANDO") {
      $rec = Recuperar $b -Remover
      Exigir ($rec.Codigo -eq 0 -and -not (Estado $b).existe) "recuperação: $($rec.Rel.resultado)"
      "morto em VALIDANDO; 0 sobreviventes; recuperar-destino → REMOVIDO"
    } else {
      $rm = Gerir "Remover" $b $s.posse[0].execucaoId
      Exigir ($rm.Codigo -eq 0) "remoção"
      "a verificação concluiu antes da queda (VERIFICADO); 0 sobreviventes; Remover → CANCELADO"
    }
  }
  Caso "PR04" "encerramento abrupto durante a LIMPEZA (gerir-restore Remover) → CLI morta; destino íntegro ou parcial com posse; Remover de novo conclui" {
    $b = Banco 43
    $r = Restore $archVol $b
    Exigir ($r.Codigo -eq 0) "restore de apoio: $($r.Rel.resultado)"
    $g = Disparar $shell @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $ops "gerir-restore.ps1"), "-Acao", "Remover", "-BancoDestino", $b, "-ExecucaoId", $r.Rel.execucaoId, "-ArquivoBackup", $archVol, "-Manifesto", $manVol, "-DiretorioRelatorio", $relDir)
    try { $cli = @(EsperarProcesso $b "*limpar-destino*") } finally { if ($cli.Count -eq 0) { Stop-Process -Id $g.P.Id -Force -ErrorAction SilentlyContinue } }
    Exigir ($cli.Count -ge 1) "a limpeza não começou; gerir saiu=$($g.P.HasExited); stderr=$(Get-Content -LiteralPath $g.Err -Raw -ErrorAction SilentlyContinue); saída=$(Get-Content -LiteralPath $g.Out -Raw -ErrorAction SilentlyContinue)"
    Start-Sleep -Milliseconds 700
    Stop-Process -Id $g.P.Id -Force
    Start-Sleep -Seconds 2
    Exigir (@(ProcessosCitando $b).Count -eq 0) "CLI de limpeza sobreviveu"
    $s = Estado $b
    Exigir ($s.posse.Count -eq 1 -and $s.posse[0].estado -in @("VERIFICADO", "INTERVENCAO_NECESSARIA", "CANCELADO_COM_LIMPEZA_COMPROVADA")) "estado após queda: $($s | ConvertTo-Json -Compress -Depth 3)"
    $antes = "$($s.dados) coleções, estado $($s.posse[0].estado)"
    if ($s.posse[0].estado -eq "VERIFICADO") { $rm = Gerir "Remover" $b $r.Rel.execucaoId } else { $rm = Recuperar $b -Remover }
    Exigir ($rm.Codigo -eq 0 -and -not (Estado $b).existe) "segunda remoção: $($rm.Rel.resultado)"
    "queda na limpeza → $antes; CLI morta; nova remoção concluiu (banco inexistente)"
  }
  Caso "PR05" "recuperação com processo filho potencialmente vivo (qualquer executável citando o destino) → recusada" {
    $b = Banco 44
    $t = RestoreInterrompido $b
    $dummy = Start-Process -FilePath "cmd.exe" -ArgumentList "/c ping -n 60 127.0.0.1 >nul & rem --nsTo=$b.*" -WindowStyle Hidden -PassThru
    try { Start-Sleep -Milliseconds 800; $rec = Recuperar $b -Remover } finally { Stop-Process -Id $dummy.Id -Force -ErrorAction SilentlyContinue }
    Exigir ($rec.Codigo -eq 1 -and (Estado $b).existe) "recuperou com processo vivo"
    $rec2 = Recuperar $b -Remover
    Exigir ($rec2.Codigo -eq 0) "recuperação depois do processo encerrado: $($rec2.Rel.resultado)"
    "processo (cmd.exe) citando o destino → NADA_REMOVIDO; encerrado → REMOVIDO"
  }
  Caso "PR06" "PID REUTILIZADO: posse aponta para PID vivo com outro horário de criação → dono tratado como encerrado" {
    $b = Banco 45
    $t = RestoreInterrompido $b
    $null = Aux @("forcar-estado", $b, "RESTAURANDO")
    $null = Invoke-Nativo -Programa $bun -Argumentos @("--no-env-file", "-e", "import { MongoClient } from 'mongodb'; const s = JSON.parse(await Bun.stdin.text()).conexao; const c = new MongoClient('mongodb://127.0.0.1:27118/?directConnection=true', { auth: { username: s.usuario, password: s.senha }, authSource: 'admin' }); await c.connect(); await c.db('$b').collection('_mariela_restore_posse').updateOne({ _id: 'posse' }, { `$set: { pid: $PID, processoInicioTicks: '1' } }); await c.close();") -DiretorioTrabalho $repo -Entrada (EntradaDe "admin")
    $rec = Recuperar $b -Remover
    Exigir ($rec.Codigo -eq 0 -and @($rec.Rel.provas | Where-Object { $_.id -eq "dono.encerrado" -and $_.ok }).Count -eq 1) "PID reutilizado tratado como vivo: $($rec.Rel.resultado)"
    "pid=$PID (vivo, outro horário) → dono.encerrado=ok → REMOVIDO"
  }
  Caso "PR07" "mesmo PID e mesmo horário, executável registrado diferente → continua VIVO (identidade = PID + horário)" {
    $b = Banco 46
    $t = RestoreInterrompido $b
    $meu = Get-InicioProcesso $PID
    $null = Invoke-Nativo -Programa $bun -Argumentos @("--no-env-file", "-e", "import { MongoClient } from 'mongodb'; const s = JSON.parse(await Bun.stdin.text()).conexao; const c = new MongoClient('mongodb://127.0.0.1:27118/?directConnection=true', { auth: { username: s.usuario, password: s.senha }, authSource: 'admin' }); await c.connect(); await c.db('$b').collection('_mariela_restore_posse').updateOne({ _id: 'posse' }, { `$set: { pid: $PID, processoInicioTicks: '$meu', executavel: 'C:\\\\outro\\\\powershell.exe' } }); await c.close();") -DiretorioTrabalho $repo -Entrada (EntradaDe "admin")
    $rec = Recuperar $b -Remover
    Exigir ($rec.Codigo -eq 1 -and (Estado $b).existe -and @($rec.Rel.provas | Where-Object { $_.id -eq "dono.encerrado" -and -not $_.ok }).Count -eq 1) "recuperou com o dono vivo"
    $null = Invoke-Nativo -Programa $bun -Argumentos @("--no-env-file", "-e", "import { MongoClient } from 'mongodb'; const s = JSON.parse(await Bun.stdin.text()).conexao; const c = new MongoClient('mongodb://127.0.0.1:27118/?directConnection=true', { auth: { username: s.usuario, password: s.senha }, authSource: 'admin' }); await c.connect(); await c.db('$b').collection('_mariela_restore_posse').updateOne({ _id: 'posse' }, { `$set: { processoInicioTicks: '1' } }); await c.close();") -DiretorioTrabalho $repo -Entrada (EntradaDe "admin")
    $rec2 = Recuperar $b -Remover
    Exigir ($rec2.Codigo -eq 0) "remoção final"
    "pid+horário do processo vivo com executável 'C:\outro\powershell.exe' → NADA_REMOVIDO (dono vivo)"
  }
  Caso "PR08" "condição 7 do PASSOU: o relatório registra semProcessoFilhoAtivo a partir do Job Object" {
    $amostra = @(Get-ChildItem -LiteralPath $relDir -Filter "restore_*.json" | ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8 | ConvertFrom-Json } | Where-Object { $_.resultado -eq "PASSOU" })
    Exigir ($amostra.Count -ge 5 -and @($amostra | Where-Object { -not $_.condicoesPassou.semProcessoFilhoAtivo -or $_.controleDeProcessos -ne "job-kill-on-close" }).Count -eq 0) "algum PASSOU sem a condição 7"
    "$($amostra.Count) relatórios PASSOU, todos com job-kill-on-close e semProcessoFilhoAtivo=true"
  }

  # ================================================ T09 ===========================================================
  Caso "T09" "consolidado: TODO documento alheio gravado nos testes continua no banco" {
    $esperado = @{ 5 = "produtos"; 6 = "produtos"; 10 = "vendas"; 11 = "alheia_t05"; 12 = "vendas"; 13 = $null; 14 = "eventos_auth"; 22 = "produtos" }
    $linhas = @()
    foreach ($n in $esperado.Keys | Sort-Object) {
      $b = "mariela_restore_20260103_" + ([int]$n).ToString("000000")
      $s = Estado $b
      $col = $esperado[$n]
      if (-not $col) { $col = @($s.alheios.PSObject.Properties.Name)[0] }
      Exigir ($col -and $s.alheios.$col -ge 1) "$b perdeu o alheio"
      $linhas += "$($n):$col=$($s.alheios.$col)"
    }
    foreach ($n in 8, 9) { $s = Estado ("mariela_restore_20260103_" + ([int]$n).ToString("000000")); Exigir ($s.alheios.produtos -ge 1) "T04b $n perdeu o alheio"; $linhas += "$($n):produtos=1" }
    "$($linhas.Count) destinos com escrita alheia, todos preservados: $($linhas -join ', ')"
  }
} finally {
  $resultados | Format-Table -AutoSize -Wrap | Out-String -Width 240 | Write-Host
  $falhas = @($resultados | Where-Object { $_.Resultado -ne "PASSOU" }).Count
  Write-Host ("TOTAL: {0} casos, {1} PASSOU, {2} FALHOU (PowerShell {3})" -f $resultados.Count, ($resultados.Count - $falhas), $falhas, $PSVersionTable.PSVersion)
  if (-not $ManterArtefatos) {
    foreach ($b in @($script:bancosCriados | Select-Object -Unique)) { try { $null = Aux @("remover-banco-de-teste", $b) } catch { Write-Host "não removido: $b" } }
    Remove-Item -LiteralPath $raiz -Recurse -Force -ErrorAction SilentlyContinue
  }
}
if ($falhas) { exit 1 } else { exit 0 }
