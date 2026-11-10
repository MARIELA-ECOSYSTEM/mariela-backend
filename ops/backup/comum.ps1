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
  param(
    [Parameter(Mandatory = $true)][string[]]$Argumentos,
    # Fase 21.2.6 (A-03): credencial da instância isolada — vai SÓ pelo stdin (nunca argumento/ambiente/log).
    $Credencial = $null
  )
  $cli = Join-Path $PSScriptRoot 'lib\cli.ts'
  $entrada = $null
  if ($null -ne $Credencial) {
    $Argumentos = @($Argumentos) + '--credencial-stdin'
    $entrada = ConvertTo-EntradaCredencial $Credencial
  }
  $r = Invoke-Nativo -Programa (Get-CaminhoBun) -Argumentos (@('--no-env-file', $cli) + $Argumentos) -Entrada $entrada
  $entrada = $null
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
    $eu = Get-Process -Id $PID
    $inicio = $eu.StartTime.ToUniversalTime().ToString("o")
    # Fase 21.2.6 (A-09): horário de criação EXATO (FILETIME UTC) — a CLI confere com o GetProcessTimes do processo pai.
    $ticks = [string]$eu.StartTime.ToUniversalTime().ToFileTimeUtc()
    $conteudo = [System.Text.Encoding]::UTF8.GetBytes((@{ execucaoId = $ExecucaoId; pid = $PID; processoInicio = $inicio; processoInicioTicks = $ticks; executavel = $eu.Path; banco = $Banco; adquiridaEm = (Get-Date).ToString("o") } | ConvertTo-Json -Compress))
    $fluxo.SetLength(0)
    $fluxo.Position = 0
    $fluxo.Write($conteudo, 0, $conteudo.Length)
    $fluxo.Flush($true)
  } catch {
    $fluxo.Close()
    throw
  }
  return [pscustomobject]@{ Fluxo = $fluxo; Caminho = $Caminho; ExecucaoId = $ExecucaoId; ProcessoInicio = $inicio; ProcessoInicioTicks = $ticks; Executavel = $eu.Path; Anterior = $anterior }
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

# ===============================================================================================================
# Fase 60.4.3.4.21.2.6 (A-03) — CREDENCIAIS da instância isolada (sintéticas, geradas localmente).
#   Guardadas com DPAPI (ConvertFrom-SecureString sem chave = escopo da conta Windows atual): só esta conta, nesta
#   máquina, as decifra. Arquivo: "<usuario>`n<blob DPAPI>", pasta <Raiz>\seguranca com ACL restrita. Nunca impressas,
#   nunca em argumento: chegam aos processos SÓ pelo stdin (Invoke-CliBackup -Credencial; mongorestore -Entrada).
# ===============================================================================================================
$script:UsuariosIsolados = @{ admin = 'mariela_bootstrap'; restore = 'mariela_restore'; guardiao = 'mariela_guardiao'; leitor = 'mariela_leitor' }

function Get-CaminhoCredencial([string]$Raiz, [ValidateSet('admin', 'restore', 'guardiao', 'leitor')][string]$Papel) {
  return (Join-Path $Raiz "seguranca\$Papel.cred")
}

<# Senha aleatória ASCII alfanumérica (gerador criptográfico), 32 caracteres. #>
function New-SenhaAleatoria {
  $alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  $bytes = New-Object byte[] 64
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  $s = New-Object System.Security.SecureString
  foreach ($b in $bytes[0..31]) { $s.AppendChar($alfabeto[$b % $alfabeto.Length]) }
  $s.MakeReadOnly()
  return $s
}

<# Cria a credencial (se não existir). Devolve $true se criou. Nunca sobrescreve. #>
function New-CredencialIsolada([string]$Raiz, [ValidateSet('admin', 'restore', 'guardiao', 'leitor')][string]$Papel) {
  $arq = Get-CaminhoCredencial $Raiz $Papel
  if (Test-Path -LiteralPath $arq) { return $false }
  $pasta = Split-Path -Parent $arq
  if (-not (Test-Path -LiteralPath $pasta)) { New-Item -ItemType Directory -Path $pasta | Out-Null; Set-AclRestrita $pasta }
  $blob = ConvertFrom-SecureString -SecureString (New-SenhaAleatoria)
  [System.IO.File]::WriteAllText($arq, "$($script:UsuariosIsolados[$Papel])`n$blob`n", (New-Object System.Text.UTF8Encoding($false)))
  Set-AclRestrita $arq
  return $true
}

function Get-CredencialIsolada([string]$Raiz, [ValidateSet('admin', 'restore', 'guardiao', 'leitor')][string]$Papel) {
  $arq = Get-CaminhoCredencial $Raiz $Papel
  if (-not (Test-Path -LiteralPath $arq -PathType Leaf)) { throw "credencial '$Papel' da instância isolada ausente (execute mongod-isolado.ps1 -Acao ConfigurarAutenticacao)." }
  $acl = Test-AclRestrita $arq
  if (-not $acl.Ok) { throw "credencial '$Papel' com ACL aberta: $($acl.Detalhe)" }
  $linhas = @([System.IO.File]::ReadAllLines($arq) | Where-Object { $_ })
  if ($linhas.Count -ne 2) { throw "credencial '$Papel' ilegível." }
  return [pscustomobject]@{ Papel = $Papel; Usuario = $linhas[0]; Senha = (ConvertTo-SecureString -String $linhas[1]) }
}

<# JSON do stdin da CLI: {"conexao":{usuario,senha}} — a senha existe em texto só dentro desta string, só para o stdin. #>
function ConvertTo-EntradaCredencial($Credencial) {
  return (@{ conexao = @{ usuario = $Credencial.Usuario; senha = (ConvertFrom-SenhaSegura $Credencial.Senha) } } | ConvertTo-Json -Compress)
}

# ===============================================================================================================
# Fase 60.4.3.4.21.2.6 (A-06) — CONTROLE DOS PROCESSOS FILHOS: Job Object do Windows com
# JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE. O próprio PowerShell coordenador entra no job; todo processo que ele criar
# depois (bun/CLI, mongorestore, …) herda o job. Quando o coordenador morre por QUALQUER motivo (fim normal,
# Stop-Process -Force, janela fechada), o último handle do job fecha e o Windows mata todos os processos do job.
# Comprovado no PowerShell 5.1 e 7 (filho morto ao matar só o PowerShell).
# ===============================================================================================================
function Initialize-TipoJob {
  if ('MarielaControleJob' -as [type]) { return }
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MarielaControleJob {
  [StructLayout(LayoutKind.Sequential)] struct BASIC { public long a; public long b; public uint LimitFlags; public UIntPtr c; public UIntPtr d; public uint e; public UIntPtr f; public uint g; public uint h; }
  [StructLayout(LayoutKind.Sequential)] struct IOC { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] struct EXT { public BASIC Basic; public IOC Io; public UIntPtr p1, p2, p3, p4; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr j, int c, ref EXT i, uint l);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr j, int c, IntPtr i, uint l, IntPtr r);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  const uint KILL_ON_JOB_CLOSE = 0x2000;
  public static IntPtr Criar() {
    IntPtr j = CreateJobObject(IntPtr.Zero, null);
    if (j == IntPtr.Zero) throw new Exception("CreateJobObject " + Marshal.GetLastWin32Error());
    EXT x = new EXT(); x.Basic.LimitFlags = KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(j, 9, ref x, (uint)Marshal.SizeOf(typeof(EXT)))) throw new Exception("SetInformationJobObject " + Marshal.GetLastWin32Error());
    if (!AssignProcessToJobObject(j, GetCurrentProcess())) throw new Exception("AssignProcessToJobObject " + Marshal.GetLastWin32Error());
    return j;
  }
  /// PIDs de TODOS os processos ativos no job (JobObjectBasicProcessIdList). Fase 21.2.8 (A21-7-08): sem limite fixo —
  /// se a lista não couber (ERROR_MORE_DATA, ou NumberOfAssigned > NumberOfIdsInList), o buffer cresce e a consulta é
  /// refeita; qualquer outra falha lança (o chamador NÃO declara "sem processo filho").
  public static long[] Processos(IntPtr j) {
    int cap = 256;
    for (int tentativa = 0; tentativa < 8; tentativa++) {
      int tam = 8 + cap * IntPtr.Size;
      IntPtr buf = Marshal.AllocHGlobal(tam);
      try {
        bool ok = QueryInformationJobObject(j, 3, buf, (uint)tam, IntPtr.Zero);
        int erro = ok ? 0 : Marshal.GetLastWin32Error();
        int atribuidos = Marshal.ReadInt32(buf, 0);
        int naLista = Marshal.ReadInt32(buf, 4);
        if (!ok && erro != 234) throw new Exception("QueryInformationJobObject " + erro);
        if (!ok || atribuidos > naLista) { cap = Math.Max(cap * 4, atribuidos + 16); continue; }
        long[] r = new long[naLista];
        for (int i = 0; i < naLista; i++) r[i] = Marshal.ReadIntPtr(buf, 8 + i * IntPtr.Size).ToInt64();
        return r;
      } finally { Marshal.FreeHGlobal(buf); }
    }
    throw new Exception("lista de processos do job não pôde ser lida por completo");
  }
}
'@
}

<# Coloca o PowerShell atual num job kill-on-close. Falha ⇒ exceção (o chamador NÃO prossegue: falha fechada). #>
function Enable-ControleDeProcessos {
  if ($script:JobControle) { return $script:JobControle }
  Initialize-TipoJob
  $script:JobControle = [MarielaControleJob]::Criar()
  return $script:JobControle
}

<#
  Processos do job além do próprio coordenador. Só o host de console do WINDOWS é ignorado — conferido pelo CAMINHO do
  executável (%SystemRoot%\System32\conhost.exe), não pelo nome (Fase 21.2.8, A21-7-08). Qualquer outro, ou um conhost
  de caminho ilegível/diferente, conta como filho ativo (falha fechada).
#>
function Get-ProcessosFilhosAtivos {
  if (-not $script:JobControle) { throw "controle de processos não habilitado" }
  $conhost = [System.IO.Path]::GetFullPath((Join-Path $env:SystemRoot 'System32\conhost.exe'))
  $r = @()
  foreach ($id in [MarielaControleJob]::Processos($script:JobControle)) {
    if ($id -eq $PID) { continue }
    $p = Get-Process -Id $id -ErrorAction SilentlyContinue
    $caminho = $null
    if ($p) { try { $caminho = $p.Path } catch { $caminho = $null } }
    if ($caminho -and [string]::Equals([System.IO.Path]::GetFullPath($caminho), $conhost, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
    $r += [pscustomobject]@{ Pid = $id; Nome = $(if ($p) { $p.ProcessName } else { '?' }); Caminho = $caminho }
  }
  return , $r
}

<# Pasta da âncora externa (Fase 21.2.8, A21-7-02): <Raiz>\evidencias, criada com ACL restrita (conta atual + SYSTEM). #>
function Initialize-PastaEvidencias([string]$Raiz) {
  $pasta = Join-Path $Raiz "evidencias"
  if (-not (Test-Path -LiteralPath $pasta -PathType Container)) { New-Item -ItemType Directory -Path $pasta | Out-Null; Set-AclRestrita $pasta }
  $acl = Test-AclRestrita $pasta
  if (-not $acl.Ok) { throw "pasta de evidências com ACL aberta: $($acl.Detalhe)" }
  return $pasta
}

<# Horário de criação (FILETIME UTC) de um processo; $null se não existir; 'SEM_ACESSO' se existir sem leitura. #>
function Get-InicioProcesso([int]$Id) {
  $p = Get-Process -Id $Id -ErrorAction SilentlyContinue
  if (-not $p) { return $null }
  try { return [string]$p.StartTime.ToUniversalTime().ToFileTimeUtc() } catch { return 'SEM_ACESSO' }
}

<#
  Decisão PURA (testável com fixtures): o dono registrado ainda pode estar vivo?
  - processo inexistente ⇒ encerrado;
  - processo existe e o horário de criação é OUTRO ⇒ PID reutilizado ⇒ o dono está encerrado;
  - mesmo horário ⇒ VIVO; horário ilegível ⇒ tratado como VIVO (falha fechada).
#>
function Test-DonoVivo([string]$TicksRegistrados, $TicksAtuais) {
  if ($null -eq $TicksAtuais) { return $false }
  if ($TicksAtuais -eq 'SEM_ACESSO' -or -not $TicksRegistrados) { return $true }
  return ([string]$TicksAtuais -eq [string]$TicksRegistrados)
}

<#
  Processos que PODEM pertencer a uma execução: qualquer processo (de qualquer nome/executável) cuja linha de comando
  cite o banco de destino ou o execucaoId — exceto este processo e seus ancestrais (que o citam por terem chamado
  este script). Falha fechada: em dúvida, conta como ativo.
#>
function Get-ProcessosDaExecucao([string[]]$Marcadores) {
  $todos = @(Get-CimInstance Win32_Process -ErrorAction Stop)
  $porId = @{}; foreach ($t in $todos) { $porId[[int]$t.ProcessId] = $t }
  $excluir = @{}; $atual = $PID
  for ($i = 0; $i -lt 64 -and $atual -and -not $excluir.ContainsKey($atual); $i++) {
    $excluir[$atual] = $true
    $atual = if ($porId.ContainsKey($atual)) { [int]$porId[$atual].ParentProcessId } else { 0 }
  }
  $r = @()
  foreach ($t in $todos) {
    if ($excluir.ContainsKey([int]$t.ProcessId) -or -not $t.CommandLine) { continue }
    foreach ($m in $Marcadores) {
      if ($m -and $t.CommandLine.IndexOf($m, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
        $r += [pscustomobject]@{ Pid = [int]$t.ProcessId; Nome = $t.Name; Executavel = $t.ExecutablePath }
        break
      }
    }
  }
  return , $r
}
