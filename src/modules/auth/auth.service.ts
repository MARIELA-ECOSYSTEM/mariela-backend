import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
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
  JANELA_RECUPERACAO_REFRESH_MS,
  LIMITE_RECUPERACOES_REFRESH,
  REFRESH_TOKEN_BYTES,
} from "./auth.constants.js";
import {
  abrirSucessor,
  hashDaChave,
  hashesIguais,
  selarSucessor,
  type ContextoSelo,
} from "./recuperacao-refresh.crypto.js";
import type { RefreshTokenDocument, SucessorSelado } from "./schemas/refresh-token.schema.js";
import { paraMilissegundos } from "./duracao.util.js";
import type { LoginDto } from "./dto/login.dto.js";
import type { RefreshTokenDto } from "./dto/refresh-token.dto.js";
import { RefreshTokensRepository } from "./refresh-tokens.repository.js";
import { EventoAuth, type EventoAuthDocument, type TipoEventoAuth } from "./schemas/evento-auth.schema.js";
import type { UsuarioDocument } from "./schemas/usuario.schema.js";
import type { ResultadoAutenticacao, UsuarioPublico } from "./types/usuario-publico.interface.js";
import { UsuariosRepository } from "./usuarios.repository.js";
import { LoginThrottleService } from "./login-throttle.service.js";
import { ProvisionamentoAdminService } from "./provisionamento-admin.service.js";
import { gerarHashDeSenha, normalizarEmailAdmin, paraUsuarioPublico } from "./usuario-admin.util.js";

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
export class AuthService implements OnModuleInit {
  constructor(
    private readonly usuariosRepository: UsuariosRepository,
    private readonly refreshTokensRepository: RefreshTokensRepository,
    private readonly provisionamentoAdminService: ProvisionamentoAdminService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService<Configuration>,
    private readonly loginThrottleService: LoginThrottleService,
    @InjectModel(EventoAuth.name) private readonly eventoModel: Model<EventoAuthDocument>,
  ) {}

  /**
   * Fase 22.8.7.2 — aviso operacional no boot quando a recuperação idempotente está DESLIGADA (segredo ausente). Não
   * é erro: o comportamento é o da Fase 22.8.7.1. Silencioso em testes. Nunca imprime valor de segredo.
   */
  onModuleInit(): void {
    const ambiente = this.configService.get("app.nodeEnv", { infer: true });
    if (!this.segredoRecuperacao() && ambiente !== "test") {
      new Logger(AuthService.name).warn(
        "Recuperação idempotente do refresh token DESLIGADA: REFRESH_IDEMPOTENCIA_HMAC_SECRET não definida.",
      );
    }
  }

  /**
   * Usado SÓ pelo script de seed (`bun run seed:admin`) — não existe rota
   * pública para criar usuários nesta etapa. Idempotente: se o e-mail já
   * existir, devolve `criado: false` em vez de lançar erro (o seed pode ser
   * executado de novo com segurança).
   *
   * Fase 60.4.3.2.1 — a regra mora em `ProvisionamentoAdminService` (o comando `seed:admin` a usa num contexto
   * mínimo, sem o `AuthService`); este método só delega, com o mesmo contrato.
   */
  async criarAdminSeed(dados: { nome: string; email: string; senha: string }): Promise<{
    criado: boolean;
    usuario: UsuarioPublico;
  }> {
    return this.provisionamentoAdminService.criar(dados);
  }

  /**
   * Usado SÓ pelo script de recuperação (`bun run admin:reset-password`) —
   * mesma decisão de não expor rota HTTP pública (§19, ver `criarAdminSeed`).
   * Nunca cria, nunca apaga, nunca altera qualquer campo além de `senhaHash`
   * — reaproveita o MESMO `hashSenha` (Argon2id) usado no cadastro e no
   * login, para a nova senha ser verificável pelo `login` normalmente.
   */
  async redefinirSenhaAdmin(dados: {
    email: string;
    senha: string;
  }): Promise<
    | { status: "nao_encontrado" }
    | { status: "nao_admin"; usuario: UsuarioPublico }
    | { status: "atualizado"; usuario: UsuarioPublico }
  > {
    const emailNormalizado = this.normalizarEmail(dados.email);
    const usuario = await this.usuariosRepository.encontrarPorEmail(emailNormalizado);
    if (!usuario) return { status: "nao_encontrado" };
    if (usuario.role !== "ADMIN") return { status: "nao_admin", usuario: this.paraUsuarioPublico(usuario) };

    const senhaHash = await this.hashSenha(dados.senha);
    await this.usuariosRepository.atualizarSenhaHash(usuario.id, senhaHash);
    // Fase 60.4.3.4.12 (F08) — redefinir a senha (tipicamente por suspeita de comprometimento) encerra TODAS as sessões
    // do administrador: sem isto, um refresh token emitido antes continuaria renovando a sessão por até
    // `JWT_REFRESH_EXPIRES_IN`. Mesma regra já aplicada ao vendedor (`VendedoresService.redefinirSenha`). A revogação vem
    // DEPOIS de gravar a senha nova: um login concorrente com a senha antiga que tenha passado antes disso tem a sessão
    // alcançada por esta revogação; um login posterior já exige a senha nova. Resta só o access token stateless (até
    // `JWT_ACCESS_EXPIRES_IN`), mesma janela já aceita na desativação.
    await this.refreshTokensRepository.revogarTodosDoUsuario(usuario._id, new Date());
    return { status: "atualizado", usuario: this.paraUsuarioPublico(usuario) };
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

    // Fase 22.8.7.1 — cada login abre uma FAMÍLIA de sessão nova (identificador gerado aqui, nunca pelo cliente).
    const tokens = await this.emitirTokens(usuario, contexto, randomUUID());

    // Fase 60.4.3.1.5 — releitura DEPOIS de gravar a sessão. A desativação (`admin:desativar`) grava `ativo: false`
    // ANTES de revogar todas as sessões; então uma sessão gravada aqui ou é alcançada por aquela revogação, ou foi
    // gravada depois de `ativo: false` — e esta releitura a enxerga e a revoga. Sem isto, um login que leu o usuário
    // ainda ativo (antes do argon2id, que é lento) podia deixar uma sessão não revogada depois da desativação.
    const atual = await this.usuariosRepository.encontrarPorId(usuario.id);
    if (!atual?.ativo) {
      await this.refreshTokensRepository.revogarSeValido(this.hashRefreshToken(tokens.refreshToken), new Date());
      this.loginThrottleService.registrarFalha(chaveThrottle);
      await this.registrarEvento(usuario.id, "LOGIN_FAILED", contexto);
      throw ApiException.invalidCredentials();
    }

    this.loginThrottleService.registrarSucesso(chaveThrottle);
    await this.usuariosRepository.registrarLogin(usuario.id);
    await this.registrarEvento(usuario.id, "LOGIN_SUCCESS", contexto);
    return { ...tokens, usuario: this.paraUsuarioPublico(usuario) };
  }

  /**
   * Etapa 26 — mesma correção, mesmo racional de `PdvAuthService.refresh`
   * (ver o comentário completo lá): fecha a corrida em que o token novo da
   * requisição VENCEDORA podia escapar da varredura de reuso
   * (`revogarTodosDoUsuario`) por timing. Correção de ORDEM: o candidato de
   * rotação é criado ANTES da decisão atômica de quem vence
   * (`revogarSeValido`, inalterada) — por causalidade (MongoDB serializa
   * updates no mesmo documento), a varredura da perdedora só pode rodar
   * depois da criação do candidato da vencedora, nunca antes, em qualquer
   * entrelaçamento. A política de segurança em si não muda.
   *
   * Fase 22.8.7.1 — o sucessor HERDA a `familiaId` do token apresentado (lida do documento persistido; `familiaId` é
   * imutável — só `criar` a grava). Assim a varredura da requisição perdedora (`revogarFamilia` em
   * `tratarFalhaDeRefresh`) alcança o candidato da vencedora, pela mesma causalidade acima. Um token LEGADO (sem
   * família) não é alterado; o sucessor dele inicia uma família nova — é assim que sessões antigas em uso migram.
   *
   * Fase 22.8.7.2 — RECUPERAÇÃO IDEMPOTENTE (`chaveIdempotencia` = cabeçalho `Idempotency-Key` já validado, ou `null`).
   * Quando R1 tem família, a chave veio e o mecanismo está ligado, o candidato R2 é SELADO (AES-256-GCM, chave HKDF de
   * R1 + chave) ANTES da decisão atômica, e `rotacionarSeValido` grava — na MESMA operação que revoga R1 — o
   * `substituidoPor`, o hash da chave, o selo, a janela de 15 min e `recuperacoes: 0`. R2 só é devolvido depois de essa
   * operação vencer. Se outra requisição venceu, o candidato desta é revogado (nunca fica um sucessor ativo órfão) e
   * `tratarFalhaDeRefresh` decide entre RECUPERAR o R2 da vencedora (mesma chave) e reuso suspeito.
   */
  async refresh(
    dto: RefreshTokenDto,
    contexto: ContextoRequisicao,
    chaveIdempotencia: string | null = null,
  ): Promise<ResultadoAutenticacao> {
    const tokenHash = this.hashRefreshToken(dto.refreshToken);
    const agora = new Date();

    const antesDaDecisao = await this.refreshTokensRepository.encontrarPorHash(tokenHash);
    const pareceValido = antesDaDecisao != null && antesDaDecisao.revogadoEm == null && antesDaDecisao.expiresAt > agora;
    const familiaDoSucessor = antesDaDecisao?.familiaId ?? randomUUID();

    let candidato: { accessToken: string; refreshToken: string; expiresIn: number } | null = null;
    let candidatoTokenHash: string | null = null;
    let recuperacao: { chaveHash: string; sucessorSelado: SucessorSelado; recuperavelAte: Date } | undefined;

    if (pareceValido) {
      const usuarioDoCandidato = await this.usuariosRepository.encontrarPorId(String(antesDaDecisao!.usuarioId));
      if (usuarioDoCandidato) {
        candidato = await this.emitirTokens(usuarioDoCandidato, contexto, familiaDoSucessor);
        candidatoTokenHash = this.hashRefreshToken(candidato.refreshToken);
        const segredoRecuperacao = this.segredoRecuperacao();
        // Só documentos COM família são recuperáveis (legado nunca usa recuperação criptográfica).
        if (chaveIdempotencia && segredoRecuperacao && antesDaDecisao!.familiaId) {
          recuperacao = {
            chaveHash: hashDaChave(segredoRecuperacao, chaveIdempotencia),
            sucessorSelado: selarSucessor(
              this.contextoDoSelo(antesDaDecisao!, dto.refreshToken, chaveIdempotencia),
              candidato.refreshToken,
            ),
            recuperavelAte: new Date(agora.getTime() + JANELA_RECUPERACAO_REFRESH_MS),
          };
        }
      }
    }

    // Decisão atômica: com candidato, revoga R1 E aponta o sucessor (+ recuperação) numa só operação; sem candidato
    // (R1 já parecia inválido — esta chamada praticamente sempre perde), só a reivindicação de antes.
    const anterior = candidatoTokenHash
      ? await this.refreshTokensRepository.rotacionarSeValido(tokenHash, agora, {
          substituidoPor: candidatoTokenHash,
          recuperacao,
        })
      : await this.refreshTokensRepository.revogarSeValido(tokenHash, agora);

    if (!anterior) {
      if (candidatoTokenHash) await this.refreshTokensRepository.revogarSeValido(candidatoTokenHash, agora);
      return this.tratarFalhaDeRefresh(tokenHash, dto.refreshToken, chaveIdempotencia, agora, contexto);
    }

    const usuario = await this.usuariosRepository.encontrarPorId(String(anterior.usuarioId));
    if (!usuario) throw ApiException.refreshTokenInvalid();
    if (!usuario.ativo) {
      if (candidatoTokenHash) await this.refreshTokensRepository.revogarSeValido(candidatoTokenHash, agora);
      await this.refreshTokensRepository.revogarTodosDoUsuario(usuario._id, agora);
      throw ApiException.userInactive();
    }

    const tokens =
      candidato ?? (await this.emitirTokens(usuario, contexto, anterior.familiaId ?? familiaDoSucessor));
    // Com candidato, `substituidoPor` já foi gravado na decisão atômica; o caminho sem candidato (praticamente
    // inatingível — exige R1 parecer inválido e ainda assim vencer) aponta o sucessor depois, como antes, sem
    // material de recuperação.
    if (!candidatoTokenHash) {
      await this.refreshTokensRepository.marcarSubstituto(tokenHash, this.hashRefreshToken(tokens.refreshToken));
    }
    await this.registrarEvento(usuario.id, "REFRESH", contexto);

    return { ...tokens, usuario: this.paraUsuarioPublico(usuario) };
  }

  /**
   * Fase 22.8.7.1 — encerra a FAMÍLIA inteira do token apresentado (qualquer token da família — ativo, já rotacionado
   * ou expirado ainda não removido pelo TTL — encerra a sessão, inclusive um sucessor cuja resposta se perdeu). Nunca
   * passa pela detecção de reutilização. Idempotente de propósito: token inexistente/já revogado não é erro (o cliente
   * só quer garantir que a sessão está encerrada) e a resposta é a mesma em todos os casos — não revela nada sobre
   * sessões de ninguém. LEGADO (documento sem família): comportamento anterior — revoga só aquele documento, se válido.
   */
  async logout(dto: RefreshTokenDto): Promise<void> {
    const tokenHash = this.hashRefreshToken(dto.refreshToken);
    const agora = new Date();
    const existente = await this.refreshTokensRepository.encontrarPorHash(tokenHash);
    if (!existente) return;

    if (existente.familiaId) {
      const revogados = await this.refreshTokensRepository.revogarFamilia(existente.usuarioId, existente.familiaId, agora);
      if (revogados > 0) await this.registrarEvento(String(existente.usuarioId), "LOGOUT", { ip: null, userAgent: null });
      return;
    }

    const revogado = await this.refreshTokensRepository.revogarSeValido(tokenHash, agora);
    if (revogado) {
      await this.registrarEvento(String(revogado.usuarioId), "LOGOUT", { ip: null, userAgent: null });
    }
  }

  async me(usuarioId: string): Promise<UsuarioPublico> {
    const usuario = await this.usuariosRepository.encontrarPorId(usuarioId);
    if (!usuario) throw ApiException.notFound("Usuário não encontrado.");
    return this.paraUsuarioPublico(usuario);
  }

  /**
   * Reutilização de um refresh token já revogado = possível sessão comprometida. Fase 22.8.7.1 — revoga só a FAMÍLIA
   * dele (lida do documento persistido, escopada ao usuário dono): as demais sessões do mesmo usuário (outros
   * dispositivos) e de outros usuários ficam intactas. LEGADO (sem família): mantém a regra anterior, mais ampla —
   * todas as sessões do usuário —, sem inferir família nenhuma; a exceção acaba quando os legados expiram.
   * Token desconhecido/expirado nunca revoga nada (`REFRESH_TOKEN_INVALID`).
   *
   * Fase 22.8.7.2 — antes de classificar como reuso, um token COM família, já revogado, apresentado com uma
   * `Idempotency-Key` cujo HMAC confere com o `chaveHash` gravado na rotação, segue para `recuperarSucessor`. Chave
   * ausente, chave errada, mecanismo desligado ou documento sem dados de recuperação → reuso suspeito, com a MESMA
   * resposta em todos os casos (não revela se existe recuperação, se a janela venceu ou se há selo).
   */
  private async tratarFalhaDeRefresh(
    tokenHash: string,
    r1: string,
    chaveIdempotencia: string | null,
    agora: Date,
    contexto: ContextoRequisicao,
  ): Promise<ResultadoAutenticacao> {
    const existente = await this.refreshTokensRepository.encontrarPorHash(tokenHash);
    if (!existente?.revogadoEm) throw ApiException.refreshTokenInvalid();

    if (!existente.familiaId) {
      // LEGADO: regra anterior, sem recuperação criptográfica.
      await this.refreshTokensRepository.revogarTodosDoUsuario(existente.usuarioId, agora);
      await this.registrarEvento(String(existente.usuarioId), "REFRESH_REUSED", contexto);
      throw ApiException.refreshTokenReused();
    }

    const segredoRecuperacao = this.segredoRecuperacao();
    if (
      chaveIdempotencia &&
      segredoRecuperacao &&
      existente.chaveHash &&
      hashesIguais(hashDaChave(segredoRecuperacao, chaveIdempotencia), existente.chaveHash)
    ) {
      return this.recuperarSucessor(existente, r1, chaveIdempotencia, agora, contexto);
    }
    return this.reusoSuspeito(existente, agora, contexto);
  }

  /** Reuso suspeito de um token COM família: revoga só a família, limpa o selo e registra `REFRESH_REUSED`. */
  private async reusoSuspeito(
    existente: RefreshTokenDocument,
    agora: Date,
    contexto: ContextoRequisicao,
  ): Promise<never> {
    await this.refreshTokensRepository.revogarFamilia(existente.usuarioId, existente.familiaId!, agora);
    if (existente.sucessorSelado) await this.refreshTokensRepository.descartarSucessorSelado(existente._id);
    await this.registrarEvento(String(existente.usuarioId), "REFRESH_REUSED", contexto);
    throw ApiException.refreshTokenReused();
  }

  /** Recuperação recusada sem suspeita de roubo (janela vencida, integridade): revoga só a família, limpa o selo. */
  private async recusarRecuperacao(
    existente: RefreshTokenDocument,
    agora: Date,
    contexto: ContextoRequisicao,
    evento: "REFRESH_RECOVERY_EXPIRED" | "REFRESH_RECOVERY_FAILED",
  ): Promise<never> {
    await this.refreshTokensRepository.revogarFamilia(existente.usuarioId, existente.familiaId!, agora);
    await this.refreshTokensRepository.descartarSucessorSelado(existente._id);
    await this.registrarEvento(String(existente.usuarioId), evento, contexto);
    throw ApiException.refreshTokenInvalid();
  }

  /**
   * Fase 22.8.7.2 — devolve o MESMO sucessor R2 de uma rotação cuja resposta se perdeu. Pré-condição: a chave confere.
   *
   *   1. Janela vencida (relógio do servidor) → `REFRESH_TOKEN_INVALID`, família revogada, `REFRESH_RECOVERY_EXPIRED`
   *      (não é reuso: quem tem a chave certa é o cliente legítimo atrasado).
   *   2. Sucessor ausente, revogado (logout/reuso), já rotacionado (consumido), expirado, ou de outra família/usuário
   *      → reuso suspeito (`REFRESH_TOKEN_REUSED`, só a família). Nenhum fluxo reativa uma família revogada.
   *   3. RESERVA atômica de uma vaga (`recuperacoes < 5`, janela aberta, mesma chave) ANTES de decifrar: duas
   *      recuperações concorrentes nunca passam do limite. Sem vaga: limite esgotado → reuso suspeito (política da
   *      Fase 22.8.6: "qualquer outro caso: reuso"); janela fechada na corrida → item 1.
   *   4. Decifra e confere que HMAC(R2 decifrado) == `substituidoPor`. Qualquer falha (selo adulterado, versão
   *      desconhecida, inconsistência) → `REFRESH_TOKEN_INVALID`, só a família, `REFRESH_RECOVERY_FAILED` — nunca
   *      revogação global do usuário, nunca R2 parcial.
   *   5. Usuário inexistente/inativo: mesmas regras da rotação normal.
   *   6. Emite SÓ um access token novo; o refresh token devolvido é o R2 original. `substituidoPor` não muda, nenhum
   *      documento novo é criado, nenhum evento de reuso; registra `REFRESH_RECOVERED`.
   */
  private async recuperarSucessor(
    existente: RefreshTokenDocument,
    r1: string,
    chaveIdempotencia: string,
    agora: Date,
    contexto: ContextoRequisicao,
  ): Promise<ResultadoAutenticacao> {
    if (!existente.recuperavelAte || existente.recuperavelAte <= agora) {
      return this.recusarRecuperacao(existente, agora, contexto, "REFRESH_RECOVERY_EXPIRED");
    }

    const sucessor = existente.substituidoPor
      ? await this.refreshTokensRepository.encontrarPorHash(existente.substituidoPor)
      : null;
    const sucessorUtilizavel =
      sucessor != null &&
      sucessor.revogadoEm == null &&
      sucessor.rotacionadoEm == null &&
      sucessor.expiresAt > agora &&
      sucessor.familiaId === existente.familiaId &&
      String(sucessor.usuarioId) === String(existente.usuarioId);
    if (!sucessorUtilizavel) return this.reusoSuspeito(existente, agora, contexto);

    const reservado = await this.refreshTokensRepository.reservarRecuperacao(
      existente._id,
      existente.chaveHash!,
      agora,
      LIMITE_RECUPERACOES_REFRESH,
    );
    if (!reservado) {
      const atual = await this.refreshTokensRepository.encontrarPorHash(existente.tokenHash);
      if (atual?.recuperavelAte && atual.recuperavelAte <= agora) {
        return this.recusarRecuperacao(existente, agora, contexto, "REFRESH_RECOVERY_EXPIRED");
      }
      return this.reusoSuspeito(existente, agora, contexto);
    }

    const r2 = abrirSucessor(this.contextoDoSelo(existente, r1, chaveIdempotencia), reservado.sucessorSelado);
    if (r2 === null || !hashesIguais(this.hashRefreshToken(r2), existente.substituidoPor!)) {
      return this.recusarRecuperacao(existente, agora, contexto, "REFRESH_RECOVERY_FAILED");
    }

    const usuario = await this.usuariosRepository.encontrarPorId(String(existente.usuarioId));
    if (!usuario) throw ApiException.refreshTokenInvalid();
    if (!usuario.ativo) {
      await this.refreshTokensRepository.revogarTodosDoUsuario(usuario._id, agora);
      throw ApiException.userInactive();
    }

    const acesso = await this.assinarAccessToken(usuario);
    await this.registrarEvento(usuario.id, "REFRESH_RECOVERED", contexto);
    return { ...acesso, refreshToken: r2, usuario: this.paraUsuarioPublico(usuario) };
  }

  /** `null` = mecanismo de recuperação desligado (segredo ausente — ver `RecuperacaoRefreshConfig`). */
  private segredoRecuperacao(): string | null {
    return this.configService.get("recuperacaoRefresh.segredoHmac", { infer: true }) ?? null;
  }

  private contextoDoSelo(documento: RefreshTokenDocument, r1: string, chave: string): ContextoSelo {
    return {
      r1,
      chave,
      documentoId: String(documento._id),
      usuarioId: String(documento.usuarioId),
      familiaId: documento.familiaId!,
    };
  }

  private async assinarAccessToken(usuario: UsuarioDocument): Promise<{ accessToken: string; expiresIn: number }> {
    const payload: JwtPayload = { sub: usuario.id, codigo: usuario.codigo, role: usuario.role as Role };
    const accessToken = await this.jwtService.signAsync(payload);
    const accessExpiresIn = this.configService.get("jwt.accessExpiresIn", { infer: true })!;
    return { accessToken, expiresIn: Math.round(paraMilissegundos(accessExpiresIn) / 1000) };
  }

  private async emitirTokens(
    usuario: UsuarioDocument,
    contexto: ContextoRequisicao,
    familiaId: string,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const { accessToken, expiresIn } = await this.assinarAccessToken(usuario);

    const refreshTokenBruto = randomBytes(REFRESH_TOKEN_BYTES).toString("base64url");
    const refreshExpiresIn = this.configService.get("jwt.refreshExpiresIn", { infer: true })!;
    const expiresAt = new Date(Date.now() + paraMilissegundos(refreshExpiresIn));

    await this.refreshTokensRepository.criar({
      usuarioId: usuario._id as Types.ObjectId,
      tokenHash: this.hashRefreshToken(refreshTokenBruto),
      expiresAt,
      userAgent: contexto.userAgent,
      ip: contexto.ip,
      familiaId,
    });

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

  /** Fase 60.4.3.2.1 — as três regras abaixo vivem em `usuario-admin.util.ts`, compartilhadas com os comandos locais. */
  private async hashSenha(senha: string): Promise<string> {
    return gerarHashDeSenha(senha);
  }

  private normalizarEmail(valor: string): string {
    return normalizarEmailAdmin(valor);
  }

  private paraUsuarioPublico(usuario: UsuarioDocument): UsuarioPublico {
    return paraUsuarioPublico(usuario);
  }

  private async registrarEvento(
    usuarioId: string | Types.ObjectId | null,
    tipo: TipoEventoAuth,
    contexto: ContextoRequisicao,
  ): Promise<void> {
    await this.eventoModel.create({ usuarioId, tipo, ip: contexto.ip, userAgent: contexto.userAgent });
  }
}
