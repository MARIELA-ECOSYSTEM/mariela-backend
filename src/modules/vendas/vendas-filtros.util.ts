import type { QueryFilter } from "mongoose";
import { FACETAS_VENDA, FAIXAS_VALOR, type ChaveFacetaVenda } from "./vendas.constants.js";
import type { Venda } from "./schemas/venda.schema.js";

export type SelecaoFacetas = Partial<Record<ChaveFacetaVenda, string[]>>;

/** Filtro aplicado SEMPRE: busca livre por código, número, cliente, vendedor ou forma de pagamento. */
export function filtroSempreAtivo(busca?: string): QueryFilter<Venda> {
  const filtro: QueryFilter<Venda> = {};
  const termo = busca?.trim();
  if (termo) {
    const regex = new RegExp(termo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filtro.$or = [
      { codigo: regex },
      { numero: regex },
      { clienteNome: regex },
      { vendedorNome: regex },
      { formaPagamento: regex },
    ];
  }
  return filtro;
}

function inicioDoDia(data: Date): Date {
  const copia = new Date(data);
  copia.setHours(0, 0, 0, 0);
  return copia;
}

/** Mesma regra de `vendaNoPeriodo` no frontend (`src/utils/venda.ts`). */
function condicaoPeriodoValor(valor: string, agora: Date): QueryFilter<Venda> | null {
  const hoje = inicioDoDia(agora);
  if (valor === "hoje") {
    const amanha = new Date(hoje);
    amanha.setDate(amanha.getDate() + 1);
    return { dataVenda: { $gte: hoje, $lt: amanha } };
  }
  if (valor === "7d" || valor === "30d") {
    const dias = valor === "7d" ? 7 : 30;
    const limite = new Date(hoje);
    limite.setDate(limite.getDate() - (dias - 1));
    return { dataVenda: { $gte: limite } };
  }
  if (valor === "mes" || valor === "mes-anterior") {
    const referencia = new Date(agora);
    if (valor === "mes-anterior") referencia.setMonth(referencia.getMonth() - 1);
    const inicio = new Date(referencia.getFullYear(), referencia.getMonth(), 1);
    const fim = new Date(referencia.getFullYear(), referencia.getMonth() + 1, 1);
    return { dataVenda: { $gte: inicio, $lt: fim } };
  }
  return null;
}

function condicaoValorValor(valor: string): QueryFilter<Venda> | null {
  const faixa = FAIXAS_VALOR.find((item) => item.valor === valor);
  if (!faixa) return null;
  return faixa.max === Number.POSITIVE_INFINITY
    ? { valorFinal: { $gt: faixa.min } }
    : { valorFinal: { $gt: faixa.min, $lte: faixa.max } };
}

function condicaoCondicoesValor(valor: string): QueryFilter<Venda> | null {
  if (valor === "promocao") return { temPromocao: true };
  if (valor === "desconto") return { temDesconto: true };
  if (valor === "cheio") return { temPromocao: false, temDesconto: false };
  return null;
}

function condicaoFinanceiroValor(valor: string): QueryFilter<Venda> | null {
  if (valor === "quitada") return { valorPendente: 0 };
  if (valor === "pendente") return { valorPendente: { $gt: 0 } };
  if (valor === "parcelada") return { totalParcelas: { $gt: 1 } };
  if (valor === "devolucao") return { valorDevolvido: { $gt: 0 } };
  return null;
}

function condicaoClienteValor(valor: string): QueryFilter<Venda> {
  return valor === "consumidor-final" ? { clienteId: null } : { clienteId: valor };
}

function combinarOu(condicoes: QueryFilter<Venda>[]): QueryFilter<Venda> {
  return condicoes.length === 1 ? (condicoes[0] as QueryFilter<Venda>) : { $or: condicoes };
}

/** Condição Mongo de UM grupo de faceta a partir dos valores selecionados (OR dentro do grupo). `null` = grupo inativo. */
export function condicaoFaceta(chave: ChaveFacetaVenda, valores: string[], agora = new Date()): QueryFilter<Venda> | null {
  if (valores.length === 0) return null;

  let condicoes: QueryFilter<Venda>[];
  switch (chave) {
    case FACETAS_VENDA.status:
      condicoes = valores.map((valor) => ({ status: valor }) as QueryFilter<Venda>);
      break;
    case FACETAS_VENDA.periodo:
      condicoes = valores.map((valor) => condicaoPeriodoValor(valor, agora)).filter((c): c is QueryFilter<Venda> => c !== null);
      break;
    case FACETAS_VENDA.vendedor:
      condicoes = valores.map((valor) => ({ vendedorId: valor }) as QueryFilter<Venda>);
      break;
    case FACETAS_VENDA.cliente:
      condicoes = valores.map(condicaoClienteValor);
      break;
    case FACETAS_VENDA.pagamento:
      condicoes = valores.map((valor) => ({ formaPagamento: valor }) as QueryFilter<Venda>);
      break;
    case FACETAS_VENDA.caixa:
      condicoes = valores.map((valor) => ({ caixaCodigo: valor }) as QueryFilter<Venda>);
      break;
    case FACETAS_VENDA.valor:
      condicoes = valores.map(condicaoValorValor).filter((c): c is QueryFilter<Venda> => c !== null);
      break;
    case FACETAS_VENDA.condicoes:
      condicoes = valores.map(condicaoCondicoesValor).filter((c): c is QueryFilter<Venda> => c !== null);
      break;
    case FACETAS_VENDA.financeiro:
      condicoes = valores.map(condicaoFinanceiroValor).filter((c): c is QueryFilter<Venda> => c !== null);
      break;
    default:
      condicoes = [];
  }
  return condicoes.length === 0 ? null : combinarOu(condicoes);
}

/** Combina o filtro sempre-ativo com as condições de faceta ativas, ignorando opcionalmente um grupo. */
export function combinarFiltros(base: QueryFilter<Venda>, selecao: SelecaoFacetas, ignorarChave?: ChaveFacetaVenda): QueryFilter<Venda> {
  const condicoes = Object.values(FACETAS_VENDA)
    .filter((chave) => chave !== ignorarChave)
    .map((chave) => condicaoFaceta(chave, selecao[chave] ?? []))
    .filter((condicao): condicao is QueryFilter<Venda> => condicao !== null);

  if (condicoes.length === 0) return base;
  return { $and: [base, ...condicoes] };
}
