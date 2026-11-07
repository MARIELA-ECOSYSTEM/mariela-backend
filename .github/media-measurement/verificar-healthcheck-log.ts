// Fase 60.4.3.4.7 — verificação de healthcheck-log.ts com amostras no formato REAL do `docker inspect --format
// '{{json .State.Health}}'` (datas com nanossegundos, saída -1 em prazo excedido). Não usa o padrão *.test.ts de
// propósito (o `bun test` do CI não o coleta). Uso: bun --no-env-file verificar-healthcheck-log.ts — sai com código 1
// na primeira divergência. O workflow executa esta verificação antes das medições.
import { consolidar, lerAmostras, paraEpochMs, transicoesDeStatus, unirExecucoes, type Amostra, type EntradaDocker } from "./healthcheck-log.ts";

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
const consulta = (t: number, status: string, streak: number): Amostra => ({ t: base + t * 1000, health: { Status: status, FailingStreak: streak, Log: todas.filter((e) => Date.parse(e.Start.replace(/(\.\d{3})\d+/, "$1")) <= base + t * 1000).slice(-5) } });
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
const comUnhealthy = [...amostras, { t: base + 300_000, health: { Status: "unhealthy", FailingStreak: 3, Log: todas.slice(-5) } }];
confere("transições de status", transicoesDeStatus(comUnhealthy).map((x) => x.status), ["starting", "healthy", "unhealthy"]);

// 4. Consolidação: contagens, status final, failing streak.
const c = consolidar(comUnhealthy);
if (!c.habilitado || !("execucoes" in c)) throw new Error("consolidação deveria estar habilitada");
confere("contagens (execuções, sucessos, falhas, prazo excedido)", [c.execucoes, c.sucessos, c.falhas, c.prazoExcedido], [8, 6, 2, 1]);
confere("status e failing streak finais/máximo", [c.statusFinal, c.failingStreakFinal, c.failingStreakMax], ["unhealthy", 3, 3]);
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
if (!("detalhes" in cc)) throw new Error("detalhes ausentes");
confere("classificação por execução", cc.detalhes.map((d) => d.classificacao), ["observada_no_proc", "nao_observada_no_proc", "nao_observada_no_proc", "fora_de_janela_de_medicao", "nao_observada_no_proc", "nao_observada_no_proc", "fora_de_janela_de_medicao", "fora_de_janela_de_medicao"]);
confere("RSS do /proc só na observada", cc.detalhes.map((d) => d.picoRssProcMiB), [31.2, null, null, null, null, null, null, null]);
confere("resumo da correlação", cc.correlacaoProc, { observadas: 1, naoObservadas: 4, foraDeJanela: 3 });

// 7. HEALTHCHECK desabilitado (modo sem_healthcheck: .State.Health = null).
const desabilitado = consolidar([{ t: base, health: null }, { t: base + 10_000, health: null }]);
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
const errado = consolidar([{ t: base, health: null }, { t: base + 10_000, health: null }], [], { esperado: "habilitado" });
confere("modo com_healthcheck mas estado desabilitado → integridade falha", [errado.habilitado, errado.integridade.ok, errado.integridade.problemas], [false, false, ["estado desabilitado diferente do esperado (habilitado)"]]);
const semHcOk = consolidar([{ t: base, health: null }, { t: base + 10_000, health: null }], [], { esperado: "desabilitado" });
confere("modo sem_healthcheck com estado desabilitado → integridade ok", [semHcOk.habilitado, semHcOk.integridade.ok], [false, true]);
const comLixo = consolidar(amostras, [], { esperado: "habilitado", linhasInvalidas: 1 });
confere("linha ilegível no NDJSON → integridade falha", [comLixo.integridade.ok, comLixo.integridade.problemas], [false, ["1 linha(s) ilegível(is) no NDJSON"]]);
const semResultado = consolidar(amostras, [], { esperado: "habilitado", resultadoHarnessLido: false });
confere("resultado.json exigido e não lido → integridade falha", semResultado.integridade.ok, false);

// 10. Fase 60.4.3.4.9 — habilitado (Status starting) mas o Docker nunca executou o HEALTHCHECK → integridade reprova.
const nunca = consolidar([{ t: base, health: { Status: "starting", FailingStreak: 0, Log: [] } }, { t: base + 10_000, health: { Status: "starting", FailingStreak: 0, Log: [] } }], [], { esperado: "habilitado" });
confere("habilitado sem nenhuma execução → integridade falha", [nunca.habilitado, nunca.integridade.ok, nunca.integridade.problemas], [true, false, ["HEALTHCHECK habilitado sem nenhuma execução registrada pelo Docker"]]);

console.log(falhas ? `\n${falhas} verificação(ões) FALHARAM` : "\nTodas as verificações passaram.");
process.exit(falhas ? 1 : 0);
