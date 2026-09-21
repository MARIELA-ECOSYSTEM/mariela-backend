<#
.SYNOPSIS
  Backup lógico diário do MongoDB Atlas (plano Free) via mongodump.

.DESCRIPTION
  Ferramenta OPERACIONAL, fora do backend (nunca importada pelo NestJS,
  nunca uma dependência do projeto) — ver docs/backup-mongodb.md para o
  procedimento completo (Fase 29-FI.1/29-FI.2).

  O Atlas Free (M0) não oferece Cloud Backup/snapshots nativos — este script
  implementa o mecanismo oficialmente recomendado pela MongoDB para este
  tier: mongodump agendado externamente.

  NUNCA contém credencial. A connection string vem exclusivamente da
  variável de ambiente MONGODB_BACKUP_URI, definida pelo operador fora
  deste repositório (variável de ambiente do SO, Task Scheduler, ou
  secret store equivalente) — nunca commitada, nunca em texto no script.

.NOTES
  Requer MongoDB Database Tools (mongodump) instalado — ver docs/backup-mongodb.md.
#>

param(
  [string]$BackupDir = "$env:USERPROFILE\mariela-backups",
  [int]$RetentionDays = 30,
  [int]$MinCopiasValidas = 2
)

$ErrorActionPreference = "Stop"

if (-not $env:MONGODB_BACKUP_URI) {
  Write-Error "MONGODB_BACKUP_URI não definida. Defina a connection string do usuário DEDICADO de backup (read-only, banco marielaDB) como variável de ambiente antes de rodar este script. Nunca passe a URI como argumento de linha de comando (fica no histórico do shell)."
  exit 1
}

$mongodump = Get-Command mongodump -ErrorAction SilentlyContinue
if (-not $mongodump) {
  Write-Error "mongodump não encontrado no PATH. Instale o MongoDB Database Tools oficial (https://www.mongodb.com/try/download/database-tools) antes de continuar."
  exit 1
}

# O banco dumpado é o definido pela própria URI (produção: "marielaDB") — o script NÃO passa --db.
# Sem banco na URI o mongodump dumparia todos os bancos acessíveis ao usuário, então isso é recusado.
if ($env:MONGODB_BACKUP_URI -notmatch '^mongodb(\+srv)?://[^/]+/[^/?]+') {
  Write-Error "A MONGODB_BACKUP_URI não define o banco de dados (esperado: .../<banco>?...). Sem ele o mongodump não teria escopo definido. Corrija a variável de ambiente."
  exit 1
}

New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

$stamp = Get-Date -Format "yyyyMMdd_HHmm"
$arquivo = Join-Path $BackupDir "mariela_prod_${stamp}.archive.gz"
# O dump é gravado num arquivo temporário (nome que NÃO casa com "mariela_prod_*.archive.gz", portanto nunca
# é considerado cópia válida pela retenção) e só recebe o nome definitivo depois de passar em todas as validações.
$temporario = "$arquivo.tmp"

Write-Host "Iniciando mongodump -> $arquivo"
& mongodump --uri="$env:MONGODB_BACKUP_URI" --gzip --archive="$temporario"
$exitCode = $LASTEXITCODE

if ($exitCode -ne 0) {
  Remove-Item -LiteralPath $temporario -Force -ErrorAction SilentlyContinue
  Write-Error "mongodump terminou com código $exitCode. Backup NÃO confiável — não prosseguir com a rotação de retenção."
  exit $exitCode
}

if (-not (Test-Path -LiteralPath $temporario)) {
  Write-Error "Arquivo de backup não foi criado: $temporario"
  exit 1
}

$tamanho = (Get-Item -LiteralPath $temporario).Length
if ($tamanho -le 0) {
  Remove-Item -LiteralPath $temporario -Force -ErrorAction SilentlyContinue
  Write-Error "Arquivo de backup está vazio (0 bytes): $temporario"
  exit 1
}

Move-Item -LiteralPath $temporario -Destination $arquivo
Write-Host "Backup criado com sucesso: $arquivo ($([math]::Round($tamanho/1MB, 2)) MB)"

# --- Retenção: nunca reduz o total de cópias válidas abaixo de $MinCopiasValidas ---
$todos = @(Get-ChildItem -Path $BackupDir -Filter "mariela_prod_*.archive.gz" | Sort-Object LastWriteTime -Descending)
# Do mais antigo para o mais novo: se o mínimo de cópias barrar a remoção, sobram as mais recentes.
$antigos = @($todos | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$RetentionDays) } | Sort-Object LastWriteTime)
$copiasRestantes = $todos.Count

foreach ($arquivoAntigo in $antigos) {
  # Conta o que realmente sobra: as remoções já feitas neste laço descontam de $copiasRestantes.
  if (($copiasRestantes - 1) -lt $MinCopiasValidas) {
    Write-Host "Mantendo $($arquivoAntigo.Name) apesar de exceder a retenção — removê-lo deixaria menos de $MinCopiasValidas cópias válidas."
    continue
  }
  Write-Host "Removendo backup expirado (> $RetentionDays dias): $($arquivoAntigo.Name)"
  Remove-Item $arquivoAntigo.FullName -Force
  $copiasRestantes--
}

Write-Host "Rotina de backup concluída. Cópias atuais: $((Get-ChildItem -Path $BackupDir -Filter 'mariela_prod_*.archive.gz').Count)"
