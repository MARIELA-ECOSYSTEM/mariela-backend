<#
.SYNOPSIS
  Testes de CONCORRÊNCIA da posse exclusiva do destino de restore (Fase 60.4.3.4.21.2.4, R21-2.3-01). MongoDB real.

.DESCRIPTION
  Pré-requisitos (verificados): instância isolada 127.0.0.1:27118 (mongod-isolado.ps1 -Acao Iniciar) e origem
  sintética 127.0.0.1:27119 (dbPath descartável). Dados 100% sintéticos. Só cria/remove bancos
  mariela_restore_20260103_* na 27118 (o auxiliar recusa qualquer outro nome) e marielaDB na 27119 sintética.
  Processos INDEPENDENTES: cada restore-test.ps1 / recuperar-destino.ps1 / auxiliar roda no seu próprio processo.
    T01 dois restores simultâneos (mesmo destino e destinos diferentes) + 8 aquisições diretas na mesma barreira
    T02 escrita alheia depois da posse e antes do mongorestore      T03 escrita alheia durante o mongorestore
    T04 escrita alheia durante a validação                           T05 escrita alheia durante a limpeza (ganchos)
    T06 queda no meio da escrita → nova execução não limpa; recuperação manual (inspeção, recusa, remoção)
    T07 execução antiga não limpa a nova (trava ocupada / trava de outra execução / outro processo)
    T08 posse adulterada ou removida durante o restore               T09 dados alheios preservados (consolidado)
    T10 trava ocupada / caminho da trava é diretório / CLI sem trava  T12 fluxo normal + -RemoverAoFinal
  T11 (duas máquinas) não é executável: a instância só escuta em 127.0.0.1 e a trava é local — ver a documentação.
#>
param([switch]$ManterArtefatos, [int]$Volume = 300000)

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

function Aux([string[]]$Argumentos) {
  $r = Invoke-Nativo -Programa $bun -Argumentos (@("--no-env-file", (Join-Path $PSScriptRoot "posse-auxiliar.ts")) + $Argumentos) -DiretorioTrabalho $repo
  $linha = @($r.Saida -split "`r?`n" | Where-Object { $_.Trim().StartsWith("{") }) | Select-Object -Last 1
  if (-not $linha) { throw "auxiliar sem JSON ($($Argumentos[0])): $($r.Erro)" }
  return ($linha | ConvertFrom-Json)
}
function Estado([string]$B) { return Aux @("estado", $B) }

# Processo INDEPENDENTE em segundo plano (saída em arquivo).
$script:k = 0
function Disparar([string]$Programa, [string[]]$Argumentos) {
  $script:k++
  $out = Join-Path $raiz "proc-$($script:k).out"; $err = Join-Path $raiz "proc-$($script:k).err"
  $linha = ($Argumentos | ForEach-Object { ConvertTo-ArgumentoProcesso $_ }) -join " "
  $p = Start-Process -FilePath $Programa -ArgumentList $linha -WorkingDirectory $repo -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden -PassThru
  $null = $p.Handle   # garante ExitCode no Windows PowerShell 5.1
  return [pscustomobject]@{ P = $p; Out = $out; Err = $err }
}
function Esperar($Proc, [int]$Segundos = 300) {
  if (-not $Proc.P.WaitForExit($Segundos * 1000)) { throw "processo $($Proc.P.Id) não terminou em ${Segundos}s" }
  $Proc.P.WaitForExit()
  return [pscustomobject]@{ Codigo = $Proc.P.ExitCode; Saida = (Get-Content -LiteralPath $Proc.Out -Raw -ErrorAction SilentlyContinue); Erro = (Get-Content -LiteralPath $Proc.Err -Raw -ErrorAction SilentlyContinue) }
}
function RestoreAsync([string]$Archive, [string]$B, [string[]]$Extra = @()) {
  return Disparar $shell (@("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $ops "restore-test.ps1"), "-ArquivoBackup", $Archive, "-BancoDestino", $B, "-DiretorioRelatorio", $relDir) + $Extra)
}
function AuxAsync([string[]]$Argumentos) { return Disparar $bun (@("--no-env-file", (Join-Path $PSScriptRoot "posse-auxiliar.ts")) + $Argumentos) }
function JsonDe($R) { $l = @("$($R.Saida)" -split "`r?`n" | Where-Object { $_.Trim().StartsWith("{") }) | Select-Object -Last 1; if ($l) { return ($l | ConvertFrom-Json) } return $null }
function Relatorio([string]$B) {
  $a = Join-Path $relDir "restore_$B.json"
  if (Test-Path -LiteralPath $a) { return (Get-Content -LiteralPath $a -Raw -Encoding UTF8 | ConvertFrom-Json) } return $null
}
function Recuperar([string]$B, [switch]$Remover) {
  $a = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $ops "recuperar-destino.ps1"), "-BancoDestino", $B, "-DiretorioRelatorio", $relDir)
  if ($Remover) { $a += "-Remover" }
  $r = Invoke-Nativo -Programa $shell -Argumentos $a
  $arq = Join-Path $relDir "recuperacao_$B.json"
  $rel = if (Test-Path -LiteralPath $arq) { Get-Content -LiteralPath $arq -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
  if (Test-Path -LiteralPath $arq) { Remove-Item -LiteralPath $arq }
  return [pscustomobject]@{ Codigo = $r.Codigo; Rel = $rel; Erro = $r.Erro }
}
function LerTrava { $fs = [System.IO.File]::Open($travaArq, "Open", "Read", "ReadWrite"); try { $sr = New-Object System.IO.StreamReader($fs); return ($sr.ReadToEnd() | ConvertFrom-Json) } finally { $fs.Close() } }
function MatarArvore([int]$Id) {
  foreach ($f in @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$Id" -ErrorAction SilentlyContinue)) { MatarArvore $f.ProcessId }
  Stop-Process -Id $Id -Force -ErrorAction SilentlyContinue
}
function ChamarCli([string[]]$A) { return Invoke-CliBackup -Argumentos $A }

try {
  # --- Pré-requisitos e backups sintéticos ------------------------------------------------------------------------
  $e18 = ChamarCli @("local-estado", "--porta", "27118")
  Exigir ($e18.ok -and $e18.resultado.versao -eq "8.0.37" -and $e18.resultado.bindIp -eq "127.0.0.1" -and $e18.resultado.replicaSet -eq "rs-restore") "instância isolada 27118 indisponível"
  $e19 = ChamarCli @("local-estado", "--porta", "27119")
  Exigir ($e19.ok -and $e19.resultado.bindIp -eq "127.0.0.1") "origem sintética 27119 indisponível"
  $bancosAntes = @((Invoke-Nativo -Programa $bun -Argumentos @("--no-env-file", "-e", "import { MongoClient } from 'mongodb'; const c = new MongoClient('mongodb://127.0.0.1:27118/?directConnection=true'); await c.connect(); console.log(JSON.stringify((await c.db('admin').admin().listDatabases({ nameOnly: true })).databases.map(d => d.name))); await c.close();") -DiretorioTrabalho $repo).Saida.Trim() | ConvertFrom-Json)
  Exigir (@($bancosAntes | Where-Object { $_ -like "mariela_restore_20260103_*" }).Count -eq 0) "já existem bancos 20260103 (de outra execução): nada feito"

  $cfgDir = Join-Path $raiz "cfg"; New-Item -ItemType Directory -Path $cfgDir | Out-Null; Set-AclRestrita $cfgDir
  $cfg = Join-Path $cfgDir "origem.yaml"
  [System.IO.File]::WriteAllText($cfg, "uri: `"mongodb://127.0.0.1:27119/marielaDB?directConnection=true`"`n", (New-Object System.Text.UTF8Encoding($false)))
  Set-AclRestrita $cfg
  function GerarBackup([string]$Nome) {
    $d = Join-Path $raiz $Nome; New-Item -ItemType Directory -Path $d | Out-Null; Set-AclRestrita $d
    # Mesmo shell do runner (powershell.exe filho de pwsh herda o PSModulePath do 7 e não carrega Get-Acl).
    $r = Invoke-Nativo -Programa $shell -Argumentos @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $ops "backup-mongo.ps1"), "-BackupDir", $d, "-ConfigMongo", $cfg, "-Extraordinario")
    $a = @(Get-ChildItem -LiteralPath $d -Filter "mariela_extra_*.archive.gz")
    Exigir ($r.Codigo -eq 0 -and $a.Count -eq 1) "backup sintético '$Nome' falhou: $($r.Saida) $($r.Erro)"
    return $a[0].FullName
  }
  $sem = { param($c, $n) $x = Invoke-Nativo -Programa $bun -Argumentos (@("--no-env-file", (Join-Path $PSScriptRoot "origem-sintetica.ts"), $c) + @($n | Where-Object { $_ })); if ($x.Codigo -ne 0) { throw "semeadura $c falhou: $($x.Erro)" } }
  & $sem "base" $null
  $archBase = GerarBackup "base"
  & $sem "volume" "$Volume"
  $archVol = GerarBackup "volume"
  $manVol = $archVol -replace '\.archive\.gz$', '.manifest.json'
  $docsVol = ((Get-Content -LiteralPath $manVol -Raw -Encoding UTF8 | ConvertFrom-Json).archive.documentosPorColecao.PSObject.Properties | Measure-Object -Property Value -Sum).Sum
  Write-Host "archives sintéticos: base e volume ($docsVol documentos)"

  # ================================================ T01 ===========================================================
  Caso "T01a" "dois restore-test SIMULTÂNEOS no MESMO destino → exatamente um prossegue; o outro é recusado sem escrever" {
    $b = Banco 1
    $p1 = RestoreAsync $archBase $b; $p2 = RestoreAsync $archBase $b
    $r1 = Esperar $p1; $r2 = Esperar $p2
    $codigos = @($r1.Codigo, $r2.Codigo) | Sort-Object
    Exigir (($codigos -join ",") -eq "0,1") "códigos $($r1.Codigo),$($r2.Codigo)"
    $perdedor = if ($r1.Codigo -eq 1) { $r1 } else { $r2 }
    Exigir ($perdedor.Erro -match "Trava|já existe|destino") "recusa sem motivo esperado: $($perdedor.Erro)"
    $s = Estado $b
    Exigir ($s.colecoes.Count -eq 27 -and $s.colecoes -notcontains "_mariela_restore_posse") "destino: $($s.colecoes.Count) coleções"
    "um PASSOU (0), outro recusado (1): $(([string]$perdedor.Erro).Trim().Split("`n")[0].Substring(0, [math]::Min(90, ([string]$perdedor.Erro).Trim().Split("`n")[0].Length)))"
  }
  Caso "T01b" "dois restore-test SIMULTÂNEOS em destinos DIFERENTES → a trava local serializa: um prossegue, o outro é recusado" {
    $b2 = Banco 2; $b3 = Banco 3
    $p1 = RestoreAsync $archBase $b2; $p2 = RestoreAsync $archBase $b3
    $r1 = Esperar $p1; $r2 = Esperar $p2
    Exigir ((@($r1.Codigo, $r2.Codigo) | Sort-Object) -join "," -eq "0,1") "códigos $($r1.Codigo),$($r2.Codigo)"
    $recusado = if ($r1.Codigo -eq 1) { $b2 } else { $b3 }
    $s = Estado $recusado
    Exigir (-not $s.existe) "o recusado criou o banco $recusado"
    Exigir ($(if ($r1.Codigo -eq 1) { $r1.Erro } else { $r2.Erro }) -match "Trava") "recusa não foi pela trava"
    "um PASSOU; o outro recusado pela trava e o banco dele NÃO existe"
  }
  Caso "T01c" "8 aquisições DIRETAS de posse no mesmo destino, na mesma barreira de relógio → exatamente 1 vence" {
    $b = Banco 4
    $barreira = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 4000
    $ids = 1..8 | ForEach-Object { [guid]::NewGuid().ToString() }
    $procs = $ids | ForEach-Object { AuxAsync @("adquirir-na-barreira", $b, $_, "$barreira") }
    $rs = @($procs | ForEach-Object { JsonDe (Esperar $_ 60) })
    $venc = @($rs | Where-Object { $_.adquirida })
    $perd = @($rs | Where-Object { -not $_.adquirida })
    Exigir ($rs.Count -eq 8 -and $venc.Count -eq 1) "vencedores: $($venc.Count) de $($rs.Count)"
    Exigir (@($perd | Where-Object { $_.motivo -eq "POSSE_JA_EXISTE" -and -not $_.controleRemovido }).Count -eq 7) "perdedores com motivo inesperado"
    $s = Estado $b
    Exigir ($s.posse.Count -eq 1 -and $s.posse[0].execucaoId -eq $venc[0].execucaoId) "posse final não é do vencedor"
    "1 vencedor, 7 POSSE_JA_EXISTE (nenhum removeu a posse do vencedor)"
  }

  # ================================================ T02 ===========================================================
  Caso "T02" "escrita alheia DEPOIS da posse e ANTES do mongorestore → nada alheio removido; FALHOU_DESTINO_PARCIAL" {
    $b = Banco 5
    $vig = AuxAsync @("aguardar-e-inserir", $b, "posse", "produtos", "T02", "120000")
    Start-Sleep -Milliseconds 800
    $r = Esperar (RestoreAsync $archBase $b)
    $v = JsonDe (Esperar $vig 130)
    $rel = Relatorio $b
    Exigir ($v.inserido) "a escrita alheia não ocorreu: $($v | ConvertTo-Json -Compress)"
    Exigir ($r.Codigo -eq 1 -and $rel.resultado -eq "FALHOU_DESTINO_PARCIAL" -and $rel.exigeIntervencao) "resultado $($rel.resultado) código $($r.Codigo)"
    $s = Estado $b
    Exigir ($s.alheios.produtos -eq 1) "documento alheio perdido: $($s.alheios | ConvertTo-Json -Compress)"
    "alheio inserido com $($v.viu) coleção(ões) no destino; resultado $($rel.resultado); limpeza recusada ($($rel.limpeza.recusa)); alheio preservado"
  }

  # ================================================ T03 ===========================================================
  Caso "T03" "escrita alheia DURANTE o mongorestore → preservada; FALHOU_DESTINO_PARCIAL" {
    $b = Banco 6
    $vig = AuxAsync @("aguardar-e-inserir", $b, "restaurando", "produtos", "T03", "120000")
    Start-Sleep -Milliseconds 800
    $p = RestoreAsync $archVol $b
    $v = JsonDe (Esperar $vig 130)
    $r = Esperar $p
    $rel = Relatorio $b
    Exigir ($v.inserido -and $v.viu -lt 28) "a escrita não ocorreu durante o restore: $($v | ConvertTo-Json -Compress)"
    Exigir ($r.Codigo -eq 1 -and $rel.resultado -eq "FALHOU_DESTINO_PARCIAL") "resultado $($rel.resultado)"
    $s = Estado $b
    Exigir ($s.alheios.produtos -eq 1) "documento alheio perdido"
    $mr = $rel.etapas | Where-Object { $_.etapa -eq "mongorestore" }
    "alheio inserido com $($v.viu)/28 coleções criadas (mongorestore em curso, $($mr.duracaoSegundos)s); $($rel.resultado); alheio preservado"
  }

  # ================================================ T04 ===========================================================
  Caso "T04" "escrita alheia DURANTE a validação (dados do archive completos) → preservada" {
    $b = Banco 7
    $vig = AuxAsync @("aguardar-e-inserir", $b, "restaurado", "alheia_t04", "T04", "180000")
    Start-Sleep -Milliseconds 800
    $p = RestoreAsync $archVol $b
    $v = JsonDe (Esperar $vig 190)
    $r = Esperar $p
    $rel = Relatorio $b
    Exigir ($v.inserido) "a escrita não ocorreu: $($v | ConvertTo-Json -Compress)"
    $s = Estado $b
    Exigir ($s.alheios.alheia_t04 -eq 1) "documento alheio perdido"
    Exigir ($rel.resultado -in @("FALHOU_DESTINO_PARCIAL", "PASSOU")) "resultado $($rel.resultado)"
    if ($rel.resultado -eq "PASSOU") { "alheio entrou DEPOIS da validação: PASSOU sem remover nada; alheio preservado" }
    else { "alheio entrou antes/durante a validação: $($rel.resultado), limpeza recusada ($($rel.limpeza.recusa)); alheio preservado" }
  }

  # ================================================ T05 ===========================================================
  $mongorestore = (Get-Command mongorestore).Source
  function DestinoComPosse([string]$B, [string]$Exec) {
    $a = Aux @("adquirir-na-barreira", $B, $Exec, "0")
    Exigir $a.adquirida "posse não adquirida em $B"
    $args2 = @("--uri=mongodb://127.0.0.1:27118/?directConnection=true", "--gzip", "--archive=$archBase", "--nsFrom=marielaDB.*", "--nsTo=$B.*", "--stopOnError")
    foreach ($c in @((ChamarCli @("politica")).resultado.colecoesIncluidas)) { $args2 += "--nsInclude=marielaDB.$c" }
    $mr = Invoke-Nativo -Programa $mongorestore -Argumentos $args2
    Exigir ($mr.Codigo -eq 0) "mongorestore manual falhou"
  }
  $manBase = $archBase -replace '\.archive\.gz$', '.manifest.json'
  Caso "T05a" "escrita alheia DURANTE a limpeza (após congelar e após verificar) → rejeitada nas coleções congeladas; coleção nova alheia preservada" {
    $b = Banco 8; $x = [guid]::NewGuid().ToString(); DestinoComPosse $b $x
    $l = Aux @("limpar-com-ganchos", $b, $x, $archBase, $manBase, "ambos")
    $ev = @($l.eventos)
    Exigir (-not $ev[0].aposCongelar.inserido -and $ev[0].aposCongelar.codigo -eq 121) "inserção após congelar NÃO foi rejeitada: $($ev[0] | ConvertTo-Json -Compress)"
    Exigir (-not $ev[1].aposVerificarProdutos.inserido -and $ev[2].aposVerificarNova.inserido) "ganchos pós-verificação: $($ev | ConvertTo-Json -Compress)"
    Exigir (-not $l.limpo -and $l.motivo -eq "ALHEIO_CRIADO_DURANTE_LIMPEZA") "resultado: $($l.motivo)"
    $s = Estado $b
    Exigir ((@($s.colecoes) -join ",") -eq "alheia_t05" -and $s.alheios.alheia_t05 -eq 1) "estado final: $($s.colecoes -join ',')"
    "após congelar: código 121 (rejeitada); após verificar: produtos rejeitada, coleção nova criada; limpeza removeu só as 27 + controle; alheia_t05 preservada"
  }
  Caso "T05b" "documento alheio ANTES da limpeza → nada removido e coleções descongeladas" {
    $b = Banco 9; $x = [guid]::NewGuid().ToString(); DestinoComPosse $b $x
    $i = Aux @("inserir", $b, "vendas", "T05b"); Exigir $i.inserido "inserção prévia"
    $l = Aux @("limpar-com-ganchos", $b, $x, $archBase, $manBase, "nenhum")
    Exigir (-not $l.limpo -and $l.motivo -eq "DADOS_ALHEIOS" -and @($l.removidas).Count -eq 0) "resultado: $($l.motivo)"
    $j = Aux @("inserir", $b, "produtos", "T05b-depois")
    Exigir $j.inserido "coleções continuaram congeladas depois da recusa"
    $s = Estado $b
    Exigir ($s.colecoes.Count -eq 28 -and $s.alheios.vendas -eq 1) "estado: $($s.colecoes.Count) coleções"
    "DADOS_ALHEIOS; 0 removidas; 28 coleções intactas; escrita volta a funcionar (descongelado)"
  }

  # ================================================ T06 ===========================================================
  $script:interrompidas = @{}
  function RestoreInterrompido([string]$B) {
    $p = RestoreAsync $archVol $B
    $g = Aux @("aguardar-e-inserir", $B, "restaurando", "-", "-", "120000")
    Exigir ($g.gatilho -and -not $g.erro) "restore não começou a escrever em $B"
    Start-Sleep -Milliseconds 300
    $conteudo = LerTrava
    MatarArvore $p.P.Id
    $null = $p.P.WaitForExit(30000)
    Start-Sleep -Milliseconds 500
    return $conteudo
  }
  Caso "T06a" "queda no meio da escrita: trava liberada pelo SO, destino parcial com posse, nenhum relatório de sucesso" {
    $b = Banco 10
    $t = RestoreInterrompido $b
    $script:interrompidas[$b] = $t.execucaoId
    $s = Estado $b
    Exigir ($s.posse.Count -eq 1 -and $s.posse[0].execucaoId -eq $t.execucaoId) "posse: $($s.posse | ConvertTo-Json -Compress)"
    $c = LerTrava
    Exigir ($c.livre -ne $true -and $c.execucaoId -eq $t.execucaoId) "a trava deveria registrar a execução interrompida"
    $fs = [System.IO.File]::Open($travaArq, "Open", "ReadWrite", "None"); $fs.Close()
    Exigir (-not (Relatorio $b)) "há relatório de uma execução morta"
    "interrompida com $($s.colecoes.Count) coleções; trava livre no SO (conteúdo não 'livre'); posse da execução morta"
  }
  Caso "T06b" "a PRÓXIMA execução registra a interrompida e NÃO toca o destino dela; restore no MESMO destino é recusado" {
    $b = Banco 10; $antes = Estado $b
    $r = Esperar (RestoreAsync $archBase (Banco 11))
    $rel = Relatorio "mariela_restore_20260103_000011"
    Exigir ($r.Codigo -eq 0 -and $rel.execucaoAnteriorInterrompida.execucaoId -eq $script:interrompidas[$b]) "não registrou: $($rel.execucaoAnteriorInterrompida | ConvertTo-Json -Compress)"
    $r2 = Esperar (RestoreAsync $archBase $b)
    Exigir ($r2.Codigo -eq 1) "restore no destino interrompido não foi recusado"
    $depois = Estado $b
    Exigir (($antes.contagens | ConvertTo-Json -Compress) -eq ($depois.contagens | ConvertTo-Json -Compress)) "o destino interrompido mudou"
    "nova execução PASSOU e registrou a interrompida; restore no destino dela recusado; contagens idênticas"
  }
  Caso "T06c" "recuperar-destino: inspeção (provas), recusa com dado alheio, remoção com provas completas" {
    $b = Banco 10
    $insp = Recuperar $b
    Exigir ($insp.Codigo -eq 0 -and $insp.Rel.resultado -eq "SO_INSPECAO" -and @($insp.Rel.provas | Where-Object { -not $_.ok }).Count -eq 0) "inspeção: $($insp.Rel.resultado) $($insp.Erro)"
    # Segunda execução interrompida, com dado alheio → recuperação recusa.
    $b2 = Banco 12
    $t2 = RestoreInterrompido $b2
    $i = Aux @("inserir", $b2, "produtos", "T06c"); Exigir $i.inserido "inserção alheia"
    $rec2 = Recuperar $b2 -Remover
    Exigir ($rec2.Codigo -eq 1 -and $rec2.Rel.resultado -eq "NADA_REMOVIDO") "com alheio: $($rec2.Rel.resultado)"
    $s2 = Estado $b2
    Exigir ($s2.alheios.produtos -eq 1 -and $s2.posse.Count -eq 1) "destino com alheio foi alterado"
    $rec = Recuperar $b -Remover
    Exigir ($rec.Codigo -eq 0 -and $rec.Rel.resultado -eq "REMOVIDO") "remoção: $($rec.Rel.resultado) $(($rec.Rel.provas | Where-Object { -not $_.ok } | ConvertTo-Json -Compress))"
    Exigir (-not (Estado $b).existe) "destino recuperado ainda existe"
    $script:interrompidas[$b2] = $t2.execucaoId
    "inspeção: $(@($insp.Rel.provas).Count) provas ok; com alheio → NADA_REMOVIDO (preservado); sem alheio → REMOVIDO"
  }

  # ================================================ T07 ===========================================================
  Caso "T07" "execução ANTIGA não limpa a NOVA: trava ocupada, trava de outra execução, outro processo" {
    $b = Banco 13
    $p = RestoreAsync $archVol $b
    $g = Aux @("aguardar-e-inserir", $b, "restaurando", "-", "-", "120000"); Exigir (-not $g.erro) "restore não começou"
    $atual = LerTrava
    $antiga = $script:interrompidas["mariela_restore_20260103_000012"]
    $rs = @(
      (ChamarCli @("limpar-destino", "--porta", "27118", "--banco", $b, "--trava-execucao", $antiga, "--posse-execucao", $antiga, "--arquivo", $archVol, "--manifesto", $manVol)),
      (ChamarCli @("limpar-destino", "--porta", "27118", "--banco", $b, "--trava-execucao", $atual.execucaoId, "--posse-execucao", $atual.execucaoId, "--arquivo", $archVol, "--manifesto", $manVol)),
      (ChamarCli @("finalizar-posse", "--porta", "27118", "--banco", $b, "--execucao", $atual.execucaoId)),
      (ChamarCli @("derrubar-restore", "--porta", "27118", "--banco", $b))
    )
    $rec = Recuperar "mariela_restore_20260103_000012" -Remover
    $r = Esperar $p
    foreach ($x in $rs) { Exigir (-not $x.ok) "uma operação concorrente foi aceita: $($x | ConvertTo-Json -Compress)" }
    Exigir ($rs[0].mensagem -match "trava.execucao" -and $rs[1].mensagem -match "trava.dono" -and $rs[3].mensagem -match "posse") "motivos inesperados: $(($rs | ForEach-Object { $_.mensagem }) -join ' | ')"
    Exigir ($rec.Codigo -eq 1 -and $rec.Erro -match "Trava") "recuperação concorrente não foi barrada"
    $rel = Relatorio $b
    Exigir ($r.Codigo -eq 0 -and $rel.resultado -eq "PASSOU") "a execução nova não concluiu: $($rel.resultado)"
    Exigir ((Estado "mariela_restore_20260103_000012").posse.Count -eq 1) "destino antigo alterado"
    "4 operações recusadas (trava de outra execução; outro processo; finalizar; derrubar com posse) + recuperação barrada pela trava; a nova PASSOU"
  }

  # ================================================ T08 ===========================================================
  Caso "T08" "posse ADULTERADA (trocada) ou REMOVIDA durante o restore → FALHOU_DESTINO_PARCIAL, nada removido" {
    $out = @()
    foreach ($par in @(@(14, "trocar"), @(15, "remover"))) {
      $b = Banco $par[0]
      $vig = AuxAsync @("aguardar-e-adulterar", $b, "restaurando", $par[1], "120000")
      Start-Sleep -Milliseconds 800
      $r = Esperar (RestoreAsync $archVol $b)
      $v = JsonDe (Esperar $vig 130)
      $rel = Relatorio $b
      Exigir ($v.adulterado) "adulteração não ocorreu"
      Exigir ($r.Codigo -eq 1 -and $rel.resultado -eq "FALHOU_DESTINO_PARCIAL" -and $rel.exigeIntervencao) "$($par[1]): $($rel.resultado)"
      $s = Estado $b
      Exigir ($s.colecoes.Count -ge 27) "$($par[1]): coleções removidas ($($s.colecoes.Count))"
      $out += "$($par[1]) → $($rel.resultado), $($s.colecoes.Count) coleções intactas"
    }
    $out -join "; "
  }

  # ================================================ T10 ===========================================================
  Caso "T10" "trava ocupada / caminho da trava é diretório / CLI sem trava ou com trava alheia → recusas sem escrita" {
    $b = Banco 16
    $fs = [System.IO.File]::Open($travaArq, "Open", "ReadWrite", "Read")
    try {
      $r = Esperar (RestoreAsync $archBase $b)
      $rec = Recuperar "mariela_restore_20260103_000012"
    } finally { $fs.Close() }
    Exigir ($r.Codigo -eq 1 -and $r.Erro -match "Trava" -and -not (Estado $b).existe) "restore com trava ocupada: $($r.Codigo)"
    Exigir ($rec.Codigo -eq 1 -and $rec.Erro -match "Trava") "recuperação com trava ocupada"
    $rd = Join-Path $raiz "raiz-dir"; New-Item -ItemType Directory -Force -Path (Join-Path $rd "locks\restore.lock") | Out-Null
    $r2 = Esperar (RestoreAsync $archBase $b @("-Raiz", $rd))
    Exigir ($r2.Codigo -eq 1 -and -not (Estado $b).existe) "trava-diretório: $($r2.Codigo)"
    $sem = ChamarCli @("adquirir-posse", "--porta", "27118", "--banco", $b, "--execucao", [guid]::NewGuid().ToString(), "--arquivo", $archBase, "--manifesto", $manBase, "--processo-inicio", "x")
    Exigir (-not $sem.ok -and $sem.mensagem -match "trava.segura" -and -not (Estado $b).existe) "adquirir-posse sem trava foi aceito"
    $outra = ChamarCli @("limpar-destino", "--porta", "27118", "--banco", "mariela_restore_20260103_000012", "--trava-execucao", [guid]::NewGuid().ToString(), "--posse-execucao", $script:interrompidas["mariela_restore_20260103_000012"], "--arquivo", $archVol, "--manifesto", $manVol)
    Exigir (-not $outra.ok -and $outra.mensagem -match "trava") "limpar-destino sem trava foi aceito"
    "restore e recuperação com trava ocupada → 1; trava-diretório → 1; adquirir-posse/limpar-destino sem trava → recusados; nenhum banco criado"
  }

  # ================================================ T12 ===========================================================
  Caso "T12" "fluxo normal: PASSOU sem coleção de controle, trava 'livre'; -RemoverAoFinal remove o destino (sem dropDatabase)" {
    $b = Banco 17
    $r = Esperar (RestoreAsync $archBase $b)
    $rel = Relatorio $b
    Exigir ($r.Codigo -eq 0 -and $rel.resultado -eq "PASSOU" -and $rel.posseAdquirida) "resultado $($rel.resultado)"
    $s = Estado $b
    Exigir ($s.colecoes.Count -eq 27 -and $s.colecoes -notcontains "_mariela_restore_posse") "coleções: $($s.colecoes.Count)"
    $c = LerTrava
    Exigir ($c.livre -eq $true -and $c.ultimaExecucao -eq $rel.execucaoId) "trava não liberada"
    $b2 = Banco 18
    $r2 = Esperar (RestoreAsync $archBase $b2 @("-RemoverAoFinal"))
    $rel2 = Relatorio $b2
    Exigir ($r2.Codigo -eq 0 -and $rel2.resultado -eq "PASSOU" -and -not (Estado $b2).existe) "-RemoverAoFinal: $($rel2.resultado)"
    "PASSOU; 27 coleções, sem controle; trava livre; -RemoverAoFinal → banco inexistente"
  }

  # ================================================ T09 ===========================================================
  Caso "T09" "consolidado: TODO documento alheio gravado nos testes continua no banco" {
    $esperado = @{ 5 = "produtos"; 6 = "produtos"; 7 = "alheia_t04"; 8 = "alheia_t05"; 9 = "vendas"; 12 = "produtos" }
    $linhas = @()
    foreach ($n in $esperado.Keys | Sort-Object) {
      $b = "mariela_restore_20260103_" + ([int]$n).ToString("000000")
      $s = Estado $b
      Exigir ($s.alheios.($esperado[$n]) -ge 1) "$b perdeu o alheio em $($esperado[$n])"
      $linhas += "$b.$($esperado[$n])=$($s.alheios.($esperado[$n]))"
    }
    "6 destinos com escrita alheia, todos preservados: $($linhas -join ', ')"
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
