<#
.SYNOPSIS
  Restaura um backup do MARIELA num banco de TESTE local — nunca em produção.

.DESCRIPTION
  Ferramenta OPERACIONAL, fora do backend. Ver docs/backup-mongodb.md
  (Fase 29-FI.1/29-FI.2) para o procedimento completo e o critério de
  PASSOU/FALHOU.

  Restaura sempre contra localhost, num banco cujo nome é explicitamente
  "mariela_restore_test_<timestamp>" — nunca aceita apontar para um host
  remoto, exatamente para tornar impossível, por engano, restaurar sobre
  produção com este script.

.PARAMETER ArquivoBackup
  Caminho do arquivo .archive.gz gerado por backup-mongo.ps1.
#>

param(
  [Parameter(Mandatory = $true)]
  [string]$ArquivoBackup
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $ArquivoBackup)) {
  Write-Error "Arquivo de backup não encontrado: $ArquivoBackup"
  exit 1
}

$mongorestore = Get-Command mongorestore -ErrorAction SilentlyContinue
if (-not $mongorestore) {
  Write-Error "mongorestore não encontrado no PATH. Instale o MongoDB Database Tools oficial antes de continuar."
  exit 1
}

# Destino SEMPRE local e SEMPRE um banco novo/descartável — nunca configurável
# para um host remoto neste script, de propósito (ver seção 3 do pedido:
# "se houver qualquer dúvida sobre o destino, NÃO executar").
$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$bancoDestino = "mariela_restore_test_$stamp"
$destinoUri = "mongodb://127.0.0.1:27017"

Write-Host "Restaurando '$ArquivoBackup' em '$bancoDestino' (localhost, banco descartável)..."
& mongorestore --uri="$destinoUri" --gzip --archive="$ArquivoBackup" --nsFrom="mariela.*" --nsTo="$bancoDestino.*"
$exitCode = $LASTEXITCODE

if ($exitCode -ne 0) {
  Write-Error "mongorestore terminou com código $exitCode. Restore FALHOU."
  exit $exitCode
}

Write-Host ""
Write-Host "Restore concluído em '$bancoDestino'. Rode a validação de collections/índices/documentos"
Write-Host "críticos (ver docs/backup-mongodb.md, seção 'Validação pós-restore') antes de considerar"
Write-Host "este teste como PASSOU. Ao terminar, derrube o banco de teste:"
Write-Host "  mongosh --eval `"db.getSiblingDB('$bancoDestino').dropDatabase()`""
