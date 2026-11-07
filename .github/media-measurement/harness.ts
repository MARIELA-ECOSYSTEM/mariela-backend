// Fase 60.4.3.4.4 — harness de medição operacional DENTRO da imagem de produção (montado em /app/medicao).
//
// Sobe a MESMA API do `dist/` (AppModule + a configuração do `main.ts`: trust proxy, helmet, CORS, prefixo, pipes,
// filtro, interceptor, logger estruturado) e executa os cenários 2–6 da fase por HTTP real. O R2 é substituído por um
// storage EM MEMÓRIA trocando os métodos da INSTÂNCIA do provider (nenhum arquivo do projeto é alterado; nenhuma
// chamada de rede ao R2). Mede pelo cgroup v2 do contêiner (memory.current/peak/events, cpu.stat) e pelo /proc
// (RSS da API e de cada subprocesso validador). Sem segredos: o ambiente é fictício (definido no workflow).
//
// Variáveis: MEDICAO_DIST (/app/dist), MEDICAO_ARQUIVOS (/saida/arquivos), MEDICAO_SAIDA (/saida),
// MEDICAO_SONDA (/saida/sonda.ndjson), PORT (3000), MEDICAO_REPOUSO_MS (10000), MEDICAO_MODO (rótulo do cenário de
// HEALTHCHECK, Fase 60.4.3.4.5). O harness NÃO liga nem desliga o HEALTHCHECK: isso é do `docker run` do workflow.
import "reflect-metadata";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import helmet from "helmet";

const DIST = process.env["MEDICAO_DIST"] ?? "/app/dist";
const ARQUIVOS = process.env["MEDICAO_ARQUIVOS"] ?? "/saida/arquivos";
const SAIDA = process.env["MEDICAO_SAIDA"] ?? "/saida";
const SONDA = process.env["MEDICAO_SONDA"] ?? join(SAIDA, "sonda.ndjson");
const PORTA = Number(process.env["PORT"] ?? 3000);
const REPOUSO_MS = Number(process.env["MEDICAO_REPOUSO_MS"] ?? 10_000);
const MODO = process.env["MEDICAO_MODO"] ?? "nao-informado";
const FALSOS = fileURLToPath(new URL("./falsos/", import.meta.url));
const log = (objeto: unknown) => console.log(`[medicao] ${JSON.stringify(objeto)}`);

const dist = (relativo: string) => import(join(DIST, relativo));
const { AppModule } = await dist("app.module.js");
const { HttpExceptionFilter } = await dist("common/filters/http-exception.filter.js");
const { ResponseInterceptor } = await dist("common/interceptors/response.interceptor.js");
const { StructuredLoggerService } = await dist("common/logger/structured-logger.service.js");
const { validationExceptionFactory } = await dist("common/pipes/validation-exception-factory.js");
const { montarOpcoesCors } = await dist("config/cors.config.js");
const { MEDIA_STORAGE } = await dist("modules/media/media.constants.js");
const { CONCORRENCIA_VALIDACAO_MIDIA, PRAZO_VALIDACAO_MIDIA_MS } = await dist("modules/media/validacao/validacao-midia.constants.js");
const { ValidadorMidiaService } = await dist("modules/media/validacao/validador-midia.service.js");
const { AuthService } = await dist("modules/auth/auth.service.js");
const { ConfiguracoesService } = await dist("modules/configuracoes/configuracoes.service.js");
const { ProdutosService } = await dist("modules/produtos/produtos.service.js");

// ---------------- coleta: cgroup v2 + /proc ----------------
const CG = "/sys/fs/cgroup";
const temCgroup = existsSync(`${CG}/memory.current`);
const ler = (caminho: string): string | null => {
  try {
    return readFileSync(caminho, "utf8");
  } catch {
    return null;
  }
};
const MiB = (bytes: number) => +(bytes / 1048576).toFixed(1);
const memoriaContainer = () => (temCgroup ? Number(ler(`${CG}/memory.current`) ?? NaN) : NaN);
const picoContainer = () => (temCgroup ? Number(ler(`${CG}/memory.peak`) ?? NaN) : NaN);
const chaveValor = (texto: string | null) => Object.fromEntries((texto ?? "").trim().split("\n").filter(Boolean).map((linha) => { const [k, v] = linha.split(/\s+/); return [k, Number(v)]; }));
const eventosMemoria = () => chaveValor(ler(`${CG}/memory.events`));
const cpuUsec = () => chaveValor(ler(`${CG}/cpu.stat`))["usage_usec"] ?? NaN;
const statMemoria = () => { const s = chaveValor(ler(`${CG}/memory.stat`)); return { anonMiB: MiB(s["anon"] ?? NaN), fileMiB: MiB(s["file"] ?? NaN), shmemMiB: MiB(s["shmem"] ?? NaN) }; };
function statusKb(pid: number | "self"): { rssKb: number; hwmKb: number } | null {
  const texto = ler(`/proc/${pid}/status`);
  if (!texto) return null;
  const campo = (nome: string) => Number(new RegExp(`${nome}:\\s+(\\d+)`).exec(texto)?.[1] ?? NaN);
  return { rssKb: campo("VmRSS"), hwmKb: campo("VmHWM") };
}
const temProc = existsSync("/proc/self/status");
type Processo = { pid: number; rssKb: number; hwmKb: number; cmd: string };
/**
 * Uma varredura do /proc por amostra: subprocessos do VALIDADOR e processos do Docker HEALTHCHECK da imagem
 * (Fase 60.4.3.4.5 — `bun -e "fetch('http://127.0.0.1:'+…/health')…"`, executado pelo daemon dentro do contêiner).
 */
function varrerProcessos(): { validadores: Processo[]; healthchecks: Processo[] } {
  const validadores: Processo[] = [], healthchecks: Processo[] = [];
  if (!temProc) return { validadores, healthchecks };
  for (const nome of readdirSync("/proc")) {
    if (!/^\d+$/.test(nome) || Number(nome) === process.pid) continue;
    const cmd = (ler(`/proc/${nome}/cmdline`) ?? "").replaceAll("\0", " ");
    const ehValidador = /validador-midia\.processo|\/falsos\//.test(cmd);
    // O HEALTHCHECK do Dockerfile é forma shell: `/bin/sh -c 'bun -e …'`. Conta só o processo do `bun` (argv[0]),
    // não o `sh` que o envolve (que também traz o texto do fetch na linha de comando).
    const ehHealthcheck = !ehValidador && cmd.includes("fetch('http://127.0.0.1:'") && /(^|\/)bun$/.test(cmd.split(" ")[0] ?? "");
    if (!ehValidador && !ehHealthcheck) continue;
    const st = statusKb(Number(nome));
    if (!st) continue;
    (ehValidador ? validadores : healthchecks).push({ pid: Number(nome), ...st, cmd: cmd.trim().split(" ").slice(-2).join(" ") });
  }
  return { validadores, healthchecks };
}

// ---------------- API (igual ao main.ts) ----------------
const app = await NestFactory.create(AppModule, { logger: new StructuredLoggerService() });
app.set("trust proxy", 1);
const configService = app.get(ConfigService);
const { apiPrefix } = configService.get("app");
const { origins } = configService.get("cors");
app.use(helmet());
app.enableCors(montarOpcoesCors(origins));
app.setGlobalPrefix(apiPrefix, { exclude: ["health", "docs"] });
app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, exceptionFactory: validationExceptionFactory }));
app.useGlobalFilters(new HttpExceptionFilter());
app.useGlobalInterceptors(new ResponseInterceptor());
await app.init();
app.enableShutdownHooks();
await app.listen(PORTA);
const BASE = `http://127.0.0.1:${PORTA}`;

// Storage em memória NA INSTÂNCIA do provider (o R2 nunca é chamado). `lerObjeto` devolve o MESMO buffer (sem cópia),
// como o R2 entregaria um único buffer baixado; o objeto é descartado após cada cenário.
type Objeto = { bytes: Uint8Array; contentType: string; etag: string };
const objetos = new Map<string, Objeto>();
const storage = app.get(MEDIA_STORAGE);
let versao = 0;
storage.inspecionarObjeto = async (chave: string) => { const o = objetos.get(chave); return o ? { existe: true, tamanho: o.bytes.length, contentType: o.contentType, etag: o.etag } : { existe: false }; };
storage.lerPrimeirosBytes = async (chave: string, n: number) => objetos.get(chave)?.bytes.subarray(0, n) ?? null;
storage.lerObjeto = async (chave: string, opcoes: { tamanhoMaximo: number; ifMatch?: string }) => {
  const o = objetos.get(chave);
  if (!o) return { estado: "ausente" };
  if ((opcoes.ifMatch !== undefined && opcoes.ifMatch !== o.etag) || o.bytes.length > opcoes.tamanhoMaximo) return { estado: "alterado" };
  return { estado: "lido", bytes: o.bytes };
};
storage.excluirObjeto = async (chave: string) => { objetos.delete(chave); };
let ultimaChave = "";
const assinarOriginal = storage.assinarUpload.bind(storage);
storage.assinarUpload = async (params: { key: string }) => { ultimaChave = params.key; return assinarOriginal(params); };

const validador = app.get(ValidadorMidiaService);
const opcoesValidador: { script: string | null; prazoMs: number; concorrencia: number } = Reflect.get(validador, "opcoes");
log({ etapa: "api-pronta", concorrenciaConstante: CONCORRENCIA_VALIDACAO_MIDIA, prazoConstanteMs: PRAZO_VALIDACAO_MIDIA_MS, opcoesEfetivas: opcoesValidador, cgroup: temCgroup, proc: temProc });

// Usuário e categoria de MEDIÇÃO (banco descartável do workflow).
const auth = app.get(AuthService);
const email = `medicao.${Date.now()}@medicao.invalid`;
await auth.criarAdminSeed({ nome: "Medicao Docker", email, senha: "senha-de-medicao-123" });
const token = (await auth.login({ usuario: email, senha: "senha-de-medicao-123" }, { ip: null, userAgent: null })).accessToken;
try { await app.get(ConfiguracoesService).adicionarItem("categorias", "Medicao", null); } catch { /* já existe */ }
const produtos = app.get(ProdutosService);
let nProduto = 0;
const novoProduto = async () => (await produtos.criar({ nome: `Medicao ${++nProduto}`, categoria: "Medicao", precoCusto: 1, precoVenda: 2, ehNovidade: false }, null)).id;

const http = async (metodo: string, caminho: string, corpo?: unknown) => {
  const r = await fetch(`${BASE}/${apiPrefix}${caminho}`, { method: metodo, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
  const json = await r.json() as { data?: { uploadId?: string }; code?: string };
  return { status: r.status, json };
};
const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "video/mp4": "mp4" };
const MIME: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", mp4: "video/mp4" };
const arquivo = (nome: string) => ({ mime: MIME[nome.split(".").pop()!]!, bytes: new Uint8Array(readFileSync(join(ARQUIVOS, nome))) });
/** Solicita e simula o PUT; devolve a função que confirma (para disparar em paralelo). */
async function preparar(nome: string) {
  const { mime, bytes } = arquivo(nome);
  const produtoId = await novoProduto();
  const s = await http("POST", `/produtos/${produtoId}/midias/uploads`, { fileName: `a.${EXT[mime]}`, contentType: mime, kind: mime.startsWith("video") ? "video" : "image", size: bytes.length });
  if (s.status !== 200 || !s.json.data?.uploadId) throw new Error(`solicitação ${s.status} ${JSON.stringify(s.json)}`);
  objetos.set(ultimaChave, { bytes, contentType: mime, etag: `"medicao-${++versao}"` });
  const uploadId = s.json.data.uploadId;
  return async () => {
    const inicio = Date.now();
    const r = await http("POST", `/produtos/${produtoId}/midias/uploads/${uploadId}/confirmacao`, {});
    return { arquivo: nome, status: r.status, code: r.json.code ?? null, inicio, fim: Date.now(), ms: Date.now() - inicio };
  };
}

// ---------------- janelas de medição ----------------
type Filho = { pid: number; primeiroVisto: number; ultimoVisto: number; hwmMaxKb: number; rssMaxKb: number; cmd: string };
interface Janela { rotulo: string; inicio: number; fim: number; [k: string]: unknown }
const janelas: Janela[] = [];
async function janela(rotulo: string, acao: () => Promise<unknown>): Promise<Janela> {
  Bun.gc(true);
  await Bun.sleep(500);
  const ev0 = eventosMemoria(), cpu0 = cpuUsec(), memAntes = memoriaContainer(), apiAntes = statusKb("self");
  let memMax = memAntes, apiRssMaxKb = apiAntes?.rssKb ?? NaN, ativosMax = 0, emExecucaoMax = 0;
  const filhos = new Map<number, Filho>();
  const healthchecks = new Map<number, Filho>();
  let healthchecksAtivosMax = 0;
  const registrar = (mapa: Map<number, Filho>, f: Processo, agora: number) => {
    const atual = mapa.get(f.pid) ?? { pid: f.pid, primeiroVisto: agora, ultimoVisto: agora, hwmMaxKb: 0, rssMaxKb: 0, cmd: f.cmd };
    atual.ultimoVisto = agora; atual.hwmMaxKb = Math.max(atual.hwmMaxKb, f.hwmKb); atual.rssMaxKb = Math.max(atual.rssMaxKb, f.rssKb);
    mapa.set(f.pid, atual);
  };
  const amostrar = () => {
    const agora = Date.now();
    memMax = Math.max(memMax, memoriaContainer());
    const api = statusKb("self");
    if (api) apiRssMaxKb = Math.max(apiRssMaxKb, api.rssKb);
    const { validadores, healthchecks: hcs } = varrerProcessos();
    ativosMax = Math.max(ativosMax, validadores.length);
    healthchecksAtivosMax = Math.max(healthchecksAtivosMax, hcs.length);
    emExecucaoMax = Math.max(emExecucaoMax, validador.emExecucao);
    for (const f of validadores) registrar(filhos, f, agora);
    for (const f of hcs) registrar(healthchecks, f, agora);
  };
  const inicio = Date.now();
  const temporizador = setInterval(amostrar, 10);
  let resultado: unknown = null, erro: string | null = null;
  try { resultado = await acao(); } catch (e) { erro = e instanceof Error ? `${e.name}: ${e.message}` : String(e); }
  amostrar();
  const fim = Date.now();
  clearInterval(temporizador);
  Bun.gc(true);
  await Bun.sleep(300);
  const ev1 = eventosMemoria();
  const registro: Janela = {
    rotulo, inicio, fim, duracaoMs: fim - inicio,
    containerAntesMiB: MiB(memAntes), containerMaxAmostradoMiB: MiB(memMax), containerDepoisGcMiB: MiB(memoriaContainer()), containerPicoAcumuladoMiB: MiB(picoContainer()),
    apiRssAntesMiB: apiAntes ? MiB(apiAntes.rssKb * 1024) : null, apiRssMaxMiB: MiB(apiRssMaxKb * 1024), apiHwmMiB: MiB((statusKb("self")?.hwmKb ?? NaN) * 1024),
    subprocessosAtivosMax: ativosMax, emExecucaoMax,
    subprocessos: [...filhos.values()].sort((a, b) => a.primeiroVisto - b.primeiroVisto).map((f) => ({ pid: f.pid, iniciouMsAposJanela: f.primeiroVisto - inicio, vivoMs: f.ultimoVisto - f.primeiroVisto, picoRssMiB: MiB(f.hwmMaxKb * 1024), cmd: f.cmd })),
    healthcheckDocker: {
      execucoesVistas: healthchecks.size,
      ativosSimultaneosMax: healthchecksAtivosMax,
      picoRssMiB: healthchecks.size ? MiB(Math.max(...[...healthchecks.values()].map((f) => f.hwmMaxKb)) * 1024) : null,
      execucoes: [...healthchecks.values()].sort((a, b) => a.primeiroVisto - b.primeiroVisto).map((f) => ({ iniciouMsAposJanela: f.primeiroVisto - inicio, vivoMs: f.ultimoVisto - f.primeiroVisto, picoRssMiB: MiB(f.hwmMaxKb * 1024) })),
    },
    eventosMemoriaDelta: Object.fromEntries(Object.keys(ev1).map((k) => [k, (ev1[k] ?? 0) - (ev0[k] ?? 0)])),
    cpuMs: +(((cpuUsec() - cpu0) / 1000)).toFixed(0),
    memoriaStat: statMemoria(),
    resultado, erro,
  };
  for (const chave of objetos.keys()) objetos.delete(chave);
  janelas.push(registro);
  log(registro);
  return registro;
}

// ---------------- cenários ----------------
await Bun.sleep(10_000); // estabilização após o boot
// Fase 60.4.3.4.5 — repouso configurável (o workflow usa 75 s: ≥ 60 s e ao menos 2 execuções do HEALTHCHECK de 30 s).
await janela(`C1b API (harness) em repouso, ${REPOUSO_MS / 1000} s`, () => Bun.sleep(REPOUSO_MS));

for (const nome of ["webp-5000x5000.webp", "png-5000x5000.png"]) {
  const confirmar = await preparar(nome);
  await janela(`C2 uma validação pesada: ${nome}`, () => confirmar());
}
for (const nome of ["jpeg-4000x3000.jpg", "gif-200x150-100q.gif", "mp4-h264-30s-900amostras.mp4"]) {
  for (let rep = 1; rep <= 3; rep++) {
    const confirmar = await preparar(nome);
    await janela(`D duração: ${nome} #${rep}`, () => confirmar());
  }
}
{
  const seq: unknown[] = [];
  await janela("C3 três validações pesadas em sequência (WebP 25 MP ×3)", async () => {
    for (let i = 0; i < 3; i++) {
      const confirmar = await preparar("webp-5000x5000.webp");
      const r = await confirmar();
      Bun.gc(true);
      seq.push({ ...r, containerAposGcMiB: MiB(memoriaContainer()), apiRssMiB: MiB((statusKb("self")?.rssKb ?? NaN) * 1024) });
    }
    return seq;
  });
}
{
  const confirmacoes = await Promise.all(["webp-5000x5000.webp", "png-5000x5000.png", "jpeg-4000x3000.jpg"].map(preparar));
  await janela("C4 três confirmações simultâneas (WebP 25 MP + PNG 25 MP + JPEG 12 MP)", () => Promise.all(confirmacoes.map((c) => c())));
}
// C5 — falhas controladas. Cada uma é seguida de uma validação VÁLIDA para provar que a vaga foi liberada.
const comScript = async (rotulo: string, script: string | null, arquivoFalha: string) => {
  const falha = await preparar(arquivoFalha);
  const depois = await preparar("jpeg-4000x3000.jpg");
  await janela(rotulo, async () => {
    opcoesValidador.script = script;
    let r1;
    try { r1 = await falha(); } finally { opcoesValidador.script = null; }
    const r2 = await depois();
    return { falha: r1, validacaoSeguinte: r2, emExecucaoAoFinal: validador.emExecucao };
  });
};
await comScript("C5a arquivo inválido (N8) e depois uma válida", null, "invalido-n8.jpg");
await comScript("C5a' arquivo inválido (JPEG 12 MP truncado) e depois uma válida", null, "invalido-jpeg-truncado.jpg");
await comScript("C5b timeout (subprocesso travado, prazo REAL de 10 s) e depois uma válida", join(FALSOS, "travado.ts"), "jpeg-4000x3000.jpg");
await comScript("C5c erro interno do validador (código 3) e depois uma válida", join(FALSOS, "quebrado.ts"), "jpeg-4000x3000.jpg");
await comScript("C5d falha de inicialização (script inexistente) e depois uma válida", join(FALSOS, "nao-existe.ts"), "jpeg-4000x3000.jpg");
await janela("C1c API em repouso após todos os cenários, 10 s", () => Bun.sleep(10_000));

// ---------------- latência da sonda por janela ----------------
const sonda = (ler(SONDA) ?? "").trim().split("\n").filter(Boolean).map((linha) => JSON.parse(linha) as { t: number; ms: number; status: number });
const percentil = (v: number[], p: number) => (v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))]! : null);
const latencias = janelas.map((j) => {
  const dentro = sonda.filter((s) => s.t >= j.inicio && s.t <= j.fim);
  const ok = dentro.filter((s) => s.status === 200).map((s) => s.ms).sort((a, b) => a - b);
  return { rotulo: j.rotulo, n: dentro.length, erros: dentro.length - ok.length, p50: percentil(ok, 0.5), p95: percentil(ok, 0.95), max: ok.length ? ok[ok.length - 1] : null };
});
const resumo = {
  modo: MODO,
  repousoMs: REPOUSO_MS,
  ambiente: { bun: Bun.version, plataforma: process.platform, arch: process.arch, cgroupV2: temCgroup, memoryMax: ler(`${CG}/memory.max`)?.trim() ?? null, swapMax: ler(`${CG}/memory.swap.max`)?.trim() ?? null, cpuMax: ler(`${CG}/cpu.max`)?.trim() ?? null },
  validador: { concorrenciaConstante: CONCORRENCIA_VALIDACAO_MIDIA, prazoConstanteMs: PRAZO_VALIDACAO_MIDIA_MS },
  memoriaPicoAcumuladoMiB: MiB(picoContainer()),
  eventosMemoriaFinais: eventosMemoria(),
  janelas, latencias, amostrasSonda: sonda.length,
};
writeFileSync(join(SAIDA, "resultado.json"), JSON.stringify(resumo, null, 2));
log({ etapa: "concluido", memoriaPicoAcumuladoMiB: resumo.memoriaPicoAcumuladoMiB, eventosMemoriaFinais: resumo.eventosMemoriaFinais });
await app.close();
process.exit(0);
