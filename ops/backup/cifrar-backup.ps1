<#
.SYNOPSIS
  Cifra (7-Zip, AES-256), verifica ou decifra um backup VÁLIDO — preparação da segunda cópia (Fase 60.4.3.4.21.2).

.DESCRIPTION
  Pacote <base>.7z = archive + .sha256 + manifesto, com cabeçalho cifrado (-mhe=on: nem os nomes ficam visíveis).
  A SENHA NUNCA PASSA POR ARGUMENTO: vai pelo stdin do 7-Zip (comportamento conferido no 7-Zip 26.03: na criação,
  "-p" sem valor pede a senha; no teste/extração, sem "-p", ele pede a senha). Sem -Senha, ela é pedida de forma
  interativa (Read-Host -AsSecureString); numa sessão não interativa isso FALHA — não há mecanismo de chave para
  execução agendada aprovado (decisão pendente do operador). Nenhuma senha é gravada em arquivo, log ou repositório.

  Cifrar:   exige manifesto VALIDO_LOCAL e SHA-256 do archive igual ao manifesto; gera <base>.7z (sem sobrescrever),
            <base>.7z.sha256, testa o pacote com a senha, decifra numa pasta temporária e confere o SHA-256 do archive
            recuperado; registra a segunda cópia no estado CIFRADO (<base>.segunda-copia.json).
  Verificar: SHA-256 do pacote = .7z.sha256 e teste de integridade com a senha.
  Decifrar:  confere o pacote, extrai numa pasta NOVA e confere o SHA-256 do archive recuperado contra o .sha256
            e o manifesto que vieram dentro do pacote.
#>
param(
  [Parameter(Mandatory = $true)][ValidateSet("Cifrar", "Verificar", "Decifrar")][string]$Acao,
  [Parameter(Mandatory = $true)][string]$Arquivo,
  [string]$Destino = "",
  [System.Security.SecureString]$Senha,
  [string]$SeteZip = "C:\Program Files\7-Zip\7z.exe"
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "comum.ps1")

# Mensagem no stderr + código de saída EXATO (com ErrorActionPreference=Stop, Write-Error encerraria sempre com 1).
# Contrato: 0 = sucesso; 1 = uso/pré-condição/integridade; 2 = senha incorreta ou pacote corrompido.
function Falhar([string]$Mensagem, [int]$Codigo) {
  [Console]::Error.WriteLine($Mensagem)
  exit $Codigo
}

if (-not (Test-Path -LiteralPath $SeteZip)) { Falhar "7-Zip não encontrado em $SeteZip." 1 }
if (-not (Test-Path -LiteralPath $Arquivo -PathType Leaf)) { Falhar "Arquivo não encontrado." 1 }
if (-not $Senha) { $Senha = Read-Host -AsSecureString "Senha da cifra (não é exibida)" }
if ($Senha.Length -lt 12) { Falhar "Senha recusada: mínimo de 12 caracteres." 1 }
# Só ASCII imprimível: os bytes da senha no stdin do 7-Zip ficam idênticos em qualquer página de código, versão do
# PowerShell e máquina — a mesma senha abre o pacote em qualquer lugar (requisito da recuperação).
$verificacaoAscii = ConvertFrom-SenhaSegura $Senha
$asciiOk = $verificacaoAscii -cmatch '^[\x21-\x7E]+$'
$verificacaoAscii = $null
if (-not $asciiOk) { Falhar "Senha recusada: use só caracteres ASCII imprimíveis (sem acentos nem espaços)." 1 }

function Rodar7z([string[]]$Argumentos, [string]$Pasta) {
  $texto = ConvertFrom-SenhaSegura $Senha
  try { return Invoke-Nativo -Programa $SeteZip -Argumentos $Argumentos -Entrada ($texto + "`n") -DiretorioTrabalho $Pasta }
  finally { $texto = $null }
}

function ConferirPacote([string]$Pacote) {
  $sha = Get-Sha256 $Pacote
  $esperado = if (Test-Path -LiteralPath "$Pacote.sha256") { ((Get-Content -LiteralPath "$Pacote.sha256" -Raw).Trim() -split '\s+')[0].ToUpperInvariant() } else { $null }
  if ($sha -ne $esperado) { Falhar "SHA-256 do pacote cifrado diverge do .7z.sha256 (ou o .sha256 não existe)." 1 }
  $t = Rodar7z @("t", "-bso0", "-bsp0", $Pacote) (Split-Path -Parent $Pacote)
  if ($t.Codigo -ne 0) {
    $erro7z = (($t.Erro -split "`r?`n") | Where-Object { $_.Trim() } | ForEach-Object { $_.Trim() }) -join " / "
    Falhar "Teste de integridade do pacote FALHOU (senha incorreta ou pacote corrompido; código $($t.Codigo)): $erro7z" 2
  }
  return $sha
}

function DecifrarEConferir([string]$Pacote, [string]$Pasta) {
  if ((Test-Path -LiteralPath $Pasta) -and @(Get-ChildItem -LiteralPath $Pasta -Force).Count -gt 0) { Falhar "A pasta de destino precisa ser nova ou vazia." 1 }
  New-Item -ItemType Directory -Force -Path $Pasta | Out-Null
  $x = Rodar7z @("x", "-bso0", "-bsp0", "-o$Pasta", $Pacote) (Split-Path -Parent $Pacote)
  if ($x.Codigo -ne 0) { Falhar "Decifragem FALHOU (código $($x.Codigo))." 2 }
  $archive = @(Get-ChildItem -LiteralPath $Pasta -File -Filter "*.archive.gz")
  if ($archive.Count -ne 1) { Falhar "Pacote sem exatamente um archive." 1 }
  $manifesto = Get-Content -LiteralPath ($archive[0].FullName -replace '\.archive\.gz$', '.manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $shaInterno = ((Get-Content -LiteralPath "$($archive[0].FullName).sha256" -Raw).Trim() -split '\s+')[0].ToUpperInvariant()
  $shaRecuperado = Get-Sha256 $archive[0].FullName
  if ($shaRecuperado -ne $shaInterno -or $shaRecuperado -ne $manifesto.archive.sha256) { Falhar "SHA-256 do archive recuperado diverge do original." 1 }
  return $shaRecuperado
}

switch ($Acao) {
  "Cifrar" {
    if ($Arquivo -notmatch '\.archive\.gz$') { Falhar "Cifrar exige o .archive.gz." 1 }
    $pasta = Split-Path -Parent (Resolve-Path -LiteralPath $Arquivo).Path
    $nome = Split-Path -Leaf $Arquivo
    $base = $nome -replace '\.archive\.gz$', ''
    $manifestoArq = Join-Path $pasta "$base.manifest.json"
    $manifesto = Get-Content -LiteralPath $manifestoArq -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifesto.estado -ne "VALIDO_LOCAL") { Falhar "Só backups VALIDO_LOCAL são cifrados para a segunda cópia." 1 }
    $sha = Get-Sha256 (Join-Path $pasta $nome)
    if ($sha -ne $manifesto.archive.sha256) { Falhar "SHA-256 do archive diverge do manifesto — nada foi cifrado." 1 }
    $pacote = Join-Path $pasta "$base.7z"
    if ((Test-Path -LiteralPath $pacote) -or (Test-Path -LiteralPath "$pacote.sha256")) { Falhar "COLISAO: $base.7z já existe — nada foi sobrescrito." 1 }

    # Criação: "-p" sem valor ⇒ o 7-Zip pede a senha (lida do stdin). -mhe=on cifra também os nomes. -mx=0: o archive já é gzip.
    $a = Rodar7z @("a", "-t7z", "-mhe=on", "-mx=0", "-p", "-bso0", "-bsp0", "$base.7z", $nome, "$nome.sha256", "$base.manifest.json") $pasta
    if ($a.Codigo -ne 0) { Remove-Item -LiteralPath $pacote -Force -ErrorAction SilentlyContinue; Falhar "Criação do pacote cifrado FALHOU (código $($a.Codigo))." 1 }
    $shaPacote = Get-Sha256 $pacote
    [System.IO.File]::WriteAllText("$pacote.sha256", "$shaPacote  $base.7z`n", (New-Object System.Text.UTF8Encoding($false)))
    $null = ConferirPacote $pacote

    $temp = Join-Path ([System.IO.Path]::GetTempPath()) ("mariela-verif-" + [guid]::NewGuid().ToString("N"))
    try { $null = DecifrarEConferir $pacote $temp } finally { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue }

    $reg = Invoke-CliBackup -Argumentos @("registrar-cifrado", "--manifesto", $manifestoArq, "--cifrado", $pacote, "--saida", (Join-Path $pasta "$base.segunda-copia.json"))
    if (-not $reg.ok) { Falhar "Registro do estado CIFRADO falhou: $($reg.mensagem)" 1 }
    Write-Host "[CIFRADO] $base.7z (SHA-256 $shaPacote) — testado e decifrado com sucesso; archive recuperado confere. Upload NÃO realizado."
    exit 0
  }
  "Verificar" {
    $sha = ConferirPacote (Resolve-Path -LiteralPath $Arquivo).Path
    Write-Host "[OK] pacote íntegro (SHA-256 $sha)"
    exit 0
  }
  "Decifrar" {
    if (-not $Destino) { Falhar "Decifrar exige -Destino (pasta nova)." 1 }
    $pacote = (Resolve-Path -LiteralPath $Arquivo).Path
    $null = ConferirPacote $pacote
    $sha = DecifrarEConferir $pacote $Destino
    Write-Host "[OK] decifrado em $Destino; SHA-256 do archive recuperado $sha confere com o original."
    exit 0
  }
}
