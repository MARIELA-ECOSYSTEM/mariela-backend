<#
.SYNOPSIS
  Funções compartilhadas dos scripts de backup/restore (dot-source). Fase 60.4.3.4.21.2.

.DESCRIPTION
  Compatível com Windows PowerShell 5.1 e PowerShell 7. Nunca lê, imprime nem registra a URI do MongoDB: o
  segredo fica só no arquivo de configuração do mongodump (--config), lido pelo próprio mongodump e pela CLI.
#>

function ConvertTo-ArgumentoProcesso([string]$Valor) {
  if ($Valor -ne '' -and $Valor -notmatch '[\s"]') { return $Valor }
  $escapado = $Valor -replace '(\\*)"', '$1$1\"'
  $escapado = $escapado -replace '(\\+)$', '$1$1'
  return '"' + $escapado + '"'
}

<#
  Executa um programa capturando stdout/stderr (leitura assíncrona: sem deadlock). $Entrada, se informada, é escrita
  no stdin — é por aqui que a senha do 7-Zip passa, NUNCA por argumento (que fica visível na lista de processos).
#>
function Invoke-Nativo {
  param(
    [Parameter(Mandatory = $true)][string]$Programa,
    [string[]]$Argumentos = @(),
    [string]$Entrada = $null,
    [string]$DiretorioTrabalho = $null
  )
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Programa
  $psi.Arguments = (@($Argumentos) | ForEach-Object { ConvertTo-ArgumentoProcesso $_ }) -join ' '
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.RedirectStandardInput = ($null -ne $Entrada)
  $psi.CreateNoWindow = $true
  $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
  if ($DiretorioTrabalho) { $psi.WorkingDirectory = $DiretorioTrabalho }
  # O stdin NUNCA pode receber BOM (o 7-Zip o leria como parte da senha). PowerShell 7 (.NET): StandardInputEncoding
  # sem preâmbulo. Windows PowerShell 5.1 (.NET Framework): o escritor do stdin usa a codificação do CONSOLE e, com
  # AutoFlush, grava o preâmbulo UTF-8 logo na criação quando o console está em UTF-8 — por isso a codificação do
  # console é trocada por UTF-8 SEM BOM só durante o Start e restaurada em seguida.
  $semBom = New-Object System.Text.UTF8Encoding($false)
  $codificacaoConsole = $null
  if ($null -ne $Entrada) {
    if ($psi.PSObject.Properties["StandardInputEncoding"]) {
      $psi.StandardInputEncoding = $semBom
    } else {
      try { $codificacaoConsole = [Console]::InputEncoding; [Console]::InputEncoding = $semBom } catch { $codificacaoConsole = $null }
    }
  }
  try {
    $processo = [System.Diagnostics.Process]::Start($psi)
  } finally {
    if ($null -ne $codificacaoConsole) { try { [Console]::InputEncoding = $codificacaoConsole } catch { } }
  }
  $tarefaSaida = $processo.StandardOutput.ReadToEndAsync()
  $tarefaErro = $processo.StandardError.ReadToEndAsync()
  if ($null -ne $Entrada) {
    # BYTES exatos (UTF-8 sem BOM) direto no stream: o StreamWriter do .NET Framework (Windows PowerShell 5.1) pode
    # emitir o preâmbulo UTF-8 conforme a codificação do console — o 7-Zip o leria como parte da senha e o pacote só
    # abriria naquele mesmo ambiente (defeito encontrado no teste T15 da Fase 21.2).
    $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($Entrada)
    $processo.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
    $processo.StandardInput.BaseStream.Flush()
    $processo.StandardInput.Close()
  }
  $processo.WaitForExit()
  return [pscustomobject]@{ Codigo = $processo.ExitCode; Saida = $tarefaSaida.Result; Erro = $tarefaErro.Result }
}

function Get-CaminhoBun {
  $cmd = Get-Command bun -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $padrao = Join-Path $env:USERPROFILE '.bun\bin\bun.exe'
  if (Test-Path -LiteralPath $padrao) { return $padrao }
  throw "bun não encontrado (PATH ou %USERPROFILE%\.bun\bin)."
}

<#
  Chama ops/backup/lib/cli.ts. `--no-env-file`: o Bun NÃO carrega o .env do diretório atual (que pode conter
  segredos de produção). Devolve o objeto JSON da resposta ({ ok, comando, resultado } ou { ok:false, codigo, mensagem }).
#>
function Invoke-CliBackup {
  param([Parameter(Mandatory = $true)][string[]]$Argumentos)
  $cli = Join-Path $PSScriptRoot 'lib\cli.ts'
  $r = Invoke-Nativo -Programa (Get-CaminhoBun) -Argumentos (@('--no-env-file', $cli) + $Argumentos)
  $linha = @($r.Saida -split "`r?`n" | Where-Object { $_.Trim().StartsWith('{') }) | Select-Object -Last 1
  if (-not $linha) { throw "A CLI de backup não devolveu JSON (código $($r.Codigo))." }
  return ($linha | ConvertFrom-Json)
}

<#
  ACL restrita: herança DESLIGADA e nenhuma regra Allow para identidades além da conta atual e SYSTEM.
  (Política 21.1: "ACL restrita à conta responsável e SYSTEM".)
#>
function Test-AclRestrita([string]$Caminho) {
  $acl = Get-Acl -LiteralPath $Caminho
  $eu = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $permitidos = @($eu, 'S-1-5-18')
  $problemas = @()
  if (-not $acl.AreAccessRulesProtected) { $problemas += 'herança de permissões ativa' }
  foreach ($regra in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($regra.AccessControlType -eq 'Allow' -and $permitidos -notcontains $regra.IdentityReference.Value) {
      $nome = try { $regra.IdentityReference.Translate([System.Security.Principal.NTAccount]).Value } catch { $regra.IdentityReference.Value }
      $problemas += "acesso concedido a '$nome'"
    }
  }
  return [pscustomobject]@{ Ok = ($problemas.Count -eq 0); Detalhe = ($problemas -join '; ') }
}

<# Aplica a ACL restrita (conta atual + SYSTEM, sem herança). Usado pelos testes e documentado para o operador. #>
function Set-AclRestrita([string]$Caminho) {
  $eu = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $ehPasta = Test-Path -LiteralPath $Caminho -PathType Container
  $heranca = if ($ehPasta) { '(OI)(CI)' } else { '' }
  $r = Invoke-Nativo -Programa 'icacls.exe' -Argumentos @($Caminho, '/inheritance:r', '/grant:r', "${eu}:${heranca}F", '/grant:r', "*S-1-5-18:${heranca}F")
  if ($r.Codigo -ne 0) { throw "icacls falhou ($($r.Codigo))." }
}

<# Uma linha JSON por evento (UTF-8 sem BOM). Nunca recebe URI, senha ou documento. #>
function Write-LogJson([string]$Arquivo, [hashtable]$Dados) {
  $pasta = Split-Path -Parent $Arquivo
  if (-not (Test-Path -LiteralPath $pasta)) { New-Item -ItemType Directory -Path $pasta | Out-Null }
  $linha = ($Dados | ConvertTo-Json -Compress -Depth 8)
  [System.IO.File]::AppendAllText($Arquivo, $linha + "`n", (New-Object System.Text.UTF8Encoding($false)))
}

function Get-Sha256([string]$Caminho) {
  return (Get-FileHash -LiteralPath $Caminho -Algorithm SHA256).Hash.ToUpperInvariant()
}

<# Converte SecureString em texto SÓ para escrever no stdin de um processo; o chamador descarta a variável. #>
function ConvertFrom-SenhaSegura([System.Security.SecureString]$Senha) {
  $ponteiro = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Senha)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ponteiro) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ponteiro) }
}
