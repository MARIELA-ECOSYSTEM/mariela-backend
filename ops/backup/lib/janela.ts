import { createHash } from "node:crypto";
// `ObjectId`/`EJSON` vêm do MESMO pacote do driver: `instanceof` funciona com os documentos que ele devolve.
import { BSON, ObjectId, type Db, type Document } from "mongodb";

const { EJSON } = BSON;
import { normalizarIndice, ordenarIndices, type IndiceNormalizado, type Verificacao } from "./archive.js";
import { COLECOES_BACKUP, COLECOES_EXCLUIDAS, SEQUENCIAS_E_CODIGOS } from "./politica.js";

/**
 * Fase 60.4.3.4.21.2 — elegibilidade da janela sem escrita e "assinaturas" do banco de origem. TUDO aqui é LEITURA
 * (count, aggregate $group/$max, distinct, find com projeção mínima, listCollections, listIndexes). Nada escreve.
 * A janela é uma CONDIÇÃO de elegibilidade: nada aqui para, bloqueia ou altera a API, o worker ou o banco.
 */

// ---------------------------------------------------------------------------------------------------------------
// Decisões puras (testáveis sem banco)
// ---------------------------------------------------------------------------------------------------------------

/** Último horário-alvo (hora:minuto LOCAL) que já passou em relação a `agora`. */
export function ultimoMarcoDaJanela(agora: Date, hora: number, minuto: number): Date {
  const marco = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate(), hora, minuto, 0, 0);
  if (marco.getTime() > agora.getTime()) marco.setDate(marco.getDate() - 1);
  return marco;
}

/**
 * Backup DIÁRIO devido? Devido a partir do último horário-alvo; já feito se existe diário VÁLIDO iniciado depois
 * dele. Computador ligado depois do horário (ou execução perdida) → continua devido: a tarefa roda ao ligar, mas só
 * coleta se as verificações da janela passarem (nunca "imediatamente" sem verificação).
 */
export function avaliarDevido(agora: Date, ultimoDiarioValidoEm: Date | null, hora: number, minuto: number): { devido: boolean; marco: string; motivo: string } {
  const marco = ultimoMarcoDaJanela(agora, hora, minuto);
  if (ultimoDiarioValidoEm && ultimoDiarioValidoEm.getTime() >= marco.getTime()) {
    return { devido: false, marco: marco.toISOString(), motivo: "JA_REALIZADO: existe diário válido depois do último horário-alvo" };
  }
  return { devido: true, marco: marco.toISOString(), motivo: "DEVIDO" };
}

export interface AssinaturaColecao {
  contagem: number;
  /** Maior `atualizadoEm`/`criadoEm` (ISO) — `null` se a coleção não tem esses campos. */
  maiorTimestamp: string | null;
  /** SHA-256 do conteúdo, só para coleções SEM timestamp (pequenas: `sequencias`, `configuracoes`). */
  hashConteudo: string | null;
}
export type Assinatura = Record<string, AssinaturaColecao>;

/** Período sem escrita: o maior timestamp de TODAS as coleções tem de ser anterior a `agora − quietMinutos`. */
export function verificarPeriodoSemEscrita(assinatura: Assinatura, agora: Date, quietMinutos: number): Verificacao {
  const limite = agora.getTime() - quietMinutos * 60_000;
  const recentes = Object.entries(assinatura)
    .filter(([, a]) => a.maiorTimestamp !== null && Date.parse(a.maiorTimestamp) > limite) // futuro também conta como recente
    .map(([nome, a]) => `${nome}@${a.maiorTimestamp}`);
  const maior = Object.values(assinatura)
    .map((a) => (a.maiorTimestamp ? Date.parse(a.maiorTimestamp) : 0))
    .reduce((x, y) => Math.max(x, y), 0);
  const minutos = maior ? Math.floor((agora.getTime() - maior) / 60_000) : null;
  return {
    id: "janela.sem_escrita",
    ok: recentes.length === 0,
    detalhe: recentes.length
      ? `escrita nos últimos ${quietMinutos} min: ${recentes.join(", ")}`
      : `última escrita registrada há ${minutos === null ? "∞ (sem timestamps)" : `${minutos} min`} (mínimo ${quietMinutos})`,
  };
}

/** Assinaturas antes/depois: iguais ⇒ nenhuma escrita DETECTÁVEL durante o dump (contagem, maior timestamp, hash). */
export function compararAssinaturas(antes: Assinatura, depois: Assinatura): { iguais: boolean; divergentes: string[] } {
  const nomes = [...new Set([...Object.keys(antes), ...Object.keys(depois)])].sort();
  const divergentes = nomes.filter((n) => JSON.stringify(antes[n] ?? null) !== JSON.stringify(depois[n] ?? null));
  return { iguais: divergentes.length === 0, divergentes };
}

// ---------------------------------------------------------------------------------------------------------------
// Leituras (somente leitura)
// ---------------------------------------------------------------------------------------------------------------

/** Limite para hash de conteúdo (coleções sem timestamp). Acima disso não há assinatura confiável → falha fechada. */
export const LIMITE_DOCS_HASH = 5000;

export class AssinaturaNaoConfiavelErro extends Error {
  constructor(colecao: string) {
    super(`coleção '${colecao}' sem timestamps e grande demais para hash de conteúdo`);
    this.name = "AssinaturaNaoConfiavelErro";
  }
}

export async function lerAssinatura(db: Db, colecoes: readonly string[]): Promise<Assinatura> {
  const assinatura: Assinatura = {};
  for (const nome of colecoes) {
    const col = db.collection(nome);
    const contagem = await col.countDocuments({});
    const [maximos] = await col.aggregate<{ a: Date | null; c: Date | null }>([{ $group: { _id: null, a: { $max: "$atualizadoEm" }, c: { $max: "$criadoEm" } } }]).toArray();
    const datas = [maximos?.a, maximos?.c].filter((d): d is Date => d instanceof Date);
    const maiorTimestamp = datas.length ? new Date(Math.max(...datas.map((d) => d.getTime()))).toISOString() : null;
    let hashConteudo: string | null = null;
    if (contagem > 0 && maiorTimestamp === null) {
      if (contagem > LIMITE_DOCS_HASH) throw new AssinaturaNaoConfiavelErro(nome);
      const docs = await col.find({}).sort({ _id: 1 }).toArray();
      hashConteudo = createHash("sha256").update(EJSON.stringify(docs, { relaxed: false })).digest("hex").toUpperCase();
    }
    assinatura[nome] = { contagem, maiorTimestamp, hashConteudo };
  }
  return assinatura;
}

export async function verificarColecoesDaOrigem(db: Db): Promise<{ existentes: string[]; desconhecidas: string[]; faltando: string[]; naoColecao: string[] }> {
  const lista = await db.listCollections({}, { nameOnly: false }).toArray();
  const existentes = lista.map((c) => c.name).filter((n) => !n.startsWith("system.")).sort();
  const conhecidas = new Set<string>([...COLECOES_BACKUP, ...COLECOES_EXCLUIDAS]);
  return {
    existentes,
    desconhecidas: existentes.filter((n) => !conhecidas.has(n)),
    faltando: COLECOES_BACKUP.filter((n) => !existentes.includes(n)),
    naoColecao: lista.filter((c) => (c as { type?: string }).type !== "collection").map((c) => c.name),
  };
}

export async function lerIndices(db: Db, colecoes: readonly string[]): Promise<Record<string, IndiceNormalizado[]>> {
  const r: Record<string, IndiceNormalizado[]> = {};
  for (const nome of colecoes) r[nome] = ordenarIndices((await db.collection(nome).indexes()).map((i) => normalizarIndice(i as Document)));
  return r;
}

const comoTexto = (v: unknown): string | null => (v instanceof ObjectId ? v.toHexString() : typeof v === "string" ? v : null);

async function idsDe(db: Db, colecao: string): Promise<Set<string>> {
  const ids = await db.collection(colecao).distinct("_id");
  return new Set(ids.map(comoTexto).filter((x): x is string => x !== null));
}

async function orfaos(db: Db, colecao: string, campo: string, alvo: Set<string>): Promise<number> {
  const valores = (await db.collection(colecao).distinct(campo)).map(comoTexto).filter((x): x is string => x !== null);
  return valores.filter((v) => !alvo.has(v)).length;
}

/** Referências entre entidades: NÚMERO DE IDS ÓRFÃOS por regra (o restore precisa reproduzir exatamente a origem). */
export async function lerReferencias(db: Db): Promise<Record<string, number>> {
  const produtos = await idsDe(db, "produtos");
  const caixas = await idsDe(db, "caixas");
  const vendas = await idsDe(db, "vendas");
  return {
    "vendas.itens.produtoId→produtos": await orfaos(db, "vendas", "itens.produtoId", produtos),
    "vendas.caixaId→caixas": await orfaos(db, "vendas", "caixaId", caixas),
    "movimentos_caixa.caixaId→caixas": await orfaos(db, "movimentos_caixa", "caixaId", caixas),
    "movimentos_caixa.vendaId→vendas": await orfaos(db, "movimentos_caixa", "vendaId", vendas),
    "movimentacoes_estoque.produtoId→produtos": await orfaos(db, "movimentacoes_estoque", "produtoId", produtos),
    "movimentacoes_estoque.vendaId→vendas": await orfaos(db, "movimentacoes_estoque", "vendaId", vendas),
    "uploads_midia.produtoId→produtos": await orfaos(db, "uploads_midia", "produtoId", produtos),
  };
}

export interface EstadoSequencia {
  valor: number | null;
  maiorEmitido: number | null;
  ok: boolean;
}

/** `sequencias.valor` ≥ maior código numérico já emitido na entidade (senão a próxima criação colide). */
export async function lerSequencias(db: Db): Promise<Record<string, EstadoSequencia>> {
  const r: Record<string, EstadoSequencia> = {};
  for (const [chave, { colecao, campo }] of Object.entries(SEQUENCIAS_E_CODIGOS)) {
    const doc = await db.collection<{ _id: string; valor?: number }>("sequencias").findOne({ _id: chave }, { projection: { valor: 1 } });
    const valor = typeof doc?.valor === "number" ? doc.valor : null;
    const codigos = await db.collection(colecao).find({}, { projection: { _id: 0, [campo]: 1 } }).toArray();
    const numeros = codigos.map((c) => /(\d+)$/.exec(String(c[campo] ?? ""))).filter((m): m is RegExpExecArray => !!m).map((m) => Number(m[1]));
    const maiorEmitido = numeros.length ? Math.max(...numeros) : null;
    r[chave] = { valor, maiorEmitido, ok: maiorEmitido === null || (valor !== null && valor >= maiorEmitido) };
  }
  return r;
}

/** Pré-condições operacionais da janela (todas leituras). `ok:false` em qualquer uma ⇒ backup ADIADO. */
export async function verificarPreCondicoes(db: Db, agora: Date, margemReconciliacaoMin: number): Promise<{ verificacoes: Verificacao[]; informacoes: Record<string, number> }> {
  const caixasAbertos = await db.collection("caixas").countDocuments({ status: "aberto" });
  const limiteRetry = new Date(agora.getTime() + margemReconciliacaoMin * 60_000);
  const reconciliacaoProxima = await db.collection("vendas").countDocuments({
    cancelamentos: {
      $elemMatch: {
        itens: {
          $elemMatch: {
            restaurado: { $ne: true },
            estadoRestauracao: { $in: ["pendente", "falha_recuperavel"] },
            $or: [{ proximaTentativaEm: null }, { proximaTentativaEm: { $lte: limiteRetry } }],
          },
        },
      },
    },
  });
  const requerIntervencao = await db.collection("vendas").countDocuments({
    cancelamentos: { $elemMatch: { itens: { $elemMatch: { restaurado: { $ne: true }, estadoRestauracao: "requer_intervencao" } } } },
  });
  const vendasEmPagamento = await db.collection("vendas").countDocuments({ status: "em_pagamento" });
  return {
    verificacoes: [
      { id: "janela.caixas_fechados", ok: caixasAbertos === 0, detalhe: `caixas abertos: ${caixasAbertos}` },
      {
        id: "janela.reconciliacao_sem_retry_proximo",
        ok: reconciliacaoProxima === 0,
        detalhe: `vendas com linha pendente/falha_recuperavel com retry vencido ou em até ${margemReconciliacaoMin} min: ${reconciliacaoProxima} (o worker poderia escrever durante o dump; o worker NÃO é desligado pelo backup)`,
      },
    ],
    informacoes: { caixasAbertos, reconciliacaoProxima, requerIntervencao, vendasEmPagamento },
  };
}
