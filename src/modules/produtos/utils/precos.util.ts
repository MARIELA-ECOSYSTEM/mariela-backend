/**
 * Regras de preço e margem — centralizadas aqui e usadas por TODO o módulo
 * (criação, atualização, promoção, listagem). Nunca duplicar esta fórmula.
 *
 * Precisão monetária: os valores continuam em ponto flutuante (compatível com
 * o contrato já existente do frontend, que trabalha em reais como `number`),
 * mas toda gravação passa por `arredondarMoeda` para não acumular erro de
 * ponto flutuante entre operações sucessivas (ex.: várias entradas/saídas).
 * Um tipo `Decimal128` foi considerado e descartado por ora: exigiria uma
 * camada de conversão na borda da API sem contrapartida real no volume de
 * dados de uma única loja — reavaliar se o domínio de pagamentos (parcelas,
 * troco) exigir precisão decimal exata.
 */

export interface PrecoEfetivoInput {
  precoVenda: number;
  ehPromocao: boolean;
  precoPromocional?: number | null;
}

/** Preço que o cliente efetivamente paga: promocional quando a promoção está ativa. */
export function precoEfetivo(produto: PrecoEfetivoInput): number {
  if (produto.ehPromocao && produto.precoPromocional) return produto.precoPromocional;
  return produto.precoVenda;
}

export function arredondarMoeda(valor: number): number {
  return Math.round(valor * 100) / 100;
}

/**
 * Margem sobre o preço EFETIVO (vigente) — decisão de negócio já aprovada:
 * `((precoEfetivo - precoCusto) / precoEfetivo) * 100`. Nunca sobre o preço
 * de custo (isso seria markup, não margem).
 */
export function calcularMargem(precoCusto: number, precoEfetivoValor: number): number {
  if (!precoEfetivoValor || precoEfetivoValor <= 0) return 0;
  return arredondarMoeda(((precoEfetivoValor - precoCusto) / precoEfetivoValor) * 100);
}
