import type { QueryFilter } from "mongoose";
import { FACETAS_FORNECEDOR, type ChaveFacetaFornecedor } from "./fornecedores.constants.js";
import type { AgregadoFornecedor } from "./fornecedores.types.js";
import type { Fornecedor } from "./schemas/fornecedor.schema.js";

/**
 * `produtosVinculados`/`valorEmCusto`/`ultimaEntrada` NÃO são campos do
 * documento `Fornecedor` — são agregados calculados a partir de Produtos (ver
 * `FornecedoresService`). Por isso os filtros/ordenação que dependem deles
 * (`produtos`, `entrada`, `produtosVinculados`, `valorEmCusto`, `ultimaEntrada`)
 * são aplicados em memória, sobre o conjunto já unido (fornecedor + agregado)
 * — não dá para empurrar isso para um único `$match`/`$sort` do Mongo sem um
 * `$lookup` acoplando este módulo ao schema interno de Produtos. Com o volume
 * real de fornecedores de uma loja (dezenas, não milhões), este custo é
 * desprezível e mantém os módulos desacoplados (mesmo princípio já adotado
 * por Estoque, que reusa `ProdutosRepository.listarTodosAtivos` em vez de
 * agregações cruzadas). A busca textual (`busca`) e o soft delete continuam
 * sendo filtrados no MongoDB, antes desta etapa.
 */
export type SelecaoFacetas = Partial<Record<ChaveFacetaFornecedor, string[]>>;

export interface FornecedorComAgregado {
  documento: Fornecedor & { id: string };
  agregado: AgregadoFornecedor;
}

/** Filtro aplicado SEMPRE no Mongo: nunca traz excluídos; `busca` livre em nome/código/contato/telefone/cnpj. */
export function filtroSempreAtivo(busca?: string): QueryFilter<Fornecedor> {
  const filtro: QueryFilter<Fornecedor> = { excluidoEm: null };
  const termo = busca?.trim();
  if (termo) {
    const regex = new RegExp(termo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filtro.$or = [{ nome: regex }, { codigo: regex }, { contato: regex }, { telefone: regex }, { cnpj: regex }];
  }
  return filtro;
}

export function temEndereco(endereco: Fornecedor["endereco"]): boolean {
  if (!endereco) return false;
  return Object.values(endereco).some((valor) => valor.trim().length > 0);
}

export function naFaixaDeProdutos(quantidade: number, faixa: string): boolean {
  switch (faixa) {
    case "sem":
      return quantidade === 0;
    case "1-5":
      return quantidade >= 1 && quantidade <= 5;
    case "6-15":
      return quantidade >= 6 && quantidade <= 15;
    case "16+":
      return quantidade >= 16;
    default:
      return true;
  }
}

/** Última entrada dentro de uma janela de dias — "nunca" quando não há nenhuma entrada. */
export function entradaDentroDeDias(ultimaEntrada: Date | null, dias: number, agora: Date): boolean {
  if (!ultimaEntrada) return false;
  const limite = agora.getTime() - dias * 86_400_000;
  return ultimaEntrada.getTime() >= limite;
}

export function condicaoValor(chave: ChaveFacetaFornecedor, valor: string, item: FornecedorComAgregado, agora: Date): boolean {
  switch (chave) {
    case FACETAS_FORNECEDOR.produtos:
      return naFaixaDeProdutos(item.agregado.produtosVinculados, valor);
    case FACETAS_FORNECEDOR.endereco:
      return valor === "com" ? temEndereco(item.documento.endereco) : !temEndereco(item.documento.endereco);
    case FACETAS_FORNECEDOR.entrada:
      return valor === "nunca"
        ? item.agregado.ultimaEntrada === null
        : entradaDentroDeDias(item.agregado.ultimaEntrada, Number(valor), agora);
    case FACETAS_FORNECEDOR.documento:
      return valor === "com" ? Boolean(item.documento.cnpj) : !item.documento.cnpj;
    default:
      return true;
  }
}

/** OR dentro do grupo, AND entre grupos — mesma semântica das facetas de Produtos/Clientes. */
export function aplicarSelecao(
  itens: FornecedorComAgregado[],
  selecao: SelecaoFacetas,
  agora: Date,
  ignorarChave?: ChaveFacetaFornecedor,
): FornecedorComAgregado[] {
  const grupos = Object.values(FACETAS_FORNECEDOR)
    .filter((chave) => chave !== ignorarChave)
    .map((chave) => ({ chave, valores: selecao[chave] ?? [] }))
    .filter((grupo) => grupo.valores.length > 0);

  if (grupos.length === 0) return itens;
  return itens.filter((item) =>
    grupos.every((grupo) => grupo.valores.some((valor) => condicaoValor(grupo.chave, valor, item, agora))),
  );
}
