/**
 * Mesma estratégia já usada no projeto para dinheiro: `number` simples
 * arredondado a centavos (ver `Produto.precoVenda` e o mock atual de Caixa,
 * `caixas.lancamentos.ts#arredondar`) — não introduzo Decimal128 aqui para
 * não divergir do restante do código já em produção.
 *
 * Etapa 18.16 — usa `Math.round`, NUNCA `Number(valor.toFixed(2))`: as duas
 * estratégias divergem exatamente em valores de meio-centavo (ex.: `0.015`
 * vira `0.01` com `toFixed` mas `0.02` com `Math.round`, confirmado
 * empiricamente). `Math.round` é o mesmo algoritmo de
 * `produtos/utils/precos.util.ts#arredondarMoeda` — a fonte de verdade de
 * arredondamento monetário já reusada por Vendas/PDV/Dashboard/Fornecedores —
 * então um valor de meio-centavo (ex.: enviado por um cliente HTTP bruto em
 * `valorInicial`/`valor`/`valorInformado`, que não têm limite de casas
 * decimais no DTO) agora arredonda de forma consistente entre os dois
 * módulos, em vez de depender de qual dos dois o processou primeiro.
 */
export function arredondar(valor: number): number {
  return Math.round(valor * 100) / 100;
}
