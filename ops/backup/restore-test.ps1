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
# Banco de PRODUÇÃO de onde o archive foi gerado (definido pela MONGODB_BACKUP_URI do backup-mongo.ps1).
$bancoOrigem = "marielaDB"

# Confere, ANTES de qualquer escrita, que o archive tem o namespace de origem esperado. O mongorestore NÃO avisa: para um
# archive válido de outro banco ele sai com exit 0 e "0 documentos restaurados", e ainda restauraria esse banco sob o seu
# nome ORIGINAL (o --nsFrom só renomeia o que casa). Lê só o começo do archive descompactado (o prelude, com os namespaces,
# vem primeiro) e procura o elemento BSON string "db" = banco de origem — checagem binária, sem parsing de texto de log.
# Arquivo que não é gzip legível não é julgado aqui: o próprio mongorestore o recusa (exit != 0) sem gravar nada.
$latin1 = [System.Text.Encoding]::GetEncoding(28591)
$prelude = $null
try {
  $entrada = [System.IO.File]::OpenRead($ArquivoBackup)
  try {
    $gz = New-Object System.IO.Compression.GzipStream($entrada, [System.IO.Compression.CompressionMode]::Decompress)
    $buffer = New-Object byte[] 1048576
    $lidos = 0
    while ($lidos -lt $buffer.Length) {
      $n = $gz.Read($buffer, $lidos, $buffer.Length - $lidos)
      if ($n -le 0) { break }
      $lidos += $n
    }
    $prelude = $latin1.GetString($buffer, 0, $lidos)
  } finally {
    $entrada.Close()
  }
} catch {
  $prelude = $null
}
if ($null -ne $prelude) {
  # elemento BSON string: 0x02 "db" 0x00, int32 (tamanho do nome + 1), nome, 0x00
  $marcador = [string][char]2 + "db" + [string][char]0 + $latin1.GetString([BitConverter]::GetBytes([int]($bancoOrigem.Length + 1))) + $bancoOrigem + [string][char]0
  if ($prelude.IndexOf($marcador, [System.StringComparison]::Ordinal) -lt 0) {
    Write-Error "O archive não contém o namespace de origem esperado '$bancoOrigem.*' (é de outro banco, ou está corrompido/truncado). Nada foi restaurado."
    exit 1
  }
}

Write-Host "Restaurando '$ArquivoBackup' em '$bancoDestino' (localhost, banco descartável)..."
& mongorestore --uri="$destinoUri" --gzip --archive="$ArquivoBackup" --nsFrom="$bancoOrigem.*" --nsTo="$bancoDestino.*"
$exitCode = $LASTEXITCODE

if ($exitCode -ne 0) {
  Write-Error "mongorestore terminou com código $exitCode. Restore FALHOU."
  exit $exitCode
}

Write-Host ""
Write-Host "Restore concluído em '$bancoDestino'. Rode a validação de collections/índices/documentos"
Write-Host "críticos (ver docs/backup-mongodb.md, seção 'Validação pós-restore') antes de considerar"
Write-Host "este teste como PASSOU. Ao terminar, derrube o banco de teste '$bancoDestino' usando o driver MongoDB do"
Write-Host "projeto (o mongosh não é necessário): ver 'Alternativa ao mongosh' em docs/backup-mongodb.md."
