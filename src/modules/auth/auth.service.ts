import { createHmac, randomBytes } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import { JwtService } from "@nestjs/jwt";
import type { Model, Types } from "mongoose";
import { ApiException } from "../../common/exceptions/api.exception.js";
import type { Configuration } from "../../config/configuration.js";
import type { JwtPayload } from "../../common/types/jwt-payload.interface.js";
import type { Role } from "../../common/types/role.type.js";
import {
  ARGON2_MEMORY_COST,
  ARGON2_TIME_COST,
  CHAVE_SEQUENCIA_USUARIO,
  DIGITOS_CODIGO_USUARIO,
  PREFIXO_CODIGO_USUARIO,
  REFRESH_TOKEN_BYTES,
} from "./auth.constants.js";
import { paraMilissegundos } from "./duracao.util.js";
import type { LoginDto } from "./dto/login.dto.js";
import type { RefreshTokenDto } from "./dto/refresh-token.dto.js";
import { RefreshTokensRepository } from "./refresh-tokens.repository.js";
import { EventoAuth, type EventoAuthDocument, type TipoEventoAuth } from "./schemas/evento-auth.schema.js";
import type { UsuarioDocument } from "./schemas/usuario.schema.js";
import type { ResultadoAutenticacao, UsuarioPublico } from "./types/usuario-publico.interface.js";
import { UsuariosRepository } from "./usuarios.repository.js";
import { LoginThrottleService } from "./login-throttle.service.js";
import { SequenciasService } from "../sequencias/sequencias.service.js";

export interface ContextoRequisicao {
  ip: string | null;
  userAgent: string | null;
}

/** Hash argon2id de uma senha aleatória, calculado uma única vez no boot — usado para manter o tempo de resposta do login constante quando o e-mail não existe (ver `login`). */
const HASH_FANTASMA = Bun.password.hashSync(randomBytes(32).toString("hex"), {
  algorithm: "argon2id",
  memoryCost: ARGON2_MEMORY_COST,
  timeCost: ARGON2_TIME_COST,
});

@Injectable()
export class AuthService {
  constructor(
    private readonly usuariosRepository: UsuariosRepository,
    private readonly refreshTokensRepository: RefreshTokensRepository,
    private readonly sequenciasService: SequenciasService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService<Configuration>,
    private readonly loginThrottleService: LoginThrottleService,
    @InjectModel(EventoAuth.name) private readonly eventoModel: Model<EventoAuthDocument>,
  ) {}

  /**
   * Usado SÓ pelo script de seed (`bun run seed:admin`) — não existe rota
   * pública para criar usuários nesta etapa. Idempotente: se o e-mail já
   * existir, devolve `criado: false` em vez de lançar erro (o seed pode ser
   * executado de novo com segurança).
   */
  async criarAdminSeed(dados: { nome: string; email: string; senha: string }): Promise<{
    criado: boolean;
    usuario: UsuarioPublico;
  }> {
    const emailNormalizado = this.normalizarEmail(dados.email);
    const existente = await this.usuariosRepository.encontrarPorEmail(emailNormalizado);
    if (existente) return { criado: false, usuario: this.paraUsuarioPublico(existente) };

    const codigo = await this.sequenciasService.proximoCodigo(
      CHAVE_SEQUENCIA_USUARIO,
      PREFIXO_CODIGO_USUARIO,
      DIGITOS_CODIGO_USUARIO,
    );
    const senhaHash = await this.hashSenha(dados.senha);
    const usuario = await this.usuariosRepository.criar({
      codigo,
      nome: dados.nome.trim(),
      email: emailNormalizado,
      senhaHash,
      role: "ADMIN",
      ativo: true,
      ultimoLoginEm: null,
    });
    return { criado: true, usuario: this.paraUsuarioPublico(usuario) };
  }

  async login(dto: LoginDto, contexto: ContextoRequisicao): Promise<ResultadoAutenticacao> {
    const emailNormalizado = this.normalizarEmail(dto.usuario);
    const chaveThrottle = `${contexto.ip ?? "desconhecido"}:${emailNormalizado}`;
    this.loginThrottleService.verificar(chaveThrottle);

    const usuario = await this.usuariosRepository.encontrarPorEmail(emailNormalizado);
    // Mesmo quando o e-mail não existe, gasta o mesmo tempo de um argon2id
    // real contra um hash fantasma — sem isso, a ausência do usuário
    // responderia mais rápido que uma senha errada, um canal lateral de
    // temporização que permitiria enumerar contas.
    const senhaConfere = await Bun.password.verify(dto.senha, usuario?.senhaHash ?? HASH_FANTASMA);

    if (!usuario || !senhaConfere || !usuario.ativo) {
      this.loginThrottleService.registrarFalha(chaveThrottle);
      await this.registrarEvento(usuario?.id ?? null, "LOGIN_FAILED", contexto);
      throw ApiException.invalidCredentials();
    }

    this.loginThrottleService.registrarSucesso(chaveThrottle);
    await this.usuariosRepository.registrarLogin(usuario.id);
    await this.registrarEvento(usuario.id, "LOGIN_SUCCESS", contexto);

    const tokens = await this.emitirTokens(usuario, contexto);
    return { ...tokens, usuario: this.paraUsuarioPublico(usuario) };
  }

  async refresh(dto: RefreshTokenDto, contexto: ContextoRequisicao): Promise<ResultadoAutenticacao> {
    const tokenHash = this.hashRefreshToken(dto.refreshToken);
    const agora = new Date();
    const anterior = await this.refreshTokensRepository.revogarSeValido(tokenHash, agora);

    if (!anterior) {
      await this.tratarFalhaDeRefresh(tokenHash, agora, contexto);
      // `tratarFalhaDeRefresh` sempre lança — isto é inatingível, só satisfaz o tipo de retorno.
      throw ApiException.refreshTokenInvalid();
    }

    const usuario = await this.usuariosRepository.encontrarPorId(String(anterior.usuarioId));
    if (!usuario) throw ApiException.refreshTokenInvalid();
    if (!usuario.ativo) {
      await this.refreshTokensRepository.revogarTodosDoUsuario(usuario._id, agora);
      throw ApiException.userInactive();
    }

    const tokens = await this.emitirTokens(usuario, contexto);
    await this.refreshTokensRepository.marcarSubstituto(tokenHash, this.hashRefreshToken(tokens.refreshToken));
    await this.registrarEvento(usuario.id, "REFRESH", contexto);

    return { ...tokens, usuario: this.paraUsuarioPublico(usuario) };
  }

  async logout(dto: RefreshTokenDto): Promise<void> {
    const tokenHash = this.hashRefreshToken(dto.refreshToken);
    const revogado = await this.refreshTokensRepository.revogarSeValido(tokenHash, new Date());
    // Idempotente de propósito: token inexistente/já revogado não é erro — o
    // cliente só quer garantir que a sessão está encerrada, e ela está.
    if (revogado) {
      await this.registrarEvento(String(revogado.usuarioId), "LOGOUT", { ip: null, userAgent: null });
    }
  }

  async me(usuarioId: string): Promise<UsuarioPublico> {
    const usuario = await this.usuariosRepository.encontrarPorId(usuarioId);
    if (!usuario) throw ApiException.notFound("Usuário não encontrado.");
    return this.paraUsuarioPublico(usuario);
  }

  /** Reutilização de um refresh token já revogado = possível sessão comprometida: mata a família inteira. */
  private async tratarFalhaDeRefresh(tokenHash: string, agora: Date, contexto: ContextoRequisicao): Promise<never> {
    const existente = await this.refreshTokensRepository.encontrarPorHash(tokenHash);
    if (existente?.revogadoEm) {
      await this.refreshTokensRepository.revogarTodosDoUsuario(existente.usuarioId, agora);
      await this.registrarEvento(String(existente.usuarioId), "REFRESH_REUSED", contexto);
      throw ApiException.refreshTokenReused();
    }
    throw ApiException.refreshTokenInvalid();
  }

  private async emitirTokens(
    usuario: UsuarioDocument,
    contexto: ContextoRequisicao,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const payload: JwtPayload = { sub: usuario.id, codigo: usuario.codigo, role: usuario.role as Role };
    const accessToken = await this.jwtService.signAsync(payload);

    const refreshTokenBruto = randomBytes(REFRESH_TOKEN_BYTES).toString("base64url");
    const refreshExpiresIn = this.configService.get("jwt.refreshExpiresIn", { infer: true })!;
    const expiresAt = new Date(Date.now() + paraMilissegundos(refreshExpiresIn));

    await this.refreshTokensRepository.criar({
      usuarioId: usuario._id as Types.ObjectId,
      tokenHash: this.hashRefreshToken(refreshTokenBruto),
      expiresAt,
      userAgent: contexto.userAgent,
      ip: contexto.ip,
    });

    const accessExpiresIn = this.configService.get("jwt.accessExpiresIn", { infer: true })!;
    const expiresIn = Math.round(paraMilissegundos(accessExpiresIn) / 1000);

    return { accessToken, refreshToken: refreshTokenBruto, expiresIn };
  }

  /**
   * O nome `JWT_REFRESH_SECRET` é herdado da etapa de infraestrutura (que
   * previu um refresh token em JWT); como o refresh token é opaco/aleatório
   * (mais seguro e revogável — ver relatório), este segredo é reaproveitado
   * como chave de HMAC do hash armazenado, em vez de assinar um JWT.
   */
  private hashRefreshToken(tokenBruto: string): string {
    const segredo = this.configService.get("jwt.refreshSecret", { infer: true })!;
    return createHmac("sha256", segredo).update(tokenBruto).digest("hex");
  }

  private async hashSenha(senha: string): Promise<string> {
    return Bun.password.hash(senha, { algorithm: "argon2id", memoryCost: ARGON2_MEMORY_COST, timeCost: ARGON2_TIME_COST });
  }

  private normalizarEmail(valor: string): string {
    return valor.trim().toLowerCase();
  }

  private paraUsuarioPublico(usuario: UsuarioDocument): UsuarioPublico {
    return {
      id: usuario.id,
      codigo: usuario.codigo,
      nome: usuario.nome,
      email: usuario.email,
      tipo: usuario.role as Role,
      ativo: usuario.ativo,
    };
  }

  private async registrarEvento(
    usuarioId: string | Types.ObjectId | null,
    tipo: TipoEventoAuth,
    contexto: ContextoRequisicao,
  ): Promise<void> {
    await this.eventoModel.create({ usuarioId, tipo, ip: contexto.ip, userAgent: contexto.userAgent });
  }
}
