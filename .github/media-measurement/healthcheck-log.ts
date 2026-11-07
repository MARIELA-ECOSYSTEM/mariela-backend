// Fase 60.4.3.4.7 — contabilização do Docker HEALTHCHECK pelo HISTÓRICO DO DOCKER (`.State.Health`), não pelo /proc.
//
// O Docker guarda em `.State.Health.Log` só as 5 execuções MAIS RECENTES. O workflow consulta `docker inspect` a cada
// poucos segundos (NDJSON: { t, health }) e este módulo junta as entradas pelo horário de início, reconstruindo o
// histórico completo — desde que o intervalo entre consultas seja menor que 5 × o intervalo do HEALTHCHECK (30 s).
// A observação pelo /proc (harness) vira métrica AUXILIAR: cada execução do Docker é classificada como observada ou
// não observada no /proc, ou como ocorrida fora das janelas de medição.
//
// Uso (CLI): bun --no-env-file healthcheck-log.ts <amostras.ndjson> <saida.json> <habilitado|desabilitado> [resultado.json do harness]
// Fase 60.4.3.4.8 — o JSON SEMPRE é gravado (inclusive com problemas, para diagnóstico), mas a CLI sai com código 2
// quando a integridade falha: amostra ilegível, falha de `docker inspect`, nenhuma leitura válida, estado diferente do
// esperado para o modo, histórico possivelmente incompleto ou `resultado.json` do harness exigido e não lido.
// Fase 60.4.3.4.9.15 (R06) — o Docker marca o HEALTHCHECK como `unhealthy` quando o contêiner PARA, mesmo com todas as
// execuções bem-sucedidas. Por isso cada leitura traz `running`, e o consolidado separa três conceitos:
//   - estadoOperacional: só leituras com running=true (o que o HEALTHCHECK dizia enquanto o contêiner rodava);
//   - estadoAposParada:  leituras com running=false (preservadas, mas NUNCA sobrescrevem o estado operacional);
//   - container:         se o contêiner foi visto parado, com que código de saída e quando.
import { readFileSync, writeFileSync } from "node:fs";

export interface EntradaDocker { Start: string; End: string; ExitCode: number; Output?: string }
export interface SaudeDocker { Status: string; FailingStreak: number; Log?: EntradaDocker[] | null }
/**
 * `erro` presente = a LEITURA falhou (ex.: `docker inspect` com erro) — nunca confundir com HEALTHCHECK desabilitado
 * nem com contêiner parado (leituras com erro não têm `running`).
 * `running` ausente numa leitura válida = formato antigo: o estado operacional fica indeterminável (integridade falha).
 * `exitCode`/`finishedAt` só têm valor com running=false (em execução o workflow grava null).
 */
export interface Amostra { t: number; health: SaudeDocker | null; erro?: string; running?: boolean; exitCode?: number | null; finishedAt?: string | null }
export type Esperado = "habilitado" | "desabilitado";

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

const ehObjeto = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function ehEntradaDocker(v: unknown): v is EntradaDocker {
  return ehObjeto(v) && typeof v["Start"] === "string" && typeof v["End"] === "string" && typeof v["ExitCode"] === "number" && (v["Output"] === undefined || typeof v["Output"] === "string");
}
/** `.State.Health` no formato do Docker: Status, FailingStreak e Log (lista de execuções, ou ausente/null). */
function ehSaudeDocker(v: unknown): v is SaudeDocker {
  if (!ehObjeto(v) || typeof v["Status"] !== "string" || typeof v["FailingStreak"] !== "number") return false;
  const log = v["Log"];
  return log === undefined || log === null || (Array.isArray(log) && log.every(ehEntradaDocker));
}

/**
 * Converte uma linha do NDJSON em amostra; `null` = linha inválida. Tipos errados NÃO são "consertados": um `health`
 * que não é objeto do Docker nem null invalidaria a distinção habilitado × desabilitado, então a linha é rejeitada.
 * Fase 60.4.3.4.9.16 — além dos tipos, valida as COMBINAÇÕES permitidas (nada é inventado nem convertido em null):
 *   - running=true:  `exitCode` e `finishedAt` presentes e null; sem `erro`;
 *   - running=false: `exitCode` presente e inteiro; `finishedAt` presente e texto não vazio; sem `erro`;
 *   - sem running, com `erro`: falha de leitura — `erro` texto não vazio, `health` null, sem `exitCode`/`finishedAt`;
 *   - sem running e sem `erro`: formato antigo — lido para diagnóstico (a integridade reprova em `consolidar`), sem
 *     `exitCode`/`finishedAt` (que só existem no formato novo, junto com `running`).
 */
function paraAmostra(obj: unknown): Amostra | null {
  if (!ehObjeto(obj) || !("health" in obj)) return null;
  const { t, health, erro, running, exitCode, finishedAt } = obj;
  if (typeof t !== "number") return null;
  let saude: SaudeDocker | null;
  if (health === null) saude = null;
  else if (ehSaudeDocker(health)) saude = health;
  else return null;
  if (running === true) {
    if (!("exitCode" in obj) || exitCode !== null || !("finishedAt" in obj) || finishedAt !== null || erro !== undefined) return null;
    return { t, health: saude, running, exitCode: null, finishedAt: null };
  }
  if (running === false) {
    if (typeof exitCode !== "number" || !Number.isInteger(exitCode) || typeof finishedAt !== "string" || finishedAt === "" || erro !== undefined) return null;
    return { t, health: saude, running, exitCode, finishedAt };
  }
  if (running !== undefined || "exitCode" in obj || "finishedAt" in obj) return null;
  if (erro === undefined) return { t, health: saude };
  if (typeof erro !== "string" || erro === "" || saude !== null) return null;
  return { t, health: null, erro };
}

/** Lê o NDJSON de amostras; linhas inválidas (JSON ilegível ou campos com tipo errado) são ignoradas e contadas. */
export function lerAmostras(texto: string): { amostras: Amostra[]; linhasInvalidas: number } {
  const amostras: Amostra[] = [];
  let linhasInvalidas = 0;
  for (const linha of texto.split(/\r?\n/)) {
    if (!linha.trim()) continue;
    let amostra: Amostra | null = null;
    try { amostra = paraAmostra(JSON.parse(linha)); } catch { amostra = null; }
    if (amostra) amostras.push(amostra); else linhasInvalidas += 1;
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

export interface OpcoesConsolidacao {
  linhasInvalidas?: number;
  /** Estado que o modo de medição exige (com_healthcheck → habilitado; sem_healthcheck → desabilitado). */
  esperado?: Esperado;
  /** false quando o `resultado.json` do harness era exigido mas não pôde ser lido. */
  resultadoHarnessLido?: boolean;
}

/** Resumo de uma leitura para o consolidado (auditoria): instante, se o contêiner rodava e o que o HEALTHCHECK dizia. */
export interface ResumoAmostra { t: number; running: boolean | null; status: string | null; failingStreak: number | null }
const resumir = (a: Amostra): ResumoAmostra => ({ t: a.t, running: a.running ?? null, status: a.health?.Status ?? null, failingStreak: a.health?.FailingStreak ?? null });
const ultimaPorT = (lista: Amostra[]): Amostra | null => lista.reduce<Amostra | null>((maior, a) => (!maior || a.t > maior.t ? a : maior), null);
const primeiraPorT = (lista: Amostra[]): Amostra | null => lista.reduce<Amostra | null>((menor, a) => (!menor || a.t < menor.t ? a : menor), null);

/** Encerramento do contêiner: só é conhecido se a última leitura válida o viu parado (running=false). */
export type Encerramento = "nao_observado" | "normal" | "com_erro" | "indeterminado";

/**
 * Fase 60.4.3.4.9.15 (R06) — separa os três conceitos a partir das leituras VÁLIDAS (leituras com `erro` não entram:
 * não são "parado" nem "desabilitado").
 */
export function separarEstados(validas: Amostra[]) {
  const operacionais = validas.filter((a) => a.running === true);
  const aposParada = validas.filter((a) => a.running === false);
  const ultimaOperacional = ultimaPorT(operacionais);
  const ultimaAposParada = ultimaPorT(aposParada);
  const ultimaObservada = ultimaPorT(validas);
  const parado = ultimaObservada?.running === false;
  const exitCode = parado ? ultimaObservada?.exitCode ?? null : null;
  const encerramento: Encerramento = !parado ? "nao_observado" : exitCode === null ? "indeterminado" : exitCode === 0 ? "normal" : "com_erro";
  return {
    operacionais,
    estadoOperacional: {
      status: ultimaOperacional?.health?.Status ?? null,
      failingStreak: ultimaOperacional?.health?.FailingStreak ?? null,
      // Só leituras em execução: o estado observado depois da parada nunca entra no contador nem nas transições.
      failingStreakMax: operacionais.some((a) => a.health) ? Math.max(0, ...operacionais.map((a) => a.health?.FailingStreak ?? 0)) : null,
      transicoesDeStatus: transicoesDeStatus(operacionais),
      amostras: operacionais.length,
      ultimaAmostraOperacional: ultimaOperacional ? resumir(ultimaOperacional) : null,
    },
    estadoAposParada: {
      status: ultimaAposParada?.health?.Status ?? null,
      failingStreak: ultimaAposParada?.health?.FailingStreak ?? null,
      amostras: aposParada.length,
      primeiraAmostraT: primeiraPorT(aposParada)?.t ?? null,
      ultimaAmostraObservada: ultimaAposParada ? resumir(ultimaAposParada) : null,
    },
    container: {
      // Estado registrado na ÚLTIMA LEITURA VÁLIDA (`ultimaAmostraObservada`) — não prova o estado efetivo do contêiner
      // no fim da coleta (pode ter parado depois dela, ou a leitura seguinte pode ter falhado).
      runningNaUltimaAmostraValida: ultimaObservada?.running ?? null,
      exitCode,
      finishedAt: parado ? ultimaObservada?.finishedAt ?? null : null,
      encerramento,
      ultimaAmostraObservada: ultimaObservada ? resumir(ultimaObservada) : null,
    },
  };
}

export function consolidar(amostras: Amostra[], janelas: JanelaHarness[] = [], opcoes: OpcoesConsolidacao = {}) {
  const linhasInvalidas = opcoes.linhasInvalidas ?? 0;
  // Só leituras VÁLIDAS (sem `erro`) contam para estado e lacuna: uma falha de leitura não é "desabilitado".
  const validas = amostras.filter((a) => a.erro === undefined);
  const errosDeLeitura = amostras.length - validas.length;
  const { operacionais, estadoOperacional, estadoAposParada, container } = separarEstados(validas);
  const semRunning = validas.filter((a) => a.running === undefined).length;
  const habilitado = validas.some((a) => a.health !== null);
  const lacuna = maiorLacunaMs(validas);
  const problemas: string[] = [];
  if (linhasInvalidas > 0) problemas.push(`${linhasInvalidas} linha(s) ilegível(is) no NDJSON`);
  if (errosDeLeitura > 0) problemas.push(`${errosDeLeitura} leitura(s) do docker inspect falharam`);
  if (validas.length === 0) problemas.push("nenhuma leitura válida do estado de saúde");
  if (semRunning > 0) problemas.push(`${semRunning} leitura(s) válida(s) sem o campo running: estado operacional indeterminável`);
  // Sem nenhuma leitura com o contêiner em execução não há estado operacional — nem "desabilitado" comprovado.
  if (validas.length > 0 && operacionais.length === 0) problemas.push("nenhuma amostra operacional (running=true) válida");
  if (opcoes.esperado && validas.length > 0 && (opcoes.esperado === "habilitado") !== habilitado) problemas.push(`estado ${habilitado ? "habilitado" : "desabilitado"} diferente do esperado (${opcoes.esperado})`);
  if (opcoes.esperado === "habilitado" && habilitado && estadoOperacional.ultimaAmostraOperacional && estadoOperacional.status === null) problemas.push("última amostra operacional sem estado de HEALTHCHECK");
  if (habilitado && lacuna >= 5 * 30_000) problemas.push(`lacuna de ${lacuna} ms entre leituras válidas: o histórico pode ter perdido execuções`);
  if (opcoes.resultadoHarnessLido === false) problemas.push("resultado.json do harness exigido e não lido: correlação com o /proc indisponível");
  const integridade = { ok: problemas.length === 0, problemas, amostras: amostras.length, leiturasValidas: validas.length, errosDeLeitura, linhasInvalidas, esperado: opcoes.esperado ?? null };
  if (!habilitado) return { habilitado: false, integridade, amostras: amostras.length, linhasInvalidas, estadoOperacional, estadoAposParada, container, observacao: "sem .State.Health nas leituras válidas: HEALTHCHECK desabilitado neste contêiner (esperado no modo sem_healthcheck)" };
  // O Log das leituras após a parada contém execuções REAIS (feitas enquanto o contêiner rodava): entra no histórico.
  const execucoes = unirExecucoes(validas);
  // Fase 60.4.3.4.9 — habilitado mas SEM nenhuma execução registrada não prova que o HEALTHCHECK rodou: reprova.
  if (opcoes.esperado === "habilitado" && execucoes.length === 0) {
    integridade.problemas.push("HEALTHCHECK habilitado sem nenhuma execução registrada pelo Docker");
    integridade.ok = false;
  }
  const correlacionadas = correlacionarComProc(execucoes, janelas);
  const duracoes = execucoes.map((e) => e.duracaoMs).sort((a, b) => a - b);
  const conta = (c: string) => correlacionadas.filter((e) => e.classificacao === c).length;
  return {
    habilitado: true,
    integridade,
    amostras: amostras.length,
    linhasInvalidas,
    maiorLacunaEntreAmostrasMs: lacuna,
    historicoPodeEstarIncompleto: lacuna >= 5 * 30_000,
    execucoes: execucoes.length,
    sucessos: execucoes.filter((e) => e.sucesso).length,
    falhas: execucoes.filter((e) => !e.sucesso).length,
    prazoExcedido: execucoes.filter((e) => e.prazoExcedido).length,
    duracaoMs: duracoes.length ? { min: duracoes[0], mediana: duracoes[Math.floor(duracoes.length / 2)], max: duracoes[duracoes.length - 1] } : null,
    estadoOperacional,
    estadoAposParada,
    container,
    correlacaoProc: { observadas: conta("observada_no_proc"), naoObservadas: conta("nao_observada_no_proc"), foraDeJanela: conta("fora_de_janela_de_medicao") },
    detalhes: correlacionadas,
  };
}

if (import.meta.main) {
  const [arquivoAmostras, arquivoSaida, esperado, arquivoResultado] = process.argv.slice(2);
  if (!arquivoAmostras || !arquivoSaida || (esperado !== "habilitado" && esperado !== "desabilitado")) {
    console.error("uso: healthcheck-log.ts <amostras.ndjson> <saida.json> <habilitado|desabilitado> [resultado.json]");
    process.exit(64);
  }
  // Arquivo de amostras ausente é falha de coleta (código 2), registrada no JSON — nunca vira "0 execuções".
  let texto = "";
  let erroLeitura: string | null = null;
  try { texto = readFileSync(arquivoAmostras, "utf8"); } catch (e) { erroLeitura = e instanceof Error ? e.message : String(e); }
  const { amostras, linhasInvalidas } = lerAmostras(texto);
  let janelas: JanelaHarness[] = [];
  let resultadoHarnessLido: boolean | undefined;
  if (arquivoResultado) {
    try { janelas = (JSON.parse(readFileSync(arquivoResultado, "utf8")) as { janelas?: JanelaHarness[] }).janelas ?? []; resultadoHarnessLido = true; } catch { resultadoHarnessLido = false; }
  }
  const resultado = consolidar(amostras, janelas, { linhasInvalidas, esperado, ...(resultadoHarnessLido === undefined ? {} : { resultadoHarnessLido }) });
  if (erroLeitura) { resultado.integridade.ok = false; resultado.integridade.problemas.unshift(`arquivo de amostras ilegível: ${erroLeitura}`); }
  writeFileSync(arquivoSaida, JSON.stringify(resultado, null, 2));
  console.log(JSON.stringify({ ...resultado, detalhes: undefined }));
  if (!resultado.integridade.ok) {
    console.error(`INTEGRIDADE FALHOU (${arquivoSaida}): ${resultado.integridade.problemas.join("; ")}`);
    process.exit(2);
  }
}
