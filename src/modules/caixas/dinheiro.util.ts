/**
 * Mesma estratégia já usada no projeto para dinheiro: `number` simples
 * arredondado a centavos (ver `Produto.precoVenda` e o mock atual de Caixa,
 * `caixas.lancamentos.ts#arredondar`) — não introduzo Decimal128 aqui para
 * não divergir do restante do código já em produção.
 */
export function arredondar(valor: number): number {
  return Number(valor.toFixed(2));
}
