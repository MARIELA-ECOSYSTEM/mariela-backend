import type { QueryFilter } from "mongoose";
import { FACETAS_CAMPANHA, type ChaveFacetaCampanha } from "./campanhas.constants.js";
import type { Campanha } from "./schemas/campanha.schema.js";

/**
 * `produtosVinculados` NÃO é um campo do documento `Campanha` — é um
 * agregado calculado a partir de Produtos (ver `CampanhasService`). Por isso
 * o filtro `produtos` (com/sem) é aplicado em memória, sobre o conjunto já
 * unido (campanha + contagem) — mesmo padrão e mesma justificativa já usados
 * em Fornecedores/Coleções (evita acoplar este módulo ao schema interno de
 * Produtos via `$lookup`, e o volume real de campanhas de uma loja é
 * pequeno). `situacao` também é derivado (de `inicio`/`fim`/`ativo` + data
 * atual), mas por depender da data "agora" também é resolvido em memória, ao
 * lado de `produtos`, mantendo um único caminho de código para todas as
 * facetas do módulo.
 */
export type SelecaoFacetas = Partial<Record<ChaveFacetaCampanha, string[]>>;

export interface CampanhaComAgregado {
  documento: Campanha & { id: string };
  produtosVinculados: number;
}

/** Filtro aplicado SEMPRE no Mongo: nunca traz excluídas; `busca` livre em nome/descrição/código. */
export function filtroSempreAtivo(busca?: string): QueryFilter<Campanha> {
  const filtro: QueryFilter<Campanha> = { excluidoEm: null };
  const termo = busca?.trim();
  if (termo) {
    const regex = new RegExp(termo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filtro.$or = [{ nome: regex }, { descricao: regex }, { codigo: regex }];
  }
  return filtro;
}

function statusVigencia(campanha: Campanha, agora: Date): string {
  if (!campanha.ativo) return "inativa";
  if (campanha.inicio > agora) return "agendada";
  if (campanha.fim < agora) return "encerrada";
  return "ativa";
}

export function condicaoValor(chave: ChaveFacetaCampanha, valor: string, item: CampanhaComAgregado, agora: Date): boolean {
  switch (chave) {
    case FACETAS_CAMPANHA.situacao:
      return statusVigencia(item.documento, agora) === valor;
    case FACETAS_CAMPANHA.destaque:
      return valor === "sim" ? item.documento.destaque : !item.documento.destaque;
    case FACETAS_CAMPANHA.banner:
      return valor === "sim" ? item.documento.banner : !item.documento.banner;
    case FACETAS_CAMPANHA.produtos:
      return valor === "com" ? item.produtosVinculados > 0 : item.produtosVinculados === 0;
    default:
      return false;
  }
}

/** OR dentro do grupo, AND entre grupos — mesma semântica das facetas de Produtos/Clientes/Fornecedores/Coleções. */
export function aplicarSelecao(
  itens: CampanhaComAgregado[],
  selecao: SelecaoFacetas,
  agora: Date,
  ignorarChave?: ChaveFacetaCampanha,
): CampanhaComAgregado[] {
  const grupos = Object.values(FACETAS_CAMPANHA)
    .filter((chave) => chave !== ignorarChave)
    .map((chave) => ({ chave, valores: selecao[chave] ?? [] }))
    .filter((grupo) => grupo.valores.length > 0);

  if (grupos.length === 0) return itens;
  return itens.filter((item) =>
    grupos.every((grupo) => grupo.valores.some((valor) => condicaoValor(grupo.chave, valor, item, agora))),
  );
}
