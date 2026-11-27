import { normalizarFormaPagamento } from "../produtos/utils/normalizacao.util.js";
import { SENTIDO_POR_TIPO } from "./caixas.constants.js";
import { arredondar } from "./dinheiro.util.js";
import type { ResumoFormaPagamentoCaixa } from "./caixas.types.js";
import type { MovimentoCaixaDocument } from "./schemas/movimento-caixa.schema.js";

/**
 * Fase 22.8.9.12 — regra do DINHEIRO FÍSICO da gaveta. O fechamento confere o dinheiro contado na gaveta; só a forma
 * "Dinheiro" (comparada como em toda a aplicação: sem acento, sem diferença de maiúsculas e espaços — ver
 * `normalizarFormaPagamento`) movimenta a gaveta. PIX, crédito, débito e QUALQUER outra forma — inclusive uma forma
 * desconhecida — NÃO entram no dinheiro físico esperado: nunca são classificadas como dinheiro por suposição. Elas
 * continuam visíveis, com o próprio nome, em `porFormaPagamento`.
 *
 * A regra vale igualmente para todos os tipos de movimento (venda, cancelamento, injeção e sangria): o efeito na gaveta
 * é decidido pela forma registrada NO MOVIMENTO.
 */
const FORMA_DINHEIRO_FISICO = normalizarFormaPagamento("Dinheiro");

export function ehDinheiroFisico(formaPagamento: string): boolean {
  return normalizarFormaPagamento(formaPagamento) === FORMA_DINHEIRO_FISICO;
}

type MovimentoParaGaveta = Pick<MovimentoCaixaDocument, "tipo" | "formaPagamento" | "valor">;

/** Valor de abertura + entradas em dinheiro − saídas em dinheiro. Pode ser negativo, como o saldo (Etapa 18.2). */
export function calcularDinheiroEsperado(movimentos: readonly MovimentoParaGaveta[], valorInicial: number): number {
  let total = valorInicial;
  for (const movimento of movimentos) {
    if (!ehDinheiroFisico(movimento.formaPagamento)) continue;
    total += SENTIDO_POR_TIPO[movimento.tipo] === "entrada" ? movimento.valor : -movimento.valor;
  }
  return arredondar(total);
}

/**
 * Totais INFORMATIVOS por forma de pagamento (não entram no cálculo do dinheiro físico). Formas iguais após
 * normalização são agrupadas, exibidas com o nome do primeiro movimento. Ordem: dinheiro primeiro, depois pelo nome.
 */
export function resumirPorFormaPagamento(movimentos: readonly MovimentoParaGaveta[]): ResumoFormaPagamentoCaixa[] {
  const grupos = new Map<string, ResumoFormaPagamentoCaixa>();
  for (const movimento of movimentos) {
    const chave = normalizarFormaPagamento(movimento.formaPagamento);
    const grupo = grupos.get(chave) ?? {
      forma: movimento.formaPagamento.trim(),
      dinheiroFisico: chave === FORMA_DINHEIRO_FISICO,
      entradas: 0,
      saidas: 0,
      saldo: 0,
    };
    if (SENTIDO_POR_TIPO[movimento.tipo] === "entrada") grupo.entradas = arredondar(grupo.entradas + movimento.valor);
    else grupo.saidas = arredondar(grupo.saidas + movimento.valor);
    grupo.saldo = arredondar(grupo.entradas - grupo.saidas);
    grupos.set(chave, grupo);
  }
  return [...grupos.values()].sort(
    (a, b) => Number(b.dinheiroFisico) - Number(a.dinheiroFisico) || a.forma.localeCompare(b.forma, "pt-BR"),
  );
}
