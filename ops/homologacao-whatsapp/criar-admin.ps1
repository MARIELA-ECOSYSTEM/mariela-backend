<#
.SYNOPSIS
  Fase 22.8.9.10.7.7 — cria o ADMIN do Backoffice NO BANCO DE HOMOLOGAÇÃO (MongoDB descartável já iniciado).

.DESCRIPTION
  Usa o seed oficial (`src/scripts/seed-admin.ts`) do clone de homologação, depois do verificador de isolamento. O
  banco é o da configuração de homologação (`mariela_homologacao_whatsapp`); o seed o trata como "protegido" e por isso
  exige `--confirmar-producao` com o mesmo nome — a confirmação é feita aqui, com o nome do banco de HOMOLOGAÇÃO.
  E-mail, nome e senha são pedidos no terminal; a senha nunca é exibida nem gravada.

.EXAMPLE
  pwsh -NoProfile -File ops\homologacao-whatsapp\criar-admin.ps1
#>
param([string]$Raiz)
#Requires -Version 7.4
. (Join-Path $PSScriptRoot "comum.ps1")
$Raiz = Get-RaizHomologacao $Raiz
$backend = Join-Path $Raiz "backend"
Assert-SemArquivoEnv @($Raiz, $backend)

$valores = Read-ConfiguracaoHomologacao (Join-Path $Raiz "config\homologacao.env") (Join-Path $PSScriptRoot "homologacao.env.example")
Set-AmbienteHomologacao $valores
if (-not (Test-PortaEmUso $script:PortaMongo)) { throw "MongoDB de homologação parado — rode o iniciar.ps1 antes." }

Push-Location $backend
try {
  bun --no-env-file (Join-Path $PSScriptRoot "verificar-isolamento.ts")
  if ($LASTEXITCODE -ne 0) { throw "Verificação de isolamento falhou — nenhum admin criado." }
  $banco = "mariela_homologacao_whatsapp"
  if ($env:MONGODB_URI -notmatch "/$banco\?") { throw "A MONGODB_URI da homologação não usa o banco $banco." }

  $env:ADMIN_EMAIL = Read-Host "E-mail do admin de homologação"
  $env:ADMIN_NAME = Read-Host "Nome"
  $senha = Read-Host "Senha (8 a 200 caracteres)" -AsSecureString
  $env:ADMIN_PASSWORD = [System.Net.NetworkCredential]::new("", $senha).Password
  $env:ADMIN_SEED_CONFIRM = $env:ADMIN_EMAIL
  try {
    bun --no-env-file src/scripts/seed-admin.ts --banco $banco --apply --confirmar-producao $banco
  } finally {
    Remove-Item Env:ADMIN_PASSWORD, Env:ADMIN_SEED_CONFIRM -ErrorAction SilentlyContinue
  }
} finally { Pop-Location }
