import { existsSync, linkSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { MongoClient, type Document } from "mongodb";
import { ArchiveInvalidoErro, conteudoDoArchiveGzipDoArquivo, lerArchiveGzipDoArquivo, sha256DoArquivo, type ArchiveLido } from "./archive.js";
import { conteudoPorColecao } from "./integridade.js";
import {
  adquirirPosse,
  COLECAO_POSSE,
  congelarDestino,
  limparDestinoComPosse,
  mesmasEvidencias,
  posseAtual,
  transicionar,
  verificarDestino,
  type ReferenciaArchive,
} from "./posse.js";
import { caminhoTrava, inicioDoProcesso, verificarTrava } from "./trava.js";
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
import {
  BANCO_ORIGEM,
  COLECOES_BACKUP,
  COLECOES_EXCLUIDAS,
  ESTADOS_INTERROMPIVEIS,
  JANELA,
  MARGEM_RECONCILIACAO_MINUTOS,
  PRIVILEGIOS_RESTORE,
  RESTORE,
  type EstadoDestino,
} from "./politica.js";
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

/**
 * Fase 60.4.3.4.21.2.6 (A-03) — credencial da instância isolada. Chega SÓ pelo stdin (`--credencial-stdin`: JSON
 * `{"conexao":{"usuario":"…","senha":"…"}}`), nunca por argumento, variável de ambiente ou URI; nunca é impressa.
 */
interface Credencial {
  usuario: string;
  senha: string;
}
let CREDENCIAL: Credencial | null = null;
let ENTRADA_STDIN: Record<string, unknown> | null = null;

async function lerEntradaStdin(): Promise<Record<string, unknown>> {
  if (ENTRADA_STDIN) return ENTRADA_STDIN;
  const texto = (await Bun.stdin.text()).replace(/^﻿/, "").trim();
  try {
    ENTRADA_STDIN = texto ? (JSON.parse(texto) as Record<string, unknown>) : {};
  } catch {
    throw new UsoInvalidoErro("entrada do stdin não é JSON válido");
  }
  return ENTRADA_STDIN;
}

function credencialDe(valor: unknown, rotulo: string): Credencial {
  const v = valor as Partial<Credencial> | undefined;
  if (!v || typeof v.usuario !== "string" || typeof v.senha !== "string" || !v.usuario || !v.senha) throw new UsoInvalidoErro(`credencial '${rotulo}' ausente ou inválida no stdin`);
  return { usuario: v.usuario, senha: v.senha };
}

/** A instância isolada (27118) SÓ é acessada com credencial; a origem sintética dos testes (27119) não tem autenticação. */
async function comCliente<T>(uri: string, fn: (c: MongoClient) => Promise<T>, appName = "mariela-backup", semCredencial = false): Promise<T> {
  const isolada = uri.includes(`${RESTORE.host}:${RESTORE.porta}/`);
  if (isolada && !semCredencial && !CREDENCIAL) throw new UsoInvalidoErro("a instância isolada exige credencial (--credencial-stdin)");
  const auth = isolada && !semCredencial && CREDENCIAL ? { auth: { username: CREDENCIAL.usuario, password: CREDENCIAL.senha }, authSource: RESTORE.autenticacao.authSource } : {};
  const c = new MongoClient(uri, { appName, readPreference: "primary", serverSelectionTimeoutMS: 30_000, ...auth });
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
    // `destinoExclusivo` é só informativo (Fase 21.2.4+): a prova de posse é o documento de posse, e nenhuma remoção
    // depende deste booleano (R21-2.3-01).
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
 * Fase 60.4.3.4.21.2.6 (A-02) — `derrubar-restore` (que fazia `dropDatabase`) foi REMOVIDO. A remoção de um restore
 * usa a mesma limpeza comprovada da falha: `limpar-destino --modo remocao` (gerir-restore.ps1 -Acao Remover).
 */
function derrubarRestoreRemovido(): never {
  throw new UsoInvalidoErro("derrubar-restore foi removido (Fase 21.2.6): use gerir-restore.ps1 -Acao Remover (limpeza comprovada, sem dropDatabase)");
}

// ---------------------------------------------------------------------------------------------------------------
// POSSE persistente, integridade e limpeza comprovada (Fases 21.2.4 e 21.2.6)
// ---------------------------------------------------------------------------------------------------------------

/** Trava segura por QUEM chamou esta CLI (PID + horário de criação), nomeando a execução informada. Senão: recusa. */
function exigirTrava(o: Record<string, string>, execucao: string): void {
  const falhas = verificarTrava(caminhoTrava(o["raiz"]), execucao, process.ppid).filter((v) => !v.ok);
  if (falhas.length) throw new UsoInvalidoErro(`trava de restore não comprovada para a execução: ${falhas.map((f) => `${f.id} (${f.detalhe})`).join("; ")}`);
}

function exigirExecucao(valor: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(valor)) throw new UsoInvalidoErro("identificador de execução inválido (GUID exigido)");
  return valor.toLowerCase();
}

async function adquirirPosseCmd(o: Record<string, string>) {
  const banco = exigir(o, "banco");
  exigirBancoRestore(banco);
  const execucaoId = exigirExecucao(exigir(o, "execucao"));
  const arquivo = exigir(o, "arquivo");
  const manifesto = exigir(o, "manifesto");
  const ticks = exigir(o, "processo-inicio-ticks");
  // O horário de criação informado tem de ser o do processo que chamou (comprovado pelo SO), não um valor qualquer.
  if (!/^\d+$/.test(ticks) || inicioDoProcesso(process.ppid) !== BigInt(ticks)) throw new UsoInvalidoErro("horário de criação do processo chamador não confere");
  return comCliente(uriLocal(exigir(o, "porta"), [RESTORE.porta]), async (c) => {
    await exigirInstanciaIsolada(c, o["raiz"]);
    exigirTrava(o, execucaoId);
    const r = await adquirirPosse(c.db(banco), {
      execucaoId,
      pid: process.ppid,
      processoInicio: exigir(o, "processo-inicio"),
      processoInicioTicks: ticks,
      executavel: exigir(o, "executavel"),
      banco,
      archive: arquivo,
      archiveSha256: await sha256DoArquivo(arquivo),
      manifesto,
      manifestoSha256: await sha256DoArquivo(manifesto),
    });
    return { ok: r.adquirida, ...r };
  });
}

/** Transições simples do fluxo de restore (RESTAURANDO; FALHOU_DESTINO_PARCIAL). As demais têm comando próprio. */
async function marcarEstadoCmd(o: Record<string, string>) {
  const banco = exigir(o, "banco");
  exigirBancoRestore(banco);
  const execucaoId = exigirExecucao(exigir(o, "execucao"));
  const para = exigir(o, "para") as EstadoDestino;
  if (para !== "RESTAURANDO" && para !== "FALHOU_DESTINO_PARCIAL") throw new UsoInvalidoErro(`marcar-estado só aceita RESTAURANDO ou FALHOU_DESTINO_PARCIAL (recebido ${para})`);
  return comCliente(uriLocal(exigir(o, "porta"), [RESTORE.porta]), async (c) => {
    await exigirInstanciaIsolada(c, o["raiz"]);
    exigirTrava(o, execucaoId);
    return transicionar(c.db(banco), execucaoId, para, o["detalhe"] ?? "");
  });
}

/** A posse vincula o archive E o manifesto por SHA-256 (A-08): os arquivos informados têm de ser exatamente esses. */
async function referenciaVinculada(o: Record<string, string>, posse: { archiveSha256?: string; manifestoSha256?: string } | null): Promise<{ ref: ReferenciaArchive; manifesto: Manifesto } | { erro: string }> {
  const arquivo = exigir(o, "arquivo");
  const caminhoManifesto = exigir(o, "manifesto");
  if (!posse) return { erro: "sem documento de posse" };
  if (posse.archiveSha256 !== (await sha256DoArquivo(arquivo))) return { erro: "ARCHIVE_DIVERGENTE: o archive informado não é o vinculado à posse" };
  if (posse.manifestoSha256 !== (await sha256DoArquivo(caminhoManifesto))) return { erro: "MANIFESTO_DIVERGENTE: o manifesto informado não é o vinculado à posse" };
  const manifesto = lerJson<Manifesto>(caminhoManifesto);
  if (manifesto.archive?.sha256 !== posse.archiveSha256) return { erro: "MANIFESTO_DIVERGENTE: o manifesto não descreve este archive" };
  return { ref: { conteudoPorColecao: conteudoPorColecao(conteudoDoArchiveGzipDoArquivo(arquivo)), indicesPorColecao: manifesto.indices?.porColecao ?? {} }, manifesto };
}

/**
 * A-01 — RESTAURANDO → VALIDANDO → (congela) → verificação INTEGRAL → VERIFICADO (com evidências) → SEGUNDA verificação
 * com o destino já VERIFICADO e protegido: tem de dar as MESMAS evidências; senão INTERVENCAO_NECESSARIA.
 */
async function congelarEVerificarCmd(o: Record<string, string>) {
  const banco = exigir(o, "banco");
  exigirBancoRestore(banco);
  const execucaoId = exigirExecucao(exigir(o, "execucao"));
  return comCliente(uriLocal(exigir(o, "porta"), [RESTORE.porta]), async (c) => {
    await exigirInstanciaIsolada(c, o["raiz"]);
    exigirTrava(o, execucaoId);
    const db = c.db(banco);
    const posse = await posseAtual(db, execucaoId);
    const vinculo = await referenciaVinculada(o, posse.documento);
    if ("erro" in vinculo) return { ok: false, estado: posse.documento?.estado ?? null, motivo: vinculo.erro, verificacoes: [] };
    if (!posse.ok || posse.documento?.estado !== "RESTAURANDO") return { ok: false, estado: posse.documento?.estado ?? null, motivo: `validação exige posse RESTAURANDO desta execução (${posse.detalhe})`, verificacoes: [] };
    // CONGELA ANTES de declarar VALIDANDO: "VALIDANDO" significa sempre "destino já protegido".
    const cong = await congelarDestino(db);
    if (!cong.ok) return { ok: false, estado: "RESTAURANDO", motivo: `congelamento recusado: ${cong.detalhe}`, verificacoes: [] };
    const t1 = await transicionar(db, execucaoId, "VALIDANDO", `destino congelado (${cong.detalhe}); validando`, {}, ["RESTAURANDO"]);
    if (!t1.ok) return { ok: false, estado: t1.de, motivo: `transição para VALIDANDO recusada: ${t1.detalhe}`, verificacoes: [] };
    exigirTrava(o, execucaoId);
    const v1 = await verificarDestino(db, execucaoId, vinculo.ref);
    // Cruzamento extra com o manifesto (contagens, referências e sequências registradas na origem).
    const manif = await validarRestaurado(db, vinculo.manifesto);
    const verificacoes = [...v1.verificacoes, ...manif];
    if (!v1.ok || manif.some((x) => !x.ok)) return { ok: false, estado: "VALIDANDO", motivo: "verificação de integridade reprovada", verificacoes, comparacoes: v1.comparacoes.filter((x) => !x.ok) };
    exigirTrava(o, execucaoId);
    const t2 = await transicionar(db, execucaoId, "VERIFICADO", "conteúdo idêntico ao archive; destino protegido", { evidencias: { ...v1.evidencias, verificacoes } }, ["VALIDANDO"]);
    if (!t2.ok) return { ok: false, estado: t2.de, motivo: `transição para VERIFICADO recusada: ${t2.detalhe}`, verificacoes };
    const v2 = await verificarDestino(db, execucaoId, vinculo.ref);
    if (!v2.ok || !mesmasEvidencias(v1.evidencias, v2.evidencias)) {
      const ti = await transicionar(db, execucaoId, "INTERVENCAO_NECESSARIA", "o destino mudou depois da verificação", { intervencao: { em: new Date(), motivo: "segunda verificação divergente" } });
      return { ok: false, estado: ti.ok ? "INTERVENCAO_NECESSARIA" : null, motivo: "o destino mudou entre a verificação e o registro de VERIFICADO", verificacoes: v2.verificacoes };
    }
    return { ok: true, estado: "VERIFICADO", verificacoes, evidencias: { ...v1.evidencias, verificacoes: undefined }, segundaVerificacao: v2.evidencias.verificadoEm };
  });
}

/** Somente leitura: o destino continua IDÊNTICO às evidências registradas no VERIFICADO (e ao archive)? */
async function verificarIntegridadeCmd(o: Record<string, string>) {
  const banco = exigir(o, "banco");
  exigirBancoRestore(banco);
  const execucaoId = exigirExecucao(exigir(o, "posse-execucao"));
  return comCliente(uriLocal(exigir(o, "porta"), [RESTORE.porta]), async (c) => {
    await exigirInstanciaIsolada(c, o["raiz"]);
    const db = c.db(banco);
    const posse = await posseAtual(db, execucaoId);
    const vinculo = await referenciaVinculada(o, posse.documento);
    if ("erro" in vinculo) return { ok: false, estado: posse.documento?.estado ?? null, motivo: vinculo.erro, verificacoes: [] };
    const v = await verificarDestino(db, execucaoId, vinculo.ref);
    const registradas = posse.documento?.evidencias;
    const iguais = !!registradas && mesmasEvidencias(registradas, v.evidencias);
    return {
      ok: v.ok && iguais,
      estado: posse.documento?.estado ?? null,
      verificacoes: [...v.verificacoes, { id: "evidencias.iguais_ao_verificado", ok: iguais, detalhe: registradas ? (iguais ? "mesmos hashes e UUIDs do VERIFICADO" : "hashes/UUIDs diferentes dos registrados") : "sem evidências registradas" }],
      divergencias: v.comparacoes.filter((x) => !x.ok),
    };
  });
}

/** VERIFICADO → LIBERACAO_AUTORIZADA, por comando EXPLÍCITO do operador, depois de reverificar tudo. Não remove nada. */
async function liberarRestoreCmd(o: Record<string, string>) {
  const banco = exigir(o, "banco");
  exigirBancoRestore(banco);
  const operacao = exigirExecucao(exigir(o, "trava-execucao"));
  const execucaoId = exigirExecucao(exigir(o, "posse-execucao"));
  const operador = exigir(o, "operador");
  return comCliente(uriLocal(exigir(o, "porta"), [RESTORE.porta]), async (c) => {
    await exigirInstanciaIsolada(c, o["raiz"]);
    exigirTrava(o, operacao);
    const db = c.db(banco);
    const posse = await posseAtual(db, execucaoId);
    if (!posse.ok || posse.documento?.estado !== "VERIFICADO") return { ok: false, estado: posse.documento?.estado ?? null, motivo: `liberação exige posse VERIFICADO desta execução (${posse.detalhe})` };
    const vinculo = await referenciaVinculada(o, posse.documento);
    if ("erro" in vinculo) return { ok: false, estado: "VERIFICADO", motivo: vinculo.erro };
    const v = await verificarDestino(db, execucaoId, vinculo.ref);
    if (!v.ok || !posse.documento.evidencias || !mesmasEvidencias(posse.documento.evidencias, v.evidencias)) {
      const ti = await transicionar(db, execucaoId, "INTERVENCAO_NECESSARIA", "reverificação da liberação divergente", { intervencao: { em: new Date(), motivo: "destino diferente do VERIFICADO" } });
      return { ok: false, estado: ti.ok ? "INTERVENCAO_NECESSARIA" : "VERIFICADO", motivo: "o destino não é mais idêntico ao VERIFICADO", verificacoes: v.verificacoes, divergencias: v.comparacoes.filter((x) => !x.ok) };
    }
    exigirTrava(o, operacao);
    const t = await transicionar(db, execucaoId, "LIBERACAO_AUTORIZADA", `liberado por ${operador}`, { liberacao: { autorizadaEm: new Date(), operador, operacaoId: operacao } }, ["VERIFICADO"]);
    return { ok: t.ok, estado: t.ok ? "LIBERACAO_AUTORIZADA" : t.de, motivo: t.detalhe };
  });
}

const ESTADOS_POR_MODO: Record<string, readonly EstadoDestino[]> = {
  /** Falha do próprio restore (depois de iniciar a escrita). */
  falha: ["FALHOU_DESTINO_PARCIAL"],
  /** Execução interrompida (dono comprovadamente encerrado) — recuperar-destino.ps1. */
  recuperacao: ESTADOS_INTERROMPIVEIS,
  /** Remoção de um restore concluído, por decisão do operador — gerir-restore.ps1 -Acao Remover. */
  remocao: ["VERIFICADO", "LIBERACAO_AUTORIZADA"],
};

/**
 * Limpeza COMPROVADA. `--trava-execucao` = operação que MANTÉM a trava agora; `--posse-execucao` = dona do destino.
 * `--modo` define em que estados a remoção é admissível. Nunca `dropDatabase`.
 */
async function limparDestinoCmd(o: Record<string, string>) {
  const banco = exigir(o, "banco");
  exigirBancoRestore(banco);
  const travaExecucao = exigirExecucao(exigir(o, "trava-execucao"));
  const posseExecucao = exigirExecucao(exigir(o, "posse-execucao"));
  const modo = exigir(o, "modo");
  const permitidos = ESTADOS_POR_MODO[modo];
  if (!permitidos) throw new UsoInvalidoErro(`--modo deve ser ${Object.keys(ESTADOS_POR_MODO).join(", ")}`);
  return comCliente(uriLocal(exigir(o, "porta"), [RESTORE.porta]), async (c) => {
    await exigirInstanciaIsolada(c, o["raiz"]);
    exigirTrava(o, travaExecucao);
    const db = c.db(banco);
    const posse = await posseAtual(db, posseExecucao);
    if (!posse.ok) return { ok: false, limpo: false, motivo: "POSSE_NAO_COMPROVADA", detalhe: posse.detalhe, estadoFinal: posse.documento?.estado ?? null };
    const vinculo = await referenciaVinculada(o, posse.documento);
    if ("erro" in vinculo) return { ok: false, limpo: false, motivo: vinculo.erro.split(":")[0], detalhe: vinculo.erro, estadoFinal: posse.documento?.estado ?? null };
    const r = await limparDestinoComPosse(db, posseExecucao, vinculo.ref, permitidos, {
      antesDeRemover: async () => exigirTrava(o, travaExecucao),
    });
    return { ok: r.limpo, ...r };
  });
}

/** Somente leitura: estado de um destino (posse, estado, histórico, evidências). */
async function inspecionarDestinoCmd(o: Record<string, string>) {
  const banco = exigir(o, "banco");
  exigirBancoRestore(banco);
  return comCliente(uriLocal(exigir(o, "porta"), [RESTORE.porta]), async (c) => {
    await exigirInstanciaIsolada(c, o["raiz"]);
    const db = c.db(banco);
    const existe = (await c.db("admin").admin().listDatabases({ nameOnly: true })).databases.some((d) => d.name === banco);
    const colecoes = existe ? (await db.listCollections({}, { nameOnly: true }).toArray()).map((x) => x.name).sort() : [];
    const docs = colecoes.includes(COLECAO_POSSE) ? await db.collection(COLECAO_POSSE).find({}).limit(10).toArray() : [];
    const p = docs.length === 1 ? docs[0]! : null;
    return {
      ok: true,
      existe,
      colecoes,
      posse: p
        ? {
            execucaoId: p["execucaoId"],
            estado: p["estado"],
            pid: p["pid"],
            processoInicio: p["processoInicio"],
            processoInicioTicks: p["processoInicioTicks"],
            executavel: p["executavel"],
            archive: p["archive"],
            archiveSha256: p["archiveSha256"],
            manifesto: p["manifesto"],
            manifestoSha256: p["manifestoSha256"],
            criadoEm: p["criadoEm"],
            historico: p["historico"],
            evidencias: p["evidencias"] ? { verificadoEm: p["evidencias"].verificadoEm, documentos: p["evidencias"].documentos, hashesPorColecao: p["evidencias"].hashesPorColecao } : null,
            liberacao: p["liberacao"] ?? null,
            intervencao: p["intervencao"] ?? null,
          }
        : null,
      documentosDePosse: docs.length,
    };
  });
}

async function listarBancosCmd(o: Record<string, string>) {
  return comCliente(uriLocal(exigir(o, "porta"), [RESTORE.porta]), async (c) => {
    await exigirInstanciaIsolada(c, o["raiz"]);
    return { bancos: (await c.db("admin").admin().listDatabases({ nameOnly: true })).databases.map((d) => d.name).sort() };
  });
}

/**
 * A-03 — configura a autenticação da instância isolada (idempotente). Stdin: `{"admin":{…},"restore":{…},"leitor":{…}}`
 * (senhas SINTÉTICAS geradas pelo mongod-isolado.ps1). Sem usuários ainda: cria o bootstrap pela exceção de localhost.
 * Depois: papel `marielaRestore` (PRIVILEGIOS_RESTORE) e os usuários de restore e leitura. Confere que conexão sem
 * autenticação é recusada.
 */
async function configurarAutenticacaoCmd(o: Record<string, string>) {
  const e = await lerEntradaStdin();
  const admin = credencialDe(e["admin"], "admin");
  const restore = credencialDe(e["restore"], "restore");
  const leitor = credencialDe(e["leitor"], "leitor");
  const uri = uriLocal(exigir(o, "porta"), [RESTORE.porta]);
  const opcoesAdmin = { auth: { username: admin.usuario, password: admin.senha }, authSource: RESTORE.autenticacao.authSource, serverSelectionTimeoutMS: 15_000 };
  let bootstrapCriado = false;
  const tentarAdmin = async () => {
    const c = new MongoClient(uri, opcoesAdmin);
    try {
      await c.connect();
      await c.db("admin").command({ connectionStatus: 1 });
      return c;
    } catch (erro) {
      await c.close().catch(() => undefined);
      throw erro;
    }
  };
  let c: MongoClient;
  try {
    c = await tentarAdmin();
  } catch {
    // Exceção de localhost: só funciona enquanto NÃO há nenhum usuário.
    const sem = new MongoClient(uri, { serverSelectionTimeoutMS: 15_000 });
    try {
      await sem.connect();
      await sem.db("admin").command({ createUser: admin.usuario, pwd: admin.senha, roles: ["root"] });
      bootstrapCriado = true;
    } finally {
      await sem.close().catch(() => undefined);
    }
    c = await tentarAdmin();
  }
  try {
    const a = c.db("admin");
    await exigirInstanciaIsolada(c, o["raiz"]);
    const papeis = (await a.command({ rolesInfo: RESTORE.autenticacao.papelRestore }))["roles"] as unknown[];
    const privilegios = PRIVILEGIOS_RESTORE.map((p) => ({ resource: p.resource, actions: [...p.actions] }));
    if (papeis.length) await a.command({ updateRole: RESTORE.autenticacao.papelRestore, privileges: privilegios, roles: [] });
    else await a.command({ createRole: RESTORE.autenticacao.papelRestore, privileges: privilegios, roles: [] });
    const garantirUsuario = async (u: Credencial, roles: Document[]) => {
      const existe = ((await a.command({ usersInfo: u.usuario }))["users"] as unknown[]).length > 0;
      if (existe) await a.command({ updateUser: u.usuario, pwd: u.senha, roles });
      else await a.command({ createUser: u.usuario, pwd: u.senha, roles });
    };
    await garantirUsuario(restore, [{ role: RESTORE.autenticacao.papelRestore, db: "admin" }]);
    await garantirUsuario(leitor, [{ role: "readAnyDatabase", db: "admin" }]);
    if (admin.usuario !== RESTORE.autenticacao.usuarioAdmin || restore.usuario !== RESTORE.autenticacao.usuarioRestore || leitor.usuario !== RESTORE.autenticacao.usuarioLeitor) {
      throw new UsoInvalidoErro("nomes de usuário diferentes da política");
    }
  } finally {
    await c.close().catch(() => undefined);
  }
  // Prova: sem credencial nada é permitido.
  const sem = new MongoClient(uri, { serverSelectionTimeoutMS: 15_000 });
  let semAuthRecusado = false;
  try {
    await sem.connect();
    await sem.db("admin").admin().listDatabases();
  } catch {
    semAuthRecusado = true;
  } finally {
    await sem.close().catch(() => undefined);
  }
  if (!semAuthRecusado) throw new Error("a instância aceitou listDatabases SEM autenticação — --auth não está ativo");
  return { bootstrapCriado, papel: RESTORE.autenticacao.papelRestore, usuarios: [admin.usuario, restore.usuario, leitor.usuario], semAuthRecusado };
}

async function localEstado(o: Record<string, string>) {
  return comCliente(uriLocal(exigir(o, "porta"), [RESTORE.porta, 27119]), async (c) => {
    const admin = c.db("admin");
    const versao = String((await admin.command({ buildInfo: 1 }))["version"]);
    const hello = await admin.command({ hello: 1 });
    const opts = (await admin.command({ getCmdLineOpts: 1 }))["parsed"] as { net?: { bindIp?: string; port?: number }; storage?: { dbPath?: string }; replication?: { replSet?: string }; security?: { authorization?: string; keyFile?: string } };
    return {
      versao,
      bindIp: opts.net?.bindIp ?? null,
      porta: opts.net?.port ?? null,
      dbPath: opts.storage?.dbPath ?? null,
      replicaSet: hello["setName"] ?? null,
      primario: hello["isWritablePrimary"] === true,
      autenticacao: opts.security?.authorization === "enabled" || !!opts.security?.keyFile,
    };
  });
}

async function localRsIniciar(o: Record<string, string>, flags: Set<string>) {
  const porta = exigir(o, "porta");
  const nome = exigir(o, "rs");
  // `--localhost`: usa a exceção de localhost (instância nova, ainda SEM usuários) — único caso sem credencial.
  return comCliente(
    uriLocal(porta, [RESTORE.porta]),
    async (c) => {
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
    },
    "mariela-backup",
    flags.has("localhost"),
  );
}

async function localDesligar(o: Record<string, string>, flags: Set<string>) {
  const uri = uriLocal(exigir(o, "porta"), [RESTORE.porta, 27119]);
  const isolada = Number(o["porta"]) === RESTORE.porta;
  // 27118: só o bootstrap (root) tem `shutdown`. `--sem-autenticacao`: migração de uma instância antiga ainda sem --auth.
  if (isolada && !CREDENCIAL && !flags.has("sem-autenticacao")) throw new UsoInvalidoErro("desligar a instância isolada exige a credencial bootstrap");
  const auth = isolada && CREDENCIAL ? { auth: { username: CREDENCIAL.usuario, password: CREDENCIAL.senha }, authSource: RESTORE.autenticacao.authSource } : {};
  const c = new MongoClient(uri, { serverSelectionTimeoutMS: 5_000, ...auth });
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
    if (flags.has("credencial-stdin")) CREDENCIAL = credencialDe((await lerEntradaStdin())["conexao"], "conexao");
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
      case "finalizar-posse":
        derrubarRestoreRemovido();
        break;
      case "local-estado":
        resultado = await localEstado(o);
        break;
      case "local-rs-iniciar":
        resultado = await localRsIniciar(o, flags);
        break;
      case "local-desligar":
        resultado = await localDesligar(o, flags);
        break;
      case "configurar-autenticacao":
        resultado = await configurarAutenticacaoCmd(o);
        break;
      case "marcar-estado":
        resultado = await marcarEstadoCmd(o);
        break;
      case "congelar-e-verificar":
        resultado = await congelarEVerificarCmd(o);
        break;
      case "verificar-integridade":
        resultado = await verificarIntegridadeCmd(o);
        break;
      case "liberar-restore":
        resultado = await liberarRestoreCmd(o);
        break;
      case "listar-bancos":
        resultado = await listarBancosCmd(o);
        break;
      case "conferir-trava": {
        // A trava continua segura, desta execução e do processo que chama (PID + horário de criação)?
        const verificacoes = verificarTrava(caminhoTrava(o["raiz"]), exigirExecucao(exigir(o, "execucao")), process.ppid);
        resultado = { ok: verificacoes.every((v) => v.ok), verificacoes };
        break;
      }
      case "registrar-cifrado":
        resultado = await registrarCifradoCmd(o);
        break;
      case "adquirir-posse":
        resultado = await adquirirPosseCmd(o);
        break;
      case "limpar-destino":
        resultado = await limparDestinoCmd(o);
        break;
      case "inspecionar-destino":
        resultado = await inspecionarDestinoCmd(o);
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
