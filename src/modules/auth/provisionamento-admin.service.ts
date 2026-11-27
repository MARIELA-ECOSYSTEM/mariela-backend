import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import { SequenciasService } from "../sequencias/sequencias.service.js";
import { CHAVE_SEQUENCIA_USUARIO, DIGITOS_CODIGO_USUARIO, PREFIXO_CODIGO_USUARIO } from "./auth.constants.js";
import { EventoAuth, type EventoAuthDocument } from "./schemas/evento-auth.schema.js";
import type { UsuarioPublico } from "./types/usuario-publico.interface.js";
import { gerarHashDeSenha, normalizarEmailAdmin, paraUsuarioPublico } from "./usuario-admin.util.js";
import { UsuariosRepository } from "./usuarios.repository.js";

/** Valor de `EventoAuth.origem` do evento `ADMIN_CREATED`. */
export const ORIGEM_SEED_ADMIN = "comando:seed:admin";

export type AvaliacaoProvisionamento =
  | { status: "existe"; usuario: UsuarioPublico }
  /** `proximoCodigo` é só uma previsão: o número não é reservado pelo dry-run. */
  | { status: "inexistente"; email: string; proximoCodigo: string };

/**
 * O ADMIN FOI criado, mas o evento `ADMIN_CREATED` não pôde ser gravado. Uma nova execução não regrava o evento (o
 * e-mail já existe): o comando relata isto para registro manual.
 */
export class FalhaAuditoriaCriacaoAdmin extends Error {
  constructor(
    readonly usuario: UsuarioPublico,
    readonly causa: unknown,
  ) {
    super("ADMIN criado, mas o evento de auditoria ADMIN_CREATED não foi gravado.");
    this.name = "FalhaAuditoriaCriacaoAdmin";
  }
}

/**
 * Fase 60.4.3.2.1 — criação de ADMIN, extraída de `AuthService.criarAdminSeed` (que agora delega para cá) para
 * que o comando `seed:admin` rode num contexto mínimo, sem o `AuthService` (JWT, throttle, eventos) nem o
 * `AppModule`. Regra inalterada: e-mail normalizado, idempotente por e-mail (já existe → `criado: false`, nada
 * alterado), código `USR-####` da sequência `usuario`, hash Argon2id, `role: "ADMIN"`, `ativo: true`.
 *
 * Fase de segurança do ciclo de usuários — cada criação efetiva grava `ADMIN_CREATED` em `eventos_auth` (id do
 * usuário, origem e executor opcional; nunca senha, hash ou token). A repetição idempotente não grava nada.
 */
@Injectable()
export class ProvisionamentoAdminService {
  constructor(
    private readonly usuariosRepository: UsuariosRepository,
    private readonly sequenciasService: SequenciasService,
    @InjectModel(EventoAuth.name) private readonly eventoModel: Model<EventoAuthDocument>,
  ) {}

  /** Somente leitura (dry-run): o usuário já existe? Se não, qual seria (previsão) o próximo código. */
  async avaliar(email: string): Promise<AvaliacaoProvisionamento> {
    const emailNormalizado = normalizarEmailAdmin(email);
    const existente = await this.usuariosRepository.encontrarPorEmail(emailNormalizado);
    if (existente) return { status: "existe", usuario: paraUsuarioPublico(existente) };
    const proximoCodigo = await this.sequenciasService.previsaoDoProximoCodigo(CHAVE_SEQUENCIA_USUARIO, PREFIXO_CODIGO_USUARIO, DIGITOS_CODIGO_USUARIO);
    return { status: "inexistente", email: emailNormalizado, proximoCodigo };
  }

  /**
   * Idempotente: se o e-mail já existir, devolve `criado: false` sem alterar nada (nem consumir a sequência). Duas
   * criações simultâneas do mesmo e-mail: o índice único de `email` recusa a segunda (`409 CONFLICT`, ver
   * `UsuariosRepository.criar`). Lança `FalhaAuditoriaCriacaoAdmin` se o usuário foi criado mas o evento não.
   */
  async criar(dados: { nome: string; email: string; senha: string; executor?: string | null }): Promise<{ criado: boolean; usuario: UsuarioPublico }> {
    const emailNormalizado = normalizarEmailAdmin(dados.email);
    const existente = await this.usuariosRepository.encontrarPorEmail(emailNormalizado);
    if (existente) return { criado: false, usuario: paraUsuarioPublico(existente) };

    const codigo = await this.sequenciasService.proximoCodigo(CHAVE_SEQUENCIA_USUARIO, PREFIXO_CODIGO_USUARIO, DIGITOS_CODIGO_USUARIO);
    const senhaHash = await gerarHashDeSenha(dados.senha);
    const usuario = await this.usuariosRepository.criar({
      codigo,
      nome: dados.nome.trim(),
      email: emailNormalizado,
      senhaHash,
      role: "ADMIN",
      ativo: true,
      ultimoLoginEm: null,
    });
    const publico = paraUsuarioPublico(usuario);
    try {
      await this.eventoModel.create({
        usuarioId: usuario._id,
        tipo: "ADMIN_CREATED",
        ip: null,
        userAgent: null,
        origem: ORIGEM_SEED_ADMIN,
        ...(dados.executor ? { executor: dados.executor } : {}),
      });
    } catch (erro) {
      throw new FalhaAuditoriaCriacaoAdmin(publico, erro);
    }
    return { criado: true, usuario: publico };
  }
}
