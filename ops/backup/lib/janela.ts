import { createHash } from "node:crypto";
// `ObjectId`/`EJSON` vêm do MESMO pacote do driver: `instanceof` funciona com os documentos que ele devolve.
import { BSON, ObjectId, type Db, type Document } from "mongodb";

const { EJSON } = BSON;
import { normalizarIndice, ordenarIndices, type IndiceNormalizado, type Verificacao } from "./archive.js";
import { ASSINATURA_POR_COLECAO, COLECOES_BACKUP, COLECOES_EXCLUIDAS, SEQUENCIAS_E_CODIGOS } from "./politica.js";

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
  /** Como a escrita é detectada nesta coleção (`ASSINATURA_POR_COLECAO`). */
  estrategia: "timestamp" | "insercao" | "conteudo";
  contagem: number;
  /** Maior data entre os `camposData` da coleção (ISO) — `null` se nenhum documento os tem. */
  maiorTimestamp: string | null;
  /** SHA-256 do conteúdo inteiro: sempre na estratégia `conteudo`; nas demais, só se houver documentos sem data. */
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
  // Atualizações SEM data (estratégia `conteudo`) não podem ser datadas pela janela: são cobertas pela comparação
  // antes/depois do dump (hash). A janela declara isso em vez de afirmar ausência de escrita nessas coleções.
  const semData = Object.entries(assinatura).filter(([, a]) => a.estrategia === "conteudo").map(([n]) => n);
  const ressalva = semData.length ? `; atualizações sem data em [${semData.join(", ")}] só são detectadas pela comparação antes/depois (hash)` : "";
  return {
    id: "janela.sem_escrita",
    ok: recentes.length === 0,
    detalhe: recentes.length
      ? `escrita nos últimos ${quietMinutos} min: ${recentes.join(", ")}`
      : `última escrita DATADA há ${minutos === null ? "∞ (sem datas)" : `${minutos} min`} (mínimo ${quietMinutos})${ressalva}`,
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

/**
 * Limite de documentos para o hash de conteúdo (custo: 1 leitura completa da coleção por assinatura, 2 por backup;
 * memória constante — o hash é calculado em fluxo). Acima dele NÃO há assinatura confiável → falha FECHADA (o backup
 * não é feito; nunca um "estável" presumido). Rever a política se `uploads_midia` se aproximar dele.
 */
export const LIMITE_DOCS_HASH = 5000;

export class AssinaturaNaoConfiavelErro extends Error {
  constructor(colecao: string, motivo: string) {
    super(`assinatura da coleção '${colecao}' não é confiável: ${motivo}`);
    this.name = "AssinaturaNaoConfiavelErro";
  }
}

/** Subconjunto do `Db` do driver que a assinatura usa (só leituras) — permite testar sem MongoDB. */
export interface FonteAssinatura {
  collection(nome: string): {
    countDocuments(filtro: Document): Promise<number>;
    aggregate(pipeline: Document[]): { toArray(): Promise<Document[]> };
    find(filtro: Document): { sort(ordem: Document): AsyncIterable<Document> };
  };
}

type RegraAssinatura = (typeof ASSINATURA_POR_COLECAO)[keyof typeof ASSINATURA_POR_COLECAO];
/** Coleção fora da política (não deveria chegar aqui — o pré-backup a bloqueia): tratada pelo modo mais estrito. */
const REGRA_DESCONHECIDA: RegraAssinatura = { estrategia: "conteudo", camposData: ["atualizadoEm", "criadoEm"] };

async function hashDoConteudo(col: ReturnType<FonteAssinatura["collection"]>, nome: string, contagem: number, limite: number): Promise<string> {
  if (contagem > limite) throw new AssinaturaNaoConfiavelErro(nome, `${contagem} documentos excedem o limite de ${limite} para hash de conteúdo`);
  const hash = createHash("sha256");
  let lidos = 0;
  // Ordem estável por _id e EJSON canônico (tipos preservados): mesmo conteúdo ⇒ mesmo hash.
  for await (const doc of col.find({}).sort({ _id: 1 })) {
    lidos += 1;
    if (lidos > limite) throw new AssinaturaNaoConfiavelErro(nome, `mais de ${limite} documentos durante a leitura`);
    hash.update(EJSON.stringify(doc, { relaxed: false }));
    hash.update("\n");
  }
  // Contagem diferente do que foi lido ⇒ alguém escreveu durante a medição: não há estabilidade a afirmar.
  if (lidos !== contagem) throw new AssinaturaNaoConfiavelErro(nome, `contagem mudou durante a leitura (${contagem} → ${lidos})`);
  return hash.digest("hex").toUpperCase();
}

/**
 * Fase 60.4.3.4.21.2.2 (R21-2.1-01) — assinatura POR ESTRATÉGIA (`ASSINATURA_POR_COLECAO`): `conteudo` sempre tem hash
 * (detecta atualização de qualquer campo, remoção lógica e física); `timestamp`/`insercao` usam contagem + maior data,
 * e caem para hash se houver documentos sem nenhuma data. Qualquer falha de leitura PROPAGA (janela não elegível).
 */
export async function lerAssinatura(db: FonteAssinatura, colecoes: readonly string[], limiteDocsHash: number = LIMITE_DOCS_HASH): Promise<Assinatura> {
  const assinatura: Assinatura = {};
  for (const nome of colecoes) {
    const regra = (ASSINATURA_POR_COLECAO as Record<string, RegraAssinatura>)[nome] ?? REGRA_DESCONHECIDA;
    const col = db.collection(nome);
    const contagem = await col.countDocuments({});
    let maiorTimestamp: string | null = null;
    if (regra.camposData.length > 0) {
      const grupo: Document = { _id: null };
      regra.camposData.forEach((campo, i) => {
        grupo[`d${i}`] = { $max: `$${campo}` };
      });
      const [maximos] = await col.aggregate([{ $group: grupo }]).toArray();
      const datas = regra.camposData.map((_, i) => maximos?.[`d${i}`]).filter((d): d is Date => d instanceof Date);
      maiorTimestamp = datas.length ? new Date(Math.max(...datas.map((d) => d.getTime()))).toISOString() : null;
    }
    const precisaHash = regra.estrategia === "conteudo" || (contagem > 0 && maiorTimestamp === null);
    const hashConteudo = precisaHash ? await hashDoConteudo(col, nome, contagem, limiteDocsHash) : null;
    assinatura[nome] = { estrategia: regra.estrategia, contagem, maiorTimestamp, hashConteudo };
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
