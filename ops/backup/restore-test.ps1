<#
.SYNOPSIS
  Restore de TESTE, isolado: só em 127.0.0.1:27118 (MongoDB 8.0.x local, COM autenticação), num banco
  mariela_restore_<carimbo>. Termina, no sucesso, com o destino VERIFICADO e protegido — NUNCA "liberado".

.DESCRIPTION
  Fases 60.4.3.4.21.1/21.2/21.2.2/21.2.4/21.2.6. Nunca aponta para o Atlas, para marielaDB nem para test.
    T. TRAVA local (<Raiz>\locks\restore.lock) mantida até o fim; execucaoId (GUID) próprio.
    J. CONTROLE DE PROCESSOS (A-06): este PowerShell entra num Job Object kill-on-close — se ele morrer, por qualquer
       motivo, o Windows mata todo processo que ele criou (bun/CLI, mongorestore).
    0. IDENTIDADE da instância (processo, bind, dbPath, marcador, replica set). Credencial do usuário de RESTORE
       (DPAPI), passada SÓ pelo stdin.
    1. Antes de qualquer escrita: SHA-256 = manifesto = .sha256; manifesto VALIDO_LOCAL; 27 namespaces e contagens;
       mesma série de versão; banco de destino inexistente.
    2. POSSE ATÔMICA e PERSISTENTE: documento `_id:"posse"` (estado PREPARANDO) com execucaoId, processo (PID + horário
       de criação + executável), SHA-256 do archive E do manifesto.
    3. RESTAURANDO: mongorestore (sem --drop, sem bypass), senha pelo stdin.
    4. VALIDANDO: o destino é CONGELADO e comparado BYTE A BYTE com o archive (conjunto de _id e conteúdo de cada
       documento), coleções exatas, índices exatos, contagens/referências/sequências do manifesto.
    5. VERIFICADO: evidências gravadas na posse; segunda verificação com o destino já VERIFICADO tem de dar o mesmo.
  PASSOU ⇔ (1) restore terminou; (2) comparação integral aprovada; (3) nada alheio; (4) proteção ativa; (5) posse
  persistida como VERIFICADO; (6) archive e manifesto vinculados por SHA-256; (7) nenhum processo filho ativo; (8) trava
  e identidade da execução válidas. A posse e a proteção PERMANECEM: liberar ou remover é decisão do operador
  (gerir-restore.ps1 -Acao Liberar|Remover).
  Falha depois de iniciar a escrita: FALHOU_DESTINO_PARCIAL e limpeza COMPROVADA (conteúdo ⊆ archive, nunca
  dropDatabase); limpo ⇒ FALHOU (destino CANCELADO_COM_LIMPEZA_COMPROVADA); senão INTERVENCAO_NECESSARIA.

.NOTES
  Saída: 0 = PASSOU; 1 = recusado ou falhou. Relatório: <DiretorioRelatorio>\restore_<destino>.json.
  Exclusão mútua só LOCAL (mesma máquina). Não há garantia distribuída.
#>
param(
  [Parameter(Mandatory = $true)][string]$ArquivoBackup,
  [string]$Manifesto = "",
  [int]$Porta = 27118,
  [string]$BancoDestino = "",
  [string]$Mongorestore = "",
  [string]$Raiz = (Join-Path $env:USERPROFILE "mariela-restore-isolado"),
  [string]$DiretorioRelatorio = (Join-Path $env:USERPROFILE "mariela-restore-isolado\relatorios")
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
  controleDeProcessos = $null
  posseAdquirida = $false
  escritaIniciada = $false
  estadoDestino = $null
  condicoesPassou = $null
  evidencias = $null
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
    [System.IO.File]::WriteAllText($arq, ($relatorio | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding($false)))
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

$cred = $null
function ChamarCli([string[]]$A) { return Invoke-CliBackup -Argumentos $A -Credencial $cred }
$comuns = @("--porta", "$Porta", "--banco", $BancoDestino, "--raiz", $Raiz)

<#
  Destino inválido depois de iniciar a escrita: FALHOU_DESTINO_PARCIAL + limpeza COMPROVADA. Limpo ⇒ "FALHOU" (destino
  CANCELADO_COM_LIMPEZA_COMPROVADA); qualquer recusa ⇒ "FALHOU_DESTINO_PARCIAL" (destino INTERVENCAO_NECESSARIA ou
  preservado como está), nada alheio removido.
#>
function TratarDestinoParcial([string]$Motivo) {
  if (-not $relatorio.posseAdquirida) {
    $relatorio.limpeza = @{ executada = $false; motivo = "posse do destino NÃO adquirida — nada removido ($Motivo)" }
    $relatorio.exigeIntervencao = $true
    return "FALHOU_DESTINO_PARCIAL"
  }
  $l = $null
  try {
    $m = ChamarCli (@("marcar-estado") + $comuns + @("--execucao", $execucaoId, "--para", "FALHOU_DESTINO_PARCIAL", "--detalhe", $Motivo))
    $relatorio.etapas += @{ etapa = "marcar-falha"; ok = [bool]($m.ok -and $m.resultado.ok); motivo = $m.resultado.detalhe; erro = $m.mensagem }
    $l = ChamarCli (@("limpar-destino") + $comuns + @("--modo", "falha", "--trava-execucao", $execucaoId, "--posse-execucao", $execucaoId, "--arquivo", $ArquivoBackup, "--manifesto", $Manifesto))
  } catch {
    $relatorio.limpeza = @{ executada = $false; motivo = $Motivo; erro = (ConvertTo-MensagemSegura $_) }
  }
  if ($l -and $l.ok -and $l.resultado.limpo) {
    $relatorio.limpeza = @{ executada = $true; motivo = $Motivo; removidas = @($l.resultado.removidas) }
    $relatorio.estadoDestino = "CANCELADO_COM_LIMPEZA_COMPROVADA"
    return "FALHOU"
  }
  if ($l) {
    $relatorio.limpeza = @{ executada = $false; motivo = $Motivo; recusa = $(if ($l.ok) { $l.resultado.motivo } else { $l.codigo }); detalhe = $(if ($l.ok) { $l.resultado.detalhe } else { $l.mensagem }); removidas = @($l.resultado.removidas); preservadas = @($l.resultado.preservadas) }
    if ($l.ok) { $relatorio.estadoDestino = $l.resultado.estadoFinal }
  }
  $relatorio.exigeIntervencao = $true
  return "FALHOU_DESTINO_PARCIAL"
}

try {
  # --- J. Controle de processos: tudo o que for criado daqui em diante morre com este PowerShell -------------------
  try {
    $null = Enable-ControleDeProcessos
    $relatorio.controleDeProcessos = "job-kill-on-close"
  } catch {
    $relatorio.etapas += @{ etapa = "controle-de-processos"; ok = $false; erro = (ConvertTo-MensagemSegura $_) }
    Encerrar "FALHOU" 1
  }

  # --- 0. Identidade do PROCESSO dono da porta e credencial ----------------------------------------------------------
  $identidade = Test-EvidenciaInstancia (Get-EvidenciaPorta $Porta) (Join-Path $Raiz "mongodb-8.0.37\bin\mongod.exe")
  $relatorio.etapas += @{ etapa = "identidade-processo"; ok = $identidade.Ok; erro = $identidade.Detalhe }
  if (-not $identidade.Ok) { Encerrar "FALHOU" 1 }
  try { $cred = Get-CredencialIsolada $Raiz 'restore' }
  catch { $relatorio.etapas += @{ etapa = "credencial"; ok = $false; erro = (ConvertTo-MensagemSegura $_) }; Encerrar "FALHOU" 1 }

  # --- 1. Validações ANTES de qualquer escrita -----------------------------------------------------------------
  if (-not (Etapa "validar-archive" (Invoke-CliBackup -Argumentos @("validar-para-restore", "--arquivo", $ArquivoBackup, "--manifesto", $Manifesto)))) { Encerrar "FALHOU" 1 }
  if (-not (Etapa "preparar-destino" (ChamarCli (@("preparar-restore") + $comuns + @("--manifesto", $Manifesto))))) { Encerrar "FALHOU" 1 }
  $politica = Invoke-CliBackup -Argumentos @("politica")
  $colecoes = @($politica.resultado.colecoesIncluidas)
  if ($colecoes.Count -ne 27) { $relatorio.etapas += @{ etapa = "politica"; ok = $false; erro = "lista positiva com $($colecoes.Count) coleções" }; Encerrar "FALHOU" 1 }

  # --- 2. Posse ATÔMICA e persistente (PREPARANDO) ------------------------------------------------------------------
  $posse = ChamarCli (@("adquirir-posse") + $comuns + @("--execucao", $execucaoId, "--arquivo", $ArquivoBackup, "--manifesto", $Manifesto, "--processo-inicio", $trava.ProcessoInicio, "--processo-inicio-ticks", $trava.ProcessoInicioTicks, "--executavel", $trava.Executavel))
  if (-not (Etapa "adquirir-posse" $posse)) { Encerrar "FALHOU" 1 }
  $relatorio.posseAdquirida = $true
  $relatorio.estadoDestino = "PREPARANDO"

  # --- 3. RESTAURANDO: mongorestore com o usuário de restore (senha SÓ pelo stdin) ----------------------------------
  $m = ChamarCli (@("marcar-estado") + $comuns + @("--execucao", $execucaoId, "--para", "RESTAURANDO", "--detalhe", "iniciando mongorestore"))
  if (-not (Etapa "marcar-restaurando" $m)) { Encerrar (TratarDestinoParcial "não foi possível marcar RESTAURANDO") 1 }
  $relatorio.estadoDestino = "RESTAURANDO"
  $argsRestore = @("--uri=mongodb://127.0.0.1:27118/?directConnection=true", "--username=$($cred.Usuario)", "--authenticationDatabase=admin", "--gzip", "--archive=$ArquivoBackup", "--nsFrom=marielaDB.*", "--nsTo=$BancoDestino.*", "--stopOnError")
  foreach ($c in $colecoes) { $argsRestore += "--nsInclude=marielaDB.$c" }
  $tRestore = Get-Date
  $relatorio.escritaIniciada = $true
  $r = Invoke-Nativo -Programa $Mongorestore -Argumentos $argsRestore -Entrada ((ConvertFrom-SenhaSegura $cred.Senha) + "`n")
  $textoRestore = "$($r.Saida)`n$($r.Erro)"
  $falhados = if ($textoRestore -match '(\d+) document\(s\) failed to restore') { [int]$Matches[1] } else { -1 }
  $restaurados = if ($textoRestore -match '(\d+) document\(s\) restored successfully') { [int]$Matches[1] } else { -1 }
  $crossVersion = $textoRestore -match 'Cross-version'
  $okRestore = ($r.Codigo -eq 0) -and ($falhados -eq 0) -and (-not $crossVersion)
  $relatorio.etapas += @{ etapa = "mongorestore"; ok = $okRestore; codigo = $r.Codigo; documentosRestaurados = $restaurados; documentosComFalha = $falhados; avisoCrossVersion = $crossVersion; duracaoSegundos = [math]::Round(((Get-Date) - $tRestore).TotalSeconds, 2) }
  if (-not $okRestore) { Encerrar (TratarDestinoParcial "mongorestore falhou (código $($r.Codigo))") 1 }

  # --- 4/5. VALIDANDO (congelado) → verificação integral → VERIFICADO ----------------------------------------------
  $v = ChamarCli (@("congelar-e-verificar") + $comuns + @("--execucao", $execucaoId, "--arquivo", $ArquivoBackup, "--manifesto", $Manifesto))
  $okV = Etapa "congelar-e-verificar" $v
  if ($v.ok) { $relatorio.estadoDestino = $v.resultado.estado }
  if (-not $okV) {
    if ($v.ok -and $v.resultado.estado -eq "INTERVENCAO_NECESSARIA") { $relatorio.exigeIntervencao = $true; Encerrar "FALHOU_DESTINO_PARCIAL" 1 }
    Encerrar (TratarDestinoParcial "verificação de integridade reprovada: $($v.resultado.motivo)$($v.mensagem)") 1
  }
  $relatorio.evidencias = $v.resultado.evidencias

  # --- Condições de PASSOU (todas, AGORA) ---------------------------------------------------------------------------
  $filhos = Get-ProcessosFilhosAtivos
  $insp = ChamarCli (@("inspecionar-destino") + $comuns)
  $int = ChamarCli (@("verificar-integridade") + $comuns + @("--posse-execucao", $execucaoId, "--arquivo", $ArquivoBackup, "--manifesto", $Manifesto))
  $travaOk = Invoke-CliBackup -Argumentos @("conferir-trava", "--execucao", $execucaoId, "--raiz", $Raiz)
  $condicoes = [ordered]@{
    restoreTerminou = $okRestore
    conteudoIntegral = [bool]($int.ok -and $int.resultado.ok)
    semAlheios = [bool]($int.ok -and $int.resultado.ok -and @($int.resultado.divergencias).Count -eq 0)
    protecaoAtiva = [bool]($int.ok -and @($int.resultado.verificacoes | Where-Object { $_.id -eq "destino.protegido" -and $_.ok }).Count -eq 1)
    posseVerificado = [bool]($insp.ok -and $insp.resultado.posse.estado -eq "VERIFICADO" -and $insp.resultado.posse.execucaoId -eq $execucaoId)
    archiveEManifestoVinculados = [bool]($insp.ok -and $insp.resultado.posse.archiveSha256 -eq (Get-Sha256 $ArquivoBackup) -and $insp.resultado.posse.manifestoSha256 -eq (Get-Sha256 $Manifesto))
    semProcessoFilhoAtivo = (@($filhos).Count -eq 0)
    travaEIdentidade = [bool]($travaOk.ok -and $travaOk.resultado.ok -and (Test-EvidenciaInstancia (Get-EvidenciaPorta $Porta) (Join-Path $Raiz "mongodb-8.0.37\bin\mongod.exe")).Ok)
  }
  $relatorio.condicoesPassou = $condicoes
  $relatorio.estadoDestino = $insp.resultado.posse.estado
  if (@($condicoes.Values | Where-Object { -not $_ }).Count -gt 0) {
    $relatorio.exigeIntervencao = $true
    $relatorio.etapas += @{ etapa = "condicoes-passou"; ok = $false; erro = "condição não atendida: " + ((@($condicoes.Keys | Where-Object { -not $condicoes[$_] })) -join ", "); filhos = @($filhos) }
    Encerrar "FALHOU_DESTINO_PARCIAL" 1
  }
  Encerrar "PASSOU" 0
} catch {
  $relatorio.etapas += @{ etapa = "excecao"; ok = $false; erro = (ConvertTo-MensagemSegura $_) }
  $final = if ($relatorio.posseAdquirida) { TratarDestinoParcial "exceção depois de adquirir a posse" } else { "FALHOU" }
  Encerrar $final 1
} finally {
  $cred = $null
  Exit-TravaRestore $trava
}
