import { BSON, MongoServerError, type Db, type Document } from "mongodb";
import { normalizarIndice, type IndiceNormalizado } from "./archive.js";
import { COLECOES_BACKUP, RESTORE } from "./politica.js";

/**
 * Fase 60.4.3.4.21.2.4 (R21-2.3-01) — POSSE EXCLUSIVA do destino de restore.
 *
 * Causa raiz do defeito: a "posse" era um booleano calculado UMA vez (destino inexistente antes da escrita) e a limpeza
 * usava `dropDatabase`, que apaga tudo — inclusive o que outra operação gravou depois da verificação.
 *
 * Modelo:
 *   1. AQUISIÇÃO ATÔMICA: inserção do documento de posse `_id: "posse"` (único) com o `execucaoId` na coleção de
 *      controle — exatamente um processo vence (os demais: E11000). O banco precisa conter SÓ essa coleção — senão só a
 *      própria coleção de controle é removida (e só se a posse nela for desta execução).
 *   2. LIMPEZA (nunca `dropDatabase`): posse ATUAL comprovada → recusa se houver coleção fora do archive → CONGELA as
 *      coleções do archive (validador que rejeita qualquer escrita) → confere que todo `_id` existe no archive e todo
 *      índice existe no manifesto → só então remove coleção por coleção, a de controle por último. Qualquer divergência:
 *      descongela, não remove nada, `FALHOU_DESTINO_PARCIAL`. Coleção alheia criada durante a limpeza nunca é removida.
 */

export const COLECAO_POSSE = RESTORE.colecaoPosse;
const ID_POSSE = "posse";
/** Validador que rejeita QUALQUER inserção/atualização (congelamento durante a verificação e a remoção). */
const VALIDADOR_CONGELADO = { $expr: { $eq: [1, 0] } };

export interface DocumentoPosse {
  _id: typeof ID_POSSE;
  execucaoId: string;
  pid: number;
  processoInicio: string;
  banco: string;
  archive: string;
  archiveSha256: string;
  manifesto: string;
  criadoEm: Date;
}

/** Chave canônica de um `_id` vindo do banco (mesma forma de `idsDoArchive`): bytes BSON do elemento `_id`. */
export function chaveDoId(id: unknown): string {
  const b = Buffer.from(BSON.serialize({ _id: id }));
  return b.subarray(4, b.length - 1).toString("hex");
}

interface InfoColecao {
  nome: string;
  tipo: string;
  opcoes: Document;
  /** UUID da coleção (muda se ela for apagada e recriada com o mesmo nome). */
  uuid: string | null;
}

async function nomesColecoes(db: Db): Promise<InfoColecao[]> {
  return (await db.listCollections({}, { nameOnly: false }).toArray())
    .filter((c) => !c.name.startsWith("system."))
    .map((c) => {
      const uuid = (c as { info?: { uuid?: { toString(enc: string): string } } }).info?.uuid;
      return { nome: c.name, tipo: (c as { type?: string }).type ?? "collection", opcoes: (c as { options?: Document }).options ?? {}, uuid: uuid ? uuid.toString("hex") : null };
    });
}

const congelada = (c: InfoColecao) => JSON.stringify(c.opcoes["validator"] ?? null) === JSON.stringify(VALIDADOR_CONGELADO);

async function documentosDePosse(db: Db): Promise<Document[]> {
  return db.collection(COLECAO_POSSE).find({}).limit(10).toArray();
}

/** A posse é desta execução AGORA? (exatamente um documento de posse, com o mesmo `execucaoId`). */
export async function posseAtual(db: Db, execucaoId: string): Promise<{ ok: boolean; detalhe: string; documento: Document | null }> {
  const existe = (await nomesColecoes(db)).some((c) => c.nome === COLECAO_POSSE);
  if (!existe) return { ok: false, detalhe: "coleção de posse ausente", documento: null };
  const docs = await documentosDePosse(db);
  if (docs.length !== 1 || docs[0]!["_id"] !== ID_POSSE) return { ok: false, detalhe: `coleção de posse com ${docs.length} documento(s) inesperado(s)`, documento: docs[0] ?? null };
  if (docs[0]!["execucaoId"] !== execucaoId) return { ok: false, detalhe: "posse pertence a OUTRA execução", documento: docs[0]! };
  return { ok: true, detalhe: "posse desta execução", documento: docs[0]! };
}

export type ResultadoAquisicao = { adquirida: true } | { adquirida: false; motivo: "POSSE_JA_EXISTE" | "DESTINO_COM_DADOS"; colecoesAlheias: string[]; controleRemovido: boolean };

/**
 * A ATOMICIDADE vem do `_id` ÚNICO do documento de posse (`_id: "posse"`): entre N processos simultâneos, exatamente um
 * `insertOne` vence; os demais recebem E11000. (`create` NÃO serve de primitiva: no MongoDB 8.0 criar uma coleção que já
 * existe com as mesmas opções é idempotente e não falha — comprovado no teste T01c.)
 */
export async function adquirirPosse(db: Db, posse: Omit<DocumentoPosse, "_id" | "criadoEm">): Promise<ResultadoAquisicao> {
  const jaExiste = async (): Promise<ResultadoAquisicao> => ({
    adquirida: false,
    motivo: "POSSE_JA_EXISTE",
    colecoesAlheias: (await nomesColecoes(db)).map((c) => c.nome).filter((n) => n !== COLECAO_POSSE),
    controleRemovido: false,
  });
  try {
    await db.createCollection(COLECAO_POSSE);
  } catch (erro) {
    if (!(erro instanceof MongoServerError && (erro.code === 48 || erro.codeName === "NamespaceExists"))) throw erro;
  }
  try {
    await db.collection<DocumentoPosse>(COLECAO_POSSE).insertOne({ _id: ID_POSSE, ...posse, criadoEm: new Date() });
  } catch (erro) {
    if (erro instanceof MongoServerError && erro.code === 11000) return jaExiste();
    throw erro;
  }
  // A coleção de controle pode ter sido criada por outro agente; documento extra nela ⇒ não é posse exclusiva.
  if ((await db.collection(COLECAO_POSSE).countDocuments({})) !== 1) {
    await db.collection(COLECAO_POSSE).deleteOne({ _id: ID_POSSE as never, execucaoId: posse.execucaoId });
    return jaExiste();
  }
  const outras = (await nomesColecoes(db)).map((c) => c.nome).filter((n) => n !== COLECAO_POSSE);
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

/** Restore concluído: remove SÓ a coleção de controle, e só se a posse ainda for desta execução. */
export async function finalizarPosse(db: Db, execucaoId: string): Promise<{ finalizada: boolean; detalhe: string }> {
  const atual = await posseAtual(db, execucaoId);
  if (!atual.ok) return { finalizada: false, detalhe: atual.detalhe };
  await db.collection(COLECAO_POSSE).drop();
  return { finalizada: true, detalhe: "coleção de controle removida" };
}

export interface ReferenciaArchive {
  /** `_id` (chave canônica) de cada coleção do archive. */
  idsPorColecao: Map<string, Set<string>>;
  /** Índices normalizados de cada coleção, segundo o manifesto. */
  indicesPorColecao: Record<string, IndiceNormalizado[]>;
}

export interface GanchosLimpeza {
  /** SOMENTE TESTES: chamados nos pontos sensíveis da limpeza (prova de concorrência). */
  aposCongelar?: () => Promise<void>;
  aposVerificar?: () => Promise<void>;
}

export type ResultadoLimpeza =
  | { limpo: true; removidas: string[] }
  | {
      limpo: false;
      motivo: "POSSE_NAO_COMPROVADA" | "COLECOES_ALHEIAS" | "DADOS_ALHEIOS" | "ALHEIO_CRIADO_DURANTE_LIMPEZA";
      detalhe: string;
      removidas: string[];
      preservadas: string[];
    };

async function congelar(db: Db, nome: string): Promise<void> {
  await db.command({ collMod: nome, validator: VALIDADOR_CONGELADO, validationLevel: "strict", validationAction: "error" });
}

async function descongelar(db: Db, nome: string, opcoes: Document): Promise<void> {
  await db.command({
    collMod: nome,
    validator: opcoes["validator"] ?? {},
    validationLevel: opcoes["validationLevel"] ?? "strict",
    validationAction: opcoes["validationAction"] ?? "error",
  });
}

/**
 * Limpeza SEGURA de um destino desta execução. Nunca `dropDatabase`; nunca remove coleção, documento ou índice que não
 * pertença ao archive ou à execução. Falha fechada em qualquer dúvida.
 */
export async function limparDestinoComPosse(db: Db, execucaoId: string, ref: ReferenciaArchive, ganchos: GanchosLimpeza = {}): Promise<ResultadoLimpeza> {
  const posse = await posseAtual(db, execucaoId);
  const nomesAntes = (await nomesColecoes(db)).map((c) => c.nome);
  if (!posse.ok) return { limpo: false, motivo: "POSSE_NAO_COMPROVADA", detalhe: posse.detalhe, removidas: [], preservadas: nomesAntes };

  const colecoes = await nomesColecoes(db);
  const permitidas = new Set<string>([...COLECOES_BACKUP, COLECAO_POSSE]);
  const alheias = colecoes.filter((c) => !permitidas.has(c.nome) || c.tipo !== "collection").map((c) => c.nome);
  if (alheias.length) return { limpo: false, motivo: "COLECOES_ALHEIAS", detalhe: `coleções fora do archive: ${alheias.join(", ")}`, removidas: [], preservadas: colecoes.map((c) => c.nome) };

  const alvo = colecoes.filter((c) => c.nome !== COLECAO_POSSE);
  const congeladas: typeof alvo = [];
  const falhar = async (motivo: "DADOS_ALHEIOS" | "POSSE_NAO_COMPROVADA", detalhe: string): Promise<ResultadoLimpeza> => {
    for (const c of congeladas) await descongelar(db, c.nome, c.opcoes).catch(() => undefined);
    return { limpo: false, motivo, detalhe, removidas: [], preservadas: (await nomesColecoes(db)).map((x) => x.nome) };
  };

  // Congela ANTES de verificar: a partir daqui nenhuma inserção/atualização (sem bypass) entra nas coleções verificadas.
  for (const c of alvo) {
    await congelar(db, c.nome);
    congeladas.push(c);
  }
  await ganchos.aposCongelar?.();

  for (const c of alvo) {
    const esperados = ref.idsPorColecao.get(c.nome) ?? new Set<string>();
    let alheios = 0;
    for await (const d of db.collection(c.nome).find({}, { projection: { _id: 1 }, promoteValues: false, promoteLongs: false })) {
      if (!esperados.has(chaveDoId(d["_id"]))) alheios += 1;
    }
    if (alheios) return falhar("DADOS_ALHEIOS", `${alheios} documento(s) fora do archive em ${c.nome}`);
    const permitidos = new Set((ref.indicesPorColecao[c.nome] ?? []).map((i) => JSON.stringify(i)));
    const indicesAlheios = (await db.collection(c.nome).indexes()).map((i) => normalizarIndice(i as Document)).filter((i) => !permitidos.has(JSON.stringify(i)));
    if (indicesAlheios.length) return falhar("DADOS_ALHEIOS", `índice(s) fora do manifesto em ${c.nome}: ${indicesAlheios.map((i) => i.nome).join(", ")}`);
  }
  const posseDepois = await posseAtual(db, execucaoId);
  if (!posseDepois.ok) return falhar("POSSE_NAO_COMPROVADA", `posse mudou durante a verificação: ${posseDepois.detalhe}`);
  await ganchos.aposVerificar?.();

  const removidas: string[] = [];
  for (const c of alvo) {
    // Defesa adicional: a coleção a remover é a MESMA que foi congelada e verificada (UUID) e continua congelada.
    // Se alguém a apagou e recriou (ou descongelou) no meio do caminho, ela não é removida.
    const agora = (await nomesColecoes(db)).find((x) => x.nome === c.nome);
    if (!agora || !c.uuid || agora.uuid !== c.uuid || !congelada(agora)) continue;
    await db.collection(c.nome).drop();
    removidas.push(c.nome);
  }
  // Controle por último, só se TODAS as coleções do alvo saíram e a posse continuar desta execução (senão a posse fica
  // como evidência para a intervenção manual).
  if (removidas.length === alvo.length && (await posseAtual(db, execucaoId)).ok) {
    await db.collection(COLECAO_POSSE).drop();
    removidas.push(COLECAO_POSSE);
  }
  const restantes = (await nomesColecoes(db)).map((c) => c.nome);
  if (restantes.length) {
    return { limpo: false, motivo: "ALHEIO_CRIADO_DURANTE_LIMPEZA", detalhe: `preservado(s): ${restantes.join(", ")}`, removidas, preservadas: restantes };
  }
  return { limpo: true, removidas };
}
