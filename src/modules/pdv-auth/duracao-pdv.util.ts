const UNIDADES_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * Converte durações no formato usado em `PDV_JWT_ACCESS_EXPIRES_IN`/
 * `PDV_JWT_REFRESH_EXPIRES_IN` (`"30m"`, `"12h"`) para milissegundos.
 * Duplicado de `modules/auth/duracao.util.ts` de propósito — ver comentário em
 * `pdv-auth.constants.ts` sobre não importar nada do módulo Auth.
 */
export function paraMilissegundosPdv(duracao: string): number {
  const encontrado = /^(\d+)\s*(s|m|h|d)$/.exec(duracao.trim());
  if (!encontrado) {
    throw new Error(`Formato de duração inválido: "${duracao}". Use algo como "30m" ou "12h".`);
  }
  const [, valor, unidade] = encontrado;
  return Number(valor) * UNIDADES_MS[unidade!]!;
}
