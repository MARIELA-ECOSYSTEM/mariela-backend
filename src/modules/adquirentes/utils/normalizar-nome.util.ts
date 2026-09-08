/**
 * Minúsculas + trim — usada só para checar unicidade de nome sem diferenciar
 * maiúsculas/minúsculas (mesma técnica de `normalizarTelefone`, em
 * Fornecedores, adaptada de dígitos para texto).
 */
export function normalizarNomeAdquirente(nome: string): string {
  return nome.trim().toLowerCase();
}
