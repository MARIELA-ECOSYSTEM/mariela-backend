import { existsSync, linkSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { MongoClient, type Document } from "mongodb";
import {
  ArchiveInvalidoErro,
  CAMPOS_VALIDACAO,
  conteudoDoArchive,
  descompactar,
  lerArchive,
  lerArchiveGzipDoArquivo,
  sha256DoArquivo,
  type ArchiveLido,
  type EspecificacaoIndice,
  type Verificacao,
} from "./archive.js";
import { acrescentarAncora, conferirAncora, criarAncora, estadosAdmitidos, lerAncora, lerCadeia, ultimasEvidencias } from "./ancora.js";
import { classificarExcecao, classificarFalhas, operarComReverificacao, type PortasReverificacao } from "./classificacao.js";
import { garantiasEfetivas } from "./garantias.js";
import { conferirPacote, criarPacoteEvidencias, type ResultadoCaso } from "./evidencias.js";
import { conteudoPorColecao, type ComparacaoColecao } from "./integridade.js";
import {
  adquirirPosse,
  COLECAO_POSSE,
  conferirIdentidadePosse,
  congelarDestino,
  ESTADOS_POR_MODO,
  estaCongelada,
  infoColecoes,
  iniciarUso,
  limparDestinoComPosse,
  mesmasEvidencias,
  posseAtual,
  transicionar,
  verificarDestino,
  type Ancorador,
  type DocumentoPosse,
  type ModoLimpeza,
  type ReferenciaArchive,
  VALIDADOR_CONGELADO,
} from "./posse.js";
import { conferirIdentidade, planoIdentidade, type FatosIdentidade } from "./identidade.js";
import { raizIsolada } from "./instancia.js";
import { caminhoTrava, exigeTravaAdministrativa, inicioDoProcesso, verificarTrava } from "./trava.js";
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
  JANELA,
  MARGEM_RECONCILIACAO_MINUTOS,
  PRIVILEGIOS_GUARDIAO,
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
// POSSE persistente, âncora externa, integridade e limpeza comprovada (Fases 21.2.4, 21.2.6 e 21.2.8)
// ---------------------------------------------------------------------------------------------------------------

/** Trava segura por QUEM chamou esta CLI (PID + horário de criação), nomeando a execução informada. Senão: recusa. */
function exigirTrava(o: Record<string, string>, execucao: string): void {
  const falhas = verificarTrava(caminhoTrava(o["raiz"]), execucao, process.ppid).filter((v) => !v.ok);
  if (falhas.length) throw new UsoInvalidoErro(`trava de restore não comprovada para a execução: ${falhas.map((f) => `${f.id} (${f.detalhe})`).join("; ")}`);
}

/**
 * 21.2.11 (N1) — operações ADMINISTRATIVAS da instância isolada (desligar, iniciar replica set, configurar autenticação)
 * exigem a MESMA trava do restore, mantida por quem chamou (mongod-isolado.ps1). A conferência é a mesma de exigirTrava
 * (EBUSY + execução + PID + início do processo chamador). Decisão por porta em trava.ts (exigeTravaAdministrativa).
 */
function exigirTravaAdministrativa(o: Record<string, string>): void {
  if (!exigeTravaAdministrativa(o["porta"] ?? "")) return;
  const execucao = o["trava-execucao"];
  if (!execucao) throw new UsoInvalidoErro("operação administrativa na instância isolada exige --trava-execucao (trava de restore mantida pelo chamador)");
  exigirTrava(o, exigirExecucao(execucao));
}

function exigirExecucao(valor: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(valor)) throw new UsoInvalidoErro("identificador de execução inválido (GUID exigido)");
  return valor.toLowerCase();
}

/**
 * A21-7-06 — IDENTIDADE da instância: documento gravado NA instância pelo bootstrap + cópia local
 * (`<raiz>/seguranca/instancia.json`). Os dois têm de existir e coincidir; senão nada é feito.
 */
async function identidadeInstancia(c: MongoClient, raiz: string | undefined): Promise<string> {
  const r = conferirIdentidade(await fatosIdentidade(c, raiz));
  if (!r.ok) throw new UsoInvalidoErro(`identidade da instância não comprovada (${r.detalhe}) — execute mongod-isolado.ps1 -Acao ConfigurarAutenticacao`);
  return r.instanciaId;
}

/** 21.2.11 (N3): documentos da coleção de identidade, se ela está congelada, e a cópia local (ilegível ⇒ erro). */
async function fatosIdentidade(c: MongoClient, raiz: string | undefined): Promise<FatosIdentidade> {
  const meta = c.db(RESTORE.identidade.banco);
  const info = (await meta.listCollections({ name: RESTORE.identidade.colecao }).toArray())[0] as { options?: Record<string, unknown> } | undefined;
  const documentos = info ? ((await meta.collection(RESTORE.identidade.colecao).find({}).limit(5).toArray()) as FatosIdentidade["documentos"]) : null;
  const arq = join(raizIsolada(raiz), ...RESTORE.identidade.arquivoLocal.split("/"));
  let local: string | null = null;
  if (existsSync(arq)) {
    const j = JSON.parse(readFileSync(arq, "utf8").replace(/^﻿/, "")) as { instanciaId?: unknown };
    if (typeof j.instanciaId !== "string") throw new UsoInvalidoErro("cópia local da identidade ilegível — intervenção manual");
    local = j.instanciaId;
  }
  return { documentos, congelada: !!info && estaCongelada({ opcoes: info.options ?? {} }), local };
}

/** Identidade isolada (processo/bind/dbPath/marcador/rs) + identidade da instância. */
async function contextoIsolado(c: MongoClient, o: Record<string, string>): Promise<{ instanciaId: string }> {
  await exigirInstanciaIsolada(c, o["raiz"]);
  return { instanciaId: await identidadeInstancia(c, o["raiz"]) };
}

/** A21-7-02 — registra cada transição na âncora EXTERNA (intenção antes do CAS, confirmação depois). */
function ancoradorPara(raiz: string | undefined, banco: string, execucaoId: string, instanciaId: string): Ancorador {
  const base = { banco, execucaoId, instanciaId };
  return {
    intencao: (de, para, detalhe) => acrescentarAncora(raiz, { ...base, evento: "INTENCAO", de, para, detalhe }),
    confirmacao: (de, para, detalhe) => acrescentarAncora(raiz, { ...base, evento: "CONFIRMACAO", de, para, detalhe }),
    evidencias: (e) => acrescentarAncora(raiz, { ...base, evento: "EVIDENCIAS", evidencias: { documentos: e.documentos, hashesPorColecao: e.hashesPorColecao, uuidsPorColecao: e.uuidsPorColecao } }),
  };
}

/** Referência de integridade a partir do ARCHIVE informado pelo operador (conteúdo, índices completos, opções). */
function referenciaDoArchive(arquivo: string): ReferenciaArchive {
  const dados = descompactar(readFileSync(arquivo));
  const lido = lerArchive(dados);
  const especificacoesPorColecao: Record<string, EspecificacaoIndice[]> = {};
  const opcoesPorColecao: Record<string, Record<string, unknown>> = {};
  for (const c of lido.colecoes) {
    if (c.db !== BANCO_ORIGEM) continue;
    especificacoesPorColecao[c.colecao] = c.especificacoes;
    opcoesPorColecao[c.colecao] = c.opcoes;
    // Política (21.1): coleções SEM validador próprio. O congelamento usa o trio de validação — um validador do archive
    // seria sobrescrito; isso é recusado em vez de ignorado.
    for (const campo of CAMPOS_VALIDACAO) if (c.opcoes[campo] !== undefined) throw new UsoInvalidoErro(`o archive traz '${campo}' em ${c.colecao}: não suportado pelo congelamento (revisar a política)`);
  }
  return { conteudoPorColecao: conteudoPorColecao(conteudoDoArchive(dados)), especificacoesPorColecao, opcoesPorColecao };
}

/**
 * A21-7-02 — confere a âncora externa: arquivos INFORMADOS PELO OPERADOR (`--arquivo`, `--manifesto`; nunca os caminhos
 * da posse), o `<archive>.sha256` e o manifesto do diretório de backup, o registro local e a posse. Devolve as
 * verificações; o chamador recusa se qualquer uma falhar.
 */
async function conferirAncoraCmd(o: Record<string, string>, banco: string, instanciaId: string, posse: DocumentoPosse | null): Promise<Verificacao[]> {
  const arquivo = exigir(o, "arquivo");
  const caminhoManifesto = exigir(o, "manifesto");
  if (!existsSync(arquivo) || !existsSync(caminhoManifesto)) return [{ id: "ancora.arquivos", ok: false, detalhe: "archive ou manifesto informado não existe" }];
  const shaArq = await sha256DoArquivo(arquivo);
  const shaMan = await sha256DoArquivo(caminhoManifesto);
  const arqSha = `${arquivo}.sha256`;
  const shaDoArquivoSha256 = existsSync(arqSha) ? (readFileSync(arqSha, "utf8").trim().split(/\s+/)[0] ?? null) : null;
  let shaDoManifesto: string | null = null;
  try {
    shaDoManifesto = lerJson<Manifesto>(caminhoManifesto).archive?.sha256 ?? null;
  } catch {
    shaDoManifesto = null;
  }
  const texto = posse ? lerAncora(o["raiz"], banco, posse.execucaoId) : null;
  return conferirAncora(texto, {
    banco,
    instanciaId,
    posse: posse ? { execucaoId: posse.execucaoId, estado: posse.estado, banco: posse.banco, instanciaId: posse.instanciaId, archiveSha256: posse.archiveSha256, manifestoSha256: posse.manifestoSha256, archive: posse.archive, manifesto: posse.manifesto, evidencias: posse.evidencias } : null,
    archiveInformado: { caminho: arquivo, sha256: shaArq },
    manifestoInformado: { caminho: caminhoManifesto, sha256: shaMan },
    shaDoArquivoSha256,
    shaDoManifesto,
  });
}

const falhasDe = (v: Verificacao[]) => v.filter((x) => !x.ok);

async function adquirirPosseCmd(o: Record<string, string>) {
  const banco = exigir(o, "banco");
  exigirBancoRestore(banco);
  const execucaoId = exigirExecucao(exigir(o, "execucao"));
  const arquivo = exigir(o, "arquivo");
  const manifesto = exigir(o, "manifesto");
  const ticks = exigir(o, "processo-inicio-ticks");
  if (!/^\d+$/.test(ticks) || inicioDoProcesso(process.ppid) !== BigInt(ticks)) throw new UsoInvalidoErro("horário de criação do processo chamador não confere");
  return comCliente(uriLocal(exigir(o, "porta"), [RESTORE.porta]), async (c) => {
    const { instanciaId } = await contextoIsolado(c, o);
    exigirTrava(o, execucaoId);
    const archiveSha256 = await sha256DoArquivo(arquivo);
    const manifestoSha256 = await sha256DoArquivo(manifesto);
    // Âncora externa ANTES da posse no banco (`wx`: nunca reaproveita um registro).
    criarAncora(o["raiz"], { evento: "POSSE", banco, execucaoId, instanciaId, archive: { caminho: arquivo, sha256: archiveSha256 }, manifesto: { caminho: manifesto, sha256: manifestoSha256 } });
    const r = await adquirirPosse(c.db(banco), {
      execucaoId,
      banco,
      instanciaId,
      pid: process.ppid,
      processoInicio: exigir(o, "processo-inicio"),
      processoInicioTicks: ticks,
      executavel: exigir(o, "executavel"),
      archive: arquivo,
      archiveSha256,
      manifesto,
      manifestoSha256,
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
    const { instanciaId } = await contextoIsolado(c, o);
    exigirTrava(o, execucaoId);
    const db = c.db(banco);
    const posse = await posseAtual(db, execucaoId, instanciaId);
    const anc = await conferirAncoraCmd(o, banco, instanciaId, posse.documento);
    if (falhasDe(anc).length) return { ok: false, de: posse.documento?.estado ?? null, detalhe: `âncora externa não confere: ${falhasDe(anc).map((f) => f.id).join(", ")}`, verificacoes: anc };
    return transicionar(db, execucaoId, instanciaId, para, o["detalhe"] ?? "", ancoradorPara(o["raiz"], banco, execucaoId, instanciaId));
  });
}

/**
 * A-01 — (congela) → RESTAURANDO → VALIDANDO → verificação INTEGRAL → VERIFICADO (evidências na posse E na âncora) →
 * SEGUNDA verificação com o destino já VERIFICADO: tem de dar as MESMAS evidências; senão INTERVENCAO_NECESSARIA.
 */
async function congelarEVerificarCmd(o: Record<string, string>) {
  const banco = exigir(o, "banco");
  exigirBancoRestore(banco);
  const execucaoId = exigirExecucao(exigir(o, "execucao"));
  return comCliente(uriLocal(exigir(o, "porta"), [RESTORE.porta]), async (c) => {
    const { instanciaId } = await contextoIsolado(c, o);
    exigirTrava(o, execucaoId);
    const db = c.db(banco);
    const ancora = ancoradorPara(o["raiz"], banco, execucaoId, instanciaId);
    const posse = await posseAtual(db, execucaoId, instanciaId);
    const anc = await conferirAncoraCmd(o, banco, instanciaId, posse.documento);
    if (falhasDe(anc).length) return { ok: false, estado: posse.documento?.estado ?? null, motivo: `âncora externa não confere: ${falhasDe(anc).map((f) => `${f.id} (${f.detalhe})`).join("; ")}`, verificacoes: anc };
    if (!posse.ok || posse.documento?.estado !== "RESTAURANDO") return { ok: false, estado: posse.documento?.estado ?? null, motivo: `validação exige posse RESTAURANDO desta execução (${posse.detalhe})`, verificacoes: [] };
    const ref = referenciaDoArchive(exigir(o, "arquivo"));
    const manifesto = lerJson<Manifesto>(exigir(o, "manifesto"));
    // CONGELA ANTES de declarar VALIDANDO: "VALIDANDO" significa sempre "destino já protegido".
    const cong = await congelarDestino(db);
    if (!cong.ok) return { ok: false, estado: "RESTAURANDO", motivo: `congelamento recusado: ${cong.detalhe}`, verificacoes: [] };
    const t1 = await transicionar(db, execucaoId, instanciaId, "VALIDANDO", `destino congelado (${cong.detalhe}); validando`, ancora, {}, ["RESTAURANDO"]);
    if (!t1.ok) return { ok: false, estado: t1.de, motivo: `transição para VALIDANDO recusada: ${t1.detalhe}`, verificacoes: [] };
    exigirTrava(o, execucaoId);
    const v1 = await verificarDestino(db, execucaoId, instanciaId, ref);
    const manif = await validarRestaurado(db, manifesto);
    const verificacoes = [...v1.verificacoes, ...manif];
    if (!v1.ok || manif.some((x) => !x.ok)) return { ok: false, estado: "VALIDANDO", motivo: "verificação de integridade reprovada", verificacoes, comparacoes: v1.comparacoes.filter((x) => !x.ok) };
    exigirTrava(o, execucaoId);
    ancora.evidencias(v1.evidencias);
    const t2 = await transicionar(db, execucaoId, instanciaId, "VERIFICADO", "conteúdo, índices e opções idênticos ao archive; destino protegido", ancora, { evidencias: { ...v1.evidencias, verificacoes } }, ["VALIDANDO"]);
    if (!t2.ok) return { ok: false, estado: t2.de, motivo: `transição para VERIFICADO recusada: ${t2.detalhe}`, verificacoes };
    const v2 = await verificarDestino(db, execucaoId, instanciaId, ref);
    if (!v2.ok || !mesmasEvidencias(v1.evidencias, v2.evidencias)) {
      const ti = await transicionar(db, execucaoId, instanciaId, "INTERVENCAO_NECESSARIA", "o destino mudou depois da verificação", ancora, { intervencao: { em: new Date(), motivo: "segunda verificação divergente" } });
      return { ok: false, estado: ti.ok ? "INTERVENCAO_NECESSARIA" : null, motivo: "o destino mudou entre a verificação e o registro de VERIFICADO", verificacoes: v2.verificacoes };
    }
    return { ok: true, estado: "VERIFICADO", verificacoes, evidencias: { ...v1.evidencias, verificacoes: undefined }, segundaVerificacao: v2.evidencias.verificadoEm };
  });
}

/**
 * Reverificação COMPLETA (só leitura no banco): identidade, âncora externa (arquivos do operador), proteção completa,
 * conteúdo/índices/opções iguais ao archive e às evidências registradas (na posse E na âncora).
 */
async function reverificar(c: MongoClient, o: Record<string, string>, banco: string, execucaoId: string, instanciaId: string) {
  const db = c.db(banco);
  const posse = await posseAtual(db, execucaoId, instanciaId);
  // 21.2.11 (X1): posse de outra execução/banco/instância é classificada como POSSE_INVALIDA antes de qualquer outra
  // conferência (o registro lido seria o da OUTRA execução).
  if (!posse.ok) return { ok: false, posse, verificacoes: [{ id: "posse.desta_execucao", ok: false, detalhe: posse.detalhe }] as Verificacao[], divergencias: [] as ComparacaoColecao[], evidencias: null };
  const anc = await conferirAncoraCmd(o, banco, instanciaId, posse.documento);
  if (falhasDe(anc).length) return { ok: false, posse, verificacoes: anc, divergencias: [] as ComparacaoColecao[], evidencias: null };
  const v = await verificarDestino(db, execucaoId, instanciaId, referenciaDoArchive(exigir(o, "arquivo")));
  const registradas = posse.documento?.evidencias;
  const daAncora = ultimasEvidencias(lerCadeia(lerAncora(o["raiz"], banco, execucaoId) ?? "").entradas);
  const iguais = !!registradas && !!daAncora && mesmasEvidencias(registradas, v.evidencias) && JSON.stringify(daAncora.hashesPorColecao) === JSON.stringify(v.evidencias.hashesPorColecao) && JSON.stringify(daAncora.uuidsPorColecao) === JSON.stringify(v.evidencias.uuidsPorColecao);
  const verificacoes = [...anc, ...v.verificacoes, { id: "evidencias.iguais_ao_verificado", ok: iguais, detalhe: iguais ? "mesmos hashes, UUIDs, índices e opções do VERIFICADO (posse e âncora)" : "diferente das evidências registradas" }];
  return { ok: v.ok && iguais, posse, verificacoes, divergencias: v.comparacoes.filter((x) => !x.ok), evidencias: v.evidencias };
}

async function verificarIntegridadeCmd(o: Record<string, string>) {
  const banco = exigir(o, "banco");
  exigirBancoRestore(banco);
  const execucaoId = exigirExecucao(exigir(o, "posse-execucao"));
  return comCliente(uriLocal(exigir(o, "porta"), [RESTORE.porta]), async (c) => {
    const { instanciaId } = await contextoIsolado(c, o);
    let r: Awaited<ReturnType<typeof reverificar>>;
    try {
      r = await reverificar(c, o, banco, execucaoId, instanciaId);
    } catch (erro) {
      const cl = classificarExcecao(erro);
      return { ok: false, estado: null, garantias: null, categoria: cl.categoria, classificacao: cl, verificacoes: [], divergencias: [] };
    }
    const estado = r.posse.documento?.estado ?? null;
    const cl = classificarFalhas(r.verificacoes);
    // 21.2.11 (N4): garantias EFETIVAS — só verdadeiras se a reverificação completa passou. Reprovada ⇒ todas falsas.
    const ancoraOk = !r.verificacoes.some((v) => !v.ok && (v.id === "ancora.presente" || v.id === "ancora.cadeia"));
    const g = garantiasEfetivas({
      estado,
      documentosDePosse: r.posse.documento ? 1 : 0,
      identidadePosseOk: r.posse.ok,
      identidadeInstanciaOk: true,
      ancora: { presente: !r.verificacoes.some((v) => v.id === "ancora.presente" && !v.ok), cadeiaOk: ancoraOk, estadoAdmitido: !r.verificacoes.some((v) => v.id === "ancora.estado" && !v.ok) },
      congeladas: r.ok ? 1 : 0,
      colecoesDeDados: 1,
      reverificacaoOk: r.ok,
    });
    return { ok: r.ok, estado, garantias: g.efetivas, garantiasDeclaradas: g.declaradas, garantiasEfetivas: g, categoria: cl?.categoria ?? null, classificacao: cl, verificacoes: r.verificacoes, divergencias: r.divergencias };
  });
}

/** Divergência PROVADA num destino que se dizia íntegro ⇒ INTERVENCAO_NECESSARIA (com âncora). Erros propagam ao fluxo. */
async function intervirPorDivergencia(c: MongoClient, o: Record<string, string>, banco: string, execucaoId: string, instanciaId: string, motivo: string) {
  return transicionar(c.db(banco), execucaoId, instanciaId, "INTERVENCAO_NECESSARIA", motivo, ancoradorPara(o["raiz"], banco, execucaoId, instanciaId), { intervencao: { em: new Date(), motivo } });
}

/** Portas reais (MongoDB + âncora) do fluxo classificado de Liberar/IniciarUso (21.2.11, X1). */
function portasReais(c: MongoClient, o: Record<string, string>, banco: string, execucaoId: string, instanciaId: string, operacao: string, executar: PortasReverificacao["executar"]): PortasReverificacao & { divergencias: () => ComparacaoColecao[] } {
  let divergencias: ComparacaoColecao[] = [];
  return {
    reverificar: async () => {
      const r = await reverificar(c, o, banco, execucaoId, instanciaId);
      divergencias = r.divergencias;
      return { estado: r.posse.documento?.estado ?? null, verificacoes: r.verificacoes };
    },
    intervir: (motivo) => intervirPorDivergencia(c, o, banco, execucaoId, instanciaId, motivo),
    executar,
    exigirTrava: () => exigirTrava(o, operacao),
    divergencias: () => divergencias,
  };
}

/** VERIFICADO → LIBERACAO_AUTORIZADA, por comando EXPLÍCITO do operador, depois de reverificar tudo. Não descongela. */
async function liberarRestoreCmd(o: Record<string, string>) {
  const banco = exigir(o, "banco");
  exigirBancoRestore(banco);
  const operacao = exigirExecucao(exigir(o, "trava-execucao"));
  const execucaoId = exigirExecucao(exigir(o, "posse-execucao"));
  const operador = exigir(o, "operador");
  return comCliente(uriLocal(exigir(o, "porta"), [RESTORE.porta]), async (c) => {
    const { instanciaId } = await contextoIsolado(c, o);
    exigirTrava(o, operacao);
    const portas = portasReais(c, o, banco, execucaoId, instanciaId, operacao, async () => {
      const t = await transicionar(c.db(banco), execucaoId, instanciaId, "LIBERACAO_AUTORIZADA", `liberado por ${operador} (destino continua congelado)`, ancoradorPara(o["raiz"], banco, execucaoId, instanciaId), { liberacao: { autorizadaEm: new Date(), operador, operacaoId: operacao } }, ["VERIFICADO"]);
      return { ok: t.ok, estado: t.ok ? "LIBERACAO_AUTORIZADA" : t.de, detalhe: t.detalhe };
    });
    const r = await operarComReverificacao(portas, "VERIFICADO");
    return { ...r, divergencias: portas.divergencias() };
  });
}

/** A21-7-05 — LIBERACAO_AUTORIZADA → EM_USO (descongela). Só por comando explícito; reverifica antes. */
async function iniciarUsoCmd(o: Record<string, string>) {
  const banco = exigir(o, "banco");
  exigirBancoRestore(banco);
  const operacao = exigirExecucao(exigir(o, "trava-execucao"));
  const execucaoId = exigirExecucao(exigir(o, "posse-execucao"));
  const operador = exigir(o, "operador");
  if (o["confirmar-banco"] !== banco) throw new UsoInvalidoErro("início de uso exige --confirmar-banco com o nome EXATO do destino");
  return comCliente(uriLocal(exigir(o, "porta"), [RESTORE.porta]), async (c) => {
    const { instanciaId } = await contextoIsolado(c, o);
    exigirTrava(o, operacao);
    const db = c.db(banco);
    const usar = async () => {
      const u = await iniciarUso(db, execucaoId, instanciaId, referenciaDoArchive(exigir(o, "arquivo")), operador, operacao, ancoradorPara(o["raiz"], banco, execucaoId, instanciaId));
      return { ok: u.ok, estado: u.estado, detalhe: u.detalhe, descongeladas: u.descongeladas };
    };
    const p = await posseAtual(db, execucaoId, instanciaId);
    if (p.documento?.estado === "EM_USO" && p.ok) {
      // Retomada idempotente (queda entre a transição e o descongelamento): só a âncora é conferida — o destino já não
      // é declarado igual ao archive. Falha ⇒ recusa classificada, sem transição.
      const anc = await conferirAncoraCmd(o, banco, instanciaId, p.documento);
      const cl = classificarFalhas(anc);
      if (cl) return { ok: false, estado: p.documento.estado, motivo: cl.motivo, categoria: cl.categoria, classificacao: cl, intervencaoPersistida: false, divergenciaNaoRegistravel: false, verificacoes: anc };
      exigirTrava(o, operacao);
      return { ...(await usar()), categoria: null, classificacao: null };
    }
    let descongeladas: string[] = [];
    const portas = portasReais(c, o, banco, execucaoId, instanciaId, operacao, async () => {
      const u = await usar();
      descongeladas = u.descongeladas;
      return { ok: u.ok, estado: u.estado, detalhe: u.detalhe };
    });
    const r = await operarComReverificacao(portas, "LIBERACAO_AUTORIZADA");
    return { ...r, descongeladas, divergencias: portas.divergencias() };
  });
}

/**
 * Limpeza COMPROVADA. `--trava-execucao` = operação que MANTÉM a trava agora; `--posse-execucao` = dona do destino.
 * `--modo` define em que estados a remoção é admissível. Sempre com a âncora externa conferida. Nunca `dropDatabase`.
 */
async function limparDestinoCmd(o: Record<string, string>) {
  const banco = exigir(o, "banco");
  exigirBancoRestore(banco);
  const travaExecucao = exigirExecucao(exigir(o, "trava-execucao"));
  const posseExecucao = exigirExecucao(exigir(o, "posse-execucao"));
  const modo = exigir(o, "modo") as ModoLimpeza;
  if (!(modo in ESTADOS_POR_MODO)) throw new UsoInvalidoErro(`--modo deve ser ${Object.keys(ESTADOS_POR_MODO).join(", ")}`);
  if (modo === "descarte" && o["confirmar-banco"] !== banco) throw new UsoInvalidoErro("descarte exige --confirmar-banco com o nome EXATO do destino");
  return comCliente(uriLocal(exigir(o, "porta"), [RESTORE.porta]), async (c) => {
    const { instanciaId } = await contextoIsolado(c, o);
    exigirTrava(o, travaExecucao);
    const db = c.db(banco);
    const posse = await posseAtual(db, posseExecucao, instanciaId);
    if (!posse.ok) return { ok: false, limpo: false, motivo: "POSSE_NAO_COMPROVADA", detalhe: posse.detalhe, estadoFinal: posse.documento?.estado ?? null };
    const anc = await conferirAncoraCmd(o, banco, instanciaId, posse.documento);
    if (falhasDe(anc).length) return { ok: false, limpo: false, motivo: "ANCORA_NAO_CONFERE", detalhe: falhasDe(anc).map((f) => `${f.id} (${f.detalhe})`).join("; "), estadoFinal: posse.documento?.estado ?? null, verificacoes: anc };
    const r = await limparDestinoComPosse(db, posseExecucao, instanciaId, referenciaDoArchive(exigir(o, "arquivo")), modo, travaExecucao, ancoradorPara(o["raiz"], banco, posseExecucao, instanciaId), {
      antesDeRemover: async () => exigirTrava(o, travaExecucao),
    });
    return { ok: r.limpo, ...r };
  });
}

/** Somente leitura: estado de um destino (posse, estado, garantias, histórico, evidências, âncora). */
async function inspecionarDestinoCmd(o: Record<string, string>) {
  const banco = exigir(o, "banco");
  exigirBancoRestore(banco);
  return comCliente(uriLocal(exigir(o, "porta"), [RESTORE.porta]), async (c) => {
    await exigirInstanciaIsolada(c, o["raiz"]);
    // 21.2.11 (N4): Inspecionar é só leitura — identidade da instância não comprovada não impede a consulta, mas torna
    // TODAS as garantias indisponíveis (e é exposta no resultado).
    let instanciaId: string | null = null;
    let identidadeInstancia_: { ok: boolean; detalhe: string };
    try {
      instanciaId = await identidadeInstancia(c, o["raiz"]);
      identidadeInstancia_ = { ok: true, detalhe: "documento na instância = cópia local" };
    } catch (erro) {
      identidadeInstancia_ = { ok: false, detalhe: erro instanceof Error ? erro.message : String(erro) };
    }
    const db = c.db(banco);
    const existe = (await c.db("admin").admin().listDatabases({ nameOnly: true })).databases.some((d) => d.name === banco);
    const info = existe ? await infoColecoes(db) : [];
    const colecoes = info.map((x) => x.nome).sort();
    const docs = colecoes.includes(COLECAO_POSSE) ? await db.collection(COLECAO_POSSE).find({}).limit(10).toArray() : [];
    const p = docs.length === 1 ? (docs[0] as unknown as DocumentoPosse) : null;
    let ancoraTexto: string | null = null;
    let erroAncora: string | null = null;
    try {
      ancoraTexto = p && typeof p.execucaoId === "string" ? lerAncora(o["raiz"], banco, p.execucaoId) : null;
    } catch (erro) {
      erroAncora = erro instanceof Error ? erro.message : String(erro);
    }
    const cadeia = ancoraTexto !== null ? lerCadeia(ancoraTexto) : null;
    const admitidos = cadeia?.ok ? estadosAdmitidos(cadeia.entradas) : [];
    const identidade = p ? (instanciaId ? conferirIdentidadePosse(p, { execucaoId: p.execucaoId, banco, instanciaId }) : { ok: false, detalhe: "identidade da instância não comprovada" }) : null;
    const dadosCol = info.filter((x) => x.nome !== COLECAO_POSSE);
    const congeladas = dadosCol.filter((x) => estaCongelada(x)).length;
    const efetivas = garantiasEfetivas({
      estado: p ? ((p.estado as string | undefined) ?? "?") : null,
      documentosDePosse: docs.length,
      identidadePosseOk: !!identidade?.ok,
      identidadeInstanciaOk: identidadeInstancia_.ok,
      ancora: { presente: ancoraTexto !== null, cadeiaOk: !!cadeia?.ok, estadoAdmitido: !!p && admitidos.includes(p.estado), erro: erroAncora },
      congeladas,
      colecoesDeDados: dadosCol.length,
    });
    return {
      ok: true,
      existe,
      colecoes,
      congeladas,
      identidadeInstancia: identidadeInstancia_,
      identidade,
      ancora: erroAncora ? { ok: false, motivo: `registro local ilegível: ${erroAncora}` } : cadeia ? { ok: cadeia.ok, motivo: cadeia.motivo, entradas: cadeia.entradas.length, estadosAdmitidos: admitidos } : { ok: false, motivo: "registro local ausente" },
      garantiasEfetivas: efetivas,
      posse: p
        ? {
            execucaoId: p.execucaoId,
            estado: p.estado,
            // 21.2.11 (N4): `garantias` = garantias EFETIVAS (mesma forma de antes, valores conservadores);
            // a declaração do estado fica em `garantiasDeclaradas`.
            garantias: efetivas.efetivas,
            garantiasDeclaradas: efetivas.declaradas,
            banco: p.banco,
            instanciaId: p.instanciaId,
            pid: p.pid,
            processoInicio: p.processoInicio,
            processoInicioTicks: p.processoInicioTicks,
            executavel: p.executavel,
            archive: p.archive,
            archiveSha256: p.archiveSha256,
            manifesto: p.manifesto,
            manifestoSha256: p.manifestoSha256,
            criadoEm: p.criadoEm,
            historico: p.historico,
            evidencias: p.evidencias ? { verificadoEm: p.evidencias.verificadoEm, documentos: p.evidencias.documentos, hashesPorColecao: p.evidencias.hashesPorColecao } : null,
            liberacao: p.liberacao ?? null,
            uso: p.uso ?? null,
            remocao: p.remocao ?? null,
            intervencao: p.intervencao ?? null,
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
 * A-03/A21-7-01/A21-7-06 — configura a autenticação da instância isolada (idempotente). Stdin:
 * `{"admin":{…},"restore":{…},"guardiao":{…},"leitor":{…}}` (senhas SINTÉTICAS geradas pelo mongod-isolado.ps1).
 * Sem usuários ainda: cria o bootstrap pela exceção de localhost. Depois: papéis `marielaRestore` e `marielaGuardiao`
 * (privilégios mínimos e SEPARADOS), usuários, e a IDENTIDADE da instância (documento na instância + cópia local).
 */
async function configurarAutenticacaoCmd(o: Record<string, string>, flags: Set<string>) {
  const e = await lerEntradaStdin();
  const admin = credencialDe(e["admin"], "admin");
  const restore = credencialDe(e["restore"], "restore");
  const guardiao = credencialDe(e["guardiao"], "guardiao");
  const leitor = credencialDe(e["leitor"], "leitor");
  const a0 = RESTORE.autenticacao;
  if (admin.usuario !== a0.usuarioAdmin || restore.usuario !== a0.usuarioRestore || guardiao.usuario !== a0.usuarioGuardiao || leitor.usuario !== a0.usuarioLeitor) throw new UsoInvalidoErro("nomes de usuário diferentes da política");
  const uri = uriLocal(exigir(o, "porta"), [RESTORE.porta]);
  exigirTravaAdministrativa(o);
  const opcoesAdmin ={ auth: { username: admin.usuario, password: admin.senha }, authSource: a0.authSource, serverSelectionTimeoutMS: 15_000 };
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
  let instanciaId: string;
  let identidadeCriada = false;
  let identidadeRestaurada = false;
  let identidadeProtegida = false;
  try {
    const a = c.db("admin");
    await exigirInstanciaIsolada(c, o["raiz"]);
    const garantirPapel = async (nome: string, privs: readonly { resource: object; actions: readonly string[] }[]) => {
      const privilegios = privs.map((p) => ({ resource: p.resource, actions: [...p.actions] }));
      const existe = ((await a.command({ rolesInfo: nome }))["roles"] as unknown[]).length > 0;
      if (existe) await a.command({ updateRole: nome, privileges: privilegios, roles: [] });
      else await a.command({ createRole: nome, privileges: privilegios, roles: [] });
    };
    await garantirPapel(a0.papelRestore, PRIVILEGIOS_RESTORE);
    await garantirPapel(a0.papelGuardiao, PRIVILEGIOS_GUARDIAO);
    const garantirUsuario = async (u: Credencial, roles: Document[]) => {
      const existe = ((await a.command({ usersInfo: u.usuario }))["users"] as unknown[]).length > 0;
      if (existe) await a.command({ updateUser: u.usuario, pwd: u.senha, roles });
      else await a.command({ createUser: u.usuario, pwd: u.senha, roles });
    };
    await garantirUsuario(restore, [{ role: a0.papelRestore, db: "admin" }]);
    await garantirUsuario(guardiao, [{ role: a0.papelGuardiao, db: "admin" }]);
    await garantirUsuario(leitor, [{ role: "readAnyDatabase", db: "admin" }]);
    // Identidade da instância (A21-7-06): documento NA instância + cópia local; nunca troca uma existente.
    // 21.2.11 (N3): plano PURO (identidade.ts) + coleção CONGELADA pelo bootstrap; reinserção a partir da cópia local
    // só com --restaurar-identidade-local (pedido explícito do operador).
    const meta = c.db(RESTORE.identidade.banco);
    const col = meta.collection(RESTORE.identidade.colecao);
    const arq = join(raizIsolada(o["raiz"]), ...RESTORE.identidade.arquivoLocal.split("/"));
    const plano = planoIdentidade(await fatosIdentidade(c, o["raiz"]), { restaurarDaCopiaLocal: flags.has("restaurar-identidade-local") });
    if (plano.acao === "RECUSAR") throw new Error(plano.detalhe);
    if (plano.acao === "CRIAR" || plano.acao === "RESTAURAR_DA_COPIA_LOCAL") {
      instanciaId = plano.acao === "CRIAR" ? crypto.randomUUID() : plano.instanciaId;
      // root tem bypassDocumentValidation: insere mesmo numa coleção já congelada (e vazia).
      await col.insertOne({ _id: RESTORE.identidade.id as never, instanciaId, criadaEm: new Date(), ...(plano.acao === "RESTAURAR_DA_COPIA_LOCAL" ? { restauradaDaCopiaLocalEm: new Date() } : {}) }, { bypassDocumentValidation: true });
      identidadeCriada = plano.acao === "CRIAR";
      identidadeRestaurada = plano.acao === "RESTAURAR_DA_COPIA_LOCAL";
    } else instanciaId = plano.instanciaId;
    const infoCol = (await meta.listCollections({ name: RESTORE.identidade.colecao }).toArray())[0] as { options?: Record<string, unknown> } | undefined;
    if (!infoCol || !estaCongelada({ opcoes: infoCol.options ?? {} })) {
      await meta.command({ collMod: RESTORE.identidade.colecao, validator: VALIDADOR_CONGELADO, validationLevel: "strict", validationAction: "error" });
    }
    if (plano.acao === "CRIAR" || plano.acao === "CRIAR_COPIA_LOCAL") {
      mkdirSync(dirname(arq), { recursive: true });
      writeFileSync(arq, JSON.stringify({ instanciaId }, null, 2), { flag: "wx" });
    }
    const conf = conferirIdentidade(await fatosIdentidade(c, o["raiz"]));
    if (!conf.ok) throw new Error(`identidade não confirmada após a configuração: ${conf.detalhe}`);
    identidadeProtegida = true;
  } finally {
    await c.close().catch(() => undefined);
  }
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
  return { bootstrapCriado, identidadeCriada, identidadeRestaurada, identidadeProtegida, papeis: [a0.papelRestore, a0.papelGuardiao], usuarios: [admin.usuario, restore.usuario, guardiao.usuario, leitor.usuario], semAuthRecusado };
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
  uriLocal(porta, [RESTORE.porta]);
  exigirTravaAdministrativa(o);
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
  exigirTravaAdministrativa(o);
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
        resultado = await configurarAutenticacaoCmd(o, flags);
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
      case "iniciar-uso":
        resultado = await iniciarUsoCmd(o);
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
      case "pacote-evidencias": {
        // 21.2.11 (N5): pacote local de evidências (fora do repositório, da raiz isolada e das origens). Segredos
        // literais a remover chegam SÓ pelo stdin (`--segredos-stdin`: {"segredos":[…]}), nunca por argumento.
        const segredos = flags.has("segredos-stdin") ? (((await lerEntradaStdin())["segredos"] as unknown[]) ?? []).filter((s): s is string => typeof s === "string") : [];
        const resultados = lerJson<ResultadoCaso[]>(exigir(o, "resultados"));
        const r = criarPacoteEvidencias({
          destino: exigir(o, "destino"),
          origens: exigir(o, "origens").split("|").filter(Boolean),
          resultados: Array.isArray(resultados) ? resultados : [],
          repositorio: resolve(import.meta.dir, "..", "..", ".."),
          raizIsolada: raizIsolada(o["raiz"]),
          segredos,
          descricao: o["descricao"],
        });
        resultado = { id: r.id, pasta: r.pasta, arquivos: r.arquivos.length, excluidos: r.excluidos, conferencia: conferirPacote(r.pasta) };
        break;
      }
      case "conferir-pacote":
        resultado = conferirPacote(exigir(o, "pasta"));
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
