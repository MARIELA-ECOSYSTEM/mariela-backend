import type { QueryFilter } from "mongoose";
import { FACETAS_COLECAO, type ChaveFacetaColecao } from "./colecoes.constants.js";
import type { Colecao } from "./schemas/colecao.schema.js";

/**
 * `produtosVinculados` NÃO é um campo do documento `Colecao` — é um agregado
 * calculado a partir de Produtos (ver `ColecoesService`). Por isso o filtro
 * `produtos` (com/sem) é aplicado em memória, sobre o conjunto já unido
 * (coleção + contagem) — mesmo padrão e mesma justificativa já usados em
 * Fornecedores (evita acoplar este módulo ao schema interno de Produtos via
 * `$lookup`, e o volume real de coleções de uma loja é pequeno). `situacao`
 * também é derivado (de `inicio`/`fim`/`ativo` + data atual — mesma regra de
 * `utils/vitrine.ts#statusVigencia` no frontend), mas por depender da data
 * "agora" também é resolvido em memória, ao lado de `produtos`, mantendo um
 * único caminho de código para todas as facetas do módulo.
 */
export type SelecaoFacetas = Partial<Record<ChaveFacetaColecao, string[]>>;

export interface ColecaoComAgregado {
  documento: Colecao & { id: string };
  produtosVinculados: number;
}

/** Filtro aplicado SEMPRE no Mongo: nunca traz excluídas; `busca` livre em nome/descrição/código. */
export function filtroSempreAtivo(busca?: string): QueryFilter<Colecao> {
  const filtro: QueryFilter<Colecao> = { excluidoEm: null };
  const termo = busca?.trim();
  if (termo) {
    const regex = new RegExp(termo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filtro.$or = [{ nome: regex }, { descricao: regex }, { codigo: regex }];
  }
  return filtro;
}

function statusVigencia(colecao: Colecao, agora: Date): string {
  if (!colecao.ativo) return "inativa";
  if (colecao.inicio > agora) return "agendada";
  if (colecao.fim < agora) return "encerrada";
  return "ativa";
}

function condicaoValor(chave: ChaveFacetaColecao, valor: string, item: ColecaoComAgregado, agora: Date): boolean {
  switch (chave) {
    case FACETAS_COLECAO.situacao:
      return statusVigencia(item.documento, agora) === valor;
    case FACETAS_COLECAO.destaque:
      return valor === "sim" ? item.documento.destaque : !item.documento.destaque;
    case FACETAS_COLECAO.banner:
      return valor === "sim" ? item.documento.banner : !item.documento.banner;
    case FACETAS_COLECAO.produtos:
      return valor === "com" ? item.produtosVinculados > 0 : item.produtosVinculados === 0;
    default:
      return false;
  }
}

export { condicaoValor };

/** OR dentro do grupo, AND entre grupos — mesma semântica das facetas de Produtos/Clientes/Fornecedores. */
export function aplicarSelecao(
  itens: ColecaoComAgregado[],
  selecao: SelecaoFacetas,
  agora: Date,
  ignorarChave?: ChaveFacetaColecao,
): ColecaoComAgregado[] {
  const grupos = Object.values(FACETAS_COLECAO)
    .filter((chave) => chave !== ignorarChave)
    .map((chave) => ({ chave, valores: selecao[chave] ?? [] }))
    .filter((grupo) => grupo.valores.length > 0);

  if (grupos.length === 0) return itens;
  return itens.filter((item) =>
    grupos.every((grupo) => grupo.valores.some((valor) => condicaoValor(grupo.chave, valor, item, agora))),
  );
}
