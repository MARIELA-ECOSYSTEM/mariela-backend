<#
.SYNOPSIS
  Instância ISOLADA do MongoDB 8.0.37 para restore de teste: 127.0.0.1:27118, replica set de 1 nó "rs-restore".

.DESCRIPTION
  Fase 60.4.3.4.21.2. Processo comum (NÃO é serviço do Windows), dbPath e log exclusivos em
  %USERPROFILE%\mariela-restore-isolado. Recusa: porta ocupada por outro processo, dbPath alheio (com dados mas sem o
  marcador desta instância) e qualquer porta diferente de 27118. Não tem autenticação: só escuta em 127.0.0.1.
  Instalação (zip oficial, SHA-256 conferido): ver docs/backup-mongodb.md.
#>
param(
  [Parameter(Mandatory = $true)][ValidateSet("Iniciar", "Parar", "Estado")][string]$Acao,
  [string]$Raiz = (Join-Path $env:USERPROFILE "mariela-restore-isolado")
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "comum.ps1")

$porta = 27118
$mongod = Join-Path $Raiz "mongodb-8.0.37\bin\mongod.exe"
$dbPath = Join-Path $Raiz "data-27118"
$logPath = Join-Path $Raiz "logs\mongod-27118.log"
$marcador = Join-Path $dbPath ".mariela-restore-isolado"

function PortaEmUso { return [bool](Get-NetTCPConnection -LocalPort $porta -State Listen -ErrorAction SilentlyContinue) }

switch ($Acao) {
  "Estado" {
    if (-not (PortaEmUso)) { Write-Host "parada (porta $porta livre)"; exit 0 }
    $e = Invoke-CliBackup -Argumentos @("local-estado", "--porta", "$porta")
    $e.resultado | ConvertTo-Json -Compress
    exit ([int](-not $e.ok))
  }
  "Parar" {
    if (-not (PortaEmUso)) { Write-Host "já parada"; exit 0 }
    $e = Invoke-CliBackup -Argumentos @("local-estado", "--porta", "$porta")
    if (-not $e.ok -or $e.resultado.dbPath -ne $dbPath) { Write-Error "A porta $porta não pertence à instância isolada — nada foi feito."; exit 1 }
    $null = Invoke-CliBackup -Argumentos @("local-desligar", "--porta", "$porta")
    for ($i = 0; $i -lt 60 -and (PortaEmUso); $i++) { Start-Sleep -Milliseconds 500 }
    if (PortaEmUso) { Write-Error "A instância não parou a tempo."; exit 1 }
    Write-Host "parada"
    exit 0
  }
  "Iniciar" {
    if (-not (Test-Path -LiteralPath $mongod)) { Write-Error "mongod 8.0.37 não encontrado em $mongod (ver instalação na documentação)."; exit 1 }
    if (PortaEmUso) {
      $e = Invoke-CliBackup -Argumentos @("local-estado", "--porta", "$porta")
      if ($e.ok -and $e.resultado.dbPath -eq $dbPath) { Write-Host "já em execução"; $e.resultado | ConvertTo-Json -Compress; exit 0 }
      Write-Error "Porta $porta ocupada por OUTRO processo — interrompido (nenhuma outra porta é escolhida)."; exit 1
    }
    if (Test-Path -LiteralPath $dbPath) {
      $temDados = @(Get-ChildItem -LiteralPath $dbPath -Force).Count -gt 0
      if ($temDados -and -not (Test-Path -LiteralPath $marcador)) { Write-Error "dbPath $dbPath tem dados sem o marcador desta instância — não é reutilizado."; exit 1 }
    } else {
      New-Item -ItemType Directory -Path $dbPath | Out-Null
    }
    if (-not (Test-Path -LiteralPath $marcador)) { Set-Content -LiteralPath $marcador -Value "dbPath exclusivo da instância isolada de restore (127.0.0.1:27118)" -Encoding ASCII }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $logPath) | Out-Null

    $argumentos = @("--port", "$porta", "--bind_ip", "127.0.0.1", "--dbpath", $dbPath, "--logpath", $logPath, "--logappend", "--replSet", "rs-restore")
    $linha = (@($argumentos) | ForEach-Object { ConvertTo-ArgumentoProcesso $_ }) -join ' '
    $null = Start-Process -FilePath $mongod -ArgumentList $linha -WindowStyle Hidden -PassThru
    for ($i = 0; $i -lt 60 -and -not (PortaEmUso); $i++) { Start-Sleep -Milliseconds 500 }
    if (-not (PortaEmUso)) { Write-Error "mongod não abriu a porta $porta a tempo (ver $logPath)."; exit 1 }
    $rs = Invoke-CliBackup -Argumentos @("local-rs-iniciar", "--porta", "$porta", "--rs", "rs-restore")
    if (-not $rs.ok) { Write-Error "replica set não inicializou: $($rs.mensagem)"; exit 1 }
    $e = Invoke-CliBackup -Argumentos @("local-estado", "--porta", "$porta")
    $e.resultado | ConvertTo-Json -Compress
    exit 0
  }
}
