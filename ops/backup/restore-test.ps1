<#
.SYNOPSIS
  Restore de TESTE, isolado: só em 127.0.0.1:27118 (MongoDB 8.0.x local), num banco mariela_restore_<carimbo>.

.DESCRIPTION
  Fases 60.4.3.4.21.1/21.2/21.2.2/21.2.4. Nunca aponta para o Atlas, para marielaDB nem para test.
    T. TRAVA local (R21-2.3-01): <Raiz>\locks\restore.lock é adquirida no início e MANTIDA até o fim; com ela ocupada
       (outro restore em andamento) nada é feito. Cada execução tem um execucaoId (GUID) próprio.
    0. IDENTIDADE da instância (R21-2.1-11): processo dono da porta = mongod.exe de -Raiz, só 127.0.0.1; já conectado:
       dbPath, marcador, bind, replica set rs-restore.
    1. Antes de QUALQUER escrita: SHA-256 = manifesto = .sha256; manifesto VALIDO_LOCAL; 27 namespaces e contagens;
       mesma série de versão; banco de destino inexistente.
    2. POSSE ATÔMICA (R21-2.3-01): cria a coleção de controle _mariela_restore_posse (falha se já existir) com o
       execucaoId; exige que o banco contenha só ela. Sem posse, nada é escrito.
    3. mongorestore --nsInclude (as 27) --nsFrom marielaDB.* --nsTo <destino>.* --stopOnError, SEM --drop.
    4. Validação: coleções exatas (a de controle não conta), contagens, índices, referências, sequências.
    5. PASSOU: remove só a coleção de controle (posse conferida). -RemoverAoFinal: limpeza segura do destino.
  Falha DEPOIS de iniciar a escrita: LIMPEZA SEGURA (nunca dropDatabase) — exige trava + posse ATUAIS, recusa se houver
  qualquer coleção/documento/índice fora do archive, congela as coleções antes de conferir e remove coleção por
  coleção. Qualquer dúvida ⇒ FALHOU_DESTINO_PARCIAL (nada removido, intervenção). Execução interrompida (queda) NUNCA é
  limpa automaticamente: use recuperar-destino.ps1.

.NOTES
  Saída: 0 = PASSOU; 1 = recusado, FALHOU ou FALHOU_DESTINO_PARCIAL. Relatório: <DiretorioRelatorio>\restore_<destino>.json.
  Exclusão mútua só LOCAL (mesma máquina; a instância só escuta em 127.0.0.1). Não há garantia distribuída.
#>
param(
  [Parameter(Mandatory = $true)][string]$ArquivoBackup,
  [string]$Manifesto = "",
  [int]$Porta = 27118,
  [string]$BancoDestino = "",
  [string]$Mongorestore = "",
  [string]$Raiz = (Join-Path $env:USERPROFILE "mariela-restore-isolado"),
  [string]$DiretorioRelatorio = (Join-Path $env:USERPROFILE "mariela-restore-isolado\relatorios"),
  [switch]$RemoverAoFinal
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "comum.ps1")

function Recusar([string]$Mensagem) {
  [Console]::Error.WriteLine($Mensagem)
  exit 1
}

$inicio = Get-Date
if ($Porta -ne 27118) { Recusar "Porta $Porta recusada: o restore isolado só usa 127.0.0.1:27118." }
if (-not (Test-Path -LiteralPath $ArquivoBackup -PathType Leaf)) { Recusar "Archive não encontrado." }
$ArquivoBackup = (Resolve-Path -LiteralPath $ArquivoBackup).Path
if (-not $Manifesto) { $Manifesto = $ArquivoBackup -replace '\.archive\.gz$', '.manifest.json' }
if (-not (Test-Path -LiteralPath $Manifesto -PathType Leaf)) { Recusar "Manifesto não encontrado ($Manifesto) — sem manifesto não há restore." }
$Manifesto = (Resolve-Path -LiteralPath $Manifesto).Path
if (-not $BancoDestino) { $BancoDestino = "mariela_restore_" + $inicio.ToString("yyyyMMdd_HHmmss") }
if ($BancoDestino -eq "marielaDB" -or $BancoDestino -notmatch '^mariela_restore_\d{8}_\d{6}$') { Recusar "Banco de destino '$BancoDestino' recusado (exigido mariela_restore_yyyyMMdd_HHmmss; nunca marielaDB)." }
if (-not $Mongorestore) {
  $cmd = Get-Command mongorestore -ErrorAction SilentlyContinue
  if (-not $cmd) { Recusar "mongorestore não encontrado no PATH." }
  $Mongorestore = $cmd.Source
}

# --- T. Trava local (antes de qualquer conexão) --------------------------------------------------------------
$execucaoId = [guid]::NewGuid().ToString()
$caminhoTrava = Join-Path $Raiz "locks\restore.lock"
try { $trava = Enter-TravaRestore -Caminho $caminhoTrava -ExecucaoId $execucaoId -Banco $BancoDestino }
catch { Recusar ("Trava de restore indisponível (outro restore em andamento, ou a trava não pôde ser criada): " + (ConvertTo-MensagemSegura $_)) }

$relatorio = [ordered]@{
  archive = (Split-Path -Leaf $ArquivoBackup)
  destino = "127.0.0.1:27118/$BancoDestino"
  execucaoId = $execucaoId
  inicio = $inicio.ToString("o")
  execucaoAnteriorInterrompida = $null
  etapas = @()
  posseAdquirida = $false
  escritaIniciada = $false
  limpeza = $null
  exigeIntervencao = $false
  resultado = "FALHOU"
}
if ($trava.Anterior -and $trava.Anterior.livre -ne $true) {
  # A execução anterior não liberou a trava (queda/encerramento abrupto): registrada, NUNCA limpa automaticamente.
  $relatorio.execucaoAnteriorInterrompida = @{ execucaoId = $trava.Anterior.execucaoId; banco = $trava.Anterior.banco; pid = $trava.Anterior.pid }
}

function Encerrar([string]$Resultado, [int]$Codigo) {
  $relatorio.resultado = $Resultado
  $relatorio.fim = (Get-Date).ToString("o")
  $relatorio.duracaoSegundos = [math]::Round(((Get-Date) - $inicio).TotalSeconds, 2)
  try {
    if (-not (Test-Path -LiteralPath $DiretorioRelatorio)) { New-Item -ItemType Directory -Path $DiretorioRelatorio | Out-Null }
    $arq = Join-Path $DiretorioRelatorio "restore_$BancoDestino.json"
    [System.IO.File]::WriteAllText($arq, ($relatorio | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "[$Resultado] relatório: $arq"
  } catch {
    [Console]::Error.WriteLine("[RELATORIO] não foi possível gravar o relatório — " + (ConvertTo-MensagemSegura $_))
    if ($Codigo -eq 0) { $Codigo = 1 }
  }
  exit $Codigo
}

function Etapa([string]$Nome, $Resposta) {
  $ok = [bool]($Resposta.ok -and ($null -eq $Resposta.resultado.ok -or $Resposta.resultado.ok))
  $relatorio.etapas += @{ etapa = $Nome; ok = $ok; verificacoes = @($Resposta.resultado.verificacoes); erro = $Resposta.mensagem; motivo = $Resposta.resultado.motivo }
  return $ok
}

<#
  Destino inválido depois de iniciada a escrita. Limpeza SEGURA pela CLI (trava + posse ATUAIS, conteúdo ⊆ archive,
  congelamento, remoção coleção por coleção). Qualquer recusa ⇒ FALHOU_DESTINO_PARCIAL (nada removido). Devolve o
  resultado final.
#>
function TratarDestinoParcial([string]$Motivo) {
  if (-not $relatorio.posseAdquirida) {
    $relatorio.limpeza = @{ executada = $false; motivo = "posse do destino NÃO adquirida — nada removido ($Motivo)" }
    $relatorio.exigeIntervencao = $true
    return "FALHOU_DESTINO_PARCIAL"
  }
  try {
    $l = Invoke-CliBackup -Argumentos @("limpar-destino", "--porta", "$Porta", "--banco", $BancoDestino, "--trava-execucao", $execucaoId, "--posse-execucao", $execucaoId, "--arquivo", $ArquivoBackup, "--manifesto", $Manifesto, "--raiz", $Raiz)
  } catch {
    $l = $null
    $relatorio.limpeza = @{ executada = $false; motivo = $Motivo; erro = (ConvertTo-MensagemSegura $_) }
  }
  if ($l -and $l.ok -and $l.resultado.limpo) {
    $relatorio.limpeza = @{ executada = $true; motivo = $Motivo; removidas = @($l.resultado.removidas) }
    return "FALHOU"
  }
  if ($l) {
    $relatorio.limpeza = @{ executada = $false; motivo = $Motivo; recusa = $(if ($l.ok) { $l.resultado.motivo } else { $l.codigo }); detalhe = $(if ($l.ok) { $l.resultado.detalhe } else { $l.mensagem }); removidas = @($l.resultado.removidas); preservadas = @($l.resultado.preservadas) }
  }
  $relatorio.exigeIntervencao = $true
  return "FALHOU_DESTINO_PARCIAL"
}

try {
  # --- 0. Identidade do PROCESSO dono da porta -----------------------------------------------------------------
  $identidade = Test-EvidenciaInstancia (Get-EvidenciaPorta $Porta) (Join-Path $Raiz "mongodb-8.0.37\bin\mongod.exe")
  $relatorio.etapas += @{ etapa = "identidade-processo"; ok = $identidade.Ok; erro = $identidade.Detalhe }
  if (-not $identidade.Ok) { Encerrar "FALHOU" 1 }

  # --- 1. Validações ANTES de qualquer escrita -----------------------------------------------------------------
  if (-not (Etapa "validar-archive" (Invoke-CliBackup -Argumentos @("validar-para-restore", "--arquivo", $ArquivoBackup, "--manifesto", $Manifesto)))) { Encerrar "FALHOU" 1 }
  if (-not (Etapa "preparar-destino" (Invoke-CliBackup -Argumentos @("preparar-restore", "--porta", "$Porta", "--banco", $BancoDestino, "--manifesto", $Manifesto, "--raiz", $Raiz)))) { Encerrar "FALHOU" 1 }
  $politica = Invoke-CliBackup -Argumentos @("politica")
  $colecoes = @($politica.resultado.colecoesIncluidas)
  if ($colecoes.Count -ne 27) { $relatorio.etapas += @{ etapa = "politica"; ok = $false; erro = "lista positiva com $($colecoes.Count) coleções" }; Encerrar "FALHOU" 1 }

  # --- 2. Posse ATÔMICA do destino (antes de qualquer escrita do restore) --------------------------------------
  $posse = Invoke-CliBackup -Argumentos @("adquirir-posse", "--porta", "$Porta", "--banco", $BancoDestino, "--execucao", $execucaoId, "--arquivo", $ArquivoBackup, "--manifesto", $Manifesto, "--processo-inicio", $trava.ProcessoInicio, "--raiz", $Raiz)
  if (-not (Etapa "adquirir-posse" $posse)) {
    # Nada desta execução ficou no destino: a CLI remove só a própria coleção de controle quando o banco tinha dados.
    Encerrar "FALHOU" 1
  }
  $relatorio.posseAdquirida = $true

  # --- 3. mongorestore ---------------------------------------------------------------------------------------------
  $argsRestore = @("--uri=mongodb://127.0.0.1:27118/?directConnection=true", "--gzip", "--archive=$ArquivoBackup", "--nsFrom=marielaDB.*", "--nsTo=$BancoDestino.*", "--stopOnError")
  foreach ($c in $colecoes) { $argsRestore += "--nsInclude=marielaDB.$c" }
  $tRestore = Get-Date
  $relatorio.escritaIniciada = $true
  $r = Invoke-Nativo -Programa $Mongorestore -Argumentos $argsRestore
  $textoRestore = "$($r.Saida)`n$($r.Erro)"
  $falhados = if ($textoRestore -match '(\d+) document\(s\) failed to restore') { [int]$Matches[1] } else { -1 }
  $restaurados = if ($textoRestore -match '(\d+) document\(s\) restored successfully') { [int]$Matches[1] } else { -1 }
  $crossVersion = $textoRestore -match 'Cross-version'
  $okRestore = ($r.Codigo -eq 0) -and ($falhados -eq 0) -and (-not $crossVersion)
  $relatorio.etapas += @{ etapa = "mongorestore"; ok = $okRestore; codigo = $r.Codigo; documentosRestaurados = $restaurados; documentosComFalha = $falhados; avisoCrossVersion = $crossVersion; duracaoSegundos = [math]::Round(((Get-Date) - $tRestore).TotalSeconds, 2) }
  if (-not $okRestore) { Encerrar (TratarDestinoParcial "mongorestore falhou (código $($r.Codigo))") 1 }

  # --- 4. Validação ------------------------------------------------------------------------------------------------
  $okFinal = Etapa "validar-restaurado" (Invoke-CliBackup -Argumentos @("validar-restaurado", "--porta", "$Porta", "--banco", $BancoDestino, "--manifesto", $Manifesto, "--raiz", $Raiz))
  if (-not $okFinal) { Encerrar (TratarDestinoParcial "validação pós-restore falhou") 1 }

  # --- 5. Conclusão: sem resíduo de controle -----------------------------------------------------------------------
  if ($RemoverAoFinal) {
    $l = Invoke-CliBackup -Argumentos @("limpar-destino", "--porta", "$Porta", "--banco", $BancoDestino, "--trava-execucao", $execucaoId, "--posse-execucao", $execucaoId, "--arquivo", $ArquivoBackup, "--manifesto", $Manifesto, "--raiz", $Raiz)
    $relatorio.etapas += @{ etapa = "remover-banco-restaurado"; ok = [bool]($l.ok -and $l.resultado.limpo); erro = $l.mensagem; motivo = $l.resultado.motivo }
    if (-not ($l.ok -and $l.resultado.limpo)) { $relatorio.exigeIntervencao = $true; Encerrar "FALHOU_DESTINO_PARCIAL" 1 }
  } else {
    $fim = Invoke-CliBackup -Argumentos @("finalizar-posse", "--porta", "$Porta", "--banco", $BancoDestino, "--execucao", $execucaoId, "--raiz", $Raiz)
    $relatorio.etapas += @{ etapa = "finalizar-posse"; ok = [bool]($fim.ok -and $fim.resultado.finalizada); erro = $fim.mensagem; motivo = $fim.resultado.detalhe }
    if (-not ($fim.ok -and $fim.resultado.finalizada)) { $relatorio.exigeIntervencao = $true; Encerrar "FALHOU_DESTINO_PARCIAL" 1 }
  }
  Encerrar "PASSOU" 0
} catch {
  $relatorio.etapas += @{ etapa = "excecao"; ok = $false; erro = (ConvertTo-MensagemSegura $_) }
  $final = if ($relatorio.escritaIniciada) { TratarDestinoParcial "exceção depois de iniciar a escrita" } else { "FALHOU" }
  Encerrar $final 1
} finally {
  Exit-TravaRestore $trava
}
