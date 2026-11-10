<#
.SYNOPSIS
  Apoio do runner testes-posse.ps1 (Fase 60.4.3.4.21.2.11, T06c) — sem MongoDB; testado em testes-scripts.ps1.

.DESCRIPTION
  O runner lembra o archive de cada destino para INFORMÁ-LO nos comandos do operador (gerir-restore, recuperar-destino).
  Defeito T06c (21.2.9/21.2.10): RestoreAsync gravava o archive a CADA tentativa; a tentativa RECUSADA do T06b
  (Restore $archBase no destino 20, já possuído pela execução interrompida com $archVol) trocava o archive lembrado do
  destino 20, e a recuperação do T06c informava o archive ERRADO — o produto recusava corretamente (âncora), o teste é
  que estava errado. Correção NO RUNNER: o destino pertence ao archive da PRIMEIRA execução que o tentou (a que adquire
  a posse); tentativas posteriores no mesmo destino não trocam o archive lembrado. O produto não muda.
#>

function Register-ArchiveDoDestino([hashtable]$Mapa, [string]$Banco, [string]$Archive) {
  if (-not $Mapa.ContainsKey($Banco)) { $Mapa[$Banco] = $Archive }
  return $Mapa[$Banco]
}

function Get-ArchiveDoDestino([hashtable]$Mapa, [string]$Banco) {
  if ($Mapa.ContainsKey($Banco)) { return $Mapa[$Banco] }
  return $null
}
