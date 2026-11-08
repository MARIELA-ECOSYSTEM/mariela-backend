import type { EstadoRestauracao } from "./vendas.constants.js";

/**
 * Fase 60.4.3.4.18 — regras PURAS (sem I/O) da reconciliação persistente de estoque em cancelamentos/devoluções.
 * Concentradas aqui para que o service, o repository (filtros), o virtual de serialização e os testes usem exatamente
 * a MESMA interpretação de estado — nunca duas regras divergentes.
 */

/** Forma mínima de uma linha de `cancelamentos[].itens[]` necessária para derivar o estado (documento ou `lean`). */
export interface LinhaRestauracao {
  restaurado?: boolean | null;
  estadoRestauracao?: EstadoRestauracao | null;
  proximaTentativaEm?: Date | null;
  tentativas?: number | null;
}

/** Forma mínima de um evento de `cancelamentos[]`. */
export interface EventoRestauracao {
  itens?: LinhaRestauracao[] | null;
}

/**
 * Estado EFETIVO de uma linha:
 *   - `restaurado === true` → `concluida` (fonte de verdade, inclusive para eventos legados que só têm o booleano);
 *   - caso contrário, `falha_recuperavel`/`requer_intervencao` quando persistidos;
 *   - qualquer outra combinação — `restaurado: false`, campo AUSENTE, `estadoRestauracao` ausente ou (inconsistente)
 *     `concluida` sem `restaurado: true` → `pendente`. Ausência NUNCA é lida como concluída.
 */
export function estadoEfetivoDaRestauracao(linha: LinhaRestauracao): EstadoRestauracao {
  if (linha.restaurado === true) return "concluida";
  if (linha.estadoRestauracao === "falha_recuperavel" || linha.estadoRestauracao === "requer_intervencao") {
    return linha.estadoRestauracao;
  }
  return "pendente";
}

export type StatusRestauracaoVenda = "nao_aplicavel" | "concluida" | "pendente" | "requer_intervencao";

/**
 * Resumo da restauração de estoque de UMA venda — exposto em toda venda serializada (`Venda.restauracaoEstoque`,
 * virtual) para que a API distinga:
 *   - `nao_aplicavel`: nenhum item devolvido;
 *   - `concluida`: todo estoque devolvido;
 *   - `pendente`: há linhas aguardando (ou em nova tentativa) — a reconciliação automática as concluirá;
 *   - `requer_intervencao`: ao menos uma linha esgotou as tentativas automáticas — precisa de um operador.
 */
export interface ResumoRestauracaoVenda {
  status: StatusRestauracaoVenda;
  totalItens: number;
  concluidos: number;
  pendentes: number;
  emFalhaRecuperavel: number;
  requerIntervencao: number;
  /** Menor `proximaTentativaEm` entre as linhas que o worker ainda vai tentar (`null` = elegível já ou nada pendente). */
  proximaTentativaEm: Date | null;
}

export function resumoRestauracao(eventos: readonly EventoRestauracao[] | null | undefined): ResumoRestauracaoVenda {
  let totalItens = 0;
  let concluidos = 0;
  let pendentes = 0;
  let emFalhaRecuperavel = 0;
  let requerIntervencao = 0;
  let proxima: Date | null = null;
  for (const evento of eventos ?? []) {
    for (const linha of evento.itens ?? []) {
      totalItens += 1;
      const estado = estadoEfetivoDaRestauracao(linha);
      if (estado === "concluida") {
        concluidos += 1;
        continue;
      }
      if (estado === "requer_intervencao") {
        requerIntervencao += 1;
        continue;
      }
      if (estado === "falha_recuperavel") emFalhaRecuperavel += 1;
      else pendentes += 1;
      const agenda = linha.proximaTentativaEm ?? null;
      if (agenda && (!proxima || agenda.getTime() < proxima.getTime())) proxima = agenda;
    }
  }
  const status: StatusRestauracaoVenda =
    totalItens === 0 ? "nao_aplicavel" : requerIntervencao > 0 ? "requer_intervencao" : concluidos === totalItens ? "concluida" : "pendente";
  return { status, totalItens, concluidos, pendentes, emFalhaRecuperavel, requerIntervencao, proximaTentativaEm: proxima };
}

/** A linha pode ser tentada AGORA pela reconciliação automática? (`requer_intervencao` nunca; agenda respeitada.) */
export function linhaElegivelParaReconciliacaoAutomatica(linha: LinhaRestauracao, agora: Date): boolean {
  const estado = estadoEfetivoDaRestauracao(linha);
  if (estado === "concluida" || estado === "requer_intervencao") return false;
  const agenda = linha.proximaTentativaEm ?? null;
  return agenda === null || agenda.getTime() <= agora.getTime();
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
