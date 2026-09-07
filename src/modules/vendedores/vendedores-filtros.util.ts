import type { QueryFilter } from "mongoose";
import { FACETAS_VENDEDOR, type ChaveFacetaVendedor } from "./vendedores.constants.js";
import type { Vendedor } from "./schemas/vendedor.schema.js";

export type SelecaoFacetas = Partial<Record<ChaveFacetaVendedor, string[]>>;

/** Filtro aplicado SEMPRE, independente de facetas: nunca traz excluídos; `busca` livre em nome/código/telefone. */
export function filtroSempreAtivo(busca?: string): QueryFilter<Vendedor> {
  const filtro: QueryFilter<Vendedor> = { excluidoEm: null };
  const termo = busca?.trim();
  if (termo) {
    const regex = new RegExp(termo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filtro.$or = [{ nome: regex }, { codigo: regex }, { telefone: regex }];
  }
  return filtro;
}

function condicaoStatusValor(valor: string): QueryFilter<Vendedor> | null {
  if (valor === "ativos") return { ativo: true };
  if (valor === "inativos") return { ativo: false };
  return null;
}

/** Mesmas faixas de `naFaixaDeVendas` no frontend (`src/utils/vendedor.ts`). */
function condicaoVendasValor(valor: string): QueryFilter<Vendedor> | null {
  switch (valor) {
    case "sem":
      return { vendas: 0 };
    case "1-5":
      return { vendas: { $gte: 1, $lte: 5 } };
    case "6-20":
      return { vendas: { $gte: 6, $lte: 20 } };
    case "21+":
      return { vendas: { $gte: 21 } };
    default:
      return null;
  }
}

/** Mesmas faixas de `naFaixaDeValor` no frontend. */
function condicaoValorValor(valor: string): QueryFilter<Vendedor> | null {
  switch (valor) {
    case "ate-500":
      return { totalVendido: { $lte: 500 } };
    case "500-2000":
      return { totalVendido: { $gt: 500, $lte: 2000 } };
    case "2000-10000":
      return { totalVendido: { $gt: 2000, $lte: 10_000 } };
    case "10000+":
      return { totalVendido: { $gt: 10_000 } };
    default:
      return null;
  }
}

/** Mesmos períodos de `ultimaVendaNoPeriodo` no frontend — "nunca vendeu" também conta quando `ultimaVenda` é null. */
function condicaoUltimaVendaValor(valor: string, agora: Date): QueryFilter<Vendedor> | null {
  if (valor === "nunca") return { ultimaVenda: null };
  const dias = Number(valor);
  if (!Number.isFinite(dias)) return null;
  const limite = new Date(agora.getTime() - dias * 86_400_000);
  return { ultimaVenda: { $ne: null, $gte: limite } };
}

/** Mesma regra de `nascimentoNoMes` no frontend: compara mês via `$expr`, independente do ano. */
function condicaoNascimentoValor(valor: string, agora: Date): QueryFilter<Vendedor> | null {
  switch (valor) {
    case "com":
      return { dataNascimento: { $ne: null } };
    case "sem":
      return { dataNascimento: null };
    case "mes":
      return {
        dataNascimento: { $ne: null },
        $expr: { $eq: [{ $month: "$dataNascimento" }, agora.getMonth() + 1] },
      } as QueryFilter<Vendedor>;
    default:
      return null;
  }
}

function condicaoObservacaoValor(valor: string): QueryFilter<Vendedor> | null {
  if (valor === "com") return { observacao: { $ne: "" } };
  if (valor === "sem") return { observacao: "" };
  return null;
}

function combinarOu(condicoes: QueryFilter<Vendedor>[]): QueryFilter<Vendedor> {
  return condicoes.length === 1 ? (condicoes[0] as QueryFilter<Vendedor>) : { $or: condicoes };
}

/** Condição Mongo de UM grupo de faceta a partir dos valores selecionados (OR dentro do grupo). `null` = grupo inativo. */
export function condicaoFaceta(chave: ChaveFacetaVendedor, valores: string[], agora = new Date()): QueryFilter<Vendedor> | null {
  if (valores.length === 0) return null;

  const construtor: ((valor: string) => QueryFilter<Vendedor> | null) | null =
    chave === FACETAS_VENDEDOR.status
      ? condicaoStatusValor
      : chave === FACETAS_VENDEDOR.vendas
        ? condicaoVendasValor
        : chave === FACETAS_VENDEDOR.valor
          ? condicaoValorValor
          : chave === FACETAS_VENDEDOR.ultimaVenda
            ? (v) => condicaoUltimaVendaValor(v, agora)
            : chave === FACETAS_VENDEDOR.nascimento
              ? (v) => condicaoNascimentoValor(v, agora)
              : chave === FACETAS_VENDEDOR.observacao
                ? condicaoObservacaoValor
                : null;
  if (!construtor) return null;

  const condicoes = valores.map((valor) => construtor(valor)).filter((c): c is QueryFilter<Vendedor> => c !== null);
  return condicoes.length === 0 ? null : combinarOu(condicoes);
}

/** Combina o filtro sempre-ativo com as condições de faceta ativas, ignorando opcionalmente um grupo. */
export function combinarFiltros(
  base: QueryFilter<Vendedor>,
  selecao: SelecaoFacetas,
  ignorarChave?: ChaveFacetaVendedor,
): QueryFilter<Vendedor> {
  const condicoes = Object.values(FACETAS_VENDEDOR)
    .filter((chave) => chave !== ignorarChave)
    .map((chave) => condicaoFaceta(chave, selecao[chave] ?? []))
    .filter((condicao): condicao is QueryFilter<Vendedor> => condicao !== null);

  if (condicoes.length === 0) return base;
  return { $and: [base, ...condicoes] };
}
