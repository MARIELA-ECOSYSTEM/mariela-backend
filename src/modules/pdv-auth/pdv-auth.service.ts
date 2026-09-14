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

  /**
   * Etapa 26 — fecha a corrida em que o token novo da requisição VENCEDORA
   * podia escapar da varredura de reuso (`revogarTodosDoVendedor`), quando
   * essa varredura (disparada pela PERDEDORA) rodava ANTES do `criar()` do
   * token novo terminar. Reprodução controlada: 1 violação em 150 iterações
   * de duas chamadas concorrentes reais (`Promise.allSettled`) contra o
   * mesmo refresh token.
   *
   * Correção de ORDEM (não de política nova nem de lógica de decisão nova):
   * o candidato de rotação agora é criado ANTES da decisão atômica de quem
   * vence (`revogarSeValido`, inalterada). Prova por causalidade: a criação
   * do candidato da vencedora acontece, na MESMA requisição, antes da sua
   * própria chamada a `revogarSeValido` que sucede; como essa chamada só
   * pode suceder se rodar ANTES da chamada da perdedora (que só falha por
   * observar `revogadoEm` já setado — MongoDB serializa updates no mesmo
   * documento), e a perdedora só dispara a varredura DEPOIS de falhar, por
   * transitividade a varredura sempre roda depois da criação do candidato —
   * nunca antes. Isso vale para QUALQUER entrelaçamento das duas
   * requisições, não só o cenário exato reproduzido.
   *
   * A decisão de segurança em si (quem vence, o que conta como reuso, a
   * política de matar a família inteira) permanece EXATAMENTE a mesma —
   * só a ordem das operações mudou.
   */
  async refresh(dto: RefreshPdvDto, contexto: ContextoRequisicaoPdv): Promise<ResultadoAutenticacaoPdv> {
    const tokenHash = this.hashRefreshToken(dto.refreshToken);
    const agora = new Date();

    // Peek NÃO-atômico: só decide SE vale a pena criar um candidato antes da
    // hora. A decisão de segurança em si continua sendo feita
    // exclusivamente pelo `findOneAndUpdate` atômico de `revogarSeValido`
    // logo abaixo — nunca por este peek (só evita criar/descartar um
    // candidato à toa quando o token já está obviamente inválido).
    const antesDaDecisao = await this.pdvAuthRepository.encontrarPorHash(tokenHash);
    const pareceValido = antesDaDecisao != null && antesDaDecisao.revogadoEm == null && antesDaDecisao.expiresAt > agora;

    let candidato: { accessToken: string; refreshToken: string; expiresIn: number } | null = null;
    let candidatoTokenHash: string | null = null;

    if (pareceValido) {
      const vendedorDoCandidato = await this.vendedoresRepository.encontrarPorId(String(antesDaDecisao!.vendedorId));
      if (vendedorDoCandidato) {
        candidato = await this.emitirTokens(vendedorDoCandidato, contexto);
        candidatoTokenHash = this.hashRefreshToken(candidato.refreshToken);
      }
    }

    const anterior = await this.pdvAuthRepository.revogarSeValido(tokenHash, agora);

    if (!anterior) {
      // Perdeu a corrida (ou o token já não era mais válido por outro
      // motivo). O candidato criado acima nunca é vinculado nem devolvido:
      // se houver reuso genuíno, a varredura de `tratarFalhaDeRefresh` já o
      // alcança (mesmo vendedor, ainda `revogadoEm: null`); revoga
      // explicitamente aqui também para nunca deixar um refresh token
      // válido e órfão no banco nos casos em que a varredura não roda (ex.:
      // o token original só expirou, sem reuso).
      if (candidatoTokenHash) await this.pdvAuthRepository.revogarSeValido(candidatoTokenHash, agora);
      await this.tratarFalhaDeRefresh(tokenHash, agora, contexto);
      // `tratarFalhaDeRefresh` sempre lança — isto é inatingível, só satisfaz o tipo de retorno.
      throw ApiException.refreshTokenInvalid();
    }

    const vendedor = await this.vendedoresRepository.encontrarPorId(String(anterior.vendedorId));
    if (!vendedor) throw ApiException.refreshTokenInvalid();
    if (!vendedor.ativo) {
      if (candidatoTokenHash) await this.pdvAuthRepository.revogarSeValido(candidatoTokenHash, agora);
      await this.pdvAuthRepository.revogarTodosDoVendedor(vendedor._id as Types.ObjectId, agora);
      throw ApiException.userInactive();
    }

    const tokens = candidato ?? (await this.emitirTokens(vendedor, contexto));
    const tokensHash = candidatoTokenHash ?? this.hashRefreshToken(tokens.refreshToken);
    await this.pdvAuthRepository.marcarSubstituto(tokenHash, tokensHash);
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
