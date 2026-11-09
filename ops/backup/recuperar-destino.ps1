<#
.SYNOPSIS
  Recuperação de um destino de restore deixado por uma execução INTERROMPIDA (Fase 60.4.3.4.21.2.4, R21-2.3-01).

.DESCRIPTION
  Nunca é automático. Sem -Remover, só INSPECIONA e relata. Com -Remover, a limpeza só acontece se TUDO for provado:
    1. a trava local é adquirida por esta recuperação (nenhum restore em andamento);
    2. a instância é a isolada (processo, bind, dbPath, marcador, replica set);
    3. o destino tem EXATAMENTE um documento de posse, de uma execução identificada;
    4. o processo dono dessa posse NÃO existe mais (PID e horário de início — PID reutilizado não engana);
    5. o archive registrado na posse ainda existe e tem o MESMO SHA-256;
    6. a limpeza segura (CLI limpar-destino) prova que o destino só contém dados do archive e da execução —
       senão nada é removido.
  Qualquer falha ⇒ nada é removido; o relatório indica o motivo (intervenção manual).

.PARAMETER BancoDestino
  mariela_restore_yyyyMMdd_HHmmss (nunca marielaDB).
.PARAMETER Remover
  Executa a limpeza segura depois das provas. Sem ele: só inspeção.
#>
param(
  [Parameter(Mandatory = $true)][string]$BancoDestino,
  [switch]$Remover,
  [int]$Porta = 27118,
  [string]$Raiz = (Join-Path $env:USERPROFILE "mariela-restore-isolado"),
  [string]$DiretorioRelatorio = (Join-Path $env:USERPROFILE "mariela-restore-isolado\relatorios")
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "comum.ps1")

function Recusar([string]$Mensagem) { [Console]::Error.WriteLine($Mensagem); exit 1 }
if ($Porta -ne 27118) { Recusar "Porta $Porta recusada." }
if ($BancoDestino -eq "marielaDB" -or $BancoDestino -notmatch '^mariela_restore_\d{8}_\d{6}$') { Recusar "Banco '$BancoDestino' recusado." }

$execucaoId = [guid]::NewGuid().ToString()
try { $trava = Enter-TravaRestore -Caminho (Join-Path $Raiz "locks\restore.lock") -ExecucaoId $execucaoId -Banco $BancoDestino }
catch { Recusar ("Trava de restore indisponível (um restore está em andamento): " + (ConvertTo-MensagemSegura $_)) }

$rel = [ordered]@{ destino = "127.0.0.1:27118/$BancoDestino"; recuperacaoId = $execucaoId; inicio = (Get-Date).ToString("o"); provas = @(); resultado = "NADA_REMOVIDO"; removidas = @() }
function Prova([string]$Id, [bool]$Ok, [string]$Detalhe) { $rel.provas += @{ id = $Id; ok = $Ok; detalhe = $Detalhe }; return $Ok }
function Fim([string]$Resultado, [int]$Codigo) {
  $rel.resultado = $Resultado
  $rel.fim = (Get-Date).ToString("o")
  try {
    if (-not (Test-Path -LiteralPath $DiretorioRelatorio)) { New-Item -ItemType Directory -Path $DiretorioRelatorio | Out-Null }
    $arq = Join-Path $DiretorioRelatorio "recuperacao_$BancoDestino.json"
    [System.IO.File]::WriteAllText($arq, ($rel | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "[$Resultado] relatório: $arq"
  } catch { [Console]::Error.WriteLine("[RELATORIO] " + (ConvertTo-MensagemSegura $_)); if ($Codigo -eq 0) { $Codigo = 1 } }
  exit $Codigo
}

try {
  $ident = Test-EvidenciaInstancia (Get-EvidenciaPorta $Porta) (Join-Path $Raiz "mongodb-8.0.37\bin\mongod.exe")
  if (-not (Prova "instancia.processo" $ident.Ok $ident.Detalhe)) { Fim "NADA_REMOVIDO" 1 }

  $insp = Invoke-CliBackup -Argumentos @("inspecionar-destino", "--porta", "$Porta", "--banco", $BancoDestino, "--raiz", $Raiz)
  if (-not (Prova "inspecao" ([bool]$insp.ok) "$($insp.mensagem)")) { Fim "NADA_REMOVIDO" 1 }
  $rel.colecoes = @($insp.resultado.colecoes)
  if (-not $insp.resultado.existe) { $null = Prova "destino.existe" $false "o destino não existe"; Fim "NADA_REMOVIDO" 0 }
  $p = $insp.resultado.posse
  if (-not (Prova "posse.unica" ([bool]$p -and $insp.resultado.documentosDePosse -eq 1) "documentos de posse: $($insp.resultado.documentosDePosse)")) { Fim "NADA_REMOVIDO" 1 }
  $rel.posse = @{ execucaoId = $p.execucaoId; pid = $p.pid; processoInicio = $p.processoInicio; criadoEm = $p.criadoEm }

  # Dono ainda vivo? PID + horário de início (PID reutilizado por outro processo não conta como o dono).
  $vivo = $false
  $proc = Get-Process -Id ([int]$p.pid) -ErrorAction SilentlyContinue
  if ($proc) { try { $vivo = ($proc.StartTime.ToUniversalTime().ToString("o") -eq $p.processoInicio) } catch { $vivo = $true } }
  if (-not (Prova "dono.encerrado" (-not $vivo) $(if ($vivo) { "o processo dono ($($p.pid)) ainda está ativo" } else { "processo dono não existe mais" }))) { Fim "NADA_REMOVIDO" 1 }

  $archiveOk = (Test-Path -LiteralPath $p.archive -PathType Leaf) -and ((Get-Sha256 $p.archive) -eq $p.archiveSha256) -and (Test-Path -LiteralPath $p.manifesto -PathType Leaf)
  if (-not (Prova "archive.mesmo" $archiveOk "archive/manifesto da posse presentes com o mesmo SHA-256: $archiveOk")) { Fim "NADA_REMOVIDO" 1 }

  if (-not $Remover) { Fim "SO_INSPECAO" 0 }

  $l = Invoke-CliBackup -Argumentos @("limpar-destino", "--porta", "$Porta", "--banco", $BancoDestino, "--trava-execucao", $execucaoId, "--posse-execucao", $p.execucaoId, "--arquivo", $p.archive, "--manifesto", $p.manifesto, "--raiz", $Raiz)
  $okL = [bool]($l.ok -and $l.resultado.limpo)
  $null = Prova "limpeza.segura" $okL $(if ($l.ok) { "$($l.resultado.motivo) $($l.resultado.detalhe)" } else { $l.mensagem })
  $rel.removidas = @($l.resultado.removidas)
  if ($okL) { Fim "REMOVIDO" 0 } else { Fim "NADA_REMOVIDO" 1 }
} catch {
  $null = Prova "excecao" $false (ConvertTo-MensagemSegura $_)
  Fim "NADA_REMOVIDO" 1
} finally {
  Exit-TravaRestore $trava
}
