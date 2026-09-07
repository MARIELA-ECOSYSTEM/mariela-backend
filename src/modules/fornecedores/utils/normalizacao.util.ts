/**
 * Só dígitos — usada para comparar telefones de forma independente da máscara.
 * A representação exibida/persistida ao usuário nunca usa este valor.
 */
export function normalizarTelefone(telefone: string): string {
  return telefone.replace(/\D/g, "");
}
