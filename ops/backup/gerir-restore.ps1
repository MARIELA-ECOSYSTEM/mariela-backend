<#
.SYNOPSIS
  Decisões do OPERADOR sobre um restore de teste já concluído (Fase 60.4.3.4.21.2.6): inspecionar, reverificar,
  LIBERAR ou REMOVER — cada uma por comando explícito e separado.

.DESCRIPTION
  -Acao Inspecionar  só leitura: estado, histórico, evidências.
  -Acao Verificar    só leitura: compara AGORA o destino com o archive e com as evidências do VERIFICADO.
  -Acao Liberar      VERIFICADO → LIBERACAO_AUTORIZADA, depois de reverificar tudo. Não remove nada, não descongela,
                     não apaga evidências. Destino diferente do VERIFICADO ⇒ INTERVENCAO_NECESSARIA.
  -Acao Remover      VERIFICADO|LIBERACAO_AUTORIZADA → CANCELADO_COM_LIMPEZA_COMPROVADA, pela limpeza comprovada (conteúdo
                     ⊆ archive, coleção por coleção com collectionUUID, nunca dropDatabase). Qualquer dúvida ⇒ nada (mais)
                     é removido e o destino vai para INTERVENCAO_NECESSARIA.
  Sempre: trava local, Job Object kill-on-close, identidade da instância, credencial de restore (DPAPI, só stdin),
  archive e manifesto conferidos pelos SHA-256 gravados na posse.

.PARAMETER ExecucaoId
  execucaoId da posse (do relatório do restore). Obrigatório para Verificar/Liberar/Remover.
#>
param(
  [Parameter(Mandatory = $true)][ValidateSet("Inspecionar", "Verificar", "Liberar", "Remover")][string]$Acao,
  [Parameter(Mandatory = $true)][string]$BancoDestino,
  [string]$ExecucaoId = "",
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
if ($Acao -ne "Inspecionar" -and $ExecucaoId -notmatch '^[0-9a-fA-F-]{36}$') { Recusar "-ExecucaoId (GUID da posse) é obrigatório para $Acao." }

$operacaoId = [guid]::NewGuid().ToString()
try { $trava = Enter-TravaRestore -Caminho (Join-Path $Raiz "locks\restore.lock") -ExecucaoId $operacaoId -Banco $BancoDestino }
catch { Recusar ("Trava de restore indisponível (um restore/operação está em andamento): " + (ConvertTo-MensagemSegura $_)) }

$rel = [ordered]@{ acao = $Acao; destino = "127.0.0.1:27118/$BancoDestino"; operacaoId = $operacaoId; posseExecucao = $ExecucaoId; operador = "$env:USERDOMAIN\$env:USERNAME"; inicio = (Get-Date).ToString("o"); estadoAntes = $null; estadoDepois = $null; resultado = "RECUSADO"; detalhe = $null }
function Fim([string]$Resultado, [int]$Codigo) {
  $rel.resultado = $Resultado
  $rel.fim = (Get-Date).ToString("o")
  try {
    if (-not (Test-Path -LiteralPath $DiretorioRelatorio)) { New-Item -ItemType Directory -Path $DiretorioRelatorio | Out-Null }
    $arq = Join-Path $DiretorioRelatorio ("gestao_{0}_{1}.json" -f $BancoDestino, $Acao.ToLowerInvariant())
    [System.IO.File]::WriteAllText($arq, ($rel | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "[$Resultado] relatório: $arq"
  } catch { [Console]::Error.WriteLine("[RELATORIO] " + (ConvertTo-MensagemSegura $_)); if ($Codigo -eq 0) { $Codigo = 1 } }
  exit $Codigo
}

try {
  try { $null = Enable-ControleDeProcessos } catch { $rel.detalhe = "controle de processos indisponível: " + (ConvertTo-MensagemSegura $_); Fim "RECUSADO" 1 }
  $ident = Test-EvidenciaInstancia (Get-EvidenciaPorta $Porta) (Join-Path $Raiz "mongodb-8.0.37\bin\mongod.exe")
  if (-not $ident.Ok) { $rel.detalhe = "identidade da instância: $($ident.Detalhe)"; Fim "RECUSADO" 1 }
  $cred = Get-CredencialIsolada $Raiz 'restore'
  $comuns = @("--porta", "$Porta", "--banco", $BancoDestino, "--raiz", $Raiz)

  $insp = Invoke-CliBackup -Argumentos (@("inspecionar-destino") + $comuns) -Credencial $cred
  if (-not $insp.ok) { $rel.detalhe = $insp.mensagem; Fim "RECUSADO" 1 }
  $p = $insp.resultado.posse
  $rel.estadoAntes = $p.estado
  $rel.colecoes = @($insp.resultado.colecoes)
  if ($Acao -eq "Inspecionar") {
    $rel.posse = $p
    $rel.estadoDepois = $p.estado
    Fim "INSPECIONADO" 0
  }
  if (-not $p -or $p.execucaoId -ne $ExecucaoId.ToLowerInvariant()) { $rel.detalhe = "a posse do destino não é da execução informada"; Fim "RECUSADO" 1 }
  # Archive/manifesto: os informados ou os registrados na posse — em ambos os casos a CLI confere os SHA-256 vinculados.
  if (-not $ArquivoBackup) { $ArquivoBackup = $p.archive }
  if (-not $Manifesto) { $Manifesto = $p.manifesto }
  $vinculo = @("--arquivo", $ArquivoBackup, "--manifesto", $Manifesto)

  switch ($Acao) {
    "Verificar" {
      $v = Invoke-CliBackup -Argumentos (@("verificar-integridade") + $comuns + @("--posse-execucao", $ExecucaoId) + $vinculo) -Credencial $cred
      $rel.verificacoes = @($v.resultado.verificacoes); $rel.divergencias = @($v.resultado.divergencias); $rel.estadoDepois = $p.estado
      if ($v.ok -and $v.resultado.ok) { Fim "INTEGRO" 0 } else { $rel.detalhe = "$($v.resultado.motivo)$($v.mensagem)"; Fim "DIVERGENTE" 1 }
    }
    "Liberar" {
      $l = Invoke-CliBackup -Argumentos (@("liberar-restore") + $comuns + @("--trava-execucao", $operacaoId, "--posse-execucao", $ExecucaoId, "--operador", $rel.operador) + $vinculo) -Credencial $cred
      $rel.estadoDepois = $l.resultado.estado; $rel.detalhe = "$($l.resultado.motivo)$($l.mensagem)"; $rel.verificacoes = @($l.resultado.verificacoes)
      if ($l.ok -and $l.resultado.ok) { Fim "LIBERACAO_AUTORIZADA" 0 } else { Fim "RECUSADO" 1 }
    }
    "Remover" {
      $l = Invoke-CliBackup -Argumentos (@("limpar-destino") + $comuns + @("--modo", "remocao", "--trava-execucao", $operacaoId, "--posse-execucao", $ExecucaoId) + $vinculo) -Credencial $cred
      $rel.estadoDepois = $l.resultado.estadoFinal; $rel.removidas = @($l.resultado.removidas); $rel.preservadas = @($l.resultado.preservadas)
      $rel.detalhe = $(if ($l.ok) { "$($l.resultado.motivo) $($l.resultado.detalhe)" } else { $l.mensagem })
      if ($l.ok -and $l.resultado.limpo) { Fim "CANCELADO_COM_LIMPEZA_COMPROVADA" 0 }
      Fim $(if ($l.resultado.estadoFinal -eq "INTERVENCAO_NECESSARIA") { "INTERVENCAO_NECESSARIA" } else { "RECUSADO" }) 1
    }
  }
} catch {
  $rel.detalhe = "exceção: " + (ConvertTo-MensagemSegura $_)
  Fim "RECUSADO" 1
} finally {
  Exit-TravaRestore $trava
}
