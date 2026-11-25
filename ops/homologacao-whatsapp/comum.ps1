# Fase 22.8.9.10.7.7 — funções comuns dos scripts do ambiente local de homologação do WhatsApp oficial.
# Nunca imprime valores de configuração: só nomes de variáveis e resultados.

$ErrorActionPreference = "Stop"

$script:RaizPadrao = Join-Path $env:LOCALAPPDATA "MARIELA-HOMOLOGACAO"
$script:PortaMongo = 27217
$script:PortaBackoffice = 5180

# Variáveis que o backend/Backoffice/seed reconhecem. TODAS são removidas do processo antes de carregar a
# configuração de homologação — nada é herdado da sessão do Windows nem de outro ambiente.
$script:PadraoVariaveisReconhecidas = '^(NODE_ENV|TZ|PORT|API_PREFIX|MONGODB_.*|MONGO_.*|MARIELA_.*|JWT_.*|PDV_.*|REFRESH_.*|CORS_.*|ADMIN_.*|SWAGGER_.*|EVOLUTION_.*|WHATSAPP_.*|META_.*|R2_.*|RATE_LIMIT_.*|RECONCILIACAO_.*|HOMOLOGACAO_.*|VITE_.*)$'

function Get-RaizHomologacao([string]$Raiz) {
  if (-not $Raiz) { $Raiz = $script:RaizPadrao }
  return [System.IO.Path]::GetFullPath($Raiz)
}

# Lê CHAVE=valor do arquivo de homologação. Só chaves do modelo são aceitas (erro de digitação ou variável estranha
# impede a inicialização). Devolve um dicionário; nada é impresso.
function Read-ConfiguracaoHomologacao([string]$Arquivo, [string]$Modelo) {
  if (-not (Test-Path $Arquivo)) { throw "Configuração de homologação não encontrada: $Arquivo (rode o preparar.ps1)." }
  $permitidas = @{}
  foreach ($linha in Get-Content $Modelo) {
    if ($linha -match '^\s*([A-Z0-9_]+)=') { $permitidas[$Matches[1]] = $true }
  }
  $valores = [ordered]@{}
  $n = 0
  foreach ($linha in Get-Content $Arquivo) {
    $n++
    if ($linha -match '^\s*(#|$)') { continue }
    if ($linha -notmatch '^([A-Z0-9_]+)=(.*)$') { throw "Linha $n do arquivo de configuração fora do formato CHAVE=valor." }
    $chave = $Matches[1]
    if (-not $permitidas.ContainsKey($chave)) { throw "Variável desconhecida no arquivo de configuração: $chave (linha $n)." }
    $valores[$chave] = $Matches[2].Trim()
  }
  return $valores
}

# Remove do PROCESSO ATUAL todas as variáveis reconhecidas e define só as da homologação (as vazias ficam ausentes).
function Set-AmbienteHomologacao($Valores) {
  foreach ($v in Get-ChildItem Env:) {
    if ($v.Name -match $script:PadraoVariaveisReconhecidas) { Remove-Item "Env:$($v.Name)" }
  }
  foreach ($chave in $Valores.Keys) {
    if ($Valores[$chave] -ne "") { Set-Item "Env:$chave" $Valores[$chave] }
  }
}

# Serviço em segundo plano SEM herdar os handles deste processo (via `cmd /c`, iniciado pelo shell do Windows): o
# terminal (ou pipe) que rodou o script não fica preso, e a saída vai para <Log>.log / <Log>.err.log. O PID registrado
# é o do `cmd`; o encerrar.ps1 derruba a árvore inteira.
function Start-ServicoOculto([string]$Diretorio, [string]$Comando, [string]$Log) {
  $linha = "/d /s /c `"$Comando > `"$Log.log`" 2> `"$Log.err.log`"`""
  return Start-Process -FilePath "cmd.exe" -ArgumentList $linha -WorkingDirectory $Diretorio -WindowStyle Hidden -PassThru
}

function Test-PortaEmUso([int]$Porta) {
  return [bool](Get-NetTCPConnection -LocalPort $Porta -State Listen -ErrorAction SilentlyContinue)
}

function Wait-Condicao([scriptblock]$Condicao, [string]$Descricao, [int]$Segundos = 120) {
  $limite = (Get-Date).AddSeconds($Segundos)
  while ((Get-Date) -lt $limite) {
    if (& $Condicao) { return }
    Start-Sleep -Milliseconds 500
  }
  throw "Tempo esgotado: $Descricao"
}

function Assert-SemArquivoEnv([string[]]$Pastas) {
  foreach ($p in $Pastas) {
    foreach ($nome in ".env", ".env.local", ".env.development", ".env.development.local") {
      if (Test-Path (Join-Path $p $nome)) { throw "Encontrado $nome em $p — a homologação não pode herdar configuração de outro ambiente. Remova-o (é uma pasta só da homologação)." }
    }
  }
}
