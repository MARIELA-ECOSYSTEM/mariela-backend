import { BSON, MongoServerError, type Db, type Document } from "mongodb";
import type { IndiceNormalizado, Verificacao } from "./archive.js";
import { compararConteudoDoDestino, compararIndices, resumoComparacao, type ComparacaoColecao, type ConteudoColecao } from "./integridade.js";
import { COLECOES_BACKUP, RESTORE, transicaoPermitida, type EstadoDestino } from "./politica.js";

/**
 * POSSE EXCLUSIVA E PERSISTENTE do destino de restore.
 *
 * Fase 60.4.3.4.21.2.4 (R21-2.3-01): a "posse" era um booleano calculado uma vez e a limpeza usava `dropDatabase`.
 * Fase 60.4.3.4.21.2.6 (auditoria 21.2.5):
 *   A-01  o destino só é VERIFICADO depois de CONGELADO e comparado BYTE A BYTE com o archive; a posse NÃO é removida no
 *         sucesso — fica `VERIFICADO` (com as evidências) até o operador liberar ou remover.
 *   A-04  a limpeza compara o CONTEÚDO de cada documento (não só o `_id`).
 *   A-05  toda remoção usa `drop` com `collectionUUID` (o servidor recusa atomicamente se a coleção não for a mesma) e
 *         reconfere posse, estado e congelamento imediatamente antes de cada coleção.
 *   A-07  o congelamento aplicado POR uma limpeza recusada é desfeito em `finally` — mas nunca o de um destino que já
 *         estava protegido (VALIDANDO/VERIFICADO/...).
 *
 * Atomicidade: o documento `_id: "posse"` é único — exatamente um processo vence a inserção (os demais: E11000).
 * Mudança de estado: compare-and-set (`updateOne` filtrando por `execucaoId` E estado atual).
 */

export const COLECAO_POSSE = RESTORE.colecaoPosse;
const ID_POSSE = "posse";
/** Validador que rejeita QUALQUER inserção/atualização. Com autenticação, só quem tem `collMod` o remove. */
export const VALIDADOR_CONGELADO = { $expr: { $eq: [1, 0] } };

export interface EvidenciasIntegridade {
  verificadoEm: string;
  documentos: number;
  hashesPorColecao: Record<string, string>;
  uuidsPorColecao: Record<string, string>;
  indicesTotal: number;
  verificacoes: Verificacao[];
}

export interface DocumentoPosse {
  _id: typeof ID_POSSE;
  execucaoId: string;
  estado: EstadoDestino;
  pid: number;
  processoInicio: string;
  processoInicioTicks: string;
  executavel: string;
  banco: string;
  archive: string;
  archiveSha256: string;
  manifesto: string;
  manifestoSha256: string;
  criadoEm: Date;
  atualizadoEm: Date;
  historico: { estado: EstadoDestino; em: Date; detalhe: string }[];
  evidencias?: EvidenciasIntegridade;
  liberacao?: { autorizadaEm: Date; operador: string; operacaoId: string };
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

export async function infoColecoes(db: Db): Promise<InfoColecao[]> {
  return (await db.listCollections({}, { nameOnly: false }).toArray())
    .filter((c) => !c.name.startsWith("system."))
    .map((c) => {
      const uuid = (c as { info?: { uuid?: BSON.UUID } }).info?.uuid ?? null;
      return { nome: c.name, tipo: (c as { type?: string }).type ?? "collection", opcoes: (c as { options?: Document }).options ?? {}, uuid };
    });
}

const hexUuid = (u: BSON.UUID | null) => (u ? Buffer.from(u.buffer).toString("hex") : null);
export const estaCongelada = (c: InfoColecao) => JSON.stringify(c.opcoes["validator"] ?? null) === JSON.stringify(VALIDADOR_CONGELADO);

async function documentosDePosse(db: Db): Promise<Document[]> {
  return db.collection(COLECAO_POSSE).find({}).limit(10).toArray();
}

/** A posse é desta execução AGORA? (exatamente um documento de posse, com o mesmo `execucaoId`). */
export async function posseAtual(db: Db, execucaoId: string): Promise<{ ok: boolean; detalhe: string; documento: DocumentoPosse | null }> {
  const existe = (await infoColecoes(db)).some((c) => c.nome === COLECAO_POSSE);
  if (!existe) return { ok: false, detalhe: "coleção de posse ausente", documento: null };
  const docs = await documentosDePosse(db);
  const doc = (docs[0] ?? null) as DocumentoPosse | null;
  if (docs.length !== 1 || doc?._id !== ID_POSSE) return { ok: false, detalhe: `coleção de posse com ${docs.length} documento(s) inesperado(s)`, documento: doc };
  if (doc.execucaoId !== execucaoId) return { ok: false, detalhe: "posse pertence a OUTRA execução", documento: doc };
  return { ok: true, detalhe: `posse desta execução (estado ${doc.estado})`, documento: doc };
}

export type ResultadoAquisicao = { adquirida: true } | { adquirida: false; motivo: "POSSE_JA_EXISTE" | "DESTINO_COM_DADOS"; colecoesAlheias: string[]; controleRemovido: boolean };

export type DadosPosse = Omit<DocumentoPosse, "_id" | "criadoEm" | "atualizadoEm" | "estado" | "historico" | "evidencias" | "liberacao" | "intervencao">;

/**
 * Aquisição ATÔMICA (estado inicial PREPARANDO). A atomicidade vem do `_id` ÚNICO (`insertOne`): `create` não serve de
 * primitiva — no MongoDB 8.0 criar uma coleção existente com as mesmas opções é idempotente (Fase 21.2.4, T01c).
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
  // O banco já tinha dados de alguém: remove SÓ a própria coleção de controle (se continuar só com a nossa posse).
  const atual = await posseAtual(db, posse.execucaoId);
  let controleRemovido = false;
  if (atual.ok) {
    await db.collection(COLECAO_POSSE).drop();
    controleRemovido = true;
  }
  return { adquirida: false, motivo: "DESTINO_COM_DADOS", colecoesAlheias: outras, controleRemovido };
}

/**
 * Transição de estado por COMPARE-AND-SET: só aplica se a posse ainda for desta execução, o estado ainda for o lido e a
 * transição for permitida pela máquina de estados. Devolve o estado anterior.
 */
export async function transicionar(db: Db, execucaoId: string, para: EstadoDestino, detalhe: string, extra: Partial<DocumentoPosse> = {}, permitidosDe?: readonly EstadoDestino[]): Promise<{ ok: boolean; de: EstadoDestino | null; detalhe: string }> {
  const atual = await posseAtual(db, execucaoId);
  if (!atual.ok || !atual.documento) return { ok: false, de: null, detalhe: atual.detalhe };
  const de = atual.documento.estado;
  if (permitidosDe && !permitidosDe.includes(de)) return { ok: false, de, detalhe: `estado ${de} não admite esta operação` };
  if (!transicaoPermitida(de, para)) return { ok: false, de, detalhe: `transição ${de} → ${para} não permitida` };
  const agora = new Date();
  const r = await db.collection<DocumentoPosse>(COLECAO_POSSE).updateOne(
    { _id: ID_POSSE, execucaoId, estado: de },
    { $set: { ...extra, estado: para, atualizadoEm: agora }, $push: { historico: { estado: para, em: agora, detalhe } } },
  );
  return r.modifiedCount === 1 ? { ok: true, de, detalhe: `${de} → ${para}` } : { ok: false, de, detalhe: "a posse mudou durante a transição" };
}

async function congelar(db: Db, c: InfoColecao): Promise<void> {
  await db.command({ collMod: c.nome, ...(c.uuid ? { collectionUUID: c.uuid } : {}), validator: VALIDADOR_CONGELADO, validationLevel: "strict", validationAction: "error" });
}

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
  /** Índices normalizados de cada coleção, segundo o manifesto. */
  indicesPorColecao: Record<string, IndiceNormalizado[]>;
}

/** Congela TODAS as coleções do archive presentes no destino (antes da validação). Recusa coleção fora da política. */
export async function congelarDestino(db: Db): Promise<{ ok: boolean; detalhe: string; congeladas: string[] }> {
  const cs = await infoColecoes(db);
  const permitidas = new Set<string>([...COLECOES_BACKUP, COLECAO_POSSE]);
  const alheias = cs.filter((c) => !permitidas.has(c.nome) || c.tipo !== "collection").map((c) => c.nome);
  if (alheias.length) return { ok: false, detalhe: `coleções fora do archive: ${alheias.join(", ")}`, congeladas: [] };
  const alvo = cs.filter((c) => c.nome !== COLECAO_POSSE);
  for (const c of alvo) await congelar(db, c);
  return { ok: true, detalhe: `${alvo.length} coleções congeladas`, congeladas: alvo.map((c) => c.nome) };
}

/**
 * Verificação INTEGRAL do destino (A-01): posse desta execução; coleções EXATAMENTE as 27 + controle; todas congeladas;
 * conteúdo byte a byte igual ao archive; índices iguais ao manifesto. Devolve evidências reproduzíveis.
 */
export async function verificarDestino(db: Db, execucaoId: string, ref: ReferenciaArchive): Promise<{ ok: boolean; verificacoes: Verificacao[]; evidencias: EvidenciasIntegridade; comparacoes: ComparacaoColecao[] }> {
  const v: Verificacao[] = [];
  const posse = await posseAtual(db, execucaoId);
  v.push({ id: "posse.desta_execucao", ok: posse.ok, detalhe: posse.detalhe });
  const cs = await infoColecoes(db);
  const nomes = cs.map((c) => c.nome).sort();
  const esperadas = [...COLECOES_BACKUP, COLECAO_POSSE].sort();
  v.push({ id: "destino.colecoes_exatas", ok: JSON.stringify(nomes) === JSON.stringify(esperadas) && cs.every((c) => c.tipo === "collection"), detalhe: `${nomes.length} coleções; esperadas ${esperadas.length} (27 + controle)` });
  const dados = cs.filter((c) => c.nome !== COLECAO_POSSE);
  const naoCongeladas = dados.filter((c) => !estaCongelada(c)).map((c) => c.nome);
  v.push({ id: "destino.protegido", ok: naoCongeladas.length === 0 && dados.length > 0, detalhe: naoCongeladas.length ? `sem proteção: ${naoCongeladas.join(", ")}` : `${dados.length} coleções congeladas` });
  const comparacoes = await compararConteudoDoDestino(db, ref.conteudoPorColecao, COLECOES_BACKUP, "igual");
  v.push(resumoComparacao(comparacoes));
  const idxRuins: string[] = [];
  let indicesTotal = 0;
  for (const c of COLECOES_BACKUP) {
    if (!nomes.includes(c)) continue;
    const r = await compararIndices(db, c, ref.indicesPorColecao[c] ?? [], "igual");
    indicesTotal += (ref.indicesPorColecao[c] ?? []).length;
    if (!r.ok) idxRuins.push(`${c}(alheios=${r.alheios.join("|") || "-"}, faltando=${r.faltando.join("|") || "-"})`);
  }
  v.push({ id: "destino.indices_exatos", ok: idxRuins.length === 0, detalhe: idxRuins.length ? idxRuins.join("; ") : `${indicesTotal} índices idênticos ao manifesto` });
  const evidencias: EvidenciasIntegridade = {
    verificadoEm: new Date().toISOString(),
    documentos: comparacoes.reduce((s, c) => s + c.encontrados, 0),
    hashesPorColecao: Object.fromEntries(comparacoes.map((c) => [c.colecao, c.hashEncontrado])),
    uuidsPorColecao: Object.fromEntries(dados.map((c) => [c.nome, hexUuid(c.uuid) ?? "?"])),
    indicesTotal,
    verificacoes: v,
  };
  return { ok: v.every((x) => x.ok), verificacoes: v, evidencias, comparacoes };
}

/** As evidências de agora são as MESMAS registradas (mesmo conteúdo, mesmas coleções/UUID)? */
export function mesmasEvidencias(a: EvidenciasIntegridade, b: EvidenciasIntegridade): boolean {
  return JSON.stringify(a.hashesPorColecao) === JSON.stringify(b.hashesPorColecao) && JSON.stringify(a.uuidsPorColecao) === JSON.stringify(b.uuidsPorColecao) && a.documentos === b.documentos;
}

export interface GanchosLimpeza {
  /** SOMENTE TESTES: chamados nos pontos sensíveis da limpeza (prova de concorrência). */
  aposCongelar?: () => Promise<void>;
  aposVerificar?: () => Promise<void>;
  antesDeRemover?: (colecao: string) => Promise<void>;
}

export type MotivoRecusaLimpeza = "POSSE_NAO_COMPROVADA" | "ESTADO_INCOMPATIVEL" | "COLECOES_ALHEIAS" | "DADOS_ALHEIOS" | "ALHEIO_CRIADO_DURANTE_LIMPEZA" | "REMOCAO_INCOMPLETA";

export type ResultadoLimpeza =
  | { limpo: true; removidas: string[]; estadoFinal: "CANCELADO_COM_LIMPEZA_COMPROVADA" }
  | { limpo: false; motivo: MotivoRecusaLimpeza; detalhe: string; removidas: string[]; preservadas: string[]; estadoFinal: EstadoDestino | null };

/**
 * Limpeza COMPROVADA de um destino desta execução (nunca `dropDatabase`). Remove SÓ o que é provadamente do archive:
 * coleções da política, conteúdo de cada documento IDÊNTICO a um documento do archive (subconjunto) e índices do
 * manifesto. Qualquer dúvida ⇒ nada (mais) é removido e a posse vai para INTERVENCAO_NECESSARIA.
 */
export async function limparDestinoComPosse(db: Db, execucaoId: string, ref: ReferenciaArchive, estadosPermitidos: readonly EstadoDestino[], ganchos: GanchosLimpeza = {}): Promise<ResultadoLimpeza> {
  const nomesAgora = async () => (await infoColecoes(db)).map((x) => x.nome);
  const intervir = async (motivo: MotivoRecusaLimpeza, detalhe: string, removidas: string[] = []): Promise<ResultadoLimpeza> => {
    const t = await transicionar(db, execucaoId, "INTERVENCAO_NECESSARIA", `${motivo}: ${detalhe}`, { intervencao: { em: new Date(), motivo: `${motivo}: ${detalhe}` } }).catch(() => ({ ok: false }));
    return { limpo: false, motivo, detalhe, removidas, preservadas: await nomesAgora(), estadoFinal: t.ok ? "INTERVENCAO_NECESSARIA" : null };
  };

  const posse = await posseAtual(db, execucaoId);
  if (!posse.ok || !posse.documento) return { limpo: false, motivo: "POSSE_NAO_COMPROVADA", detalhe: posse.detalhe, removidas: [], preservadas: await nomesAgora(), estadoFinal: null };
  if (!estadosPermitidos.includes(posse.documento.estado)) {
    return { limpo: false, motivo: "ESTADO_INCOMPATIVEL", detalhe: `estado ${posse.documento.estado} não admite esta limpeza`, removidas: [], preservadas: await nomesAgora(), estadoFinal: posse.documento.estado };
  }

  const cs = await infoColecoes(db);
  const permitidas = new Set<string>([...COLECOES_BACKUP, COLECAO_POSSE]);
  const alheias = cs.filter((c) => !permitidas.has(c.nome) || c.tipo !== "collection").map((c) => c.nome);
  if (alheias.length) return intervir("COLECOES_ALHEIAS", `coleções fora do archive: ${alheias.join(", ")}`);

  const alvo = cs.filter((c) => c.nome !== COLECAO_POSSE);
  // A-07: só o congelamento aplicado POR ESTA limpeza é desfeito numa recusa (proteção prévia nunca é removida).
  const congeladasAqui: InfoColecao[] = [];
  let concluiu = false;
  try {
    for (const c of alvo) {
      if (estaCongelada(c)) continue;
      await congelar(db, c);
      congeladasAqui.push(c);
    }
    await ganchos.aposCongelar?.();

    const comp = await compararConteudoDoDestino(db, ref.conteudoPorColecao, alvo.map((c) => c.nome), "subconjunto");
    const ruins = comp.filter((c) => !c.ok);
    if (ruins.length) return await intervir("DADOS_ALHEIOS", resumoComparacao(comp).detalhe);
    for (const c of alvo) {
      const r = await compararIndices(db, c.nome, ref.indicesPorColecao[c.nome] ?? [], "subconjunto");
      if (!r.ok) return await intervir("DADOS_ALHEIOS", `índice(s) fora do manifesto em ${c.nome}: ${r.alheios.join(", ")}`);
    }
    const posseDepois = await posseAtual(db, execucaoId);
    if (!posseDepois.ok || !posseDepois.documento || !estadosPermitidos.includes(posseDepois.documento.estado)) {
      return { limpo: false, motivo: "POSSE_NAO_COMPROVADA", detalhe: `posse mudou durante a verificação: ${posseDepois.detalhe}`, removidas: [], preservadas: await nomesAgora(), estadoFinal: null };
    }
    await ganchos.aposVerificar?.();
    concluiu = true;
  } finally {
    if (!concluiu) for (const c of congeladasAqui) await descongelar(db, c).catch(() => undefined);
  }

  const removidas: string[] = [];
  for (const c of alvo) {
    await ganchos.antesDeRemover?.(c.nome);
    // Imediatamente antes de CADA remoção: posse e estado ainda desta execução; coleção ainda congelada e a MESMA.
    const p = await posseAtual(db, execucaoId);
    if (!p.ok || !p.documento || !estadosPermitidos.includes(p.documento.estado)) break;
    const agora = (await infoColecoes(db)).find((x) => x.nome === c.nome);
    if (!agora || !c.uuid || hexUuid(agora.uuid) !== hexUuid(c.uuid) || !estaCongelada(agora)) continue;
    try {
      // `collectionUUID`: o servidor recusa (CollectionUUIDMismatch, 361) se o nome não aponta mais para ESTA coleção.
      await db.command({ drop: c.nome, collectionUUID: c.uuid });
      removidas.push(c.nome);
    } catch (erro) {
      if (erro instanceof MongoServerError && (erro.code === 361 || erro.code === 26)) continue;
      throw erro;
    }
  }
  if (removidas.length !== alvo.length) return intervir("REMOCAO_INCOMPLETA", `removidas ${removidas.length} de ${alvo.length}; o restante foi preservado`, removidas);

  const t = await transicionar(db, execucaoId, "CANCELADO_COM_LIMPEZA_COMPROVADA", "todas as coleções do archive removidas com prova de conteúdo");
  if (!t.ok) return { limpo: false, motivo: "POSSE_NAO_COMPROVADA", detalhe: `posse mudou antes do encerramento: ${t.detalhe}`, removidas, preservadas: await nomesAgora(), estadoFinal: null };
  const controle = (await infoColecoes(db)).find((x) => x.nome === COLECAO_POSSE);
  if (controle?.uuid) await db.command({ drop: COLECAO_POSSE, collectionUUID: controle.uuid });
  removidas.push(COLECAO_POSSE);
  const restantes = await nomesAgora();
  if (restantes.length) return { limpo: false, motivo: "ALHEIO_CRIADO_DURANTE_LIMPEZA", detalhe: `preservado(s): ${restantes.join(", ")}`, removidas, preservadas: restantes, estadoFinal: "CANCELADO_COM_LIMPEZA_COMPROVADA" };
  return { limpo: true, removidas, estadoFinal: "CANCELADO_COM_LIMPEZA_COMPROVADA" };
}
