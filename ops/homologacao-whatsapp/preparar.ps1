<#
.SYNOPSIS
  Fase 22.8.9.10.7.7 — prepara a pasta de trabalho do AMBIENTE LOCAL DE HOMOLOGAÇÃO do WhatsApp oficial.

.DESCRIPTION
  Cria <Raiz> (padrão %LOCALAPPDATA%\MARIELA-HOMOLOGACAO), fora de qualquer repositório:
    backend\     clone próprio do backend no commit escolhido (instalado e compilado; NUNCA tem .env)
    backoffice\  clone próprio do Backoffice (instalado; NUNCA tem .env)
    mongodb\bin\ cópia do mongod.exe portátil informado (nada é instalado no sistema)
    mongo\dados\ dados do MongoDB descartável
    config\homologacao.env  configuração (cópia do modelo + segredos JWT LOCAIS gerados aqui; acesso só do seu usuário)
    logs\, estado\
  Não acessa rede além do `bun install`, não lê nenhum .env, não fala com a Meta, não envia nada.

.EXAMPLE
  pwsh -NoProfile -File ops\homologacao-whatsapp\preparar.ps1 -MongodExe "C:\caminho\mongod.exe"
#>
param(
  [string]$Raiz,
  [Parameter(Mandatory = $true)][string]$MongodExe,
  [string]$OrigemBackend = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [string]$OrigemBackoffice = (Join-Path (Split-Path (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path -Parent) "mariela-backoffice"),
  [string]$RefBackend = "HEAD",
  [string]$RefBackoffice = "HEAD"
)
#Requires -Version 7.4
. (Join-Path $PSScriptRoot "comum.ps1")
$Raiz = Get-RaizHomologacao $Raiz

if (-not (Test-Path $MongodExe)) { throw "mongod.exe não encontrado: $MongodExe" }
foreach ($p in "backend", "backoffice", "mongodb\bin", "mongo\dados", "config", "logs", "estado") {
  New-Item -ItemType Directory -Force (Join-Path $Raiz $p) | Out-Null
}
Copy-Item $MongodExe (Join-Path $Raiz "mongodb\bin\mongod.exe") -Force
Write-Host "mongod copiado para $Raiz\mongodb\bin"

function Initialize-Clone([string]$Origem, [string]$Ref, [string]$Destino) {
  if (-not (Test-Path (Join-Path $Destino ".git"))) {
    if ((Get-ChildItem $Destino -Force | Measure-Object).Count -gt 0) { throw "$Destino não está vazio e não é um clone." }
    git clone --quiet --no-hardlinks $Origem $Destino
  }
  $commit = git -C $Origem rev-parse $Ref
  git -C $Destino fetch --quiet origin
  git -C $Destino checkout --quiet --detach $commit
  Assert-SemArquivoEnv @($Destino)
  Write-Host ("{0}: commit {1}" -f (Split-Path $Destino -Leaf), $commit.Substring(0, 7))
}

$backend = Join-Path $Raiz "backend"
$backoffice = Join-Path $Raiz "backoffice"
Initialize-Clone $OrigemBackend $RefBackend $backend
Initialize-Clone $OrigemBackoffice $RefBackoffice $backoffice

Push-Location $backend
try {
  bun install --frozen-lockfile | Out-Null
  bun --no-env-file run build | Out-Null
  if (-not (Test-Path "dist\main.js")) { throw "Build do backend não gerou dist\main.js." }
} finally { Pop-Location }
Push-Location $backoffice
try { bun install --frozen-lockfile | Out-Null } finally { Pop-Location }
Write-Host "dependências instaladas; backend compilado"

$config = Join-Path $Raiz "config\homologacao.env"
if (-not (Test-Path $config)) {
  $segredo = { [Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(48)).TrimEnd("=").Replace("+", "-").Replace("/", "_") }
  $conteudo = Get-Content (Join-Path $PSScriptRoot "homologacao.env.example")
  $conteudo = $conteudo | ForEach-Object {
    if ($_ -match '^(JWT_ACCESS_SECRET|JWT_REFRESH_SECRET|PDV_JWT_ACCESS_SECRET|PDV_JWT_REFRESH_SECRET)=$') { "$($Matches[1])=$(& $segredo)" } else { $_ }
  }
  Set-Content -Path $config -Value $conteudo -Encoding utf8NoBOM
  # Só o usuário atual lê/escreve a configuração (nela entrarão as credenciais da Meta de homologação).
  icacls $config /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
  Write-Host "configuração criada: $config (segredos JWT locais gerados; credenciais da Meta: preencher à mão)"
} else {
  Write-Host "configuração já existia (não alterada): $config"
}
Write-Host "Preparação concluída. Próximo passo: pwsh -NoProfile -File ops\homologacao-whatsapp\iniciar.ps1"
