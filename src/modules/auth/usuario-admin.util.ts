import { ARGON2_MEMORY_COST, ARGON2_TIME_COST } from "./auth.constants.js";
import type { UsuarioDocument } from "./schemas/usuario.schema.js";
import type { UsuarioPublico } from "./types/usuario-publico.interface.js";

/**
 * Fase 60.4.3.2.1 — regras de usuário compartilhadas pelo `AuthService` (login, seed) e pelos comandos
 * administrativos locais (`seed:admin`, `admin:desativar`), para que nenhum deles reimplemente normalização, hash
 * ou a forma pública do usuário.
 */

/** E-mail gravado e comparado sempre assim: trim + minúsculas. */
export function normalizarEmailAdmin(email: string): string {
  return email.trim().toLowerCase();
}

/** Formato mínimo de e-mail para os comandos administrativos: um único `@`, partes não vazias, sem espaços. */
export const FORMATO_EMAIL_ADMIN = /^[^\s@]+@[^\s@]+$/;
export const TAMANHO_MAXIMO_EMAIL = 254;

/** Hash Argon2id com os parâmetros do projeto (o MESMO verificado pelo login via `Bun.password.verify`). */
export async function gerarHashDeSenha(senha: string): Promise<string> {
  return Bun.password.hash(senha, { algorithm: "argon2id", memoryCost: ARGON2_MEMORY_COST, timeCost: ARGON2_TIME_COST });
}

/** Forma pública do usuário — nunca inclui `senhaHash`. */
export function paraUsuarioPublico(usuario: UsuarioDocument): UsuarioPublico {
  return {
    id: usuario.id,
    codigo: usuario.codigo,
    nome: usuario.nome,
    email: usuario.email,
    tipo: usuario.role,
    ativo: usuario.ativo,
  };
}
