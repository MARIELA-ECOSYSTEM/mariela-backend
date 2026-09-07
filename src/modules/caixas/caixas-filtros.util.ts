import {
  DIFERENCA_TOLERANCIA,
  FACETAS_CAIXA,
  FAIXAS_SALDO,
  type ChaveFacetaCaixa,
} from "./caixas.constants.js";
import type { ResumoCaixaCalculado } from "./caixas.types.js";
import type { CaixaDocument } from "./schemas/caixa.schema.js";

export type SelecaoFacetas = Partial<Record<ChaveFacetaCaixa, string[]>>;

/**
 * Caixa + resumo já calculado — a unidade de trabalho da filtragem híbrida
 * (Node-side, mesmo padrão de Fornecedores/Coleções/Campanhas): como `resumo`
 * nunca é persistido, filtrar/ordenar por ele exige o conjunto já teve seus
 * resumos calculados a partir de `movimentos_caixa` antes de chegar aqui.
 */
export interface CaixaComResumo {
  documento: CaixaDocument & { id: string };
  resumo: ResumoCaixaCalculado;
}

export type SituacaoDiferenca = "conferido" | "sobra" | "falta";

export function situacaoDiferenca(diferenca: number): SituacaoDiferenca {
  if (Math.abs(diferenca) < DIFERENCA_TOLERANCIA) return "conferido";
  return diferenca > 0 ? "sobra" : "falta";
}

function inicioDoDia(data: Date): Date {
  const copia = new Date(data);
  copia.setHours(0, 0, 0, 0);
  return copia;
}

/** Mesma regra de `caixaNoPeriodo` no frontend (`src/utils/caixa.ts`). */
function noPeriodo(item: CaixaComResumo, periodo: string, agora: Date): boolean {
  const data = item.documento.abertura.dataHora;
  const hoje = inicioDoDia(agora);

  if (periodo === "hoje") return inicioDoDia(data).getTime() === hoje.getTime();
  if (periodo === "7d" || periodo === "30d") {
    const limite = new Date(hoje);
    limite.setDate(limite.getDate() - (periodo === "7d" ? 7 : 30));
    return data >= limite;
  }
  if (periodo === "mes") return data.getMonth() === agora.getMonth() && data.getFullYear() === agora.getFullYear();
  if (periodo === "mes-anterior") {
    const anterior = new Date(agora.getFullYear(), agora.getMonth() - 1, 1);
    return data.getMonth() === anterior.getMonth() && data.getFullYear() === anterior.getFullYear();
  }
  return true;
}

function naFaixaDeSaldo(item: CaixaComResumo, faixaId: string): boolean {
  const faixa = FAIXAS_SALDO.find((f) => f.valor === faixaId);
  if (!faixa) return true;
  const saldo = item.resumo.saldoEsperado;
  return saldo >= faixa.min && saldo < faixa.max;
}

function temDiferenca(item: CaixaComResumo, valor: string): boolean {
  if (!item.documento.fechamento) return false;
  return situacaoDiferenca(item.documento.fechamento.diferenca) === valor;
}

/** Condição de UM valor dentro de um grupo de faceta — `null` = faceta desconhecida. */
export function condicaoValor(chave: ChaveFacetaCaixa, valor: string, item: CaixaComResumo, agora: Date): boolean {
  switch (chave) {
    case FACETAS_CAIXA.status:
      return item.documento.status === valor;
    case FACETAS_CAIXA.periodo:
      return noPeriodo(item, valor, agora);
    case FACETAS_CAIXA.responsavel:
      return item.documento.abertura.responsavelNome === valor;
    case FACETAS_CAIXA.diferenca:
      return temDiferenca(item, valor);
    case FACETAS_CAIXA.saldo:
      return naFaixaDeSaldo(item, valor);
    default:
      return true;
  }
}

/** Aplica a seleção: OR dentro do grupo, AND entre grupos. `ignorarChave` exclui um grupo (cálculo de facet). */
export function aplicarSelecao(
  itens: CaixaComResumo[],
  selecao: SelecaoFacetas,
  agora: Date,
  ignorarChave?: ChaveFacetaCaixa,
): CaixaComResumo[] {
  const grupos = Object.values(FACETAS_CAIXA).filter((chave) => chave !== ignorarChave);
  return itens.filter((item) =>
    grupos.every((chave) => {
      const valores = selecao[chave] ?? [];
      if (valores.length === 0) return true;
      return valores.some((valor) => condicaoValor(chave, valor, item, agora));
    }),
  );
}

/** Busca livre por código do caixa ou nome do responsável da abertura. */
export function filtroBusca(itens: CaixaComResumo[], busca?: string): CaixaComResumo[] {
  const termo = busca?.trim().toLowerCase();
  if (!termo) return itens;
  return itens.filter(
    (item) =>
      item.documento.codigo.toLowerCase().includes(termo) ||
      item.documento.abertura.responsavelNome.toLowerCase().includes(termo),
  );
}
