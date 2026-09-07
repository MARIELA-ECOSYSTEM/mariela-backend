const UNIDADES_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * Converte durações no mesmo formato usado em `JWT_ACCESS_EXPIRES_IN`/
 * `JWT_REFRESH_EXPIRES_IN` (`"15m"`, `"7d"`) para milissegundos. Evita
 * adicionar a dependência `ms` só para isto — cobre exatamente os formatos
 * que a configuração deste projeto usa.
 */
export function paraMilissegundos(duracao: string): number {
  const encontrado = /^(\d+)\s*(s|m|h|d)$/.exec(duracao.trim());
  if (!encontrado) {
    throw new Error(`Formato de duração inválido: "${duracao}". Use algo como "15m" ou "7d".`);
  }
  const [, valor, unidade] = encontrado;
  return Number(valor) * UNIDADES_MS[unidade!]!;
}
