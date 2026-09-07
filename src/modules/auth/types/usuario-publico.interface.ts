import type { Role } from "../../../common/types/role.type.js";

/**
 * Forma pública do usuário — nunca inclui `senhaHash`. `tipo` (não `role`) é
 * mantido de propósito: é o nome de campo que `Usuario` já usa no Backoffice
 * (`src/types/auth.ts`) — `codigo`/`email`/`ativo` são extras que o frontend
 * atual simplesmente ignora, sem quebrar nada.
 */
export interface UsuarioPublico {
  id: string;
  codigo: string;
  nome: string;
  email: string;
  tipo: Role;
  ativo: boolean;
}

export interface ResultadoAutenticacao {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  usuario: UsuarioPublico;
}
