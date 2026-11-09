<#
.SYNOPSIS
  Restore de TESTE, isolado: só em 127.0.0.1:27118 (MongoDB 8.0.x local), num banco mariela_restore_<carimbo>.

.DESCRIPTION
  Fases 60.4.3.4.21.1/21.2/21.2.2. Nunca aponta para o Atlas, para marielaDB nem para test. Ordem (falha FECHADA):
    0. IDENTIDADE da instância (R21-2.1-11): o processo que escuta em 27118 é o mongod.exe instalado em -Raiz, só em
       127.0.0.1; depois, já conectado: dbPath = <Raiz>\data-27118 com o marcador, bind só 127.0.0.1, replica set
       rs-restore. Qualquer divergência ⇒ nada é feito.
    1. Antes de QUALQUER escrita: SHA-256 do archive = manifesto = .sha256; manifesto VALIDO_LOCAL; archive com
       exatamente os 27 namespaces de marielaDB e as contagens do manifesto; mesma série de versão da origem (8.0);
       banco de destino INEXISTENTE (é essa a prova de que o destino pertence a esta execução).
    2. mongorestore --nsInclude (as 27) --nsFrom marielaDB.* --nsTo <destino>.* --stopOnError, SEM --drop.
    3. Depois: coleções exatas, contagens, índices, referências e sequências idênticos ao manifesto.
  R21-2.1-07 — falha DEPOIS de iniciar a escrita (mongorestore, validação ou exceção): o destino é inválido. Ele é
  removido AUTOMATICAMENTE só se a exclusividade foi provada no passo 1 (e a remoção é confirmada); senão — ou se a
  remoção falhar — o resultado é FALHOU_DESTINO_PARCIAL (intervenção manual), nunca PASSOU.

.PARAMETER ArquivoBackup
  Caminho do .archive.gz (com <base>.manifest.json e <base>.archive.gz.sha256 ao lado).
.PARAMETER Porta
  Só 27118 é aceita (parâmetro explícito para que qualquer outra porta seja recusada, não ignorada).
.PARAMETER BancoDestino
  Padrão mariela_restore_<yyyyMMdd_HHmmss>. Nunca marielaDB.
.PARAMETER Raiz
  Raiz da instância isolada (padrão %USERPROFILE%\mariela-restore-isolado).
.PARAMETER RemoverAoFinal
  Derruba o banco restaurado ao final de um restore que PASSOU (padrão: mantém, para inspeção).

.NOTES
  Saída: 0 = PASSOU; 1 = recusado, FALHOU ou FALHOU_DESTINO_PARCIAL. Relatório: <DiretorioRelatorio>\restore_<destino>.json.
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

# Recusa antes de qualquer coisa: stderr + código 1 (sem relatório — nada foi tentado).
function Recusar([string]$Mensagem) {
  [Console]::Error.WriteLine($Mensagem)
  exit 1
}

$inicio = Get-Date
if ($Porta -ne 27118) { Recusar "Porta $Porta recusada: o restore isolado só usa 127.0.0.1:27118." }
if (-not (Test-Path -LiteralPath $ArquivoBackup -PathType Leaf)) { Recusar "Archive não encontrado." }
if (-not $Manifesto) { $Manifesto = $ArquivoBackup -replace '\.archive\.gz$', '.manifest.json' }
if (-not (Test-Path -LiteralPath $Manifesto -PathType Leaf)) { Recusar "Manifesto não encontrado ($Manifesto) — sem manifesto não há restore." }
if (-not $BancoDestino) { $BancoDestino = "mariela_restore_" + $inicio.ToString("yyyyMMdd_HHmmss") }
if ($BancoDestino -eq "marielaDB" -or $BancoDestino -notmatch '^mariela_restore_\d{8}_\d{6}$') { Recusar "Banco de destino '$BancoDestino' recusado (exigido mariela_restore_yyyyMMdd_HHmmss; nunca marielaDB)." }
if (-not $Mongorestore) {
  $cmd = Get-Command mongorestore -ErrorAction SilentlyContinue
  if (-not $cmd) { Recusar "mongorestore não encontrado no PATH." }
  $Mongorestore = $cmd.Source
}

$relatorio = [ordered]@{
  archive = (Split-Path -Leaf $ArquivoBackup)
  destino = "127.0.0.1:27118/$BancoDestino"
  inicio = $inicio.ToString("o")
  etapas = @()
  escritaIniciada = $false
  destinoExclusivo = $false
  limpeza = $null
  exigeIntervencao = $false
  resultado = "FALHOU"
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
    # Falha do relatório nunca vira sucesso.
    [Console]::Error.WriteLine("[RELATORIO] não foi possível gravar o relatório — " + (ConvertTo-MensagemSegura $_))
    if ($Codigo -eq 0) { $Codigo = 1 }
  }
  exit $Codigo
}

function Etapa([string]$Nome, $Resposta) {
  $ok = [bool]($Resposta.ok -and ($null -eq $Resposta.resultado.ok -or $Resposta.resultado.ok))
  $relatorio.etapas += @{ etapa = $Nome; ok = $ok; verificacoes = @($Resposta.resultado.verificacoes); erro = $Resposta.mensagem }
  return $ok
}

<#
  R21-2.1-07 — destino inválido depois de iniciada a escrita. Remove SÓ o banco desta execução e SÓ com a
  exclusividade provada (banco inexistente antes do restore); a CLI recusa marielaDB e nomes fora do padrão e confere
  a identidade da instância de novo. Devolve o resultado final a usar.
#>
function TratarDestinoParcial([string]$Motivo) {
  if (-not $relatorio.destinoExclusivo) {
    $relatorio.limpeza = @{ executada = $false; motivo = "exclusividade do destino NÃO comprovada — nada removido ($Motivo)" }
    $relatorio.exigeIntervencao = $true
    return "FALHOU_DESTINO_PARCIAL"
  }
  try {
    $d = Invoke-CliBackup -Argumentos @("derrubar-restore", "--porta", "$Porta", "--banco", $BancoDestino, "--raiz", $Raiz)
    $erro = $d.mensagem
  } catch {
    $d = $null
    $erro = ConvertTo-MensagemSegura $_
  }
  if ($d -and $d.ok -and -not $d.resultado.aindaExiste) {
    $relatorio.limpeza = @{ executada = $true; removido = [bool]$d.resultado.removido; motivo = $Motivo }
    return "FALHOU"
  }
  $relatorio.limpeza = @{ executada = $false; motivo = $Motivo; erro = $erro }
  $relatorio.exigeIntervencao = $true
  return "FALHOU_DESTINO_PARCIAL"
}

try {
  # --- 0. Identidade do PROCESSO dono da porta (antes de qualquer conexão) ------------------------------------
  $identidade = Test-EvidenciaInstancia (Get-EvidenciaPorta $Porta) (Join-Path $Raiz "mongodb-8.0.37\bin\mongod.exe")
  $relatorio.etapas += @{ etapa = "identidade-processo"; ok = $identidade.Ok; erro = $identidade.Detalhe }
  if (-not $identidade.Ok) { Encerrar "FALHOU" 1 }

  # --- 1. Validações ANTES de qualquer escrita -----------------------------------------------------------------
  if (-not (Etapa "validar-archive" (Invoke-CliBackup -Argumentos @("validar-para-restore", "--arquivo", $ArquivoBackup, "--manifesto", $Manifesto)))) { Encerrar "FALHOU" 1 }
  $preparo = Invoke-CliBackup -Argumentos @("preparar-restore", "--porta", "$Porta", "--banco", $BancoDestino, "--manifesto", $Manifesto, "--raiz", $Raiz)
  if (-not (Etapa "preparar-destino" $preparo)) { Encerrar "FALHOU" 1 }
  $relatorio.destinoExclusivo = [bool]($preparo.ok -and $preparo.resultado.destinoExclusivo)
  if (-not $relatorio.destinoExclusivo) { Encerrar "FALHOU" 1 }
  $politica = Invoke-CliBackup -Argumentos @("politica")
  $colecoes = @($politica.resultado.colecoesIncluidas)
  if ($colecoes.Count -ne 27) { $relatorio.etapas += @{ etapa = "politica"; ok = $false; erro = "lista positiva com $($colecoes.Count) coleções" }; Encerrar "FALHOU" 1 }

  # --- 2. mongorestore (a partir daqui o destino pode conter dados) --------------------------------------------
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

  # --- 3. Validação do banco restaurado ------------------------------------------------------------------------
  $okFinal = Etapa "validar-restaurado" (Invoke-CliBackup -Argumentos @("validar-restaurado", "--porta", "$Porta", "--banco", $BancoDestino, "--manifesto", $Manifesto, "--raiz", $Raiz))
  if (-not $okFinal) { Encerrar (TratarDestinoParcial "validação pós-restore falhou") 1 }
  if ($RemoverAoFinal) {
    $d = Invoke-CliBackup -Argumentos @("derrubar-restore", "--porta", "$Porta", "--banco", $BancoDestino, "--raiz", $Raiz)
    $relatorio.etapas += @{ etapa = "remover-banco-restaurado"; ok = [bool]($d.ok -and -not $d.resultado.aindaExiste); erro = $d.mensagem }
  }
  Encerrar "PASSOU" 0
} catch {
  # Exceção inesperada (o `exit` de Encerrar não passa por aqui). Mensagem sanitizada; destino tratado se já houve escrita.
  $relatorio.etapas += @{ etapa = "excecao"; ok = $false; erro = (ConvertTo-MensagemSegura $_) }
  $final = if ($relatorio.escritaIniciada) { TratarDestinoParcial "exceção depois de iniciar a escrita" } else { "FALHOU" }
  Encerrar $final 1
}
