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
    # SEM tipo [string] de propósito (R21-2.1-04): um parâmetro [string] converte $null em "" e a entrada AUSENTE
    # ficaria indistinguível da entrada VAZIA. $null = stdin não redirecionado; "" = stdin redirecionado e vazio.
    [AllowNull()]$Entrada = $null,
    [string]$DiretorioTrabalho = $null
  )
  if ($null -ne $Entrada -and $Entrada -isnot [string]) { throw "Invoke-Nativo: -Entrada precisa ser texto ou nula." }
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
  # StdinRedirecionado: a decisão efetivamente tomada (R21-2.1-04) — informativa, para diagnóstico e testes.
  return [pscustomobject]@{ Codigo = $processo.ExitCode; Saida = $tarefaSaida.Result; Erro = $tarefaErro.Result; StdinRedirecionado = $psi.RedirectStandardInput }
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

<#
  R21-2.1-05 — texto SEGURO de uma exceção para log/stderr: tipo + mensagem sem URI, host, IP nem caminhos de
  configuração, truncada. Nunca a pilha.
#>
function ConvertTo-MensagemSegura($Erro) {
  $tipo = if ($Erro -is [System.Management.Automation.ErrorRecord]) { $Erro.Exception.GetType().Name } elseif ($Erro -is [Exception]) { $Erro.GetType().Name } else { "Erro" }
  $texto = if ($Erro -is [System.Management.Automation.ErrorRecord]) { $Erro.Exception.Message } elseif ($Erro -is [Exception]) { $Erro.Message } else { "$Erro" }
  $texto = $texto -replace 'mongodb(\+srv)?://\S+', '[uri-removida]'
  $texto = $texto -replace '\b[a-z0-9-]+(\.[a-z0-9-]+)+\.(mongodb\.net|com|net|org|br|io)(:\d+)?\b', '[host-removido]'
  $texto = $texto -replace '\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b', '[ip-removido]'
  $texto = ($texto -replace '\s+', ' ').Trim()
  if ($texto.Length -gt 200) { $texto = $texto.Substring(0, 200) + "…" }
  return "${tipo}: $texto"
}

<#
  R21-2.1-11 — identidade do PROCESSO que escuta na porta da instância isolada. Coleta (Get-EvidenciaPorta, só
  leitura do sistema) separada da decisão (Test-EvidenciaInstancia, PURA — testável com fixtures).
#>
function Get-EvidenciaPorta([int]$Porta) {
  $conexoes = @(Get-NetTCPConnection -LocalPort $Porta -State Listen -ErrorAction SilentlyContinue)
  $processos = @($conexoes | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
      $p = Get-Process -Id $_ -ErrorAction SilentlyContinue
      [pscustomobject]@{ Pid = $_; Caminho = $(if ($p) { $p.Path } else { $null }) }
    })
  return [pscustomobject]@{
    Enderecos = @($conexoes | Select-Object -ExpandProperty LocalAddress -Unique)
    Processos = $processos
  }
}

function Test-EvidenciaInstancia($Evidencia, [string]$MongodEsperado) {
  $problemas = @()
  $enderecos = @($Evidencia.Enderecos)
  $processos = @($Evidencia.Processos)
  if ($enderecos.Count -eq 0) { $problemas += "nenhum processo escuta na porta (instância isolada parada)" }
  elseif (@($enderecos | Where-Object { $_ -ne "127.0.0.1" }).Count -gt 0) { $problemas += "a porta também escuta fora de 127.0.0.1 ($($enderecos -join ', '))" }
  if ($processos.Count -gt 1) { $problemas += "mais de um processo na porta" }
  elseif ($processos.Count -eq 1) {
    $caminho = $processos[0].Caminho
    if (-not $caminho) { $problemas += "processo da porta sem caminho identificável" }
    elseif ([System.IO.Path]::GetFullPath($caminho) -ne [System.IO.Path]::GetFullPath($MongodEsperado)) { $problemas += "processo da porta não é o mongod da instância isolada" }
  }
  return [pscustomobject]@{ Ok = ($problemas.Count -eq 0); Detalhe = ($problemas -join "; ") }
}

<#
  R21-2.3-01 — TRAVA de exclusão mútua LOCAL do restore. Abre <raiz>\locks\restore.lock com FileShare.Read e a
  MANTÉM aberta até Exit-TravaRestore (ou até o processo morrer — o SO libera). Enquanto isso nenhum outro processo
  consegue abri-la para escrita: a aquisição é atômica pelo próprio SO (comprovado entre processos independentes).
  O conteúdo nomeia a execução dona (execucaoId, pid, início do processo) — a CLI confere isso antes de cada operação
  de posse/limpeza. Se a execução anterior não deixou "livre", ela foi interrompida: isso é devolvido em .Anterior.
  Lança se a trava estiver ocupada (outro restore em andamento) ou não puder ser criada.
#>
function Enter-TravaRestore([string]$Caminho, [string]$ExecucaoId, [string]$Banco) {
  $pasta = Split-Path -Parent $Caminho
  if (-not (Test-Path -LiteralPath $pasta -PathType Container)) { New-Item -ItemType Directory -Path $pasta | Out-Null }
  $fluxo = [System.IO.File]::Open($Caminho, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::Read)
  try {
    $buffer = New-Object byte[] ([int]$fluxo.Length)
    $lidos = if ($buffer.Length) { $fluxo.Read($buffer, 0, $buffer.Length) } else { 0 }
    $anterior = $null
    if ($lidos -gt 0) { try { $anterior = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $lidos) | ConvertFrom-Json } catch { $anterior = [pscustomobject]@{ ilegivel = $true } } }
    $inicio = (Get-Process -Id $PID).StartTime.ToUniversalTime().ToString("o")
    $conteudo = [System.Text.Encoding]::UTF8.GetBytes((@{ execucaoId = $ExecucaoId; pid = $PID; processoInicio = $inicio; banco = $Banco; adquiridaEm = (Get-Date).ToString("o") } | ConvertTo-Json -Compress))
    $fluxo.SetLength(0)
    $fluxo.Position = 0
    $fluxo.Write($conteudo, 0, $conteudo.Length)
    $fluxo.Flush($true)
  } catch {
    $fluxo.Close()
    throw
  }
  return [pscustomobject]@{ Fluxo = $fluxo; Caminho = $Caminho; ExecucaoId = $ExecucaoId; ProcessoInicio = $inicio; Anterior = $anterior }
}

function Exit-TravaRestore($Trava) {
  if (-not $Trava -or -not $Trava.Fluxo) { return }
  try {
    $livre = [System.Text.Encoding]::UTF8.GetBytes((@{ livre = $true; ultimaExecucao = $Trava.ExecucaoId; liberadaEm = (Get-Date).ToString("o") } | ConvertTo-Json -Compress))
    $Trava.Fluxo.SetLength(0)
    $Trava.Fluxo.Position = 0
    $Trava.Fluxo.Write($livre, 0, $livre.Length)
    $Trava.Fluxo.Flush($true)
  } finally {
    $Trava.Fluxo.Close()
  }
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
