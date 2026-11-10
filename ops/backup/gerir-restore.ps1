<#
.SYNOPSIS
  Decisões do OPERADOR sobre um restore de teste (Fases 60.4.3.4.21.2.6 e 21.2.8): inspecionar, reverificar, LIBERAR,
  INICIAR USO, REMOVER ou DESCARTAR — cada uma por comando explícito e separado.

.DESCRIPTION
  -Acao Inspecionar  só leitura: estado, garantias EFETIVAS (Fase 21.2.11: declaradas pelo estado × efetivamente
                     comprovadas nesta consulta — âncora, identidade, posse, proteção; "igual ao archive" nunca é
                     reconferido aqui), histórico, evidências, âncora.
  -Acao Verificar    só leitura: compara AGORA o destino com o archive, as evidências e a âncora externa.
  -Acao Liberar      VERIFICADO → LIBERACAO_AUTORIZADA, depois de reverificar tudo. NÃO descongela (o destino continua
                     protegido e igual ao archive); NÃO remove nada; NÃO apaga evidências.
  -Acao IniciarUso   LIBERACAO_AUTORIZADA → EM_USO: reverifica, registra (data, operador, UUIDs) e DESCONGELA. A partir daí
                     o destino NÃO é mais garantido igual ao archive nem imutável. Exige -ConfirmarBanco.
  -Acao Remover      VERIFICADO|LIBERACAO_AUTORIZADA → REMOVENDO → CANCELADO_COM_LIMPEZA_COMPROVADA (conteúdo ⊆ archive,
                     coleção por coleção com collectionUUID, nunca dropDatabase).
  -Acao Descartar    EM_USO → REMOVENDO → DESCARTADO: remove só as coleções da política com o MESMO UUID registrado no
                     início do uso (sem exigir igualdade com o archive, que deixou de valer). Exige -ConfirmarBanco.
  Qualquer dúvida ⇒ nada (mais) é removido e o destino vai para INTERVENCAO_NECESSARIA.

  Sempre: trava local, Job Object kill-on-close, identidade da instância (processo e instanciaId), credenciais DPAPI só
  pelo stdin (RESTORE para leitura; GUARDIÃO para transições) e — Fase 21.2.8, A21-7-02 — ÂNCORA EXTERNA: o archive e o
  manifesto são os INFORMADOS PELO OPERADOR (-ArquivoBackup/-Manifesto, obrigatórios fora de Inspecionar; nunca os
  caminhos gravados na posse), conferidos contra o .sha256 e o manifesto do diretório de backup, o registro local de
  evidências e a posse.
#>
param(
  [Parameter(Mandatory = $true)][ValidateSet("Inspecionar", "Verificar", "Liberar", "IniciarUso", "Remover", "Descartar")][string]$Acao,
  [Parameter(Mandatory = $true)][string]$BancoDestino,
  [string]$ExecucaoId = "",
  [string]$ArquivoBackup = "",
  [string]$Manifesto = "",
  [string]$ConfirmarBanco = "",
  [int]$Porta = 27118,
  [string]$Raiz = (Join-Path $env:USERPROFILE "mariela-restore-isolado"),
  [string]$DiretorioRelatorio = (Join-Path $env:USERPROFILE "mariela-restore-isolado\relatorios")
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "comum.ps1")

function Recusar([string]$Mensagem) { [Console]::Error.WriteLine($Mensagem); exit 1 }
if ($Porta -ne 27118) { Recusar "Porta $Porta recusada." }
if ($BancoDestino -eq "marielaDB" -or $BancoDestino -notmatch '^mariela_restore_\d{8}_\d{6}$') { Recusar "Banco '$BancoDestino' recusado." }
if ($Acao -ne "Inspecionar") {
  if ($ExecucaoId -notmatch '^[0-9a-fA-F-]{36}$') { Recusar "-ExecucaoId (GUID da posse) é obrigatório para $Acao." }
  if (-not $ArquivoBackup -or -not $Manifesto) { Recusar "-ArquivoBackup e -Manifesto (os do backup escolhido pelo operador) são obrigatórios para $Acao — os caminhos gravados na posse não são aceitos." }
  if (-not (Test-Path -LiteralPath $ArquivoBackup -PathType Leaf) -or -not (Test-Path -LiteralPath $Manifesto -PathType Leaf)) { Recusar "archive ou manifesto informado não existe." }
  $ArquivoBackup = (Resolve-Path -LiteralPath $ArquivoBackup).Path
  $Manifesto = (Resolve-Path -LiteralPath $Manifesto).Path
}
if (($Acao -eq "IniciarUso" -or $Acao -eq "Descartar") -and $ConfirmarBanco -ne $BancoDestino) { Recusar "$Acao exige -ConfirmarBanco com o nome EXATO do destino." }

$operacaoId = [guid]::NewGuid().ToString()
try { $trava = Enter-TravaRestore -Caminho (Join-Path $Raiz "locks\restore.lock") -ExecucaoId $operacaoId -Banco $BancoDestino }
catch { Recusar ("Trava de restore indisponível (um restore/operação está em andamento): " + (ConvertTo-MensagemSegura $_)) }

$rel = [ordered]@{ acao = $Acao; destino = "127.0.0.1:27118/$BancoDestino"; operacaoId = $operacaoId; posseExecucao = $ExecucaoId; operador = "$env:USERDOMAIN\$env:USERNAME"; inicio = (Get-Date).ToString("o"); estadoAntes = $null; estadoDepois = $null; garantiasDepois = $null; resultado = "RECUSADO"; detalhe = $null }
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
# Fase 21.2.11 (X1): a CLI classifica a falha; o relatório a expõe e o resultado distingue intervenção, falha operacional
# e recusa simples (entrada do operador, posse alheia, evidência de backup).
function Set-Classificacao($Resultado) {
  if (-not $Resultado) { return }
  $c = $Resultado.classificacao
  $rel.categoria = $Resultado.categoria
  $rel.escopo = $(if ($c) { $c.escopo } else { $null })
  $rel.intervencaoManual = [bool]($c -and $c.intervencaoManual)
  $rel.intervencaoPersistida = [bool]$Resultado.intervencaoPersistida
  $rel.divergenciaNaoRegistravel = [bool]$Resultado.divergenciaNaoRegistravel
}
function Get-ResultadoRecusa($Resultado) {
  if ($Resultado -and $Resultado.estado -eq "INTERVENCAO_NECESSARIA") { return "INTERVENCAO_NECESSARIA" }
  if ($Resultado -and $Resultado.categoria -eq "FALHA_OPERACIONAL") { return "FALHA_OPERACIONAL" }
  return "RECUSADO"
}

try {
  try { $null = Enable-ControleDeProcessos } catch { $rel.detalhe = "controle de processos indisponível: " + (ConvertTo-MensagemSegura $_); Fim "RECUSADO" 1 }
  $null = Initialize-PastaEvidencias $Raiz
  $ident = Test-EvidenciaInstancia (Get-EvidenciaPorta $Porta) (Join-Path $Raiz "mongodb-8.0.37\bin\mongod.exe")
  if (-not $ident.Ok) { $rel.detalhe = "identidade da instância: $($ident.Detalhe)"; Fim "RECUSADO" 1 }
  $cred = Get-CredencialIsolada $Raiz 'restore'
  $comuns = @("--porta", "$Porta", "--banco", $BancoDestino, "--raiz", $Raiz)

  $insp = Invoke-CliBackup -Argumentos (@("inspecionar-destino") + $comuns) -Credencial $cred
  if (-not $insp.ok) { $rel.detalhe = $insp.mensagem; Fim "RECUSADO" 1 }
  $p = $insp.resultado.posse
  $rel.estadoAntes = $p.estado
  $rel.colecoes = @($insp.resultado.colecoes)
  $rel.ancora = $insp.resultado.ancora
  if ($Acao -eq "Inspecionar") {
    $rel.posse = $p
    $rel.identidade = $insp.resultado.identidade
    $rel.estadoDepois = $p.estado
    $rel.garantiasDepois = $p.garantias
    $rel.garantiasDeclaradas = $p.garantiasDeclaradas
    $rel.garantiasEfetivas = $insp.resultado.garantiasEfetivas
    $rel.identidadeInstancia = $insp.resultado.identidadeInstancia
    Fim "INSPECIONADO" 0
  }
  if (-not $p -or $p.execucaoId -ne $ExecucaoId.ToLowerInvariant()) { $rel.detalhe = "a posse do destino não é da execução informada"; Fim "RECUSADO" 1 }
  $vinculo = @("--arquivo", $ArquivoBackup, "--manifesto", $Manifesto)
  $guard = if ($Acao -ne "Verificar") { Get-CredencialIsolada $Raiz 'guardiao' } else { $null }

  switch ($Acao) {
    "Verificar" {
      $v = Invoke-CliBackup -Argumentos (@("verificar-integridade") + $comuns + $vinculo + @("--posse-execucao", $ExecucaoId)) -Credencial $cred
      $rel.verificacoes = @($v.resultado.verificacoes); $rel.divergencias = @($v.resultado.divergencias); $rel.estadoDepois = $p.estado; $rel.garantiasDepois = $v.resultado.garantias
      Set-Classificacao $v.resultado
      if ($v.ok -and $v.resultado.ok) { Fim "INTEGRO" 0 } else { $rel.detalhe = "$($v.resultado.classificacao.motivo)$($v.mensagem)"; Fim $(if ($v.resultado.categoria -eq "FALHA_OPERACIONAL") { "FALHA_OPERACIONAL" } else { "DIVERGENTE" }) 1 }
    }
    "Liberar" {
      $l = Invoke-CliBackup -Argumentos (@("liberar-restore") + $comuns + $vinculo + @("--trava-execucao", $operacaoId, "--posse-execucao", $ExecucaoId, "--operador", $rel.operador)) -Credencial $guard
      $rel.estadoDepois = $l.resultado.estado; $rel.detalhe = "$($l.resultado.motivo)$($l.mensagem)"; $rel.verificacoes = @($l.resultado.verificacoes)
      Set-Classificacao $l.resultado
      if ($l.ok -and $l.resultado.ok) { Fim "LIBERACAO_AUTORIZADA" 0 } else { Fim (Get-ResultadoRecusa $l.resultado) 1 }
    }
    "IniciarUso" {
      $u = Invoke-CliBackup -Argumentos (@("iniciar-uso") + $comuns + $vinculo + @("--trava-execucao", $operacaoId, "--posse-execucao", $ExecucaoId, "--operador", $rel.operador, "--confirmar-banco", $ConfirmarBanco)) -Credencial $guard
      $rel.estadoDepois = $u.resultado.estado; $rel.detalhe = "$($u.resultado.detalhe)$($u.resultado.motivo)$($u.mensagem)"; $rel.descongeladas = @($u.resultado.descongeladas)
      Set-Classificacao $u.resultado
      if ($u.ok -and $u.resultado.ok) { Fim "EM_USO" 0 } else { Fim (Get-ResultadoRecusa $u.resultado) 1 }
    }
    default {
      # Remover (remoção comprovada) ou Descartar (destino usado)
      $modo = if ($Acao -eq "Descartar") { "descarte" } else { "remocao" }
      $extra = if ($Acao -eq "Descartar") { @("--confirmar-banco", $ConfirmarBanco) } else { @() }
      $l = Invoke-CliBackup -Argumentos (@("limpar-destino") + $comuns + $vinculo + $extra + @("--modo", $modo, "--trava-execucao", $operacaoId, "--posse-execucao", $ExecucaoId)) -Credencial $guard
      $rel.estadoDepois = $l.resultado.estadoFinal; $rel.removidas = @($l.resultado.removidas); $rel.preservadas = @($l.resultado.preservadas); $rel.bancoRemovido = $l.resultado.bancoRemovido; $rel.restantes = @($l.resultado.restantes)
      $rel.detalhe = $(if ($l.ok) { "$($l.resultado.motivo) $($l.resultado.detalhe)" } else { $l.mensagem })
      if ($l.ok -and $l.resultado.limpo) { Fim $l.resultado.estadoFinal 0 }
      Fim $(if ($l.resultado.estadoFinal -eq "INTERVENCAO_NECESSARIA") { "INTERVENCAO_NECESSARIA" } else { "RECUSADO" }) 1
    }
  }
} catch {
  $rel.detalhe = "exceção: " + (ConvertTo-MensagemSegura $_)
  Fim "RECUSADO" 1
} finally {
  $cred = $null; $guard = $null
  Exit-TravaRestore $trava
}
