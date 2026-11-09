import type { EstadoRestauracao } from "./vendas.constants.js";

/**
 * Fase 60.4.3.4.18 — regras PURAS (sem I/O) da reconciliação persistente de estoque em cancelamentos/devoluções.
 * Concentradas aqui para que o service, o repository (filtros), o virtual de serialização e os testes usem exatamente
 * a MESMA interpretação de estado — nunca duas regras divergentes.
 */

/**
 * Forma mínima de uma linha de `cancelamentos[].itens[]` necessária para classificar (documento ou `lean`).
 * `estadoRestauracao` é `string`: o banco pode conter valores fora de `ESTADOS_RESTAURACAO` (o enum do schema só valida
 * escrita) — a classificação os trata como indeterminados.
 */
export interface LinhaRestauracao {
  restaurado?: boolean | null;
  estadoRestauracao?: string | null;
  proximaTentativaEm?: Date | null;
  tentativas?: number | null;
}

/** Forma mínima de um evento de `cancelamentos[]`. */
export interface EventoRestauracao {
  itens?: LinhaRestauracao[] | null;
}

/**
 * Fase 60.4.3.4.18.3 — estados em que a linha é PROVADAMENTE pendente: só o código transacional atual (desde
 * `78194a7`) grava `estadoRestauracao`, e nele uma linha não restaurada significa que nenhuma devolução foi confirmada.
 * São os únicos estados em que QUALQUER caminho (worker, cancelamento, repetição, rota ADMIN) pode devolver estoque.
 */
export const ESTADOS_RESTAURAVEIS = ["pendente", "falha_recuperavel", "requer_intervencao"] as const;
export type EstadoRestauravel = (typeof ESTADOS_RESTAURAVEIS)[number];

/** Estados que a reconciliação AUTOMÁTICA pode tentar (respeitando a agenda). */
export const ESTADOS_ELEGIVEIS_AUTOMATICO = ["pendente", "falha_recuperavel"] as const;

/**
 * Classificação de uma linha — `EstadoRestauracao` mais `indeterminado`:
 *   - `indeterminado`: histórico sem prova do estado físico do estoque. Nunca é devolvido por nenhum caminho
 *     automático ou de repetição; só aparece nas consultas operacionais.
 */
export type ClassificacaoRestauracao = EstadoRestauracao | "indeterminado";

/**
 * Fase 60.4.3.4.18.3 — classificação CONSERVADORA e ÚNICA (service, repository, virtual e testes usam só esta):
 *   1. `restaurado === true` → `concluida`;
 *   2. `estadoRestauracao` explícito e válido → a semântica do estado (`pendente`, `falha_recuperavel`,
 *      `requer_intervencao`);
 *   3. qualquer outro caso → `indeterminado`:
 *      - `estadoRestauracao` ausente (linhas gravadas antes de `78194a7`). Entre `b3a3367` e `76042f8` a restauração
 *        era em duas fases e uma falha ao marcar DEPOIS de devolver deixava `restaurado:false` com o estoque JÁ
 *        devolvido — `restaurado:false` sozinho não prova pendência;
 *      - `restaurado` ausente;
 *      - estado desconhecido/inválido;
 *      - `estadoRestauracao: "concluida"` sem `restaurado: true` (contraditório — o código nunca grava isso).
 */
export function classificarRestauracao(linha: LinhaRestauracao): ClassificacaoRestauracao {
  if (linha.restaurado === true) return "concluida";
  const estado = linha.estadoRestauracao;
  for (const restauravel of ESTADOS_RESTAURAVEIS) {
    if (estado === restauravel) return restauravel;
  }
  return "indeterminado";
}

/** Algum caminho pode devolver estoque desta linha? (só estados provadamente pendentes). */
export function linhaRestauravel(classificacao: ClassificacaoRestauracao): classificacao is EstadoRestauravel {
  return classificacao === "pendente" || classificacao === "falha_recuperavel" || classificacao === "requer_intervencao";
}

export type StatusRestauracaoVenda = "nao_aplicavel" | "concluida" | "pendente" | "requer_intervencao" | "indeterminado";

/**
 * Resumo da restauração de estoque de UMA venda — exposto em toda venda serializada (`Venda.restauracaoEstoque`,
 * virtual) para que a API distinga:
 *   - `nao_aplicavel`: nenhum item devolvido;
 *   - `concluida`: todo estoque devolvido;
 *   - `pendente`: há linhas aguardando (ou em nova tentativa) — a reconciliação automática as concluirá;
 *   - `requer_intervencao`: ao menos uma linha precisa de um operador (tentativas esgotadas ou referência ausente);
 *   - `indeterminado`: ao menos uma linha histórica sem prova do estado do estoque (nada é devolvido
 *     automaticamente; precisa de análise própria). `requer_intervencao` tem precedência.
 */
export interface ResumoRestauracaoVenda {
  status: StatusRestauracaoVenda;
  totalItens: number;
  concluidos: number;
  pendentes: number;
  emFalhaRecuperavel: number;
  requerIntervencao: number;
  indeterminados: number;
  /** Menor `proximaTentativaEm` entre as linhas que o worker ainda vai tentar (`null` = elegível já ou nada pendente). */
  proximaTentativaEm: Date | null;
}

export function resumoRestauracao(eventos: readonly EventoRestauracao[] | null | undefined): ResumoRestauracaoVenda {
  let totalItens = 0;
  let concluidos = 0;
  let pendentes = 0;
  let emFalhaRecuperavel = 0;
  let requerIntervencao = 0;
  let indeterminados = 0;
  let proxima: Date | null = null;
  for (const evento of eventos ?? []) {
    for (const linha of evento.itens ?? []) {
      totalItens += 1;
      const classificacao = classificarRestauracao(linha);
      if (classificacao === "concluida") {
        concluidos += 1;
        continue;
      }
      if (classificacao === "requer_intervencao") {
        requerIntervencao += 1;
        continue;
      }
      if (classificacao === "indeterminado") {
        indeterminados += 1;
        continue;
      }
      if (classificacao === "falha_recuperavel") emFalhaRecuperavel += 1;
      else pendentes += 1;
      const agenda = linha.proximaTentativaEm ?? null;
      if (agenda && (!proxima || agenda.getTime() < proxima.getTime())) proxima = agenda;
    }
  }
  const status: StatusRestauracaoVenda =
    totalItens === 0
      ? "nao_aplicavel"
      : requerIntervencao > 0
        ? "requer_intervencao"
        : indeterminados > 0
          ? "indeterminado"
          : concluidos === totalItens
            ? "concluida"
            : "pendente";
  return { status, totalItens, concluidos, pendentes, emFalhaRecuperavel, requerIntervencao, indeterminados, proximaTentativaEm: proxima };
}

/** A linha pode ser tentada AGORA pela reconciliação automática? (só `pendente`/`falha_recuperavel`, agenda respeitada.) */
export function linhaElegivelParaReconciliacaoAutomatica(linha: LinhaRestauracao, agora: Date): boolean {
  const classificacao = classificarRestauracao(linha);
  if (classificacao !== "pendente" && classificacao !== "falha_recuperavel") return false;
  const agenda = linha.proximaTentativaEm ?? null;
  return agenda === null || agenda.getTime() <= agora.getTime();
}

/**
 * Fase 60.4.3.4.18.3 — referência de estoque ausente: a devolução NÃO pode acontecer e repetir não resolve. A linha vai
 * direto para `requer_intervencao` com o código específico; nunca é marcada como restaurada.
 */
export const CODIGOS_REFERENCIA_AUSENTE = [
  "ITEM_VENDA_INEXISTENTE",
  "ITEM_SEM_VARIANTE",
  "PRODUTO_EXCLUIDO_OU_INEXISTENTE",
  "VARIANTE_INEXISTENTE",
  "TAMANHO_INEXISTENTE",
] as const;
export type CodigoReferenciaAusente = (typeof CODIGOS_REFERENCIA_AUSENTE)[number];

const MENSAGENS_REFERENCIA_AUSENTE: Record<CodigoReferenciaAusente, string> = {
  ITEM_VENDA_INEXISTENTE: "O item da venda referenciado pela devolução não existe.",
  ITEM_SEM_VARIANTE: "O item da venda não tem variante: não há onde devolver o estoque.",
  PRODUTO_EXCLUIDO_OU_INEXISTENTE: "O produto foi excluído ou não existe.",
  VARIANTE_INEXISTENTE: "A variante do item não existe mais no produto.",
  TAMANHO_INEXISTENTE: "O tamanho do item não existe mais na variante (não é recriado automaticamente).",
};

export class ReferenciaDeEstoqueAusenteErro extends Error {
  readonly code: CodigoReferenciaAusente;

  constructor(codigo: CodigoReferenciaAusente) {
    super(MENSAGENS_REFERENCIA_AUSENTE[codigo]);
    this.name = "ReferenciaDeEstoqueAusenteErro";
    this.code = codigo;
  }
}

/** Espera antes da tentativa seguinte: `base × 2^(tentativas−1)`, limitada a `maximo` (tentativas ≥ 1). */
export function calcularEsperaDeRestauracao(tentativas: number, esperaBaseMs: number, esperaMaximaMs: number): number {
  const expoente = Math.max(0, Math.floor(tentativas) - 1);
  // Limita o expoente antes de elevar — evita `Infinity` com contagens muito altas.
  const fator = 2 ** Math.min(expoente, 30);
  return Math.min(esperaBaseMs * fator, esperaMaximaMs);
}

/** Dados SEGUROS de uma falha — gravados no documento e nos logs; nunca stack trace, URI, segredo ou dado pessoal. */
export interface DescricaoFalhaRestauracao {
  classe: string;
  codigo: string | null;
  mensagem: string;
}

const TAMANHO_MAXIMO_MENSAGEM = 200;
const PADRAO_URI = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;

export function descreverFalhaDeRestauracao(erro: unknown): DescricaoFalhaRestauracao {
  if (!(erro instanceof Error)) {
    return { classe: typeof erro, codigo: null, mensagem: "Falha não identificada." };
  }
  const classe = erro.constructor?.name || erro.name || "Error";
  const codigoBruto: unknown = "codeName" in erro && typeof erro.codeName === "string" ? erro.codeName : "code" in erro ? erro.code : undefined;
  const codigo = typeof codigoBruto === "string" || typeof codigoBruto === "number" ? String(codigoBruto) : null;
  const semUri = (erro.message || "").replace(PADRAO_URI, "[uri-removida]").replace(/\s+/g, " ").trim();
  const mensagem = semUri.length > TAMANHO_MAXIMO_MENSAGEM ? `${semUri.slice(0, TAMANHO_MAXIMO_MENSAGEM)}…` : semUri || classe;
  return { classe, codigo, mensagem };
}
