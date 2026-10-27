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
 * Margem sobre o preço de CUSTO — decisão de negócio vigente (correção
 * pós-go-live, substitui a fórmula anterior que calculava sobre o preço de
 * venda): `((precoEfetivo - precoCusto) / precoCusto) * 100`.
 *
 * Exemplo: custo R$100, venda R$220 → lucro R$120 → margem 120%.
 *
 * `precoCusto <= 0` (zero ou inválido) devolve 0 em vez de dividir por zero
 * (evita `Infinity`/`NaN`); `precoEfetivoValor` não é mais o divisor, então
 * ele pode legitimamente ser 0 ou menor que o custo (resulta em margem
 * negativa, matematicamente válida — venda abaixo do custo).
 */
export function calcularMargem(precoCusto: number, precoEfetivoValor: number): number {
  if (!precoCusto || precoCusto <= 0) return 0;
  return arredondarMoeda(((precoEfetivoValor - precoCusto) / precoCusto) * 100);
}
