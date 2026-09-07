/**
 * Só dígitos — usada para comparar telefones de forma independente da máscara
 * ("(11) 99999-9999" vs "11999999999" devem contar como o mesmo número).
 * A representação exibida/persistida ao cliente nunca usa este valor.
 */
export function normalizarTelefone(telefone: string): string {
  return telefone.replace(/\D/g, "");
}
