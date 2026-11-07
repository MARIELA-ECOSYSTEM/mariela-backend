// Fase 60.4.3.4.7 — verificação de healthcheck-log.ts com amostras no formato REAL do `docker inspect --format
// '{{json .State.Health}}'` (datas com nanossegundos, saída -1 em prazo excedido). Não usa o padrão *.test.ts de
// propósito (o `bun test` do CI não o coleta). Uso: bun --no-env-file verificar-healthcheck-log.ts — sai com código 1
// na primeira divergência. O workflow executa esta verificação antes das medições.
// Fase 60.4.3.4.9.15 (R06) — as leituras trazem `running` (e, parado, `exitCode`/`finishedAt`); os casos T01–T10
// verificam a separação entre estado operacional, estado após a parada e estado do contêiner.
import { consolidar, lerAmostras, paraEpochMs, transicoesDeStatus, unirExecucoes, type Amostra, type EntradaDocker, type Esperado, type SaudeDocker } from "./healthcheck-log.ts";

let falhas = 0;
function confere(descricao: string, obtido: unknown, esperado: unknown) {
  const ok = JSON.stringify(obtido) === JSON.stringify(esperado);
  if (!ok) falhas += 1;
  console.log(`${ok ? "OK  " : "FALHA"} ${descricao}${ok ? "" : ` — obtido ${JSON.stringify(obtido)}, esperado ${JSON.stringify(esperado)}`}`);
}

const base = Date.parse("2026-11-07T16:00:00.000Z");
const iso = (ms: number, nanos = "123456") => new Date(ms).toISOString().replace("Z", `${nanos}Z`).replace(/(\.\d{3})/, "$1");
const execucao = (segundo: number, duracaoMs: number, codigo: number, saida = ""): EntradaDocker => ({ Start: iso(base + segundo * 1000), End: iso(base + segundo * 1000 + duracaoMs), ExitCode: codigo, Output: saida });
// 8 execuções a cada 30 s: 6 sucessos, 1 falha comum, 1 prazo excedido. O Docker só guarda as 5 últimas em cada consulta.
const todas = [
  execucao(30, 410, 0), execucao(60, 395, 0), execucao(90, 5003, -1, "Health check exceeded timeout (5s)"),
  execucao(120, 820, 1, "TypeError: fetch failed"), execucao(150, 402, 0), execucao(180, 390, 0), execucao(210, 405, 0), execucao(240, 399, 0),
];
// Leituras com o contêiner EM EXECUÇÃO (running=true), como o workflow grava a partir da Fase 60.4.3.4.9.15.
const consulta = (t: number, status: string, streak: number): Amostra => ({ t: base + t * 1000, running: true, exitCode: null, finishedAt: null, health: { Status: status, FailingStreak: streak, Log: todas.filter((e) => Date.parse(e.Start.replace(/(\.\d{3})\d+/, "$1")) <= base + t * 1000).slice(-5) } });
const amostras: Amostra[] = [
  consulta(10, "starting", 0), consulta(40, "healthy", 0), consulta(100, "healthy", 1), consulta(130, "healthy", 2),
  consulta(160, "healthy", 0), consulta(200, "healthy", 0), consulta(250, "healthy", 0),
];

// 1. Datas do Docker com nanossegundos e com fuso.
confere("data com nanossegundos → epoch ms", paraEpochMs("2026-11-07T16:00:30.123456789Z"), Date.parse("2026-11-07T16:00:30.123Z"));
confere("data com fuso -03:00", paraEpochMs("2026-11-07T13:00:30.5-03:00"), Date.parse("2026-11-07T16:00:30.500Z"));

// 2. União sem duplicar, mesmo com o histórico limitado a 5 por consulta.
const unidas = unirExecucoes(amostras);
confere("8 execuções reconstruídas a partir de consultas com só 5 entradas", unidas.length, 8);
confere("ordem por início e durações", unidas.map((e) => e.duracaoMs), [410, 395, 5003, 820, 402, 390, 405, 399]);
confere("sucesso / falha / prazo excedido", unidas.map((e) => [e.sucesso, e.prazoExcedido]), [[true, false], [true, false], [false, true], [false, false], [true, false], [true, false], [true, false], [true, false]]);

// 3. Estados starting / healthy / unhealthy.
const comUnhealthy: Amostra[] = [...amostras, { t: base + 300_000, running: true, exitCode: null, finishedAt: null, health: { Status: "unhealthy", FailingStreak: 3, Log: todas.slice(-5) } }];
confere("transições de status", transicoesDeStatus(comUnhealthy).map((x) => x.status), ["starting", "healthy", "unhealthy"]);

// 4. Consolidação: contagens, status final, failing streak.
const c = consolidar(comUnhealthy);
if (!c.habilitado || !("execucoes" in c)) throw new Error("consolidação deveria estar habilitada");
confere("contagens (execuções, sucessos, falhas, prazo excedido)", [c.execucoes, c.sucessos, c.falhas, c.prazoExcedido], [8, 6, 2, 1]);
confere("status e failing streak operacionais finais/máximo", [c.estadoOperacional.status, c.estadoOperacional.failingStreak, c.estadoOperacional.failingStreakMax], ["unhealthy", 3, 3]);
confere("durações min/mediana/max", c.duracaoMs, { min: 390, mediana: 405, max: 5003 });
confere("lacuna entre amostras < 150 s → histórico completo", c.historicoPodeEstarIncompleto, false);

// 5. Lacuna grande entre consultas → histórico pode ter perdido entradas.
const esparsas = [consulta(10, "starting", 0), consulta(250, "healthy", 0)];
const ce = consolidar(esparsas);
confere("lacuna ≥ 150 s sinalizada", "historicoPodeEstarIncompleto" in ce ? ce.historicoPodeEstarIncompleto : null, true);
confere("com lacuna, só as 5 últimas são recuperáveis", "execucoes" in ce ? ce.execucoes : null, 5);

// 6. Correlação com o /proc: observada, não observada, fora de janela.
const janelas = [
  { rotulo: "repouso", inicio: base + 25_000, fim: base + 100_000, healthcheckDocker: { execucoes: [{ iniciouMsAposJanela: 5_050, vivoMs: 300, picoRssMiB: 31.2 }] } },
  { rotulo: "validação", inicio: base + 140_000, fim: base + 200_000, healthcheckDocker: { execucoes: [] } },
];
const cc = consolidar(amostras, janelas);
const detalhesCc = cc.detalhes;
if (!detalhesCc) throw new Error("detalhes ausentes");
confere("classificação por execução", detalhesCc.map((d) => d.classificacao), ["observada_no_proc", "nao_observada_no_proc", "nao_observada_no_proc", "fora_de_janela_de_medicao", "nao_observada_no_proc", "nao_observada_no_proc", "fora_de_janela_de_medicao", "fora_de_janela_de_medicao"]);
confere("RSS do /proc só na observada", detalhesCc.map((d) => d.picoRssProcMiB), [31.2, null, null, null, null, null, null, null]);
confere("resumo da correlação", cc.correlacaoProc, { observadas: 1, naoObservadas: 4, foraDeJanela: 3 });

// 7. HEALTHCHECK desabilitado (modo sem_healthcheck: .State.Health = null).
const emExecucaoSemHealth = (t: number): Amostra => ({ t, running: true, exitCode: null, finishedAt: null, health: null });
const desabilitado = consolidar([emExecucaoSemHealth(base), emExecucaoSemHealth(base + 10_000)]);
confere("desabilitado → habilitado=false", desabilitado.habilitado, false);

// 8. NDJSON com linhas inválidas.
const lido = lerAmostras(`{"t":1,"health":null}\nlixo\n\n{"t":2,"health":{"Status":"starting","FailingStreak":0,"Log":[]}}\n{"sem":"t"}\n`);
confere("NDJSON: 2 válidas, 2 inválidas", [lido.amostras.length, lido.linhasInvalidas], [2, 2]);

// 9. Fase 60.4.3.4.8 — integridade: falha de leitura NUNCA vira "desabilitado"; lacuna só sobre leituras válidas.
const integra = consolidar(amostras, [], { esperado: "habilitado" });
confere("histórico íntegro e esperado habilitado → integridade ok", [integra.integridade.ok, integra.integridade.problemas], [true, []]);
const soErros = consolidar([{ t: base, health: null, erro: "docker inspect falhou" }, { t: base + 2_000, health: null, erro: "docker inspect falhou" }], [], { esperado: "habilitado" });
confere("só falhas de leitura → não é 'desabilitado' válido; integridade falha", [soErros.habilitado, soErros.integridade.ok, soErros.integridade.leiturasValidas, soErros.integridade.errosDeLeitura], [false, false, 0, 2]);
confere("problemas registrados para leituras com erro", soErros.integridade.problemas, ["2 leitura(s) do docker inspect falharam", "nenhuma leitura válida do estado de saúde"]);
const comBuraco = consolidar([consulta(10, "starting", 0), ...Array.from({ length: 20 }, (_, i) => ({ t: base + (20 + i * 10) * 1000, health: null, erro: "docker inspect falhou" })), consulta(250, "healthy", 0)], [], { esperado: "habilitado" });
confere("lacuna medida só entre leituras válidas (erros no meio não 'fecham' o buraco)", "maiorLacunaEntreAmostrasMs" in comBuraco ? [comBuraco.maiorLacunaEntreAmostrasMs, comBuraco.historicoPodeEstarIncompleto, comBuraco.integridade.ok] : null, [240_000, true, false]);
const errado = consolidar([emExecucaoSemHealth(base), emExecucaoSemHealth(base + 10_000)], [], { esperado: "habilitado" });
confere("modo com_healthcheck mas estado desabilitado → integridade falha", [errado.habilitado, errado.integridade.ok, errado.integridade.problemas], [false, false, ["estado desabilitado diferente do esperado (habilitado)"]]);
const semHcOk = consolidar([emExecucaoSemHealth(base), emExecucaoSemHealth(base + 10_000)], [], { esperado: "desabilitado" });
confere("modo sem_healthcheck com estado desabilitado → integridade ok", [semHcOk.habilitado, semHcOk.integridade.ok], [false, true]);
const comLixo = consolidar(amostras, [], { esperado: "habilitado", linhasInvalidas: 1 });
confere("linha ilegível no NDJSON → integridade falha", [comLixo.integridade.ok, comLixo.integridade.problemas], [false, ["1 linha(s) ilegível(is) no NDJSON"]]);
const semResultado = consolidar(amostras, [], { esperado: "habilitado", resultadoHarnessLido: false });
confere("resultado.json exigido e não lido → integridade falha", semResultado.integridade.ok, false);

// 10. Fase 60.4.3.4.9 — habilitado (Status starting) mas o Docker nunca executou o HEALTHCHECK → integridade reprova.
const iniciando = (t: number): Amostra => ({ t, running: true, exitCode: null, finishedAt: null, health: { Status: "starting", FailingStreak: 0, Log: [] } });
const nunca = consolidar([iniciando(base), iniciando(base + 10_000)], [], { esperado: "habilitado" });
confere("habilitado sem nenhuma execução → integridade falha", [nunca.habilitado, nunca.integridade.ok, nunca.integridade.problemas], [true, false, ["HEALTHCHECK habilitado sem nenhuma execução registrada pelo Docker"]]);

// ---------------------------------------------------------------------------------------------------------------
// 11. Fase 60.4.3.4.9.15 (R06) — separação entre estado operacional, estado após a parada e estado do contêiner.
// As leituras são escritas como LINHAS NDJSON no formato exato do workflow e lidas por lerAmostras (contrato
// produtor → consumidor): em execução `exitCode`/`finishedAt` são null; parado, trazem o código e o FinishedAt.
// ---------------------------------------------------------------------------------------------------------------
const saude = (status: string, streak: number, log: EntradaDocker[]): SaudeDocker => ({ Status: status, FailingStreak: streak, Log: log });
const finishedAt = (s: number) => iso(base + s * 1000 - 300, "987654");
const emExecucao = (s: number, health: SaudeDocker | null) => JSON.stringify({ t: base + s * 1000, running: true, exitCode: null, finishedAt: null, health });
const parado = (s: number, health: SaudeDocker | null, codigo = 0) => JSON.stringify({ t: base + s * 1000, running: false, exitCode: codigo, finishedAt: finishedAt(s), health });
const erroLeitura = (s: number) => JSON.stringify({ t: base + s * 1000, health: null, erro: "docker inspect falhou" });
const deNdjson = (linhas: string[], esperado: Esperado = "habilitado") => {
  const { amostras: lidas, linhasInvalidas } = lerAmostras(`${linhas.join("\n")}\n`);
  return consolidar(lidas, [], { linhasInvalidas, esperado });
};
/** Os três blocos em forma compacta: [status, failingStreak] operacional · [status, amostras] após parada · contêiner. */
const blocos = (r: ReturnType<typeof consolidar>) => ({
  operacional: [r.estadoOperacional.status, r.estadoOperacional.failingStreak],
  aposParada: [r.estadoAposParada.status, r.estadoAposParada.amostras],
  container: [r.container.runningFinal, r.container.exitCode, r.container.encerramento],
});
const ok5 = execucao(5, 400, 0), ok35 = execucao(35, 400, 0), falha5 = execucao(5, 700, 1);

// T01 — running=true, healthy → contêiner parado → running=false, unhealthy (sequência real da execução 42405592796).
const t01 = deNdjson([emExecucao(10, saude("healthy", 0, [ok5])), emExecucao(40, saude("healthy", 0, [ok5, ok35])), parado(42, saude("unhealthy", 0, [ok5, ok35]))]);
confere("T01 healthy em execução → parada → unhealthy: três blocos separados", blocos(t01), { operacional: ["healthy", 0], aposParada: ["unhealthy", 1], container: [false, 0, "normal"] });
confere("T01 última amostra operacional é a de t=40 s (a pós-parada não a substitui)", t01.estadoOperacional.ultimaAmostraOperacional, { t: base + 40_000, running: true, status: "healthy", failingStreak: 0 });
confere("T01 transições operacionais não incluem o 'unhealthy' pós-parada", t01.estadoOperacional.transicoesDeStatus.map((x) => x.status), ["healthy"]);
confere("T01 estado após a parada preservado; finishedAt do contêiner; integridade ok; execuções do Log pós-parada contadas", [t01.estadoAposParada.ultimaAmostraObservada, t01.container.finishedAt, t01.integridade.ok, "execucoes" in t01 ? t01.execucoes : null], [{ t: base + 42_000, running: false, status: "unhealthy", failingStreak: 0 }, finishedAt(42), true, 2]);
confere("T01 consolidado não tem mais statusFinal / failingStreakFinal", ["statusFinal" in t01, "failingStreakFinal" in t01], [false, false]);

// T02 — running=true, unhealthy → parada: o operacional continua unhealthy (agora por leitura em execução, não por acaso).
const t02 = deNdjson([emExecucao(10, saude("unhealthy", 3, [falha5])), parado(12, saude("unhealthy", 3, [falha5]))]);
confere("T02 unhealthy em execução → parada", blocos(t02), { operacional: ["unhealthy", 3], aposParada: ["unhealthy", 1], container: [false, 0, "normal"] });

// T03 — healthy → falha de inspect → healthy: a falha não vira 'parado' nem sobrescreve o estado; a integridade a registra.
const t03 = deNdjson([emExecucao(10, saude("healthy", 0, [ok5])), erroLeitura(12), emExecucao(14, saude("healthy", 0, [ok5]))]);
confere("T03 falha de leitura não sobrescreve o operacional nem conta como parada", blocos(t03), { operacional: ["healthy", 0], aposParada: [null, 0], container: [true, null, "nao_observado"] });
confere("T03 falha de leitura reprova a integridade (não vira sucesso)", [t03.integridade.ok, t03.integridade.errosDeLeitura, t03.integridade.problemas], [false, 1, ["1 leitura(s) do docker inspect falharam"]]);

// T04 — unhealthy → healthy, ambos em execução.
const t04 = deNdjson([emExecucao(10, saude("unhealthy", 3, [falha5])), emExecucao(40, saude("healthy", 0, [falha5, ok35]))]);
confere("T04 unhealthy → healthy em execução: operacional final healthy", blocos(t04), { operacional: ["healthy", 0], aposParada: [null, 0], container: [true, null, "nao_observado"] });
confere("T04 transições e failing streak máximo só das operacionais", [t04.estadoOperacional.transicoesDeStatus.map((x) => x.status), t04.estadoOperacional.failingStreakMax], [["unhealthy", "healthy"], 3]);

// T05 — só amostras pós-parada: não existe estado operacional válido → integridade reprova.
const t05 = deNdjson([parado(10, saude("unhealthy", 0, [ok5])), parado(12, saude("unhealthy", 0, [ok5]))]);
confere("T05 só pós-parada: sem estado operacional; após parada preservado", [blocos(t05), t05.estadoOperacional.ultimaAmostraOperacional], [{ operacional: [null, null], aposParada: ["unhealthy", 2], container: [false, 0, "normal"] }, null]);
confere("T05 ausência de amostra operacional reprova a integridade", [t05.integridade.ok, t05.integridade.problemas], [false, ["nenhuma amostra operacional (running=true) válida"]]);

// T06 — HEALTHCHECK desabilitado COMPROVADO: leituras em execução com health:null (sem nenhuma falha de leitura).
const t06 = deNdjson([emExecucao(10, null), emExecucao(20, null), parado(22, null)], "desabilitado");
confere("T06 desabilitado comprovado por leituras em execução", [t06.habilitado, t06.integridade.ok, blocos(t06), t06.estadoOperacional.ultimaAmostraOperacional], [false, true, { operacional: [null, null], aposParada: [null, 1], container: [false, 0, "normal"] }, { t: base + 20_000, running: true, status: null, failingStreak: null }]);
// T06b — só falhas de inspect e uma leitura pós-parada com health:null: "desabilitado" NÃO está comprovado.
const t06b = deNdjson([erroLeitura(10), erroLeitura(12), parado(14, null)], "desabilitado");
confere("T06b falhas de inspect + só pós-parada: desabilitado não comprovado, integridade falha", [t06b.habilitado, t06b.integridade.ok, t06b.integridade.problemas], [false, false, ["2 leitura(s) do docker inspect falharam", "nenhuma amostra operacional (running=true) válida"]]);

// T07 — falha isolada seguida de sucesso: o failing streak operacional volta a zero; o máximo registra a falha.
const t07 = deNdjson([emExecucao(10, saude("healthy", 1, [falha5])), emExecucao(40, saude("healthy", 0, [falha5, ok35]))]);
confere("T07 failing streak operacional final 0, máximo 1", [t07.estadoOperacional.failingStreak, t07.estadoOperacional.failingStreakMax, t07.integridade.ok], [0, 1, true]);

// T08 — mais de 5 execuções reconstruídas de leituras com Log limitado a 5: deduplicação por Start e ordem cronológica.
const historico = Array.from({ length: 8 }, (_, i) => execucao(30 + i * 30, 400 + i, 0));
const linhasT08 = historico.map((_, i) => emExecucao(40 + i * 30, saude("healthy", 0, historico.slice(0, i + 1).slice(-5))));
const t08 = deNdjson(linhasT08);
const inicios = (t08.detalhes ?? []).map((d) => d.inicio);
confere("T08 8 execuções a partir de 30 entradas de Log (deduplicação por Start), em ordem cronológica", ["execucoes" in t08 ? t08.execucoes : null, new Set(inicios).size, inicios.every((v, i) => i === 0 || v > inicios[i - 1]!)], [8, 8, true]);
// T08b — as mesmas leituras fora de ordem: o resultado não depende da ordem das linhas.
const t08b = deNdjson([...linhasT08].reverse());
confere("T08b leituras fora de ordem: mesmas execuções e mesma última amostra operacional", ["execucoes" in t08b ? t08b.execucoes : null, t08b.estadoOperacional.ultimaAmostraOperacional?.t], [8, base + (40 + 7 * 30) * 1000]);

// T09 — contêiner encerra com ExitCode=0: o encerramento é do CONTÊINER, separado do HEALTHCHECK.
const t09 = deNdjson([emExecucao(10, saude("healthy", 0, [ok5])), parado(12, saude("unhealthy", 0, [ok5]), 0)]);
confere("T09 ExitCode 0: encerramento normal, operacional healthy, após parada unhealthy", [blocos(t09), t09.integridade.ok], [{ operacional: ["healthy", 0], aposParada: ["unhealthy", 1], container: [false, 0, "normal"] }, true]);

// T10 — contêiner encerra com ExitCode≠0: falha de PROCESSO preservada, sem contaminar o estado operacional do HEALTHCHECK
// (a reprovação do modo pelo código de saída continua sendo do workflow: codigo_saida_harness).
const t10 = deNdjson([emExecucao(10, saude("healthy", 0, [ok5])), parado(12, saude("unhealthy", 0, [ok5]), 137)]);
confere("T10 ExitCode 137: encerramento com_erro preservado; operacional healthy; integridade do HEALTHCHECK não reprova por isso", [blocos(t10), t10.integridade.ok], [{ operacional: ["healthy", 0], aposParada: ["unhealthy", 1], container: [false, 137, "com_erro"] }, true]);

// TR — regressão com a forma exata da execução real 42405592796 (cenário B): Log com 5 sucessos, `healthy` até a parada
// e, 498 ms depois do FinishedAt, `unhealthy` com FailingStreak 0 e o mesmo Log.
const logReal = [47.615212742, 78.014432637, 108.613391497, 139.413829113, 171.113783113].map((s) => ({ Start: iso(base + Math.floor(s * 1000), "212742"), End: iso(base + Math.floor(s * 1000) + 400, "212742"), ExitCode: 0, Output: "" }));
const tr = deNdjson([emExecucao(170, saude("healthy", 0, logReal.slice(0, 4))), emExecucao(173.5, saude("healthy", 0, logReal)), JSON.stringify({ t: base + 176_321, running: false, exitCode: 0, finishedAt: iso(base + 175_823, "605413"), health: saude("unhealthy", 0, logReal) })]);
confere("TR sequência real 42405592796: operacional healthy, após parada unhealthy, 5 execuções, integridade ok", [blocos(tr), "execucoes" in tr ? tr.execucoes : null, tr.integridade.ok], [{ operacional: ["healthy", 0], aposParada: ["unhealthy", 1], container: [false, 0, "normal"] }, 5, true]);

// L01 — NDJSON no formato ANTIGO (sem running): o estado operacional é indeterminável → integridade reprova, sem adivinhar.
const l01 = deNdjson([JSON.stringify({ t: base + 10_000, health: saude("healthy", 0, [ok5]) })]);
confere("L01 leitura válida sem running: estado operacional indeterminável, integridade falha", [l01.integridade.ok, l01.integridade.problemas, l01.estadoOperacional.ultimaAmostraOperacional], [false, ["1 leitura(s) válida(s) sem o campo running: estado operacional indeterminável", "nenhuma amostra operacional (running=true) válida"], null]);

// P — contrato do NDJSON: tipos errados invalidam a linha (nunca viram 'desabilitado', 'parado' ou sucesso).
const p = lerAmostras([
  `{"t":1,"running":"true","exitCode":null,"finishedAt":null,"health":null}`,
  `{"t":2,"running":true,"exitCode":null,"finishedAt":null,"health":"healthy"}`,
  `{"t":3,"running":false,"exitCode":"0","finishedAt":"2026-11-07T16:00:00Z","health":null}`,
  `{"t":4,"running":false,"exitCode":0,"finishedAt":5,"health":null}`,
  `{"t":5,"running":true,"exitCode":null,"finishedAt":null,"health":{"Status":"healthy","FailingStreak":"0","Log":[]}}`,
  `{"t":6,"running":true,"exitCode":null,"finishedAt":null}`,
  `{"t":7,"running":true,"exitCode":null,"finishedAt":null,"health":{"Status":"healthy","FailingStreak":0,"Log":[{"Start":"2026-11-07T16:00:05.1Z","End":"2026-11-07T16:00:05.5Z","ExitCode":0,"Output":"a|b"}]}}`,
  `{"t":8,"running":false,"exitCode":137,"finishedAt":"2026-11-07T16:00:09.123456789Z","health":null}`,
  `{"t":9,"health":null,"erro":"docker inspect falhou"}`,
].join("\n"));
confere("P tipos errados (running texto, health texto, exitCode texto, finishedAt número, FailingStreak texto, sem health) → 6 linhas inválidas", [p.amostras.length, p.linhasInvalidas], [3, 6]);
confere("P linhas válidas preservam running/exitCode/finishedAt; erro de leitura sem running", p.amostras.map((a) => [a.t, a.running ?? null, a.exitCode ?? null, a.finishedAt ?? null, a.erro ?? null]), [[7, true, null, null, null], [8, false, 137, "2026-11-07T16:00:09.123456789Z", null], [9, null, null, null, "docker inspect falhou"]]);

console.log(falhas ? `\n${falhas} verificação(ões) FALHARAM` : "\nTodas as verificações passaram.");
process.exit(falhas ? 1 : 0);
