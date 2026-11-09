<#
.SYNOPSIS
  Restore de TESTE, isolado: só em 127.0.0.1:27118 (MongoDB 8.0.x local), num banco mariela_restore_<carimbo>.

.DESCRIPTION
  Fases 60.4.3.4.21.1/21.2. Nunca aponta para o Atlas, para marielaDB nem para test. Ordem (falha FECHADA):
    1. Antes de QUALQUER escrita: SHA-256 do archive = manifesto = .sha256; manifesto VALIDO_LOCAL; archive com
       exatamente os 27 namespaces de marielaDB e as contagens do manifesto; destino na porta 27118 com a MESMA
       série de versão da origem (8.0); banco de destino inexistente.
    2. mongorestore --nsInclude (as 27 coleções, explícitas) --nsFrom marielaDB.* --nsTo <destino>.* --stopOnError,
       SEM --drop. Aviso "Cross-version" ou qualquer documento com falha ⇒ FALHOU.
    3. Depois: coleções exatas, contagens, índices, referências (órfãos iguais aos da origem) e sequências
       idênticos ao manifesto.
  Não conecta o backend a nada (o smoke test do backend é de fase posterior, com autorização própria).

.PARAMETER ArquivoBackup
  Caminho do .archive.gz (com <base>.manifest.json e <base>.archive.gz.sha256 ao lado).
.PARAMETER Porta
  Só 27118 é aceita (parâmetro explícito para que qualquer outra porta seja recusada, não ignorada).
.PARAMETER BancoDestino
  Padrão mariela_restore_<yyyyMMdd_HHmmss>. Nunca marielaDB.
.PARAMETER RemoverAoFinal
  Derruba o banco restaurado ao final (padrão: mantém, para inspeção; derrube depois com o mesmo guarda de nome).
#>
param(
  [Parameter(Mandatory = $true)][string]$ArquivoBackup,
  [string]$Manifesto = "",
  [int]$Porta = 27118,
  [string]$BancoDestino = "",
  [string]$Mongorestore = "",
  [string]$DiretorioRelatorio = (Join-Path $env:USERPROFILE "mariela-restore-isolado\relatorios"),
  [switch]$RemoverAoFinal
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "comum.ps1")

$inicio = Get-Date
if ($Porta -ne 27118) { Write-Error "Porta $Porta recusada: o restore isolado só usa 127.0.0.1:27118."; exit 1 }
if (-not (Test-Path -LiteralPath $ArquivoBackup -PathType Leaf)) { Write-Error "Archive não encontrado."; exit 1 }
if (-not $Manifesto) { $Manifesto = $ArquivoBackup -replace '\.archive\.gz$', '.manifest.json' }
if (-not (Test-Path -LiteralPath $Manifesto -PathType Leaf)) { Write-Error "Manifesto não encontrado ($Manifesto) — sem manifesto não há restore."; exit 1 }
if (-not $BancoDestino) { $BancoDestino = "mariela_restore_" + $inicio.ToString("yyyyMMdd_HHmmss") }
if ($BancoDestino -eq "marielaDB" -or $BancoDestino -notmatch '^mariela_restore_\d{8}_\d{6}$') { Write-Error "Banco de destino '$BancoDestino' recusado (exigido mariela_restore_yyyyMMdd_HHmmss; nunca marielaDB)."; exit 1 }
if (-not $Mongorestore) {
  $cmd = Get-Command mongorestore -ErrorAction SilentlyContinue
  if (-not $cmd) { Write-Error "mongorestore não encontrado no PATH."; exit 1 }
  $Mongorestore = $cmd.Source
}

$relatorio = [ordered]@{ archive = (Split-Path -Leaf $ArquivoBackup); destino = "127.0.0.1:27118/$BancoDestino"; inicio = $inicio.ToString("o"); etapas = @(); resultado = "FALHOU" }
function Encerrar([string]$Resultado, [int]$Codigo) {
  $relatorio.resultado = $Resultado
  $relatorio.fim = (Get-Date).ToString("o")
  $relatorio.duracaoSegundos = [math]::Round(((Get-Date) - $inicio).TotalSeconds, 2)
  if (-not (Test-Path -LiteralPath $DiretorioRelatorio)) { New-Item -ItemType Directory -Path $DiretorioRelatorio | Out-Null }
  $arq = Join-Path $DiretorioRelatorio "restore_$BancoDestino.json"
  [System.IO.File]::WriteAllText($arq, ($relatorio | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "[$Resultado] relatório: $arq"
  exit $Codigo
}
function Etapa([string]$Nome, $Resposta) {
  $ok = [bool]($Resposta.ok -and ($null -eq $Resposta.resultado.ok -or $Resposta.resultado.ok))
  $relatorio.etapas += @{ etapa = $Nome; ok = $ok; verificacoes = @($Resposta.resultado.verificacoes); erro = $Resposta.mensagem }
  return $ok
}

# --- 1. Validações ANTES de qualquer escrita -----------------------------------------------------------------
if (-not (Etapa "validar-archive" (Invoke-CliBackup -Argumentos @("validar-para-restore", "--arquivo", $ArquivoBackup, "--manifesto", $Manifesto)))) { Encerrar "FALHOU" 1 }
if (-not (Etapa "preparar-destino" (Invoke-CliBackup -Argumentos @("preparar-restore", "--porta", "$Porta", "--banco", $BancoDestino, "--manifesto", $Manifesto)))) { Encerrar "FALHOU" 1 }
$politica = Invoke-CliBackup -Argumentos @("politica")
$colecoes = @($politica.resultado.colecoesIncluidas)
if ($colecoes.Count -ne 27) { $relatorio.etapas += @{ etapa = "politica"; ok = $false; erro = "lista positiva com $($colecoes.Count) coleções" }; Encerrar "FALHOU" 1 }

# --- 2. mongorestore ---------------------------------------------------------------------------------------------
$argsRestore = @("--uri=mongodb://127.0.0.1:27118/?directConnection=true", "--gzip", "--archive=$ArquivoBackup", "--nsFrom=marielaDB.*", "--nsTo=$BancoDestino.*", "--stopOnError")
foreach ($c in $colecoes) { $argsRestore += "--nsInclude=marielaDB.$c" }
$tRestore = Get-Date
$r = Invoke-Nativo -Programa $Mongorestore -Argumentos $argsRestore
$textoRestore = "$($r.Saida)`n$($r.Erro)"
$falhados = if ($textoRestore -match '(\d+) document\(s\) failed to restore') { [int]$Matches[1] } else { -1 }
$restaurados = if ($textoRestore -match '(\d+) document\(s\) restored successfully') { [int]$Matches[1] } else { -1 }
$crossVersion = $textoRestore -match 'Cross-version'
$okRestore = ($r.Codigo -eq 0) -and ($falhados -eq 0) -and (-not $crossVersion)
$relatorio.etapas += @{ etapa = "mongorestore"; ok = $okRestore; codigo = $r.Codigo; documentosRestaurados = $restaurados; documentosComFalha = $falhados; avisoCrossVersion = $crossVersion; duracaoSegundos = [math]::Round(((Get-Date) - $tRestore).TotalSeconds, 2) }
if (-not $okRestore) { Encerrar "FALHOU" 1 }

# --- 3. Validação do banco restaurado ------------------------------------------------------------------------
$okFinal = Etapa "validar-restaurado" (Invoke-CliBackup -Argumentos @("validar-restaurado", "--porta", "$Porta", "--banco", $BancoDestino, "--manifesto", $Manifesto))
if ($RemoverAoFinal) {
  $d = Invoke-CliBackup -Argumentos @("derrubar-restore", "--porta", "$Porta", "--banco", $BancoDestino)
  $relatorio.etapas += @{ etapa = "remover-banco-restaurado"; ok = [bool]$d.ok }
}
if ($okFinal) { Encerrar "PASSOU" 0 } else { Encerrar "FALHOU" 1 }
