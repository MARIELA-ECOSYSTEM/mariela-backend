import type { Request } from "express";

/**
 * Claims do access token do MARIELA PDV — payload próprio, NUNCA compatível
 * com `JwtPayload` (ADMIN, `common/types/jwt-payload.interface.ts`). O campo
 * `tipo: "PDV"` fixo é o discriminador que impede qualquer confusão entre os
 * dois domínios de identidade, mesmo que alguém tentasse usar um token do PDV
 * contra um guard do Backoffice (que exige `role`, inexistente aqui) ou
 * vice-versa (`PdvJwtAuthGuard` exige `tipo === "PDV"`, inexistente num token
 * do ADMIN).
 */
export interface PdvJwtPayload {
  sub: string;
  vendedorId: string;
  codigo: string;
  tipo: "PDV";
  iat?: number;
  exp?: number;
}

/** Identidade pública do vendedor — nunca inclui `senhaHash`/`telefoneNormalizado`/agregados comerciais. */
export interface VendedorPublicoPdv {
  id: string;
  codigo: string;
  nome: string;
  foto: string | null;
  ativo: boolean;
}

export interface ResultadoAutenticacaoPdv {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  vendedor: VendedorPublicoPdv;
}

export interface ContextoRequisicaoPdv {
  ip: string | null;
  userAgent: string | null;
}

/** Populado por `PdvJwtAuthGuard` a partir do vendedor validado — nunca do payload do token cru (ver o guard). */
export interface PdvAuthenticatedRequest extends Request {
  vendedor: VendedorPublicoPdv;
}

