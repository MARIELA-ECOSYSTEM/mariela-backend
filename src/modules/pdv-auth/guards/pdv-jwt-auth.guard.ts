import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ApiException } from "../../../common/exceptions/api.exception.js";
import { VendedoresRepository } from "../../vendedores/vendedores.repository.js";
import type { PdvAuthenticatedRequest, PdvJwtPayload } from "../pdv-auth.types.js";

/**
 * Guard de autenticação do MARIELA PDV. Lê o access token do header
 * `Authorization: Bearer <token>`, valida a assinatura com o `JwtService`
 * PRÓPRIO deste módulo (segredo `PDV_JWT_ACCESS_SECRET`, nunca o do ADMIN —
 * ver `pdv-auth.module.ts`) e popula `request.vendedor`.
 *
 * Ao contrário de `JwtAuthGuard` (ADMIN, deliberadamente stateless), este
 * guard É stateful de propósito: recarrega o vendedor do MongoDB a cada
 * requisição e rejeita se ele não existir mais, estiver excluído
 * (`VendedoresRepository.encontrarPorId` já filtra `excluidoEm: null`) ou
 * tiver sido desativado depois de emitido o token — um vendedor desligado no
 * meio do expediente perde o acesso na PRÓXIMA requisição, não só no próximo
 * refresh (30min de tolerância seria inaceitável para "encerramos o contrato
 * dela agora", diferente do ADMIN onde essa janela foi julgada aceitável).
 */
@Injectable()
export class PdvJwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly vendedoresRepository: VendedoresRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<PdvAuthenticatedRequest>();
    const token = this.extrairToken(request.headers.authorization);
    if (!token) throw ApiException.unauthorized("Token de acesso não informado.");

    let payload: PdvJwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<PdvJwtPayload>(token);
    } catch {
      throw ApiException.unauthorized("Sessão expirada. Faça login novamente.");
    }

    if (!this.payloadValido(payload)) {
      throw ApiException.unauthorized("Sessão expirada. Faça login novamente.");
    }

    const vendedor = await this.vendedoresRepository.encontrarPorId(payload.sub);
    if (!vendedor || !vendedor.ativo) {
      throw ApiException.unauthorized("Sessão expirada. Faça login novamente.");
    }

    request.vendedor = { id: vendedor.id, codigo: vendedor.codigo, nome: vendedor.nome, foto: vendedor.foto, ativo: vendedor.ativo };
    return true;
  }

  /** Defesa contra um token de OUTRO domínio (ex.: um JWT do ADMIN, que nunca tem `tipo: "PDV"`/`vendedorId`). */
  private payloadValido(payload: PdvJwtPayload): boolean {
    return (
      typeof payload?.sub === "string" &&
      payload.sub.length > 0 &&
      typeof payload.vendedorId === "string" &&
      typeof payload.codigo === "string" &&
      payload.tipo === "PDV"
    );
  }

  private extrairToken(header: string | undefined): string | null {
    if (!header?.startsWith("Bearer ")) return null;
    return header.slice("Bearer ".length).trim() || null;
  }
}
