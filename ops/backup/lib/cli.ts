import { existsSync, linkSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { MongoClient } from "mongodb";
import { ArchiveInvalidoErro, lerArchiveGzipDoArquivo, sha256DoArquivo, type ArchiveLido } from "./archive.js";
import { ConfigMongoErro, lerConfigMongo, sanitizarMensagem } from "./config-mongo.js";
import {
  avaliarDevido,
  lerAssinatura,
  lerIndices,
  lerReferencias,
  lerSequencias,
  verificarColecoesDaOrigem,
  verificarPeriodoSemEscrita,
  verificarPreCondicoes,
} from "./janela.js";
import { montarManifesto, validarArchiveParaRestore, validarBackup, validarRestaurado, verificarVersaoDestino, type Manifesto, type PreBackup } from "./manifesto.js";
import { BANCO_ORIGEM, COLECOES_BACKUP, COLECOES_EXCLUIDAS, JANELA, MARGEM_RECONCILIACAO_MINUTOS, RESTORE } from "./politica.js";
import { verificarInstanciaConectada } from "./instancia.js";
import { aplicarRetencao, listarBackups, planejarRetencao } from "./retencao.js";
import { iniciarRegistro, registrarCifrado } from "./segunda-copia.js";

/**
 * Fase 60.4.3.4.21.2 — CLI da biblioteca de backup, chamada pelos scripts `ops/backup/*.ps1` (`bun ops/backup/lib/cli.ts
 * <comando> --opcao valor`). Saída: UM objeto JSON no stdout, nunca com URI/host/segredo. Código de saída: 0 = comando
 * executado (a decisão está no JSON), 1 = falha operacional, 2 = uso inválido.
 */

class UsoInvalidoErro extends Error {}

function opcoes(argv: string[]): { comando: string; o: Record<string, string>; flags: Set<string> } {
  const [comando = "", ...resto] = argv;
  const o: Record<string, string> = {};
  const flags = new Set<string>();
  for (let i = 0; i < resto.length; i += 1) {
    const a = resto[i]!;
    if (!a.startsWith("--")) throw new UsoInvalidoErro(`argumento inesperado: ${a}`);
    const prox = resto[i + 1];
    if (prox === undefined || prox.startsWith("--")) flags.add(a.slice(2));
    else {
      o[a.slice(2)] = prox;
      i += 1;
    }
  }
  return { comando, o, flags };
}

function exigir(o: Record<string, string>, chave: string): string {
  const v = o[chave];
  if (!v) throw new UsoInvalidoErro(`--${chave} é obrigatório`);
  return v;
}

function agoraDe(o: Record<string, string>): Date {
  if (!o["agora"]) return new Date();
  const t = Date.parse(o["agora"]);
  if (!Number.isFinite(t)) throw new UsoInvalidoErro("--agora inválido");
  return new Date(t);
}

/** Só loopback e só as portas previstas: 27118 (restore isolado) e 27119 (origem sintética dos testes). */
function uriLocal(porta: string, permitidas: number[]): string {
  const p = Number(porta);
  if (!permitidas.includes(p)) throw new UsoInvalidoErro(`porta ${porta} não permitida (permitidas: ${permitidas.join(", ")})`);
  return `mongodb://${RESTORE.host}:${p}/?directConnection=true`;
}

async function comCliente<T>(uri: string, fn: (c: MongoClient) => Promise<T>, appName = "mariela-backup"): Promise<T> {
  const c = new MongoClient(uri, { appName, readPreference: "primary", serverSelectionTimeoutMS: 30_000 });
  try {
    await c.connect();
    return await fn(c);
  } finally {
    await c.close().catch(() => undefined);
  }
}

const lerJson = <T>(caminho: string): T => JSON.parse(readFileSync(caminho, "utf8")) as T;

// ---------------------------------------------------------------------------------------------------------------

async function preBackup(o: Record<string, string>): Promise<PreBackup> {
  const tipo = exigir(o, "tipo");
  if (tipo !== "diario" && tipo !== "extraordinario") throw new UsoInvalidoErro("--tipo deve ser diario ou extraordinario");
  const { uri } = lerConfigMongo(exigir(o, "config"), BANCO_ORIGEM);
  const agora = agoraDe(o);
  const dir = exigir(o, "dir");

  return comCliente(uri, async (c) => {
    const db = c.db(BANCO_ORIGEM);
    const versaoServidor = String((await db.admin().command({ buildInfo: 1 }))["version"] ?? "") || null;
    const base: PreBackup = {
      elegivel: false,
      motivo: "",
      agora: agora.toISOString(),
      versaoServidor,
      verificacoes: [],
      informacoes: {},
      colecoesExistentes: [],
      exclusoes: [...COLECOES_EXCLUIDAS],
      assinatura: null,
      indices: null,
      referencias: null,
      sequencias: null,
    };

    const origem = await verificarColecoesDaOrigem(db);
    base.colecoesExistentes = origem.existentes;
    const politicaOk = origem.desconhecidas.length === 0 && origem.faltando.length === 0 && origem.naoColecao.length === 0;
    base.verificacoes.push({
      id: "origem.colecoes_conforme_politica",
      ok: politicaOk,
      detalhe: `existentes=${origem.existentes.length} desconhecidas=${JSON.stringify(origem.desconhecidas)} faltando=${JSON.stringify(origem.faltando)} naoColecao=${JSON.stringify(origem.naoColecao)}`,
    });
    if (!politicaOk) return { ...base, motivo: "BLOQUEADO: coleções da origem divergem da lista positiva — revisar a política antes de qualquer backup" };

    if (tipo === "diario") {
      const validos = listarBackups(dir).filter((e) => e.classe === "diario").map((e) => Date.parse(e.instante)).filter(Number.isFinite);
      const ultimo = validos.length ? new Date(Math.max(...validos)) : null;
      const devido = avaliarDevido(agora, ultimo, JANELA.horaAlvo, JANELA.minutoAlvo);
      base.verificacoes.push({ id: "janela.devido", ok: devido.devido, detalhe: `${devido.motivo}; marco=${devido.marco}` });
      if (!devido.devido) return { ...base, motivo: devido.motivo };
    }

    const pre = await verificarPreCondicoes(db, agora, MARGEM_RECONCILIACAO_MINUTOS);
    base.verificacoes.push(...pre.verificacoes);
    base.informacoes = pre.informacoes;
    base.assinatura = await lerAssinatura(db, COLECOES_BACKUP);
    base.verificacoes.push(verificarPeriodoSemEscrita(base.assinatura, agora, JANELA.quietMinutos));
    base.indices = await lerIndices(db, COLECOES_BACKUP);
    base.referencias = await lerReferencias(db);
    base.sequencias = await lerSequencias(db);
    const falhas = base.verificacoes.filter((v) => !v.ok);
    return { ...base, elegivel: falhas.length === 0, motivo: falhas.length ? `ADIADO: ${falhas.map((f) => f.id).join(", ")}` : "ELEGIVEL" };
  });
}

async function posBackup(o: Record<string, string>): Promise<{ estado: string; sha256: string | null; falhas: string[]; avisos: string[] }> {
  const pre = lerJson<PreBackup>(exigir(o, "pre"));
  const tmp = exigir(o, "tmp");
  const saida = exigir(o, "saida");
  const { uri } = lerConfigMongo(exigir(o, "config"), BANCO_ORIGEM);
  const depois = await comCliente(uri, (c) => lerAssinatura(c.db(BANCO_ORIGEM), COLECOES_BACKUP));

  let archive: ArchiveLido | null = null;
  const validacoes = [];
  const avisos: string[] = [];
  try {
    archive = lerArchiveGzipDoArquivo(tmp);
    validacoes.push({ id: "archive.legivel", ok: true, detalhe: `${archive.bytesDescompactados} bytes descompactados` });
  } catch (erro) {
    validacoes.push({ id: "archive.legivel", ok: false, detalhe: erro instanceof ArchiveInvalidoErro ? `${erro.codigo}: ${erro.message}` : "falha ao ler o archive" });
  }
  const sha256 = existsSync(tmp) ? await sha256DoArquivo(tmp) : null;
  if (archive) {
    const r = validarBackup(pre, depois, archive);
    validacoes.push(...r.validacoes);
    avisos.push(...r.avisos);
  }
  const tamanho = existsSync(tmp) ? readFileSync(tmp).length : 0;
  if (tamanho === 0) validacoes.push({ id: "archive.nao_vazio", ok: false, detalhe: "arquivo vazio ou inexistente" });

  const manifesto = montarManifesto({
    execucaoId: exigir(o, "execucao-id"),
    tipo: exigir(o, "tipo") as Manifesto["tipo"],
    iniciadoEm: exigir(o, "iniciado-em"),
    concluidoEm: new Date().toISOString(),
    dataLocal: exigir(o, "data-local"),
    fusoHorario: exigir(o, "fuso"),
    ferramentas: { mongodump: o["mongodump-versao"] ?? null },
    servidor: { versao: pre.versaoServidor },
    origem: { banco: BANCO_ORIGEM },
    janela: { verificacoes: pre.verificacoes, informacoes: pre.informacoes },
    assinaturaAntes: pre.assinatura,
    assinaturaDepois: depois,
    indices: pre.indices ? { porColecao: pre.indices, total: Object.values(pre.indices).reduce((s, l) => s + l.length, 0) } : null,
    referencias: pre.referencias,
    sequencias: pre.sequencias,
    archive:
      archive && sha256
        ? {
            arquivo: exigir(o, "nome-final"),
            tamanhoBytes: tamanho,
            sha256,
            versaoServidor: archive.versaoServidor,
            versaoFerramenta: archive.versaoFerramenta,
            documentosPorColecao: Object.fromEntries(COLECOES_BACKUP.map((c) => [c, archive!.documentos[`${BANCO_ORIGEM}.${c}`] ?? 0])),
          }
        : null,
    validacoes,
    avisos,
  });
  // Archive inválido recebe o prefixo próprio no nome (nunca confundível com um válido).
  if (manifesto.estado !== "VALIDO_LOCAL" && manifesto.archive) manifesto.archive.arquivo = exigir(o, "nome-invalido");
  writeFileSync(saida, JSON.stringify(manifesto, null, 2), { flag: "wx" }); // nunca sobrescreve
  return { estado: manifesto.estado, sha256, falhas: validacoes.filter((v) => !v.ok).map((v) => `${v.id}: ${v.detalhe}`), avisos };
}

function manifestoDeFalha(o: Record<string, string>): { estado: string } {
  const manifesto = montarManifesto({
    execucaoId: exigir(o, "execucao-id"),
    tipo: exigir(o, "tipo") as Manifesto["tipo"],
    iniciadoEm: exigir(o, "iniciado-em"),
    concluidoEm: new Date().toISOString(),
    dataLocal: exigir(o, "data-local"),
    fusoHorario: exigir(o, "fuso"),
    ferramentas: { mongodump: o["mongodump-versao"] ?? null },
    servidor: { versao: null },
    origem: { banco: BANCO_ORIGEM },
    janela: { verificacoes: [], informacoes: {} },
    assinaturaAntes: null,
    assinaturaDepois: null,
    indices: null,
    referencias: null,
    sequencias: null,
    archive: null,
    validacoes: [{ id: "execucao", ok: false, detalhe: sanitizarMensagem(exigir(o, "motivo")) }],
    avisos: [],
  });
  writeFileSync(exigir(o, "saida"), JSON.stringify(manifesto, null, 2), { flag: "wx" });
  return { estado: manifesto.estado };
}

/** Renomeação SEM sobrescrita: hard link (falha se o destino existe) + remoção da origem. */
function promover(o: Record<string, string>): { promovido: string } {
  const origem = exigir(o, "origem");
  const destino = exigir(o, "destino");
  if (dirname(origem) !== dirname(destino)) throw new UsoInvalidoErro("origem e destino precisam estar no mesmo diretório");
  if (existsSync(destino)) throw new UsoInvalidoErro(`COLISAO: ${basename(destino)} já existe — nada foi sobrescrito`);
  linkSync(origem, destino);
  unlinkSync(origem);
  return { promovido: basename(destino) };
}

function retencao(o: Record<string, string>, flags: Set<string>) {
  const dir = exigir(o, "dir");
  const entradas = listarBackups(dir);
  const decisao = planejarRetencao(entradas, { agora: agoraDe(o), novoValidoBase: o["novo"] ?? null });
  const apagados = flags.has("aplicar") ? aplicarRetencao(dir, decisao) : [];
  if (flags.has("aplicar")) {
    const logs = join(dir, "logs");
    mkdirSync(logs, { recursive: true });
    const carimbo = new Date().toISOString().replace(/[:.]/g, "-");
    writeFileSync(join(logs, `retencao_${carimbo}.json`), JSON.stringify({ em: new Date().toISOString(), decisao, apagados }, null, 2), { flag: "wx" });
  }
  return { decisao, apagados, aplicada: flags.has("aplicar") };
}

async function validarParaRestore(o: Record<string, string>) {
  const arquivo = exigir(o, "arquivo");
  const manifesto = lerJson<Manifesto>(exigir(o, "manifesto"));
  const verificacoes = [];
  const sha = await sha256DoArquivo(arquivo);
  const shaArquivo = existsSync(`${arquivo}.sha256`) ? readFileSync(`${arquivo}.sha256`, "utf8").trim().split(/\s+/)[0]!.toUpperCase() : null;
  verificacoes.push({ id: "sha256.manifesto", ok: sha === manifesto.archive?.sha256, detalhe: `calculado=${sha}` });
  verificacoes.push({ id: "sha256.arquivo_sha256", ok: sha === shaArquivo, detalhe: shaArquivo ? "confere com .sha256" : "arquivo .sha256 ausente" });
  try {
    verificacoes.push(...validarArchiveParaRestore(lerArchiveGzipDoArquivo(arquivo), manifesto));
  } catch (erro) {
    verificacoes.push({ id: "archive.legivel", ok: false, detalhe: erro instanceof ArchiveInvalidoErro ? erro.codigo : "falha ao ler" });
  }
  return { ok: verificacoes.every((v) => v.ok), verificacoes };
}

function exigirBancoRestore(banco: string): void {
  if (banco === BANCO_ORIGEM || !RESTORE.padraoBanco.test(banco)) throw new UsoInvalidoErro(`banco de destino '${banco}' recusado (exigido: mariela_restore_yyyyMMdd_HHmmss; nunca ${BANCO_ORIGEM})`);
}

/** Fase 60.4.3.4.21.2.2 (R21-2.1-11) — recusa qualquer operação se a instância não for a isolada. */
async function exigirInstanciaIsolada(c: MongoClient, raiz: string | undefined): Promise<void> {
  const falhas = (await verificarInstanciaConectada(c.db("admin"), raiz)).filter((v) => !v.ok);
  if (falhas.length) throw new UsoInvalidoErro(`instância em ${RESTORE.host}:${RESTORE.porta} NÃO é a isolada de restore: ${falhas.map((f) => f.id).join(", ")}`);
}

async function prepararRestore(o: Record<string, string>) {
  const banco = exigir(o, "banco");
  exigirBancoRestore(banco);
  const manifesto = lerJson<Manifesto>(exigir(o, "manifesto"));
  return comCliente(uriLocal(exigir(o, "porta"), [RESTORE.porta]), async (c) => {
    // A identidade vem PRIMEIRO; com ela falhando, as demais verificações nem são executadas.
    const identidade = await verificarInstanciaConectada(c.db("admin"), o["raiz"]);
    if (identidade.some((v) => !v.ok)) return { ok: false, destinoExclusivo: false, versaoDestino: null, verificacoes: identidade };
    const versao = String((await c.db("admin").command({ buildInfo: 1 }))["version"] ?? "") || null;
    const bancos = (await c.db("admin").admin().listDatabases({ nameOnly: true })).databases.map((d) => d.name);
    const destinoExclusivo = !bancos.includes(banco);
    const verificacoes = [
      ...identidade,
      verificarVersaoDestino(manifesto.archive?.versaoServidor ?? null, versao),
      { id: "restore.destino_inexistente", ok: destinoExclusivo, detalhe: destinoExclusivo ? "destino livre (criado por esta execução)" : `o banco ${banco} já existe — nada será sobrescrito nem removido` },
    ];
    // `destinoExclusivo` é a PROVA usada pelo restore para poder remover o destino depois de uma falha.
    return { ok: verificacoes.every((v) => v.ok), destinoExclusivo, versaoDestino: versao, verificacoes };
  });
}

async function validarRestauradoCmd(o: Record<string, string>) {
  const banco = exigir(o, "banco");
  exigirBancoRestore(banco);
  const manifesto = lerJson<Manifesto>(exigir(o, "manifesto"));
  return comCliente(uriLocal(exigir(o, "porta"), [RESTORE.porta]), async (c) => {
    await exigirInstanciaIsolada(c, o["raiz"]);
    const verificacoes = await validarRestaurado(c.db(banco), manifesto);
    return { ok: verificacoes.every((v) => v.ok), verificacoes };
  });
}

/**
 * Remove SÓ o banco de destino de um restore (nome `mariela_restore_<carimbo>`, nunca `marielaDB`), SÓ na instância
 * isolada, e confirma que ele não existe mais depois.
 */
async function derrubarRestore(o: Record<string, string>) {
  const banco = exigir(o, "banco");
  exigirBancoRestore(banco);
  return comCliente(uriLocal(exigir(o, "porta"), [RESTORE.porta]), async (c) => {
    await exigirInstanciaIsolada(c, o["raiz"]);
    const listar = async () => (await c.db("admin").admin().listDatabases({ nameOnly: true })).databases.map((d) => d.name);
    const existia = (await listar()).includes(banco);
    if (existia) await c.db(banco).dropDatabase();
    const aindaExiste = (await listar()).includes(banco);
    if (aindaExiste) throw new Error(`o banco ${banco} continua existindo depois da remoção`);
    return { existia, removido: existia, aindaExiste };
  });
}

async function localEstado(o: Record<string, string>) {
  return comCliente(uriLocal(exigir(o, "porta"), [RESTORE.porta, 27119]), async (c) => {
    const admin = c.db("admin");
    const versao = String((await admin.command({ buildInfo: 1 }))["version"]);
    const hello = await admin.command({ hello: 1 });
    const opts = (await admin.command({ getCmdLineOpts: 1 }))["parsed"] as { net?: { bindIp?: string; port?: number }; storage?: { dbPath?: string }; replication?: { replSet?: string } };
    return {
      versao,
      bindIp: opts.net?.bindIp ?? null,
      porta: opts.net?.port ?? null,
      dbPath: opts.storage?.dbPath ?? null,
      replicaSet: hello["setName"] ?? null,
      primario: hello["isWritablePrimary"] === true,
    };
  });
}

async function localRsIniciar(o: Record<string, string>) {
  const porta = exigir(o, "porta");
  const nome = exigir(o, "rs");
  return comCliente(uriLocal(porta, [RESTORE.porta]), async (c) => {
    const admin = c.db("admin");
    try {
      await admin.command({ replSetInitiate: { _id: nome, members: [{ _id: 0, host: `${RESTORE.host}:${porta}` }] } });
    } catch (erro) {
      if (!/already initialized/i.test(String((erro as Error).message))) throw erro;
    }
    for (let i = 0; i < 60; i += 1) {
      if ((await admin.command({ hello: 1 }))["isWritablePrimary"] === true) return { replicaSet: nome, primario: true };
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("replica set não ficou primário a tempo");
  });
}

async function localDesligar(o: Record<string, string>) {
  const uri = uriLocal(exigir(o, "porta"), [RESTORE.porta, 27119]);
  const c = new MongoClient(uri, { serverSelectionTimeoutMS: 5_000 });
  try {
    await c.connect();
    await c.db("admin").command({ shutdown: 1 });
  } catch {
    // shutdown fecha a conexão — erro de rede aqui é o esperado
  } finally {
    await c.close().catch(() => undefined);
  }
  return { desligado: true };
}

/** Segunda cópia: VALIDO_LOCAL → CIFRADO (só com o hash do pacote cifrado e o manifesto válido). Nunca sobrescreve. */
async function registrarCifradoCmd(o: Record<string, string>) {
  const manifesto = lerJson<Manifesto>(exigir(o, "manifesto"));
  if (manifesto.estado !== "VALIDO_LOCAL" || !manifesto.archive) throw new UsoInvalidoErro("manifesto não é VALIDO_LOCAL — nada é cifrado como cópia válida");
  const cifrado = exigir(o, "cifrado");
  const base = basename(cifrado).replace(/\.7z$/, "");
  const agora = new Date();
  const registro = registrarCifrado(
    iniciarRegistro(base, manifesto.archive.sha256, agora),
    { arquivoCifrado: basename(cifrado), sha256Cifrado: await sha256DoArquivo(cifrado), tamanhoCifrado: statSync(cifrado).size },
    agora,
  );
  writeFileSync(exigir(o, "saida"), JSON.stringify(registro, null, 2), { flag: "wx" });
  return { estado: registro.estado, sha256Cifrado: registro.sha256Cifrado };
}

// ---------------------------------------------------------------------------------------------------------------

async function principal(): Promise<number> {
  let resultado: unknown;
  try {
    const { comando, o, flags } = opcoes(process.argv.slice(2));
    switch (comando) {
      case "pre-backup": {
        const pre = await preBackup(o);
        // O próprio pré-backup grava o arquivo de trabalho (sem ida e volta de JSON pelo PowerShell).
        if (o["saida"] && pre.elegivel) writeFileSync(o["saida"], JSON.stringify(pre, null, 2), { flag: "wx" });
        resultado = pre;
        break;
      }
      case "pos-backup":
        resultado = await posBackup(o);
        break;
      case "manifesto-falha":
        resultado = manifestoDeFalha(o);
        break;
      case "promover":
        resultado = promover(o);
        break;
      case "retencao":
        resultado = retencao(o, flags);
        break;
      case "validar-para-restore":
        resultado = await validarParaRestore(o);
        break;
      case "preparar-restore":
        resultado = await prepararRestore(o);
        break;
      case "validar-restaurado":
        resultado = await validarRestauradoCmd(o);
        break;
      case "derrubar-restore":
        resultado = await derrubarRestore(o);
        break;
      case "local-estado":
        resultado = await localEstado(o);
        break;
      case "local-rs-iniciar":
        resultado = await localRsIniciar(o);
        break;
      case "local-desligar":
        resultado = await localDesligar(o);
        break;
      case "registrar-cifrado":
        resultado = await registrarCifradoCmd(o);
        break;
      case "politica":
        resultado = { banco: BANCO_ORIGEM, colecoesIncluidas: [...COLECOES_BACKUP], colecoesExcluidas: [...COLECOES_EXCLUIDAS], restore: { host: RESTORE.host, porta: RESTORE.porta } };
        break;
      default:
        throw new UsoInvalidoErro(`comando desconhecido: '${comando}'`);
    }
    process.stdout.write(`${JSON.stringify({ ok: true, comando, resultado })}\n`);
    return 0;
  } catch (erro) {
    const uso = erro instanceof UsoInvalidoErro;
    const codigo = erro instanceof ConfigMongoErro ? erro.codigo : uso ? "USO_INVALIDO" : ((erro as { codeName?: string; name?: string }).codeName ?? (erro as Error).name ?? "ERRO");
    process.stdout.write(`${JSON.stringify({ ok: false, codigo, mensagem: sanitizarMensagem(erro instanceof Error ? erro.message : String(erro)) })}\n`);
    return uso ? 2 : 1;
  }
}

process.exitCode = await principal();
