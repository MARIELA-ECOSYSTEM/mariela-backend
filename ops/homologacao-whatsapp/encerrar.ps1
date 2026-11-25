<#
.SYNOPSIS
  Fase 22.8.9.10.7.7 — encerra o AMBIENTE LOCAL DE HOMOLOGAÇÃO (Backoffice, backend, MongoDB) e confere as portas.

.DESCRIPTION
  Só encerra os processos registrados pelo iniciar.ps1 em <Raiz>\estado\processos.json (nunca outro processo). O
  MongoDB é desligado pelo comando `shutdown` (limpo), só se a instância for a de homologação.
  -ApagarDados também remove <Raiz>\mongo\dados (banco de homologação descartado; pede confirmação).

.EXAMPLE
  pwsh -NoProfile -File ops\homologacao-whatsapp\encerrar.ps1
#>
param([string]$Raiz, [switch]$ApagarDados)
#Requires -Version 7.4
. (Join-Path $PSScriptRoot "comum.ps1")
$Raiz = Get-RaizHomologacao $Raiz
$estadoArquivo = Join-Path $Raiz "estado\processos.json"
$backend = Join-Path $Raiz "backend"

$processos = if (Test-Path $estadoArquivo) { Get-Content $estadoArquivo -Raw | ConvertFrom-Json } else { $null }
foreach ($nome in "backoffice", "backend") {
  $id = $processos.$nome
  if ($id) {
    # Vite e Bun podem ter filhos: encerra a árvore do processo registrado.
    taskkill /PID $id /T /F 2>$null | Out-Null
    Write-Host "$nome encerrado (PID $id)"
  }
}
if (Test-Path $backend) {
  Push-Location $backend
  try { bun --no-env-file (Join-Path $PSScriptRoot "mongo-homologacao.ts") desligar } finally { Pop-Location }
}
if ($processos.mongod) {
  try { Wait-Process -Id $processos.mongod -Timeout 30 -ErrorAction Stop } catch { Stop-Process -Id $processos.mongod -Force -ErrorAction SilentlyContinue }
}
if (Test-Path $estadoArquivo) { Remove-Item $estadoArquivo }

foreach ($p in 3100, $script:PortaMongo, $script:PortaBackoffice) {
  Write-Host ("porta {0}: {1}" -f $p, $(if (Test-PortaEmUso $p) { "AINDA EM USO" } else { "livre" }))
}
if ($ApagarDados) {
  $dados = Join-Path $Raiz "mongo\dados"
  if ((Read-Host "Apagar o banco de homologação em $dados? Digite APAGAR") -eq "APAGAR") {
    Remove-Item $dados -Recurse -Force
    New-Item -ItemType Directory -Force $dados | Out-Null
    Write-Host "banco de homologação apagado"
  }
}
Write-Host "Ambiente de homologação ENCERRADO."
