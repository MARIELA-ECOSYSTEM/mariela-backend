import type { QueryFilter } from "mongoose";
import {
  COM_ESTOQUE,
  EH_NOVIDADE,
  EM_PROMOCAO,
  FACETAS_PRODUTO,
  type ChaveFaceta,
} from "./produtos.constants.js";
import type { Produto } from "./schemas/produto.schema.js";

export type SelecaoFacetas = Partial<Record<ChaveFaceta, string[]>>;

/** Filtro aplicado SEMPRE, independente de facetas: nunca traz excluídos; `busca` livre em nome/código/categoria. */
export function filtroSempreAtivo(busca?: string): QueryFilter<Produto> {
  const filtro: QueryFilter<Produto> = { excluidoEm: null };
  const termo = busca?.trim();
  if (termo) {
    const regex = new RegExp(termo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filtro.$or = [{ nome: regex }, { codProduto: regex }, { categoria: regex }];
  }
  return filtro;
}

/** Condição Mongo de UM grupo de faceta a partir dos valores selecionados (OR dentro do grupo). `null` = grupo inativo. */
export function condicaoFaceta(chave: ChaveFaceta, valores: string[]): QueryFilter<Produto> | null {
  if (valores.length === 0) return null;

  switch (chave) {
    case FACETAS_PRODUTO.categorias:
      return { categoria: { $in: valores } };
    case FACETAS_PRODUTO.colecoes:
      return { colecaoId: { $in: valores } };
    case FACETAS_PRODUTO.campanhas:
      return { campanhaId: { $in: valores } };
    case FACETAS_PRODUTO.fornecedores:
      return { fornecedorId: { $in: valores } };
    case FACETAS_PRODUTO.estoque:
      return combinarOu(valores.map((v) => (v === COM_ESTOQUE ? { quantidadeTotal: { $gt: 0 } } : { quantidadeTotal: { $lte: 0 } })));
    case FACETAS_PRODUTO.promocao:
      return combinarOu(valores.map((v) => ({ ehPromocao: v === EM_PROMOCAO })));
    case FACETAS_PRODUTO.novidade:
      return combinarOu(valores.map((v) => ({ ehNovidade: v === EH_NOVIDADE })));
    default:
      return null;
  }
}

function combinarOu(condicoes: QueryFilter<Produto>[]): QueryFilter<Produto> {
  return condicoes.length === 1 ? (condicoes[0] as QueryFilter<Produto>) : { $or: condicoes };
}

/** Combina o filtro sempre-ativo com as condições de faceta ativas, ignorando opcionalmente um grupo. */
export function combinarFiltros(
  base: QueryFilter<Produto>,
  selecao: SelecaoFacetas,
  ignorarChave?: ChaveFaceta,
): QueryFilter<Produto> {
  const condicoes = Object.values(FACETAS_PRODUTO)
    .filter((chave) => chave !== ignorarChave)
    .map((chave) => condicaoFaceta(chave, selecao[chave] ?? []))
    .filter((condicao): condicao is QueryFilter<Produto> => condicao !== null);

  if (condicoes.length === 0) return base;
  return { $and: [base, ...condicoes] };
}
