<#
.SYNOPSIS
  Recuperação de um destino de restore deixado por uma execução INTERROMPIDA (Fases 60.4.3.4.21.2.4 e 21.2.6).

.DESCRIPTION
  Nunca é automático. Sem -Remover, só INSPECIONA e relata. Com -Remover, a limpeza só acontece se TUDO for provado:
    1. a trava local é adquirida por esta recuperação (nenhum restore/operação em andamento);
    2. este PowerShell entra num Job Object kill-on-close (nada do que ele criar sobrevive a ele);
    3. a instância é a isolada (processo, bind, dbPath, marcador, replica set) e a credencial de restore é usada;
    4. o destino tem EXATAMENTE um documento de posse, num estado INTERROMPÍVEL (PREPARANDO, RESTAURANDO, VALIDANDO,
       FALHOU_DESTINO_PARCIAL, INTERVENCAO_NECESSARIA) — VERIFICADO/LIBERACAO_AUTORIZADA são do gerir-restore.ps1;
    5. o processo dono NÃO existe mais: PID **e** horário de criação (FILETIME) — PID reutilizado não engana;
    6. NENHUM outro processo (de qualquer nome ou executável) cita o banco ou o execucaoId na linha de comando
       (um mongorestore/CLI órfão de versões sem Job Object seria encontrado aqui);
    7. (Fase 21.2.8, A21-7-02) archive e manifesto INFORMADOS PELO OPERADOR (-ArquivoBackup/-Manifesto), conferidos pela
       CLI contra o .sha256, o manifesto, o registro local de evidências e a posse (âncora externa);
    8. a limpeza comprovada (conteúdo ⊆ archive, collectionUUID, nunca dropDatabase) não encontra nada alheio.
  Qualquer falha ⇒ nada é removido; o relatório indica o motivo (intervenção manual).
#>
param(
  [Parameter(Mandatory = $true)][string]$BancoDestino,
  [switch]$Remover,
  # Fase 21.2.8 (A21-7-02): para -Remover, archive e manifesto do backup escolhido pelo OPERADOR (nunca os da posse).
  [string]$ArquivoBackup = "",
  [string]$Manifesto = "",
  [int]$Porta = 27118,
  [string]$Raiz = (Join-Path $env:USERPROFILE "mariela-restore-isolado"),
  [string]$DiretorioRelatorio = (Join-Path $env:USERPROFILE "mariela-restore-isolado\relatorios")
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "comum.ps1")

function Recusar([string]$Mensagem) { [Console]::Error.WriteLine($Mensagem); exit 1 }
if ($Porta -ne 27118) { Recusar "Porta $Porta recusada." }
if ($BancoDestino -eq "marielaDB" -or $BancoDestino -notmatch '^mariela_restore_\d{8}_\d{6}$') { Recusar "Banco '$BancoDestino' recusado." }
if ($Remover) {
  if (-not $ArquivoBackup -or -not $Manifesto -or -not (Test-Path -LiteralPath $ArquivoBackup -PathType Leaf) -or -not (Test-Path -LiteralPath $Manifesto -PathType Leaf)) { Recusar "-Remover exige -ArquivoBackup e -Manifesto existentes (os do backup escolhido pelo operador)." }
  $ArquivoBackup = (Resolve-Path -LiteralPath $ArquivoBackup).Path
  $Manifesto = (Resolve-Path -LiteralPath $Manifesto).Path
}

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
  $jobOk = $true
  try { $null = Enable-ControleDeProcessos } catch { $jobOk = $false }
  if (-not (Prova "controle.processos" $jobOk "Job Object kill-on-close")) { Fim "NADA_REMOVIDO" 1 }
  $null = Initialize-PastaEvidencias $Raiz
  $ident = Test-EvidenciaInstancia (Get-EvidenciaPorta $Porta) (Join-Path $Raiz "mongodb-8.0.37\bin\mongod.exe")
  if (-not (Prova "instancia.processo" $ident.Ok $ident.Detalhe)) { Fim "NADA_REMOVIDO" 1 }
  $cred = Get-CredencialIsolada $Raiz 'restore'
  $comuns = @("--porta", "$Porta", "--banco", $BancoDestino, "--raiz", $Raiz)

  $insp = Invoke-CliBackup -Argumentos (@("inspecionar-destino") + $comuns) -Credencial $cred
  if (-not (Prova "inspecao" ([bool]$insp.ok) "$($insp.mensagem)")) { Fim "NADA_REMOVIDO" 1 }
  $rel.colecoes = @($insp.resultado.colecoes)
  if (-not $insp.resultado.existe) { $null = Prova "destino.existe" $false "o destino não existe"; Fim "NADA_REMOVIDO" 0 }
  $p = $insp.resultado.posse
  if (-not (Prova "posse.unica" ([bool]$p -and $insp.resultado.documentosDePosse -eq 1) "documentos de posse: $($insp.resultado.documentosDePosse)")) { Fim "NADA_REMOVIDO" 1 }
  $rel.posse = @{ execucaoId = $p.execucaoId; estado = $p.estado; pid = $p.pid; processoInicio = $p.processoInicio; executavel = $p.executavel; criadoEm = $p.criadoEm }
  # 21.2.8: REMOVENDO (remoção interrompida, A21-7-04) e estado final com a coleção de controle órfã (A21-7-07) também.
  $interrompiveis = @("PREPARANDO", "RESTAURANDO", "VALIDANDO", "FALHOU_DESTINO_PARCIAL", "INTERVENCAO_NECESSARIA", "REMOVENDO", "CANCELADO_COM_LIMPEZA_COMPROVADA", "DESCARTADO")
  if (-not (Prova "posse.estado_interrompivel" ($interrompiveis -contains $p.estado) "estado $($p.estado)")) { Fim "NADA_REMOVIDO" 1 }

  # Dono ainda vivo? PID + horário de criação (FILETIME). PID reutilizado por outro processo não conta como o dono.
  $vivo = Test-DonoVivo ([string]$p.processoInicioTicks) (Get-InicioProcesso ([int]$p.pid))
  if (-not (Prova "dono.encerrado" (-not $vivo) $(if ($vivo) { "o processo dono ($($p.pid)) ainda está ativo (ou não pôde ser lido)" } else { "processo dono não existe mais (ou o PID foi reutilizado por outro processo)" }))) { Fim "NADA_REMOVIDO" 1 }

  # Algum processo (qualquer nome/executável) ainda cita o destino ou a execução? (mongorestore/CLI órfão)
  $ativos = Get-ProcessosDaExecucao @($BancoDestino, [string]$p.execucaoId)
  if (-not (Prova "processos.nenhum_ativo" (@($ativos).Count -eq 0) $(if (@($ativos).Count) { "ativos: " + ((@($ativos) | ForEach-Object { "$($_.Nome)#$($_.Pid)" }) -join ", ") } else { "nenhum processo cita o destino ou a execução" }))) { Fim "NADA_REMOVIDO" 1 }

  $rel.ancora = $insp.resultado.ancora
  if (-not $Remover) { Fim "SO_INSPECAO" 0 }

  # Âncora externa: a CLI confere os arquivos INFORMADOS contra .sha256, manifesto, registro local e posse.
  $guard = Get-CredencialIsolada $Raiz 'guardiao'
  $l = Invoke-CliBackup -Argumentos (@("limpar-destino") + $comuns + @("--modo", "recuperacao", "--trava-execucao", $execucaoId, "--posse-execucao", $p.execucaoId, "--arquivo", $ArquivoBackup, "--manifesto", $Manifesto)) -Credencial $guard
  $okL = [bool]($l.ok -and $l.resultado.limpo)
  $null = Prova "limpeza.comprovada" $okL $(if ($l.ok) { "$($l.resultado.motivo) $($l.resultado.detalhe)" } else { $l.mensagem })
  $rel.removidas = @($l.resultado.removidas)
  $rel.estadoFinal = $l.resultado.estadoFinal
  if ($okL) { Fim "REMOVIDO" 0 } else { Fim "NADA_REMOVIDO" 1 }
} catch {
  $null = Prova "excecao" $false (ConvertTo-MensagemSegura $_)
  Fim "NADA_REMOVIDO" 1
} finally {
  Exit-TravaRestore $trava
}
