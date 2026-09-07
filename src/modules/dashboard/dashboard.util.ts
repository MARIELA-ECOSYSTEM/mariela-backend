/**
 * Lógica de calendário e agregação pura do Dashboard — espelha exatamente
 * `src/services/mock/dashboard.mock.ts` (a especificação de fato do
 * contrato), com uma única melhoria deliberada: os recortes de data usam
 * intervalos semiabertos `[inicio, fim)` em vez de comparações `>=` sem limite
 * superior — mesmo resultado para dados reais, sem a armadilha clássica de
 * `23:59:59.999`.
 */
import { arredondarMoeda } from "../produtos/utils/precos.util.js";
import { MESES_DISPONIVEIS } from "./dashboard.constants.js";
import type { MesReferencia } from "./dashboard.types.js";

export interface IntervaloData {
  inicio: Date;
  fim: Date;
}

/** Chave `YYYY-MM` a partir do fuso horário local do servidor — mesmo critério do mock (nunca UTC). */
export function chaveMes(data: Date): string {
  return `${data.getFullYear()}-${String(data.getMonth() + 1).padStart(2, "0")}`;
}

export function labelMes(chave: string): string {
  const [ano, mes] = chave.split("-").map(Number);
  const data = new Date(ano!, mes! - 1, 1);
  return data.toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
}

export function calcularMesesDisponiveis(agora: Date = new Date()): MesReferencia[] {
  const lista: MesReferencia[] = [];
  for (let i = 0; i < MESES_DISPONIVEIS; i += 1) {
    const data = new Date(agora);
    data.setDate(1);
    data.setMonth(data.getMonth() - i);
    const valor = chaveMes(data);
    lista.push({ valor, label: labelMes(valor) });
  }
  return lista;
}

export function calcularMesAnterior(chave: string): string {
  const [ano, mes] = chave.split("-").map(Number);
  const data = new Date(ano!, mes! - 2, 1);
  return chaveMes(data);
}

/** Resolve o mês solicitado contra os disponíveis; fora do intervalo cai no mês atual (mesmo comportamento do mock). */
export function resolverMesReferencia(mesSolicitado: string | undefined, disponiveis: MesReferencia[]): string {
  if (mesSolicitado && disponiveis.some((mes) => mes.valor === mesSolicitado)) return mesSolicitado;
  return disponiveis[0]!.valor;
}

/** Intervalo semiaberto `[inicio do mês, início do mês seguinte)` a partir de uma chave `YYYY-MM`. */
export function limitesDoMes(chave: string): IntervaloData {
  const [ano, mes] = chave.split("-").map(Number);
  return { inicio: new Date(ano!, mes! - 1, 1, 0, 0, 0, 0), fim: new Date(ano!, mes!, 1, 0, 0, 0, 0) };
}

/** `[hoje 00:00, amanhã 00:00)` no fuso horário local do servidor. */
export function limitesDeHoje(agora: Date = new Date()): IntervaloData {
  const inicio = new Date(agora);
  inicio.setHours(0, 0, 0, 0);
  const fim = new Date(inicio);
  fim.setDate(fim.getDate() + 1);
  return { inicio, fim };
}

/** Janela móvel de 7 dias terminando hoje (inclusive): `[hoje - 6 dias, amanhã)`. */
export function limitesDaSemana(agora: Date = new Date()): IntervaloData {
  const { fim } = limitesDeHoje(agora);
  const inicio = new Date(fim);
  inicio.setDate(inicio.getDate() - 7);
  return { inicio, fim };
}

export function somarValorFinal(vendas: { valorFinal: number }[]): number {
  return arredondarMoeda(vendas.reduce((total, venda) => total + venda.valorFinal, 0));
}

export function diasNoMes(chave: string): number {
  const [ano, mes] = chave.split("-").map(Number);
  return new Date(ano!, mes!, 0).getDate();
}
