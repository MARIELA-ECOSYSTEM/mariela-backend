// Fase 60.4.3.4.7 — contabilização do Docker HEALTHCHECK pelo HISTÓRICO DO DOCKER (`.State.Health`), não pelo /proc.
//
// O Docker guarda em `.State.Health.Log` só as 5 execuções MAIS RECENTES. O workflow consulta `docker inspect` a cada
// poucos segundos (NDJSON: { t, health }) e este módulo junta as entradas pelo horário de início, reconstruindo o
// histórico completo — desde que o intervalo entre consultas seja menor que 5 × o intervalo do HEALTHCHECK (30 s).
// A observação pelo /proc (harness) vira métrica AUXILIAR: cada execução do Docker é classificada como observada ou
// não observada no /proc, ou como ocorrida fora das janelas de medição.
//
// Uso (CLI): bun --no-env-file healthcheck-log.ts <amostras.ndjson> <saida.json> [resultado.json do harness]
import { readFileSync, writeFileSync } from "node:fs";

export interface EntradaDocker { Start: string; End: string; ExitCode: number; Output?: string }
export interface SaudeDocker { Status: string; FailingStreak: number; Log?: EntradaDocker[] | null }
export interface Amostra { t: number; health: SaudeDocker | null }

export interface Execucao {
  inicio: number;
  fim: number;
  duracaoMs: number;
  codigoSaida: number;
  sucesso: boolean;
  /** true quando o Docker encerrou pelo prazo do HEALTHCHECK (saída -1 / "exceeded timeout"). */
  prazoExcedido: boolean;
  saida: string;
}

export interface JanelaHarness { rotulo: string; inicio: number; fim: number; healthcheckDocker?: { execucoes?: { iniciouMsAposJanela: number; vivoMs: number; picoRssMiB: number | null }[] } }

/** Data ISO do Docker (nanossegundos, com ou sem fuso) → epoch ms. Frações além de milissegundos são descartadas. */
export function paraEpochMs(iso: string): number {
  const normalizado = iso.replace(/(\.\d{3})\d+/, "$1");
  const ms = Date.parse(normalizado);
  if (Number.isNaN(ms)) throw new Error(`data inválida no histórico do Docker: ${iso}`);
  return ms;
}

/** Lê o NDJSON de amostras; linhas inválidas são ignoradas e contadas. */
export function lerAmostras(texto: string): { amostras: Amostra[]; linhasInvalidas: number } {
  const amostras: Amostra[] = [];
  let linhasInvalidas = 0;
  for (const linha of texto.split(/\r?\n/)) {
    if (!linha.trim()) continue;
    try {
      const obj = JSON.parse(linha) as { t?: unknown; health?: unknown };
      if (typeof obj.t !== "number") throw new Error("sem t");
      amostras.push({ t: obj.t, health: obj.health && typeof obj.health === "object" ? (obj.health as SaudeDocker) : null });
    } catch {
      linhasInvalidas += 1;
    }
  }
  return { amostras, linhasInvalidas };
}

/** Une as entradas de todas as amostras (sem duplicar), em ordem de início. */
export function unirExecucoes(amostras: Amostra[]): Execucao[] {
  const porInicio = new Map<string, EntradaDocker>();
  for (const a of amostras) for (const e of a.health?.Log ?? []) porInicio.set(e.Start, e);
  return [...porInicio.values()]
    .map((e) => {
      const inicio = paraEpochMs(e.Start), fim = paraEpochMs(e.End);
      const saida = (e.Output ?? "").trim().slice(0, 300);
      return { inicio, fim, duracaoMs: fim - inicio, codigoSaida: e.ExitCode, sucesso: e.ExitCode === 0, prazoExcedido: e.ExitCode === -1 || /exceeded timeout/i.test(saida), saida };
    })
    .sort((a, b) => a.inicio - b.inicio);
}

/** Maior intervalo entre amostras consecutivas: acima de 5 × 30 s, pode ter havido perda de entradas. */
export function maiorLacunaMs(amostras: Amostra[]): number {
  let maior = 0;
  const ts = amostras.map((a) => a.t).sort((a, b) => a - b);
  for (let i = 1; i < ts.length; i++) maior = Math.max(maior, ts[i]! - ts[i - 1]!);
  return maior;
}

/** Transições de status (starting → healthy → unhealthy …) na ordem em que foram vistas nas amostras. */
export function transicoesDeStatus(amostras: Amostra[]): { t: number; status: string; failingStreak: number }[] {
  const saida: { t: number; status: string; failingStreak: number }[] = [];
  for (const a of [...amostras].sort((x, y) => x.t - y.t)) {
    if (!a.health) continue;
    const ultimo = saida[saida.length - 1];
    if (!ultimo || ultimo.status !== a.health.Status) saida.push({ t: a.t, status: a.health.Status, failingStreak: a.health.FailingStreak });
  }
  return saida;
}

/** Classifica cada execução do Docker contra as observações do /proc feitas pelo harness (tolerância de 1 s). */
export function correlacionarComProc(execucoes: Execucao[], janelas: JanelaHarness[], toleranciaMs = 1_000) {
  const vistas = janelas.flatMap((j) => (j.healthcheckDocker?.execucoes ?? []).map((x) => ({ inicio: j.inicio + x.iniciouMsAposJanela, fim: j.inicio + x.iniciouMsAposJanela + x.vivoMs, picoRssMiB: x.picoRssMiB })));
  return execucoes.map((e) => {
    const janela = janelas.find((j) => e.inicio <= j.fim && e.fim >= j.inicio);
    const vista = vistas.find((v) => v.inicio <= e.fim + toleranciaMs && v.fim >= e.inicio - toleranciaMs);
    const classificacao = !janela ? "fora_de_janela_de_medicao" : vista ? "observada_no_proc" : "nao_observada_no_proc";
    return { ...e, classificacao, janela: janela?.rotulo ?? null, picoRssProcMiB: vista?.picoRssMiB ?? null };
  });
}

export function consolidar(amostras: Amostra[], janelas: JanelaHarness[] = [], linhasInvalidas = 0) {
  const habilitado = amostras.some((a) => a.health !== null);
  if (!habilitado) return { habilitado: false, amostras: amostras.length, linhasInvalidas, observacao: "sem .State.Health: HEALTHCHECK desabilitado neste contêiner (esperado no modo sem_healthcheck)" };
  const execucoes = unirExecucoes(amostras);
  const correlacionadas = correlacionarComProc(execucoes, janelas);
  const duracoes = execucoes.map((e) => e.duracaoMs).sort((a, b) => a - b);
  const ultima = [...amostras].sort((a, b) => b.t - a.t).find((a) => a.health)?.health ?? null;
  const conta = (c: string) => correlacionadas.filter((e) => e.classificacao === c).length;
  return {
    habilitado: true,
    amostras: amostras.length,
    linhasInvalidas,
    maiorLacunaEntreAmostrasMs: maiorLacunaMs(amostras),
    historicoPodeEstarIncompleto: maiorLacunaMs(amostras) >= 5 * 30_000,
    execucoes: execucoes.length,
    sucessos: execucoes.filter((e) => e.sucesso).length,
    falhas: execucoes.filter((e) => !e.sucesso).length,
    prazoExcedido: execucoes.filter((e) => e.prazoExcedido).length,
    duracaoMs: duracoes.length ? { min: duracoes[0], mediana: duracoes[Math.floor(duracoes.length / 2)], max: duracoes[duracoes.length - 1] } : null,
    statusFinal: ultima?.Status ?? null,
    failingStreakFinal: ultima?.FailingStreak ?? null,
    failingStreakMax: Math.max(0, ...amostras.map((a) => a.health?.FailingStreak ?? 0)),
    transicoesDeStatus: transicoesDeStatus(amostras),
    correlacaoProc: { observadas: conta("observada_no_proc"), naoObservadas: conta("nao_observada_no_proc"), foraDeJanela: conta("fora_de_janela_de_medicao") },
    detalhes: correlacionadas,
  };
}

if (import.meta.main) {
  const [arquivoAmostras, arquivoSaida, arquivoResultado] = process.argv.slice(2);
  if (!arquivoAmostras || !arquivoSaida) throw new Error("uso: healthcheck-log.ts <amostras.ndjson> <saida.json> [resultado.json]");
  const { amostras, linhasInvalidas } = lerAmostras(readFileSync(arquivoAmostras, "utf8"));
  let janelas: JanelaHarness[] = [];
  if (arquivoResultado) {
    try { janelas = (JSON.parse(readFileSync(arquivoResultado, "utf8")) as { janelas?: JanelaHarness[] }).janelas ?? []; } catch { janelas = []; }
  }
  const resultado = consolidar(amostras, janelas, linhasInvalidas);
  writeFileSync(arquivoSaida, JSON.stringify(resultado, null, 2));
  console.log(JSON.stringify({ ...resultado, detalhes: undefined }));
}
