import type { LoggerService } from "@nestjs/common";
import { descreverFalhaDeRestauracao } from "./restauracao-estoque.util.js";
import type { ResultadoCicloReconciliacao } from "./vendas.service.js";

/**
 * Fase 60.4.3.4.19.5 — observabilidade do `ReconciliacaoEstoqueWorker`: funções PURAS (sem I/O além do logger
 * recebido) que montam os eventos estruturados dos ciclos. Nada aqui altera estoque, vendas, ledger ou o fluxo
 * transacional — só descreve o que já aconteceu.
 */

/** Desfecho de um ciclo que terminou normalmente (ver `classificarResultadoDoCiclo`). */
export type ResultadoDoCiclo = "sem_itens_elegiveis" | "processado" | "processado_com_falhas";

/** Categoria SEGURA de um erro geral de ciclo — nunca a mensagem bruta (pode conter host/URI). */
export type CategoriaErroDeCiclo = "banco_indisponivel" | "erro_banco" | "conflito_transacao" | "desconhecido";

/**
 * Contadores do evento `reconciliacao_estoque.ciclo_concluido`. Métricas por ciclo; cada linha de cancelamento é
 * visitada no máximo UMA vez por ciclo (cada venda é lida uma vez e a lista de vendas não se repete).
 *
 * Relação verificável (sem dupla contagem — cada linha tentada tem exatamente um desfecho):
 *   itensElegiveis = itensConcluidos + jaConcluidos + falhasRecuperaveis + requeremIntervencao
 *                    + falhasNaoRegistradas + adiadosNaTransacao + indeterminadosNaTransacao
 * `adiados` e `indeterminados` são linhas NÃO tentadas (pré-checagem) e ficam fora dessa soma.
 */
export interface ContadoresDoCiclo {
  /** Vendas devolvidas pela consulta inicial (no máximo `loteVendas`). */
  vendasConsultadas: number;
  /** Vendas efetivamente percorridas (menor que `vendasConsultadas` se `maxItensPorCiclo` interromper o laço). */
  vendasProcessadas: number;
  /** Linhas que passaram na pré-checagem e foram submetidas a UMA tentativa lógica (retry interno não conta). */
  itensElegiveis: number;
  /** Linhas cujo commit NESTE ciclo confirmou a restauração. */
  itensConcluidos: number;
  /** Linhas encontradas já concluídas (por outra execução) na releitura transacional. */
  jaConcluidos: number;
  /** Linhas que PASSARAM a `falha_recuperavel` neste ciclo (registro da falha aplicado). */
  falhasRecuperaveis: number;
  /** Linhas que PASSARAM a `requer_intervencao` neste ciclo (registro da falha aplicado). */
  requeremIntervencao: number;
  /** Linhas restauráveis não tentadas na pré-checagem: agenda futura ou já em `requer_intervencao`. */
  adiados: number;
  /** Linhas históricas indeterminadas deixadas intactas na pré-checagem. */
  indeterminados: number;
  /** Linhas tentadas que a releitura transacional adiou (outra execução registrou nova agenda). */
  adiadosNaTransacao: number;
  /** Linhas tentadas que a releitura transacional encontrou indeterminadas (deixadas intactas). */
  indeterminadosNaTransacao: number;
  /** Tentativas que falharam mas cujo registro (CAS) não foi aplicado — outra execução alterou a linha antes. */
  falhasNaoRegistradas: number;
  /** Vendas cuja leitura/processamento lançou erro (as demais continuam no mesmo ciclo). */
  vendasComErro: number;
  /** Ticks/chamadas que encontraram ESTE ciclo em andamento e reaproveitaram a mesma execução. */
  ticksSobrepostos: number;
}

export function contadoresDoCiclo(resultado: ResultadoCicloReconciliacao, ticksSobrepostos: number): ContadoresDoCiclo {
  return {
    vendasConsultadas: resultado.vendasConsultadas,
    vendasProcessadas: resultado.vendas,
    itensElegiveis: resultado.tentadas,
    itensConcluidos: resultado.concluidas,
    jaConcluidos: resultado.jaConcluidas,
    falhasRecuperaveis: resultado.falhasRecuperaveis,
    requeremIntervencao: resultado.requeremIntervencao,
    // `adiadas`/`indeterminadas` do service são TOTAIS (pré-checagem + transação); aqui são separados sem sobreposição.
    adiados: resultado.adiadas - resultado.adiadasNaTransacao,
    indeterminados: resultado.indeterminadas - resultado.indeterminadasNaTransacao,
    adiadosNaTransacao: resultado.adiadasNaTransacao,
    indeterminadosNaTransacao: resultado.indeterminadasNaTransacao,
    falhasNaoRegistradas: resultado.falhasNaoRegistradas,
    vendasComErro: resultado.vendasComErro,
    ticksSobrepostos,
  };
}

/**
 * - `processado_com_falhas`: houve falha recuperável, intervenção, falha não registrada ou erro de venda;
 * - `sem_itens_elegiveis`: nenhuma linha foi submetida a tentativa (adiadas/indeterminadas podem existir);
 * - `processado`: houve itens elegíveis e nenhuma falha.
 */
export function classificarResultadoDoCiclo(c: ContadoresDoCiclo): ResultadoDoCiclo {
  if (c.falhasRecuperaveis + c.requeremIntervencao + c.falhasNaoRegistradas + c.vendasComErro > 0) return "processado_com_falhas";
  return c.itensElegiveis === 0 ? "sem_itens_elegiveis" : "processado";
}

const CLASSES_BANCO_INDISPONIVEL = new Set([
  "MongoServerSelectionError",
  "MongooseServerSelectionError",
  "MongoNetworkError",
  "MongoNetworkTimeoutError",
  "MongoNotConnectedError",
  "MongoTopologyClosedError",
  "MongoPoolClearedError",
]);
const CODIGOS_CONFLITO_TRANSACAO = new Set(["WriteConflict", "NoSuchTransaction", "CONFLICT"]);

function temRotulo(erro: unknown, rotulo: string): boolean {
  if (typeof erro !== "object" || erro === null) return false;
  const comRotulo = erro as { hasErrorLabel?: (r: string) => boolean; errorLabels?: unknown };
  if (typeof comRotulo.hasErrorLabel === "function") {
    try {
      return comRotulo.hasErrorLabel(rotulo);
    } catch {
      return false;
    }
  }
  return Array.isArray(comRotulo.errorLabels) && comRotulo.errorLabels.includes(rotulo);
}

/** Classifica um erro GERAL de ciclo só por classe/código/rótulos — nunca pela mensagem. */
export function categorizarErroDeCiclo(erro: unknown): CategoriaErroDeCiclo {
  const { classe, codigo } = descreverFalhaDeRestauracao(erro);
  if (CLASSES_BANCO_INDISPONIVEL.has(classe)) return "banco_indisponivel";
  if (temRotulo(erro, "TransientTransactionError") || (codigo !== null && CODIGOS_CONFLITO_TRANSACAO.has(codigo))) return "conflito_transacao";
  if (/^Mongo/.test(classe) || /^Mongoose/.test(classe)) return "erro_banco";
  return "desconhecido";
}

/** Classe e código SEGUROS de um erro (sem mensagem — ver R1 no relatório da Fase 60.4.3.4.19.5). */
export function identificarErro(erro: unknown): { erroClasse: string; erroCodigo: string | null } {
  const { classe, codigo } = descreverFalhaDeRestauracao(erro);
  return { erroClasse: classe, erroCodigo: codigo };
}

/**
 * Metadados da plataforma Render (documentação oficial "Environment Variables": `RENDER_GIT_COMMIT` — "The commit SHA
 * for a service or deploy"; `RENDER_INSTANCE_ID` — "The unique identifier of the current service instance"). Só
 * ESTAS duas variáveis são lidas; valores fora do formato esperado (ou ausentes, fora do Render) viram `null`.
 */
export function metadadosDaPlataforma(env: Record<string, string | undefined> = process.env): { commit: string | null; instancia: string | null } {
  const commit = env["RENDER_GIT_COMMIT"]?.trim() ?? "";
  const instancia = env["RENDER_INSTANCE_ID"]?.trim() ?? "";
  return {
    commit: /^[0-9a-f]{7,40}$/i.test(commit) ? commit.toLowerCase() : null,
    instancia: /^[A-Za-z0-9._-]{1,100}$/.test(instancia) ? instancia : null,
  };
}

/**
 * Emissão PROTEGIDA: serialização e escrita dentro de `try/catch`. Uma falha do logger (ou de `JSON.stringify`) é
 * descartada — nunca muda o resultado de um ciclo, nunca interrompe a reconciliação, nunca vira `ciclo_falhou`.
 */
export function emitirSeguro(logger: Pick<LoggerService, "log" | "warn" | "error">, nivel: "log" | "warn" | "error", dados: Record<string, unknown>): void {
  try {
    const mensagem = JSON.stringify(dados);
    if (nivel === "error") logger.error(mensagem);
    else if (nivel === "warn") logger.warn(mensagem);
    else logger.log(mensagem);
  } catch {
    // Intencional: observabilidade nunca pode afetar o resultado operacional.
  }
}
