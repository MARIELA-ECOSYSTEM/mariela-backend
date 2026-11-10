<#
.SYNOPSIS
  Instância ISOLADA do MongoDB 8.0.37 para restore de teste: 127.0.0.1:27118, replica set de 1 nó "rs-restore",
  COM AUTENTICAÇÃO (Fase 60.4.3.4.21.2.6, A-03).

.DESCRIPTION
  Fase 60.4.3.4.21.2. Processo comum (NÃO é serviço do Windows), dbPath e log exclusivos em
  %USERPROFILE%\mariela-restore-isolado. Recusa: porta ocupada por outro processo, dbPath alheio (com dados mas sem o
  marcador desta instância) e qualquer porta diferente de 27118. Só escuta em 127.0.0.1.

  Fase 21.2.6: sempre `--auth --keyFile`. Usuários (credenciais SINTÉTICAS, DPAPI, em <Raiz>\seguranca):
    mariela_bootstrap (root)        — só configuração e desligamento;
    mariela_restore (marielaRestore) — mongorestore e leitura: insert/createIndex/find; SEM collMod, drop, rename,
                                       bypass, update/remove, dropDatabase ou escrita na posse;
    mariela_guardiao (marielaGuardiao) — posse, transições, congelamento e limpeza: collMod, dropCollection (sempre
                                       com collectionUUID), escrita SÓ na coleção de controle; SEM escrita em dados;
    mariela_leitor (readAnyDatabase) — inspeção.
  ConfigurarAutenticacao (idempotente): gera chave e credenciais que faltarem, migra uma instância antiga sem --auth
  (desliga e religa com --auth), cria o bootstrap pela exceção de localhost, os papéis e os usuários, a IDENTIDADE da instância (documento
  na instância + cópia local seguranca\instancia.json — Fase 21.2.8, A21-7-06) e prova que conexão sem credencial é recusada.
#>
param(
  [Parameter(Mandatory = $true)][ValidateSet("Iniciar", "Parar", "Estado", "ConfigurarAutenticacao")][string]$Acao,
  [string]$Raiz = (Join-Path $env:USERPROFILE "mariela-restore-isolado")
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "comum.ps1")

$porta = 27118
$mongod = Join-Path $Raiz "mongodb-8.0.37\bin\mongod.exe"
$dbPath = Join-Path $Raiz "data-27118"
$logPath = Join-Path $Raiz "logs\mongod-27118.log"
$marcador = Join-Path $dbPath ".mariela-restore-isolado"
$chave = Join-Path $Raiz "seguranca\mongod.key"

function Falhar([string]$Mensagem) { [Console]::Error.WriteLine($Mensagem); exit 1 }
function PortaEmUso { return [bool](Get-NetTCPConnection -LocalPort $porta -State Listen -ErrorAction SilentlyContinue) }
function EsperarPorta([bool]$Aberta) { for ($i = 0; $i -lt 60 -and ((PortaEmUso) -ne $Aberta); $i++) { Start-Sleep -Milliseconds 500 }; return ((PortaEmUso) -eq $Aberta) }
function ProcessoDaPortaOk { return (Test-EvidenciaInstancia (Get-EvidenciaPorta $porta) $mongod).Ok }

function IniciarProcesso {
  if (-not (Test-Path -LiteralPath $mongod)) { Falhar "mongod 8.0.37 não encontrado em $mongod (ver instalação na documentação)." }
  if (-not (Test-Path -LiteralPath $chave -PathType Leaf)) { Falhar "chave interna ausente ($chave): execute -Acao ConfigurarAutenticacao." }
  if (Test-Path -LiteralPath $dbPath) {
    $temDados = @(Get-ChildItem -LiteralPath $dbPath -Force).Count -gt 0
    if ($temDados -and -not (Test-Path -LiteralPath $marcador)) { Falhar "dbPath $dbPath tem dados sem o marcador desta instância — não é reutilizado." }
  } else {
    New-Item -ItemType Directory -Path $dbPath | Out-Null
  }
  if (-not (Test-Path -LiteralPath $marcador)) { Set-Content -LiteralPath $marcador -Value "dbPath exclusivo da instância isolada de restore (127.0.0.1:27118)" -Encoding ASCII }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $logPath) | Out-Null
  $argumentos = @("--port", "$porta", "--bind_ip", "127.0.0.1", "--dbpath", $dbPath, "--logpath", $logPath, "--logappend", "--replSet", "rs-restore", "--auth", "--keyFile", $chave)
  $linha = (@($argumentos) | ForEach-Object { ConvertTo-ArgumentoProcesso $_ }) -join ' '
  $null = Start-Process -FilePath $mongod -ArgumentList $linha -WindowStyle Hidden -PassThru
  if (-not (EsperarPorta $true)) { Falhar "mongod não abriu a porta $porta a tempo (ver $logPath)." }
  if (-not (ProcessoDaPortaOk)) { Falhar "o processo da porta $porta não é o mongod da instância isolada." }
}

<# replica set primário: com o bootstrap; sem usuários ainda, pela exceção de localhost. #>
function GarantirReplicaSet {
  $admin = Get-CredencialIsolada $Raiz 'admin'
  $rs = Invoke-CliBackup -Argumentos @("local-rs-iniciar", "--porta", "$porta", "--rs", "rs-restore") -Credencial $admin
  if (-not $rs.ok) { $rs = Invoke-CliBackup -Argumentos @("local-rs-iniciar", "--porta", "$porta", "--rs", "rs-restore", "--localhost") }
  if (-not $rs.ok) { Falhar "replica set não ficou primário: $($rs.mensagem)" }
}

switch ($Acao) {
  "Estado" {
    if (-not (PortaEmUso)) { Write-Host "parada (porta $porta livre)"; exit 0 }
    $e = Invoke-CliBackup -Argumentos @("local-estado", "--porta", "$porta") -Credencial (Get-CredencialIsolada $Raiz 'restore')
    if (-not $e.ok) { Falhar "estado indisponível: $($e.mensagem)" }
    $e.resultado | ConvertTo-Json -Compress
    exit 0
  }
  "Parar" {
    if (-not (PortaEmUso)) { Write-Host "já parada"; exit 0 }
    if (-not (ProcessoDaPortaOk)) { Falhar "A porta $porta não pertence à instância isolada — nada foi feito." }
    $e = Invoke-CliBackup -Argumentos @("local-estado", "--porta", "$porta") -Credencial (Get-CredencialIsolada $Raiz 'restore')
    if (-not $e.ok -or $e.resultado.dbPath -ne $dbPath) { Falhar "A porta $porta não pertence à instância isolada — nada foi feito." }
    $null = Invoke-CliBackup -Argumentos @("local-desligar", "--porta", "$porta") -Credencial (Get-CredencialIsolada $Raiz 'admin')
    if (-not (EsperarPorta $false)) { Falhar "A instância não parou a tempo." }
    Write-Host "parada"
    exit 0
  }
  "Iniciar" {
    if (PortaEmUso) {
      if (-not (ProcessoDaPortaOk)) { Falhar "Porta $porta ocupada por OUTRO processo — interrompido (nenhuma outra porta é escolhida)." }
      $e = Invoke-CliBackup -Argumentos @("local-estado", "--porta", "$porta") -Credencial (Get-CredencialIsolada $Raiz 'restore')
      if ($e.ok -and $e.resultado.dbPath -eq $dbPath -and $e.resultado.autenticacao) { Write-Host "já em execução"; $e.resultado | ConvertTo-Json -Compress; exit 0 }
      Falhar "A instância em $porta não está no estado esperado (com autenticação) — use -Acao ConfigurarAutenticacao."
    }
    IniciarProcesso
    GarantirReplicaSet
    $e = Invoke-CliBackup -Argumentos @("local-estado", "--porta", "$porta") -Credencial (Get-CredencialIsolada $Raiz 'restore')
    if (-not ($e.ok -and $e.resultado.autenticacao)) { Falhar "instância iniciada sem autenticação ativa: $($e.mensagem)" }
    $e.resultado | ConvertTo-Json -Compress
    exit 0
  }
  "ConfigurarAutenticacao" {
    # 1. Chave interna do replica set (obrigatória com --auth em replica set) e credenciais que faltarem.
    $pastaSeg = Split-Path -Parent $chave
    if (-not (Test-Path -LiteralPath $pastaSeg)) { New-Item -ItemType Directory -Path $pastaSeg | Out-Null; Set-AclRestrita $pastaSeg }
    if (-not (Test-Path -LiteralPath $chave)) {
      $bytes = New-Object byte[] 512
      $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create(); try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
      [System.IO.File]::WriteAllText($chave, [Convert]::ToBase64String($bytes), (New-Object System.Text.ASCIIEncoding))
      Set-AclRestrita $chave
    }
    $criadas = @(foreach ($p in 'admin', 'restore', 'guardiao', 'leitor') { if (New-CredencialIsolada $Raiz $p) { $p } })
    # 2. Migração: instância antiga rodando SEM --auth (só se for comprovadamente a isolada).
    if (PortaEmUso) {
      if (-not (ProcessoDaPortaOk)) { Falhar "Porta $porta ocupada por OUTRO processo — nada foi feito." }
      $semAuth = Invoke-CliBackup -Argumentos @("local-desligar", "--porta", "$porta", "--sem-autenticacao")
      if (-not (EsperarPorta $false)) {
        # Já estava com --auth (desligar sem credencial é recusado): desliga com o bootstrap.
        $null = Invoke-CliBackup -Argumentos @("local-desligar", "--porta", "$porta") -Credencial (Get-CredencialIsolada $Raiz 'admin')
        if (-not (EsperarPorta $false)) { Falhar "não foi possível parar a instância para religá-la com autenticação." }
      }
    }
    # 3. Religa com --auth --keyFile, garante o replica set e configura usuários e papel.
    IniciarProcesso
    GarantirReplicaSet
    $creds = @{}
    foreach ($p in 'admin', 'restore', 'guardiao', 'leitor') { $c = Get-CredencialIsolada $Raiz $p; $creds[$p] = @{ usuario = $c.Usuario; senha = (ConvertFrom-SenhaSegura $c.Senha) } }
    $entrada = $creds | ConvertTo-Json -Compress
    $creds = $null
    $r = Invoke-Nativo -Programa (Get-CaminhoBun) -Argumentos @("--no-env-file", (Join-Path $PSScriptRoot "lib\cli.ts"), "configurar-autenticacao", "--porta", "$porta", "--raiz", $Raiz) -Entrada $entrada
    $entrada = $null
    $linha = @($r.Saida -split "`r?`n" | Where-Object { $_.Trim().StartsWith('{') }) | Select-Object -Last 1
    $j = if ($linha) { $linha | ConvertFrom-Json } else { $null }
    if (-not ($j -and $j.ok)) { Falhar "configuração de autenticação falhou: $(if ($j) { $j.mensagem } else { 'sem resposta' })" }
    $idLocal = Join-Path $Raiz "seguranca\instancia.json"
    if (Test-Path -LiteralPath $idLocal) { Set-AclRestrita $idLocal }
    $e = Invoke-CliBackup -Argumentos @("local-estado", "--porta", "$porta") -Credencial (Get-CredencialIsolada $Raiz 'restore')
    if (-not ($e.ok -and $e.resultado.autenticacao)) { Falhar "autenticação não confirmada: $($e.mensagem)" }
    [pscustomobject]@{ credenciaisCriadas = $criadas; bootstrapCriado = $j.resultado.bootstrapCriado; identidadeCriada = $j.resultado.identidadeCriada; papeis = $j.resultado.papeis; usuarios = $j.resultado.usuarios; semAuthRecusado = $j.resultado.semAuthRecusado; instancia = $e.resultado } | ConvertTo-Json -Compress -Depth 4
    exit 0
  }
}
