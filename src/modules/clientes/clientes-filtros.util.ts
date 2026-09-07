import type { QueryFilter } from "mongoose";
import { FACETAS_CLIENTE, type ChaveFacetaCliente } from "./clientes.constants.js";
import type { Cliente } from "./schemas/cliente.schema.js";

export type SelecaoFacetas = Partial<Record<ChaveFacetaCliente, string[]>>;

/** Filtro aplicado SEMPRE, independente de facetas: nunca traz excluídos; `busca` livre em nome/telefone. */
export function filtroSempreAtivo(busca?: string): QueryFilter<Cliente> {
  const filtro: QueryFilter<Cliente> = { excluidoEm: null };
  const termo = busca?.trim();
  if (termo) {
    const regex = new RegExp(termo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filtro.$or = [{ nome: regex }, { telefone: regex }];
  }
  return filtro;
}

/** Início do dia, N meses atrás — mesma aritmética de calendário usada pelo frontend (`utils/cliente.ts#limiteSemCompra`). */
function limiteMeses(meses: number, agora = new Date()): Date {
  const limite = new Date(agora);
  limite.setHours(0, 0, 0, 0);
  limite.setMonth(limite.getMonth() - meses);
  return limite;
}

const MESES_POR_JANELA: Record<string, number> = { "1m": 1, "3m": 3, "6m": 6 };

/** Nunca comprou também conta como "sem compra recente" — mesma regra do frontend. */
function condicaoRecenciaValor(valor: string, agora: Date): QueryFilter<Cliente> | null {
  const meses = MESES_POR_JANELA[valor];
  if (!meses) return null;
  return { $or: [{ ultimaCompra: null }, { ultimaCompra: { $lt: limiteMeses(meses, agora) } }] };
}

function condicaoHistoricoValor(valor: string): QueryFilter<Cliente> | null {
  switch (valor) {
    case "com":
      return { compras: { $gt: 0 } };
    case "sem":
      return { compras: 0 };
    case "recorrente":
      return { compras: { $gte: 2 } };
    default:
      return null;
  }
}

function condicaoObservacaoValor(valor: string): QueryFilter<Cliente> | null {
  if (valor === "com") return { observacao: { $ne: "" } };
  if (valor === "sem") return { observacao: "" };
  return null;
}

/** Pares {mes, dia} de hoje até `dias` dias à frente — atravessa virada de mês/ano corretamente. */
function proximosDiasMesAno(base: Date, dias: number): { mes: number; dia: number }[] {
  const inicio = new Date(base);
  inicio.setHours(0, 0, 0, 0);
  const pares: { mes: number; dia: number }[] = [];
  for (let offset = 0; offset <= dias; offset += 1) {
    const alvo = new Date(inicio);
    alvo.setDate(inicio.getDate() + offset);
    pares.push({ mes: alvo.getMonth() + 1, dia: alvo.getDate() });
  }
  return pares;
}

/**
 * "mes"/"semana" comparam mês/dia via `$expr` (independente do ano); "semana"
 * enumera os próprios pares mês/dia dos próximos 7 dias em vez de aritmética
 * de data dentro da query — mesma lógica de `aniversarioNoPeriodo` do
 * frontend, só que expressa como igualdade em vez de laço.
 */
function condicaoAniversarioValor(valor: string, agora: Date): QueryFilter<Cliente> | null {
  switch (valor) {
    case "com":
      return { dataNascimento: { $ne: null } };
    case "sem":
      return { dataNascimento: null };
    case "mes":
      return {
        dataNascimento: { $ne: null },
        $expr: { $eq: [{ $month: "$dataNascimento" }, agora.getMonth() + 1] },
      } as QueryFilter<Cliente>;
    case "semana": {
      const pares = proximosDiasMesAno(agora, 7);
      return {
        dataNascimento: { $ne: null },
        $or: pares.map(({ mes, dia }) => ({
          $expr: {
            $and: [{ $eq: [{ $month: "$dataNascimento" }, mes] }, { $eq: [{ $dayOfMonth: "$dataNascimento" }, dia] }],
          },
        })),
      } as QueryFilter<Cliente>;
    }
    default:
      return null;
  }
}

function combinarOu(condicoes: QueryFilter<Cliente>[]): QueryFilter<Cliente> {
  return condicoes.length === 1 ? (condicoes[0] as QueryFilter<Cliente>) : { $or: condicoes };
}

/** Condição Mongo de UM grupo de faceta a partir dos valores selecionados (OR dentro do grupo). `null` = grupo inativo. */
export function condicaoFaceta(chave: ChaveFacetaCliente, valores: string[], agora = new Date()): QueryFilter<Cliente> | null {
  if (valores.length === 0) return null;

  const construtor: ((valor: string) => QueryFilter<Cliente> | null) | null =
    chave === FACETAS_CLIENTE.recencia
      ? (v) => condicaoRecenciaValor(v, agora)
      : chave === FACETAS_CLIENTE.historico
        ? condicaoHistoricoValor
        : chave === FACETAS_CLIENTE.aniversario
          ? (v) => condicaoAniversarioValor(v, agora)
          : chave === FACETAS_CLIENTE.observacao
            ? condicaoObservacaoValor
            : null;
  if (!construtor) return null;

  const condicoes = valores.map((valor) => construtor(valor)).filter((c): c is QueryFilter<Cliente> => c !== null);
  return condicoes.length === 0 ? null : combinarOu(condicoes);
}

/** Combina o filtro sempre-ativo com as condições de faceta ativas, ignorando opcionalmente um grupo. */
export function combinarFiltros(
  base: QueryFilter<Cliente>,
  selecao: SelecaoFacetas,
  ignorarChave?: ChaveFacetaCliente,
): QueryFilter<Cliente> {
  const condicoes = Object.values(FACETAS_CLIENTE)
    .filter((chave) => chave !== ignorarChave)
    .map((chave) => condicaoFaceta(chave, selecao[chave] ?? []))
    .filter((condicao): condicao is QueryFilter<Cliente> => condicao !== null);

  if (condicoes.length === 0) return base;
  return { $and: [base, ...condicoes] };
}
