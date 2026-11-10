import { createHash } from "node:crypto";
import { BSON, MongoServerError, type Db, type Document } from "mongodb";
import type { EspecificacaoIndice, Verificacao } from "./archive.js";
import { compararConteudoDoDestino, compararIndices, compararOpcoesColecao, resumoComparacao, type ComparacaoColecao, type ConteudoColecao } from "./integridade.js";
import { COLECOES_BACKUP, ESTADOS_FINAIS, RESTORE, transicaoPermitida, type EstadoDestino } from "./politica.js";

/**
 * POSSE EXCLUSIVA E PERSISTENTE do destino de restore.
 *
 * 21.2.4 (R21-2.3-01): posse atômica (`_id: "posse"` único) e limpeza sem `dropDatabase`.
 * 21.2.6 (A-01…A-07): VERIFICADO com comparação byte a byte; `collectionUUID` no `drop`; descongelamento controlado.
 * 21.2.8 (auditoria 21.2.7):
 *   A21-7-01  `estaCongelada` exige validador E `validationLevel: "strict"` E `validationAction: "error"` — UMA definição,
 *             usada em todos os pontos (verificação, PASSOU, Liberar, uso, limpeza antes de cada drop, recuperação).
 *   A21-7-02  toda transição é registrada na âncora EXTERNA (intenção antes, confirmação depois) — `Ancorador`.
 *   A21-7-03  índices pela especificação COMPLETA e opções de coleção comparadas com o archive.
 *   A21-7-04  estado REMOVENDO antes do primeiro drop; retomada idempotente.
 *   A21-7-05  EM_USO (descongelado, sem garantia de igualdade) e descarte de destino usado.
 *   A21-7-06  a posse guarda e confere o NOME do banco e o `instanciaId`.
 *   A21-7-07  conclusão do CANCELADO/DESCARTADO com a coleção de controle órfã; `removidas` só com drop efetivo;
 *             `system.*` no destino é tratado como alheio (nunca se declara "banco removido" com objetos restantes).
 */

export const COLECAO_POSSE = RESTORE.colecaoPosse;
const ID_POSSE = "posse";
/** Validador que rejeita QUALQUER inserção/atualização. */
export const VALIDADOR_CONGELADO = { $expr: { $eq: [1, 0] } };

export interface EvidenciasIntegridade {
  verificadoEm: string;
  documentos: number;
  hashesPorColecao: Record<string, string>;
  uuidsPorColecao: Record<string, string>;
  /** SHA-256 das especificações completas de índice e das opções de coleção (A21-7-03). */
  indicesHash: string;
  opcoesHash: string;
  indicesTotal: number;
  verificacoes?: Verificacao[];
}

export interface DocumentoPosse {
  _id: typeof ID_POSSE;
  execucaoId: string;
  estado: EstadoDestino;
  banco: string;
  instanciaId: string;
  pid: number;
  processoInicio: string;
  processoInicioTicks: string;
  executavel: string;
  archive: string;
  archiveSha256: string;
  manifesto: string;
  manifestoSha256: string;
  criadoEm: Date;
  atualizadoEm: Date;
  historico: { estado: EstadoDestino; em: Date; detalhe: string }[];
  evidencias?: EvidenciasIntegridade;
  liberacao?: { autorizadaEm: Date; operador: string; operacaoId: string };
  uso?: { iniciadoEm: Date; operador: string; operacaoId: string; uuidsPorColecao: Record<string, string> };
  remocao?: { modo: ModoLimpeza; iniciadaEm: Date; operacaoId: string; alvo: { nome: string; uuid: string }[] };
  intervencao?: { em: Date; motivo: string };
}

export function chaveDoId(id: unknown): string {
  const b = Buffer.from(BSON.serialize({ _id: id }));
  return b.subarray(4, b.length - 1).toString("hex");
}

export interface InfoColecao {
  nome: string;
  tipo: string;
  opcoes: Document;
  uuid: BSON.UUID | null;
}

/** TODAS as coleções do banco, inclusive `system.*` (A21-7-08: nada fica invisível). */
export async function infoColecoes(db: Db): Promise<InfoColecao[]> {
  return (await db.listCollections({}, { nameOnly: false }).toArray()).map((c) => {
    const uuid = (c as { info?: { uuid?: BSON.UUID } }).info?.uuid ?? null;
    return { nome: c.name, tipo: (c as { type?: string }).type ?? "collection", opcoes: (c as { options?: Document }).options ?? {}, uuid };
  });
}

export const hexUuid = (u: BSON.UUID | null) => (u ? Buffer.from(u.buffer).toString("hex") : null);

function canonicoOrdenado(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  const tipo = (v as { _bsontype?: string })._bsontype;
  if (tipo === "Int32" || tipo === "Double" || tipo === "Long") return Number(String(v));
  if (Array.isArray(v)) return v.map(canonicoOrdenado);
  return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, canonicoOrdenado((v as Record<string, unknown>)[k])]));
}

/**
 * A21-7-01 — ÚNICA definição de "congelado": validador estruturalmente igual ao de congelamento E nível "strict" E ação
 * "error". Ausência de qualquer um, valor inesperado ou opção ilegível ⇒ NÃO congelado (falha fechada).
 */
export function estaCongelada(c: Pick<InfoColecao, "opcoes">): boolean {
  try {
    const o = c.opcoes ?? {};
    if (o["validationLevel"] !== "strict" || o["validationAction"] !== "error") return false;
    if (o["validator"] === undefined || o["validator"] === null) return false;
    return JSON.stringify(canonicoOrdenado(o["validator"])) === JSON.stringify(canonicoOrdenado(VALIDADOR_CONGELADO));
  } catch {
    return false;
  }
}

/** A21-7-06 — a posse lida é desta execução, deste banco e desta instância? (PURA) */
export function conferirIdentidadePosse(doc: Partial<DocumentoPosse> | null, esperado: { execucaoId: string; banco: string; instanciaId: string }): { ok: boolean; detalhe: string } {
  if (!doc) return { ok: false, detalhe: "sem documento de posse" };
  if (doc.execucaoId !== esperado.execucaoId) return { ok: false, detalhe: "posse pertence a OUTRA execução" };
  if (doc.banco !== esperado.banco) return { ok: false, detalhe: `posse registrada para OUTRO banco (${doc.banco ?? "?"})` };
  if (!doc.instanciaId || doc.instanciaId !== esperado.instanciaId) return { ok: false, detalhe: "posse registrada para OUTRA instância (ou sem identidade de instância)" };
  return { ok: true, detalhe: `posse desta execução, deste banco e desta instância (estado ${doc.estado})` };
}

/** A posse é desta execução AGORA, neste banco e nesta instância? (exatamente um documento de posse) */
export async function posseAtual(db: Db, execucaoId: string, instanciaId: string): Promise<{ ok: boolean; detalhe: string; documento: DocumentoPosse | null }> {
  const existe = (await infoColecoes(db)).some((c) => c.nome === COLECAO_POSSE);
  if (!existe) return { ok: false, detalhe: "coleção de posse ausente", documento: null };
  const docs = await db.collection(COLECAO_POSSE).find({}).limit(10).toArray();
  const doc = (docs[0] ?? null) as unknown as DocumentoPosse | null;
  if (docs.length !== 1 || doc?._id !== ID_POSSE) return { ok: false, detalhe: `coleção de posse com ${docs.length} documento(s) inesperado(s)`, documento: doc };
  const id = conferirIdentidadePosse(doc, { execucaoId, banco: db.databaseName, instanciaId });
  return { ok: id.ok, detalhe: id.detalhe, documento: doc };
}

export type ResultadoAquisicao = { adquirida: true } | { adquirida: false; motivo: "POSSE_JA_EXISTE" | "DESTINO_COM_DADOS"; colecoesAlheias: string[]; controleRemovido: boolean };

export type DadosPosse = Omit<DocumentoPosse, "_id" | "criadoEm" | "atualizadoEm" | "estado" | "historico" | "evidencias" | "liberacao" | "uso" | "remocao" | "intervencao">;

/**
 * Aquisição ATÔMICA (estado inicial PREPARANDO): `_id` ÚNICO (`insertOne`; E11000 para os demais). A âncora externa
 * (evento POSSE) é criada pelo chamador ANTES desta chamada.
 */
export async function adquirirPosse(db: Db, posse: DadosPosse): Promise<ResultadoAquisicao> {
  const jaExiste = async (): Promise<ResultadoAquisicao> => ({
    adquirida: false,
    motivo: "POSSE_JA_EXISTE",
    colecoesAlheias: (await infoColecoes(db)).map((c) => c.nome).filter((n) => n !== COLECAO_POSSE),
    controleRemovido: false,
  });
  try {
    await db.createCollection(COLECAO_POSSE);
  } catch (erro) {
    if (!(erro instanceof MongoServerError && (erro.code === 48 || erro.codeName === "NamespaceExists"))) throw erro;
  }
  const agora = new Date();
  try {
    await db.collection<DocumentoPosse>(COLECAO_POSSE).insertOne({
      _id: ID_POSSE,
      ...posse,
      estado: "PREPARANDO",
      criadoEm: agora,
      atualizadoEm: agora,
      historico: [{ estado: "PREPARANDO", em: agora, detalhe: "posse adquirida" }],
    });
  } catch (erro) {
    if (erro instanceof MongoServerError && erro.code === 11000) return jaExiste();
    throw erro;
  }
  if ((await db.collection(COLECAO_POSSE).countDocuments({})) !== 1) {
    await db.collection(COLECAO_POSSE).deleteOne({ _id: ID_POSSE as never, execucaoId: posse.execucaoId });
    return jaExiste();
  }
  const outras = (await infoColecoes(db)).map((c) => c.nome).filter((n) => n !== COLECAO_POSSE);
  if (outras.length === 0) return { adquirida: true };
  const atual = await posseAtual(db, posse.execucaoId, posse.instanciaId);
  let controleRemovido = false;
  if (atual.ok) {
    await db.collection(COLECAO_POSSE).drop();
    controleRemovido = true;
  }
  return { adquirida: false, motivo: "DESTINO_COM_DADOS", colecoesAlheias: outras, controleRemovido };
}

/** A21-7-02 — quem registra as transições na âncora externa (intenção ANTES do CAS; confirmação DEPOIS). */
export interface Ancorador {
  intencao(de: EstadoDestino, para: EstadoDestino, detalhe: string): void;
  confirmacao(de: EstadoDestino, para: EstadoDestino, detalhe: string): void;
  evidencias(e: EvidenciasIntegridade): void;
}

/** Decisão PURA da transição (testável sem banco). */
export function decidirTransicao(de: EstadoDestino, para: EstadoDestino, permitidosDe?: readonly EstadoDestino[]): { ok: boolean; detalhe: string } {
  if (permitidosDe && !permitidosDe.includes(de)) return { ok: false, detalhe: `estado ${de} não admite esta operação` };
  if (!transicaoPermitida(de, para)) return { ok: false, detalhe: `transição ${de} → ${para} não permitida` };
  return { ok: true, detalhe: `${de} → ${para}` };
}

/**
 * Transição por COMPARE-AND-SET (filtra execucaoId, banco, instanciaId E estado lido), com intenção e confirmação na
 * âncora externa. Uma queda entre intenção e confirmação deixa o banco no `de` ou no `para` — ambos admitidos pela âncora.
 */
export async function transicionar(db: Db, execucaoId: string, instanciaId: string, para: EstadoDestino, detalhe: string, ancora: Ancorador, extra: Partial<DocumentoPosse> = {}, permitidosDe?: readonly EstadoDestino[]): Promise<{ ok: boolean; de: EstadoDestino | null; detalhe: string }> {
  const atual = await posseAtual(db, execucaoId, instanciaId);
  if (!atual.ok || !atual.documento) return { ok: false, de: null, detalhe: atual.detalhe };
  const de = atual.documento.estado;
  const d = decidirTransicao(de, para, permitidosDe);
  if (!d.ok) return { ok: false, de, detalhe: d.detalhe };
  ancora.intencao(de, para, detalhe);
  const agora = new Date();
  const r = await db.collection<DocumentoPosse>(COLECAO_POSSE).updateOne(
    { _id: ID_POSSE, execucaoId, banco: db.databaseName, instanciaId, estado: de },
    { $set: { ...extra, estado: para, atualizadoEm: agora }, $push: { historico: { estado: para, em: agora, detalhe } } },
  );
  if (r.modifiedCount !== 1) return { ok: false, de, detalhe: "a posse mudou durante a transição" };
  ancora.confirmacao(de, para, detalhe);
  return { ok: true, de, detalhe: `${de} → ${para}` };
}

async function congelar(db: Db, c: InfoColecao): Promise<void> {
  await db.command({ collMod: c.nome, ...(c.uuid ? { collectionUUID: c.uuid } : {}), validator: VALIDADOR_CONGELADO, validationLevel: "strict", validationAction: "error" });
}

/** Volta ao trio de validação ORIGINAL (o que a coleção tinha antes de ESTA operação congelá-la). */
async function descongelar(db: Db, c: InfoColecao): Promise<void> {
  await db.command({
    collMod: c.nome,
    ...(c.uuid ? { collectionUUID: c.uuid } : {}),
    validator: c.opcoes["validator"] ?? {},
    validationLevel: c.opcoes["validationLevel"] ?? "strict",
    validationAction: c.opcoes["validationAction"] ?? "error",
  });
}

export interface ReferenciaArchive {
  /** Conteúdo esperado (chave do `_id` → SHA-256 dos bytes) por coleção. */
  conteudoPorColecao: Map<string, ConteudoColecao>;
  /** Especificações COMPLETAS de índice por coleção, do archive (A21-7-03). */
  especificacoesPorColecao: Record<string, EspecificacaoIndice[]>;
  /** Opções de coleção do archive (A21-7-03). */
  opcoesPorColecao: Record<string, Record<string, unknown>>;
}

const permitidas = () => new Set<string>([...COLECOES_BACKUP, COLECAO_POSSE]);
/** Coleções que NÃO podem estar no destino: fora da política, `system.*` ou não-coleção (view…). */
export function colecoesAlheias(cs: Pick<InfoColecao, "nome" | "tipo">[]): string[] {
  const p = permitidas();
  return cs.filter((c) => c.nome.startsWith("system.") || !p.has(c.nome) || c.tipo !== "collection").map((c) => c.nome);
}

/** Congela TODAS as coleções do archive presentes no destino (antes da validação). Recusa coleção alheia. */
export async function congelarDestino(db: Db): Promise<{ ok: boolean; detalhe: string; congeladas: string[] }> {
  const cs = await infoColecoes(db);
  const alheias = colecoesAlheias(cs);
  if (alheias.length) return { ok: false, detalhe: `coleções fora do archive: ${alheias.join(", ")}`, congeladas: [] };
  const alvo = cs.filter((c) => c.nome !== COLECAO_POSSE);
  for (const c of alvo) await congelar(db, c);
  return { ok: true, detalhe: `${alvo.length} coleções congeladas`, congeladas: alvo.map((c) => c.nome) };
}

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

/**
 * Verificação INTEGRAL do destino: posse desta execução/banco/instância; coleções EXATAMENTE as 27 + controle (nenhuma
 * `system.*`); todas congeladas por completo; conteúdo byte a byte igual ao archive; índices (especificação completa) e
 * opções de coleção iguais ao archive.
 */
export async function verificarDestino(db: Db, execucaoId: string, instanciaId: string, ref: ReferenciaArchive): Promise<{ ok: boolean; verificacoes: Verificacao[]; evidencias: EvidenciasIntegridade; comparacoes: ComparacaoColecao[] }> {
  const v: Verificacao[] = [];
  const posse = await posseAtual(db, execucaoId, instanciaId);
  v.push({ id: "posse.desta_execucao", ok: posse.ok, detalhe: posse.detalhe });
  const cs = await infoColecoes(db);
  const nomes = cs.map((c) => c.nome).sort();
  const esperadas = [...COLECOES_BACKUP, COLECAO_POSSE].sort();
  v.push({ id: "destino.colecoes_exatas", ok: JSON.stringify(nomes) === JSON.stringify(esperadas) && colecoesAlheias(cs).length === 0, detalhe: `${nomes.length} coleções (inclusive system.*); esperadas ${esperadas.length} (27 + controle)` });
  const dados = cs.filter((c) => c.nome !== COLECAO_POSSE && !c.nome.startsWith("system."));
  const naoCongeladas = dados.filter((c) => !estaCongelada(c)).map((c) => c.nome);
  v.push({ id: "destino.protegido", ok: naoCongeladas.length === 0 && dados.length > 0, detalhe: naoCongeladas.length ? `sem proteção completa (validador+nível+ação): ${naoCongeladas.join(", ")}` : `${dados.length} coleções congeladas (validador, strict, error)` });
  const comparacoes = await compararConteudoDoDestino(db, ref.conteudoPorColecao, COLECOES_BACKUP, "igual");
  v.push(resumoComparacao(comparacoes));
  const idxRuins: string[] = [];
  const optRuins: string[] = [];
  const specs: string[] = [];
  const opts: string[] = [];
  let indicesTotal = 0;
  for (const c of COLECOES_BACKUP) {
    const info = cs.find((x) => x.nome === c);
    if (!info) continue;
    const esperadosIdx = ref.especificacoesPorColecao[c] ?? [];
    const r = await compararIndices(db, c, esperadosIdx, "igual");
    indicesTotal += esperadosIdx.length;
    specs.push(`${c}:${esperadosIdx.map((e) => e.especificacao).join("|")}`);
    if (!r.ok) idxRuins.push(`${c}(alheios=${r.alheios.join("|") || "-"}, faltando=${r.faltando.join("|") || "-"})`);
    const o = compararOpcoesColecao(info.opcoes, ref.opcoesPorColecao[c]);
    opts.push(`${c}:${o.atual}`);
    if (!o.ok) optRuins.push(`${c}(atual=${o.atual}, archive=${o.esperado})`);
  }
  v.push({ id: "destino.indices_exatos", ok: idxRuins.length === 0, detalhe: idxRuins.length ? idxRuins.join("; ") : `${indicesTotal} índices idênticos ao archive (especificação completa)` });
  v.push({ id: "destino.opcoes_colecao", ok: optRuins.length === 0, detalhe: optRuins.length ? optRuins.join("; ") : "opções de coleção iguais ao archive" });
  const evidencias: EvidenciasIntegridade = {
    verificadoEm: new Date().toISOString(),
    documentos: comparacoes.reduce((s, c) => s + c.encontrados, 0),
    hashesPorColecao: Object.fromEntries(comparacoes.map((c) => [c.colecao, c.hashEncontrado])),
    uuidsPorColecao: Object.fromEntries(dados.map((c) => [c.nome, hexUuid(c.uuid) ?? "?"])),
    indicesHash: sha(specs.sort().join("\n")),
    opcoesHash: sha(opts.sort().join("\n")),
    indicesTotal,
    verificacoes: v,
  };
  return { ok: v.every((x) => x.ok), verificacoes: v, evidencias, comparacoes };
}

/** As evidências de agora são as MESMAS registradas? (conteúdo, UUIDs, índices, opções) */
export function mesmasEvidencias(a: Pick<EvidenciasIntegridade, "hashesPorColecao" | "uuidsPorColecao" | "documentos"> & Partial<EvidenciasIntegridade>, b: Pick<EvidenciasIntegridade, "hashesPorColecao" | "uuidsPorColecao" | "documentos"> & Partial<EvidenciasIntegridade>): boolean {
  return (
    JSON.stringify(a.hashesPorColecao) === JSON.stringify(b.hashesPorColecao) &&
    JSON.stringify(a.uuidsPorColecao) === JSON.stringify(b.uuidsPorColecao) &&
    a.documentos === b.documentos &&
    a.indicesHash === b.indicesHash &&
    a.opcoesHash === b.opcoesHash
  );
}

/**
 * A21-7-05 — INÍCIO DE USO (LIBERACAO_AUTORIZADA → EM_USO). A transição vem PRIMEIRO (a partir dela o destino não é mais
 * declarado íntegro nem imutável) e só então as coleções são descongeladas (trio de validação do ARCHIVE). Uma queda no
 * meio deixa EM_USO ainda congelado — repetir o comando conclui o descongelamento (idempotente).
 */
export async function iniciarUso(db: Db, execucaoId: string, instanciaId: string, ref: ReferenciaArchive, operador: string, operacaoId: string, ancora: Ancorador): Promise<{ ok: boolean; estado: EstadoDestino | null; detalhe: string; descongeladas: string[] }> {
  const p = await posseAtual(db, execucaoId, instanciaId);
  if (!p.ok || !p.documento) return { ok: false, estado: p.documento?.estado ?? null, detalhe: p.detalhe, descongeladas: [] };
  if (p.documento.estado === "LIBERACAO_AUTORIZADA") {
    const cs = await infoColecoes(db);
    const uuids = Object.fromEntries(cs.filter((c) => c.nome !== COLECAO_POSSE).map((c) => [c.nome, hexUuid(c.uuid) ?? "?"]));
    const t = await transicionar(db, execucaoId, instanciaId, "EM_USO", `uso iniciado por ${operador}`, ancora, { uso: { iniciadoEm: new Date(), operador, operacaoId, uuidsPorColecao: uuids } }, ["LIBERACAO_AUTORIZADA"]);
    if (!t.ok) return { ok: false, estado: t.de, detalhe: t.detalhe, descongeladas: [] };
  } else if (p.documento.estado !== "EM_USO") {
    return { ok: false, estado: p.documento.estado, detalhe: `início de uso exige LIBERACAO_AUTORIZADA (estado ${p.documento.estado})`, descongeladas: [] };
  }
  const descongeladas: string[] = [];
  for (const c of await infoColecoes(db)) {
    if (c.nome === COLECAO_POSSE || !estaCongelada(c)) continue;
    const orig = ref.opcoesPorColecao[c.nome] ?? {};
    await db.command({ collMod: c.nome, ...(c.uuid ? { collectionUUID: c.uuid } : {}), validator: (orig["validator"] as Document) ?? {}, validationLevel: (orig["validationLevel"] as string) ?? "strict", validationAction: (orig["validationAction"] as string) ?? "error" });
    descongeladas.push(c.nome);
  }
  return { ok: true, estado: "EM_USO", detalhe: `EM_USO: ${descongeladas.length} coleções descongeladas; o destino NÃO é mais garantido igual ao archive`, descongeladas };
}

export interface GanchosLimpeza {
  /** SOMENTE TESTES: chamados nos pontos sensíveis da limpeza (prova de concorrência). */
  aposCongelar?: () => Promise<void>;
  aposVerificar?: () => Promise<void>;
  antesDeRemover?: (colecao: string) => Promise<void>;
}

/**
 * Modos de limpeza:
 *   falha        restore que falhou (FALHOU_DESTINO_PARCIAL) — conteúdo ⊆ archive;
 *   recuperacao  execução interrompida (dono encerrado) — conteúdo ⊆ archive; também conclui REMOVENDO e o CANCELADO/
 *                DESCARTADO com a coleção de controle órfã;
 *   remocao      decisão do operador sobre VERIFICADO/LIBERACAO_AUTORIZADA — conteúdo ⊆ archive;
 *   descarte     destino USADO (EM_USO) — sem igualdade com o archive (deixou de valer no uso); só coleções da política
 *                com o MESMO UUID registrado no início do uso; coleção alheia/recriada ⇒ nada (mais) é removido.
 */
export type ModoLimpeza = "falha" | "recuperacao" | "remocao" | "descarte";

export const ESTADOS_POR_MODO: Record<ModoLimpeza, readonly EstadoDestino[]> = {
  falha: ["FALHOU_DESTINO_PARCIAL", "REMOVENDO"],
  recuperacao: ["PREPARANDO", "RESTAURANDO", "VALIDANDO", "FALHOU_DESTINO_PARCIAL", "INTERVENCAO_NECESSARIA", "REMOVENDO", "CANCELADO_COM_LIMPEZA_COMPROVADA", "DESCARTADO"],
  remocao: ["VERIFICADO", "LIBERACAO_AUTORIZADA", "REMOVENDO"],
  descarte: ["EM_USO", "REMOVENDO"],
};

export type MotivoRecusaLimpeza =
  | "POSSE_NAO_COMPROVADA"
  | "ESTADO_INCOMPATIVEL"
  | "COLECOES_ALHEIAS"
  | "DADOS_ALHEIOS"
  | "UUID_DIVERGENTE"
  | "ALHEIO_CRIADO_DURANTE_LIMPEZA"
  | "REMOCAO_INCOMPLETA"
  | "RESIDUOS_APOS_ESTADO_FINAL";

export type ResultadoLimpeza =
  | { limpo: true; removidas: string[]; estadoFinal: "CANCELADO_COM_LIMPEZA_COMPROVADA" | "DESCARTADO"; bancoRemovido: boolean; restantes: string[] }
  | { limpo: false; motivo: MotivoRecusaLimpeza; detalhe: string; removidas: string[]; preservadas: string[]; estadoFinal: EstadoDestino | null };

/**
 * Plano PURO da limpeza a partir do estado e das coleções presentes (testável sem banco).
 *   "concluir-controle": estado final com SÓ a coleção de controle restante (queda entre o estado final e o drop dela);
 *   "recusar": motivo; "remover": seguir com a verificação e a remoção.
 */
export function planoDeLimpeza(estado: EstadoDestino, modo: ModoLimpeza, colecoes: Pick<InfoColecao, "nome" | "tipo">[]): { acao: "concluir-controle" | "recusar" | "remover"; motivo?: MotivoRecusaLimpeza; detalhe: string } {
  if (!ESTADOS_POR_MODO[modo].includes(estado)) return { acao: "recusar", motivo: "ESTADO_INCOMPATIVEL", detalhe: `estado ${estado} não admite a limpeza '${modo}'` };
  const alheias = colecoesAlheias(colecoes);
  if (ESTADOS_FINAIS.includes(estado)) {
    const resto = colecoes.filter((c) => c.nome !== COLECAO_POSSE);
    if (resto.length === 0) return { acao: "concluir-controle", detalhe: `estado final ${estado} com a coleção de controle órfã` };
    return { acao: "recusar", motivo: "RESIDUOS_APOS_ESTADO_FINAL", detalhe: `estado final ${estado}, mas restam: ${resto.map((c) => c.nome).join(", ")}` };
  }
  if (alheias.length) return { acao: "recusar", motivo: "COLECOES_ALHEIAS", detalhe: `coleções fora do archive (inclusive system.*): ${alheias.join(", ")}` };
  return { acao: "remover", detalhe: "verificar e remover" };
}

async function removerControle(db: Db): Promise<boolean> {
  const controle = (await infoColecoes(db)).find((x) => x.nome === COLECAO_POSSE);
  if (!controle?.uuid) return false;
  try {
    await db.command({ drop: COLECAO_POSSE, collectionUUID: controle.uuid });
    return true;
  } catch (erro) {
    if (erro instanceof MongoServerError && (erro.code === 361 || erro.code === 26)) return false;
    throw erro;
  }
}

async function bancoExiste(db: Db): Promise<boolean> {
  const r = await db.admin().listDatabases({ nameOnly: true });
  return r.databases.some((d) => d.name === db.databaseName);
}

/**
 * Limpeza COMPROVADA (nunca `dropDatabase`). Antes do primeiro drop: posse/identidade, coleções, CONGELAMENTO COMPLETO,
 * conteúdo/índices/opções (ou UUIDs no descarte), e CAS para REMOVENDO. Imediatamente antes de cada drop: trava (gancho
 * do chamador), posse em REMOVENDO, coleção ainda COMPLETAMENTE congelada e com o mesmo UUID — e `drop` com
 * `collectionUUID`. Qualquer dúvida ⇒ nada (mais) é removido e a posse vai para INTERVENCAO_NECESSARIA (com a lista do
 * que já foi removido) — nunca fica num estado que sugira integridade.
 */
export async function limparDestinoComPosse(db: Db, execucaoId: string, instanciaId: string, ref: ReferenciaArchive, modo: ModoLimpeza, operacaoId: string, ancora: Ancorador, ganchos: GanchosLimpeza = {}): Promise<ResultadoLimpeza> {
  const nomesAgora = async () => (await infoColecoes(db)).map((x) => x.nome);
  const intervir = async (motivo: MotivoRecusaLimpeza, detalhe: string, removidas: string[] = []): Promise<ResultadoLimpeza> => {
    const t = await transicionar(db, execucaoId, instanciaId, "INTERVENCAO_NECESSARIA", `${motivo}: ${detalhe}`, ancora, { intervencao: { em: new Date(), motivo: `${motivo}: ${detalhe}${removidas.length ? ` (já removidas: ${removidas.join(", ")})` : ""}` } }).catch(() => ({ ok: false }));
    return { limpo: false, motivo, detalhe, removidas, preservadas: await nomesAgora(), estadoFinal: t.ok ? "INTERVENCAO_NECESSARIA" : null };
  };

  const posse = await posseAtual(db, execucaoId, instanciaId);
  if (!posse.ok || !posse.documento) return { limpo: false, motivo: "POSSE_NAO_COMPROVADA", detalhe: posse.detalhe, removidas: [], preservadas: await nomesAgora(), estadoFinal: null };
  const estado = posse.documento.estado;
  // Retomada de REMOVENDO: só no MESMO modo que a iniciou (um descarte nunca vira remoção comprovada e vice-versa).
  if (estado === "REMOVENDO" && posse.documento.remocao && posse.documento.remocao.modo !== modo && modo !== "recuperacao") {
    return { limpo: false, motivo: "ESTADO_INCOMPATIVEL", detalhe: `REMOVENDO iniciado no modo '${posse.documento.remocao.modo}'`, removidas: [], preservadas: await nomesAgora(), estadoFinal: estado };
  }
  const modoEfetivo: ModoLimpeza = estado === "REMOVENDO" && posse.documento.remocao ? posse.documento.remocao.modo : modo;
  const cs = await infoColecoes(db);
  const plano = planoDeLimpeza(estado, modo, cs);
  if (plano.acao === "concluir-controle") {
    const ok = await removerControle(db);
    const restantes = await nomesAgora();
    return ok && restantes.length === 0
      ? { limpo: true, removidas: [COLECAO_POSSE], estadoFinal: estado as "CANCELADO_COM_LIMPEZA_COMPROVADA" | "DESCARTADO", bancoRemovido: !(await bancoExiste(db)), restantes }
      : { limpo: false, motivo: "RESIDUOS_APOS_ESTADO_FINAL", detalhe: `controle ${ok ? "removido" : "NÃO removido"}; restam ${restantes.join(", ") || "-"}`, removidas: ok ? [COLECAO_POSSE] : [], preservadas: restantes, estadoFinal: estado };
  }
  if (plano.acao === "recusar") {
    if (plano.motivo === "ESTADO_INCOMPATIVEL" || plano.motivo === "RESIDUOS_APOS_ESTADO_FINAL") return { limpo: false, motivo: plano.motivo!, detalhe: plano.detalhe, removidas: [], preservadas: await nomesAgora(), estadoFinal: estado };
    return intervir(plano.motivo!, plano.detalhe);
  }

  const alvo = cs.filter((c) => c.nome !== COLECAO_POSSE);
  const congeladasAqui: InfoColecao[] = [];
  let verificado = false;
  try {
    for (const c of alvo) {
      if (estaCongelada(c)) continue;
      await congelar(db, c);
      congeladasAqui.push(c);
    }
    await ganchos.aposCongelar?.();

    if (modoEfetivo === "descarte") {
      // Destino USADO: igualdade com o archive deixou de valer. Só coleções com o MESMO UUID do início do uso.
      const uuidsUso = posse.documento.uso?.uuidsPorColecao ?? {};
      const divergentes = alvo.filter((c) => uuidsUso[c.nome] === undefined || uuidsUso[c.nome] !== hexUuid(c.uuid)).map((c) => c.nome);
      if (divergentes.length) return await intervir("UUID_DIVERGENTE", `coleções criadas/recriadas durante o uso (preservadas): ${divergentes.join(", ")}`);
    } else {
      const comp = await compararConteudoDoDestino(db, ref.conteudoPorColecao, alvo.map((c) => c.nome), "subconjunto");
      if (comp.some((c) => !c.ok)) return await intervir("DADOS_ALHEIOS", resumoComparacao(comp).detalhe);
      for (const c of alvo) {
        const r = await compararIndices(db, c.nome, ref.especificacoesPorColecao[c.nome] ?? [], "subconjunto");
        if (!r.ok) return await intervir("DADOS_ALHEIOS", `índice(s) fora do archive em ${c.nome}: ${r.alheios.join(", ")}`);
        const o = compararOpcoesColecao(c.opcoes, ref.opcoesPorColecao[c.nome]);
        if (!o.ok) return await intervir("DADOS_ALHEIOS", `opções de coleção diferentes do archive em ${c.nome}`);
      }
    }
    const posseDepois = await posseAtual(db, execucaoId, instanciaId);
    if (!posseDepois.ok || posseDepois.documento?.estado !== estado) {
      return { limpo: false, motivo: "POSSE_NAO_COMPROVADA", detalhe: `posse mudou durante a verificação: ${posseDepois.detalhe}`, removidas: [], preservadas: await nomesAgora(), estadoFinal: null };
    }
    await ganchos.aposVerificar?.();
    verificado = true;
  } finally {
    if (!verificado) for (const c of congeladasAqui) await descongelar(db, c).catch(() => undefined);
  }

  // A21-7-04 — REMOVENDO ANTES do primeiro drop (nunca VERIFICADO/LIBERACAO com o destino parcial).
  if (estado !== "REMOVENDO") {
    const t = await transicionar(db, execucaoId, instanciaId, "REMOVENDO", `remoção '${modoEfetivo}' iniciada`, ancora, { remocao: { modo: modoEfetivo, iniciadaEm: new Date(), operacaoId, alvo: alvo.map((c) => ({ nome: c.nome, uuid: hexUuid(c.uuid) ?? "?" })) } }, [estado]);
    if (!t.ok) return { limpo: false, motivo: "POSSE_NAO_COMPROVADA", detalhe: `transição para REMOVENDO recusada: ${t.detalhe}`, removidas: [], preservadas: await nomesAgora(), estadoFinal: t.de };
  }

  const removidas: string[] = [];
  for (const c of alvo) {
    await ganchos.antesDeRemover?.(c.nome);
    const p = await posseAtual(db, execucaoId, instanciaId);
    if (!p.ok || p.documento?.estado !== "REMOVENDO") break;
    const agora = (await infoColecoes(db)).find((x) => x.nome === c.nome);
    if (!agora || !c.uuid || hexUuid(agora.uuid) !== hexUuid(c.uuid) || !estaCongelada(agora)) continue;
    try {
      // `collectionUUID`: o servidor recusa (CollectionUUIDMismatch, 361) se o nome não aponta mais para ESTA coleção.
      await db.command({ drop: c.nome, collectionUUID: c.uuid });
      removidas.push(c.nome);
    } catch (erro) {
      if (erro instanceof MongoServerError && (erro.code === 361 || erro.code === 26)) continue;
      return intervir("REMOCAO_INCOMPLETA", `erro ao remover ${c.nome}: ${(erro as Error).message}`, removidas);
    }
  }
  if (removidas.length !== alvo.length) return intervir("REMOCAO_INCOMPLETA", `removidas ${removidas.length} de ${alvo.length}; o restante foi preservado`, removidas);

  const final: "CANCELADO_COM_LIMPEZA_COMPROVADA" | "DESCARTADO" = modoEfetivo === "descarte" ? "DESCARTADO" : "CANCELADO_COM_LIMPEZA_COMPROVADA";
  const tf = await transicionar(db, execucaoId, instanciaId, final, modoEfetivo === "descarte" ? "destino usado descartado (coleções do uso, mesmo UUID)" : "todas as coleções do archive removidas com prova de conteúdo", ancora, {}, ["REMOVENDO"]);
  if (!tf.ok) return { limpo: false, motivo: "POSSE_NAO_COMPROVADA", detalhe: `posse mudou antes do encerramento: ${tf.detalhe}`, removidas, preservadas: await nomesAgora(), estadoFinal: tf.de };
  // A21-7-07: só registra o controle como removido se o drop dele aconteceu; e só declara o banco removido se ele sumiu.
  if (await removerControle(db)) removidas.push(COLECAO_POSSE);
  const restantes = await nomesAgora();
  if (restantes.length) return { limpo: false, motivo: "ALHEIO_CRIADO_DURANTE_LIMPEZA", detalhe: `preservado(s): ${restantes.join(", ")}`, removidas, preservadas: restantes, estadoFinal: final };
  return { limpo: true, removidas, estadoFinal: final, bancoRemovido: !(await bancoExiste(db)), restantes };
}
