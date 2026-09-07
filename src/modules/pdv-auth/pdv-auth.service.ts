import { createHmac, randomBytes } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import { JwtService } from "@nestjs/jwt";
import type { Model, Types } from "mongoose";
import { ApiException } from "../../common/exceptions/api.exception.js";
import type { Configuration } from "../../config/configuration.js";
import { VendedoresRepository } from "../vendedores/vendedores.repository.js";
import { VendedoresService } from "../vendedores/vendedores.service.js";
import type { VendedorDocument } from "../vendedores/schemas/vendedor.schema.js";
import { paraMilissegundosPdv } from "./duracao-pdv.util.js";
import { REFRESH_TOKEN_BYTES } from "./pdv-auth.constants.js";
import { PdvAuthLoginThrottleService } from "./pdv-auth-login-throttle.service.js";
import { PdvAuthRepository } from "./pdv-auth.repository.js";
import type { LoginPdvDto } from "./dto/login-pdv.dto.js";
import type { RefreshPdvDto } from "./dto/refresh-pdv.dto.js";
import { EventoPdvAuth, type EventoPdvAuthDocument, type TipoEventoPdvAuth } from "./schemas/evento-pdv-auth.schema.js";
import type { ContextoRequisicaoPdv, PdvJwtPayload, ResultadoAutenticacaoPdv, VendedorPublicoPdv } from "./pdv-auth.types.js";

/**
 * Autenticação do MARIELA PDV — espelha `AuthService` (ADMIN) passo a passo
 * (mesmas defesas: tempo constante contra enumeração, rotação de refresh
 * token, detecção de reuso), mas para a identidade `Vendedor`, completamente
 * separada de `Usuario` (ver `pdv-auth.constants.ts`). Injeta `JwtService`
 * configurado pelo `JwtModule` PRÓPRIO deste módulo (segredo `PDV_JWT_*`,
 * nunca o `JwtService` global do ADMIN — ver `pdv-auth.module.ts`).
 */
@Injectable()
export class PdvAuthService {
  constructor(
    private readonly vendedoresService: VendedoresService,
    private readonly vendedoresRepository: VendedoresRepository,
    private readonly pdvAuthRepository: PdvAuthRepository,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService<Configuration>,
    private readonly pdvAuthLoginThrottleService: PdvAuthLoginThrottleService,
    @InjectModel(EventoPdvAuth.name) private readonly eventoModel: Model<EventoPdvAuthDocument>,
  ) {}

  async login(dto: LoginPdvDto, contexto: ContextoRequisicaoPdv): Promise<ResultadoAutenticacaoPdv> {
    const codigo = this.normalizarCodigo(dto.codigo);
    const chaveThrottle = `${contexto.ip ?? "desconhecido"}:${codigo}`;
    this.pdvAuthLoginThrottleService.verificar(chaveThrottle);

    const vendedor = await this.vendedoresService.verificarSenha(codigo, dto.senha);

    if (!vendedor) {
      this.pdvAuthLoginThrottleService.registrarFalha(chaveThrottle);
      // `verificarSenha` devolve `null` uniformemente (código inexistente,
      // senha errada, inativo ou excluído) de propósito — nunca deixa a
      // decisão de autenticação vazar essa distinção (mesma defesa contra
      // enumeração do login ADMIN). Esta busca adicional é só para a
      // auditoria conseguir atribuir a tentativa a um vendedor quando ele
      // existe (mesmo padrão de `AuthService.login`, que audita `usuario?.id`
      // mesmo numa falha) — não influencia o resultado da autenticação.
      const candidato = await this.vendedoresRepository.encontrarPorCodigo(codigo);
      await this.registrarEvento(candidato?.id ?? null, "pdv.login_falha", contexto);
      throw ApiException.invalidCredentials();
    }

    this.pdvAuthLoginThrottleService.registrarSucesso(chaveThrottle);
    await this.registrarEvento(vendedor.id, "pdv.login_sucesso", contexto);

    const tokens = await this.emitirTokens(vendedor, contexto);
    return { ...tokens, vendedor: this.paraVendedorPublico(vendedor) };
  }

  async refresh(dto: RefreshPdvDto, contexto: ContextoRequisicaoPdv): Promise<ResultadoAutenticacaoPdv> {
    const tokenHash = this.hashRefreshToken(dto.refreshToken);
    const agora = new Date();
    const anterior = await this.pdvAuthRepository.revogarSeValido(tokenHash, agora);

    if (!anterior) {
      await this.tratarFalhaDeRefresh(tokenHash, agora, contexto);
      // `tratarFalhaDeRefresh` sempre lança — isto é inatingível, só satisfaz o tipo de retorno.
      throw ApiException.refreshTokenInvalid();
    }

    const vendedor = await this.vendedoresRepository.encontrarPorId(String(anterior.vendedorId));
    if (!vendedor) throw ApiException.refreshTokenInvalid();
    if (!vendedor.ativo) {
      await this.pdvAuthRepository.revogarTodosDoVendedor(vendedor._id as Types.ObjectId, agora);
      throw ApiException.userInactive();
    }

    const tokens = await this.emitirTokens(vendedor, contexto);
    await this.pdvAuthRepository.marcarSubstituto(tokenHash, this.hashRefreshToken(tokens.refreshToken));
    await this.registrarEvento(vendedor.id, "pdv.refresh", contexto);

    return { ...tokens, vendedor: this.paraVendedorPublico(vendedor) };
  }

  async logout(dto: RefreshPdvDto): Promise<void> {
    const tokenHash = this.hashRefreshToken(dto.refreshToken);
    const revogado = await this.pdvAuthRepository.revogarSeValido(tokenHash, new Date());
    // Idempotente de propósito: token inexistente/já revogado não é erro — o
    // cliente só quer garantir que a sessão está encerrada, e ela está.
    if (revogado) {
      await this.registrarEvento(String(revogado.vendedorId), "pdv.logout", { ip: null, userAgent: null });
    }
  }

  /** Reutilização de um refresh token já revogado = possível sessão comprometida: mata a família inteira. */
  private async tratarFalhaDeRefresh(tokenHash: string, agora: Date, contexto: ContextoRequisicaoPdv): Promise<never> {
    const existente = await this.pdvAuthRepository.encontrarPorHash(tokenHash);
    if (existente?.revogadoEm) {
      await this.pdvAuthRepository.revogarTodosDoVendedor(existente.vendedorId, agora);
      await this.registrarEvento(String(existente.vendedorId), "pdv.refresh_reusado", contexto);
      throw ApiException.refreshTokenReused();
    }
    throw ApiException.refreshTokenInvalid();
  }

  private async emitirTokens(
    vendedor: VendedorDocument,
    contexto: ContextoRequisicaoPdv,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const payload: PdvJwtPayload = { sub: vendedor.id, vendedorId: vendedor.id, codigo: vendedor.codigo, tipo: "PDV" };
    const accessToken = await this.jwtService.signAsync(payload);

    const refreshTokenBruto = randomBytes(REFRESH_TOKEN_BYTES).toString("base64url");
    const refreshExpiresIn = this.configService.get("pdvJwt.refreshExpiresIn", { infer: true })!;
    const expiresAt = new Date(Date.now() + paraMilissegundosPdv(refreshExpiresIn));

    await this.pdvAuthRepository.criar({
      vendedorId: vendedor._id as Types.ObjectId,
      tokenHash: this.hashRefreshToken(refreshTokenBruto),
      expiresAt,
      userAgent: contexto.userAgent,
      ip: contexto.ip,
    });

    const accessExpiresIn = this.configService.get("pdvJwt.accessExpiresIn", { infer: true })!;
    const expiresIn = Math.round(paraMilissegundosPdv(accessExpiresIn) / 1000);

    return { accessToken, refreshToken: refreshTokenBruto, expiresIn };
  }

  /** Refresh token é opaco/aleatório (mais seguro e revogável) — este segredo é a chave HMAC do hash armazenado, nunca assina um JWT. */
  private hashRefreshToken(tokenBruto: string): string {
    const segredo = this.configService.get("pdvJwt.refreshSecret", { infer: true })!;
    return createHmac("sha256", segredo).update(tokenBruto).digest("hex");
  }

  private normalizarCodigo(valor: string): string {
    return valor.trim().toUpperCase();
  }

  private paraVendedorPublico(vendedor: VendedorDocument): VendedorPublicoPdv {
    return { id: vendedor.id, codigo: vendedor.codigo, nome: vendedor.nome, foto: vendedor.foto, ativo: vendedor.ativo };
  }

  private async registrarEvento(
    vendedorId: string | Types.ObjectId | null,
    tipo: TipoEventoPdvAuth,
    contexto: ContextoRequisicaoPdv,
  ): Promise<void> {
    await this.eventoModel.create({ vendedorId, tipo, ip: contexto.ip, userAgent: contexto.userAgent });
  }
}
