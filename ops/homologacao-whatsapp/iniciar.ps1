<#
.SYNOPSIS
  Fase 22.8.9.10.7.7 — inicia o AMBIENTE LOCAL DE HOMOLOGAÇÃO do WhatsApp oficial (MongoDB descartável, backend,
  Backoffice), SÓ depois de o verificador de isolamento aprovar a configuração e o banco.

.DESCRIPTION
  1. carrega <Raiz>\config\homologacao.env no PROCESSO deste script (variáveis reconhecidas da sessão são removidas antes);
  2. verifica o isolamento da configuração (qualquer FALHA = nada é iniciado);
  3. sobe o MongoDB (127.0.0.1:27217, replica set própria) e verifica o conteúdo do banco;
  4. sobe o backend compilado (bun --no-env-file, a partir de <Raiz>\backend, que não tem .env) em 127.0.0.1:PORT;
  5. sobe o Backoffice (Vite) em http://localhost:5180 apontando para esse backend, com a faixa "HOMOLOGAÇÃO".
  PIDs em <Raiz>\estado\processos.json; logs em <Raiz>\logs. Encerrar: encerrar.ps1.

.EXAMPLE
  pwsh -NoProfile -File ops\homologacao-whatsapp\iniciar.ps1
#>
param([string]$Raiz, [switch]$SemBackoffice)
#Requires -Version 7.4
. (Join-Path $PSScriptRoot "comum.ps1")
$Raiz = Get-RaizHomologacao $Raiz
$backend = Join-Path $Raiz "backend"
$backoffice = Join-Path $Raiz "backoffice"
$logs = Join-Path $Raiz "logs"
$estadoArquivo = Join-Path $Raiz "estado\processos.json"
$mongod = Join-Path $Raiz "mongodb\bin\mongod.exe"
$verificador = Join-Path $PSScriptRoot "verificar-isolamento.ts"
$auxMongo = Join-Path $PSScriptRoot "mongo-homologacao.ts"

foreach ($p in $backend, $backoffice, $mongod, (Join-Path $backend "dist\main.js")) {
  if (-not (Test-Path $p)) { throw "Ambiente não preparado ($p ausente). Rode o preparar.ps1." }
}
Assert-SemArquivoEnv @($Raiz, $backend, $backoffice)
if (Test-Path $estadoArquivo) { throw "Já existe um ambiente de homologação registrado ($estadoArquivo). Rode o encerrar.ps1 antes." }

$valores = Read-ConfiguracaoHomologacao (Join-Path $Raiz "config\homologacao.env") (Join-Path $PSScriptRoot "homologacao.env.example")
Set-AmbienteHomologacao $valores
$porta = [int]$env:PORT
foreach ($p in $script:PortaMongo, $porta, $script:PortaBackoffice) {
  if (Test-PortaEmUso $p) { throw "Porta $p já está em uso — outro processo ocuparia o lugar do ambiente de homologação." }
}

# 1. Configuração. O verificador roda a partir da pasta do backend de homologação (é dela que o backend sobe).
Push-Location $backend
try {
  bun --no-env-file $verificador
  if ($LASTEXITCODE -ne 0) { throw "Verificação de isolamento da configuração falhou — nada foi iniciado." }
} finally { Pop-Location }

$processos = [ordered]@{ raiz = $Raiz; iniciadoEm = (Get-Date).ToString("o") }
$salvar = { $processos | ConvertTo-Json | Set-Content -Path $estadoArquivo -Encoding utf8NoBOM }
try {
  # 2. MongoDB descartável.
  $pMongo = Start-Process -FilePath $mongod -PassThru -WindowStyle Hidden -ArgumentList @(
    "--port", $script:PortaMongo, "--bind_ip", "127.0.0.1", "--replSet", "rs-homologacao-whatsapp",
    "--dbpath", (Join-Path $Raiz "mongo\dados"), "--logpath", (Join-Path $logs "mongod.log"), "--logappend")
  $processos.mongod = $pMongo.Id; & $salvar
  Push-Location $backend
  try {
    bun --no-env-file $auxMongo iniciar
    if ($LASTEXITCODE -ne 0) { throw "MongoDB de homologação não ficou pronto." }
    bun --no-env-file $verificador --banco
    if ($LASTEXITCODE -ne 0) { throw "Verificação de isolamento do banco falhou — backend não iniciado." }
  } finally { Pop-Location }

  # 3. Backend compilado, sem .env, a partir da pasta da homologação.
  $pApi = Start-ServicoOculto $backend "bun --no-env-file dist/main.js" (Join-Path $logs "backend")
  $processos.backend = $pApi.Id; & $salvar
  $base = "http://127.0.0.1:$porta"
  Wait-Condicao { try { (Invoke-WebRequest "$base/health" -TimeoutSec 2 -SkipHttpErrorCheck).StatusCode -eq 200 } catch { $false } } "backend de homologação em $base" 120
  # POST sem assinatura: 503 = webhook desativado (configuração incompleta); 401 = ativo (a assinatura é exigida).
  $webhook = (Invoke-WebRequest "$base/api/v1/integracoes/whatsapp/webhook" -Method POST -ContentType "application/json" -Body "{}" -SkipHttpErrorCheck).StatusCode
  Write-Host ("backend: {0}/api/v1 (webhook: {1})" -f $base, $(if ($webhook -eq 401) { "ATIVO" } elseif ($webhook -eq 503) { "desativado — configuração da Meta incompleta" } else { "HTTP $webhook" }))

  # 4. Backoffice (Vite) apontando SÓ para o backend de homologação.
  if (-not $SemBackoffice) {
    $env:VITE_USE_MOCK_API = "false"
    $env:VITE_API_URL = "$base/api/v1"
    $env:VITE_AMBIENTE_HOMOLOGACAO = "WhatsApp oficial"
    $pVite = Start-ServicoOculto $backoffice "node node_modules/vite/bin/vite.js dev --port $($script:PortaBackoffice) --strictPort" (Join-Path $logs "backoffice")
    $processos.backoffice = $pVite.Id; & $salvar
    Wait-Condicao { Test-PortaEmUso $script:PortaBackoffice } "Backoffice em http://localhost:$($script:PortaBackoffice)" 120
    Write-Host "Backoffice: http://localhost:$($script:PortaBackoffice)"
  }
  Write-Host "Ambiente de homologação INICIADO. Encerrar: pwsh -NoProfile -File ops\homologacao-whatsapp\encerrar.ps1"
} catch {
  Write-Host "Falha ao iniciar: $($_.Exception.Message). Encerrando o que foi iniciado..."
  & (Join-Path $PSScriptRoot "encerrar.ps1") -Raiz $Raiz
  throw
}
