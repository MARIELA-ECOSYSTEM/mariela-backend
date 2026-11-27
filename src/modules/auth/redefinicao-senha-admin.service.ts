import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import { RefreshTokensRepository } from "./refresh-tokens.repository.js";
import { EventoAuth, type EventoAuthDocument } from "./schemas/evento-auth.schema.js";
import type { UsuarioDocument } from "./schemas/usuario.schema.js";
import { gerarHashDeSenha, normalizarEmailAdmin } from "./usuario-admin.util.js";
import { UsuariosRepository } from "./usuarios.repository.js";

/** Valor de `EventoAuth.origem` do evento `ADMIN_PASSWORD_RESET`. */
export const ORIGEM_RESET_SENHA_ADMIN = "comando:admin:reset-password";

/** Identificação NÃO sensível do usuário alvo (nunca senha, hash ou token). */
export interface AlvoRedefinicao {
  id: string;
  codigo: string;
  email: string;
  ativo: boolean;
}

export type AvaliacaoRedefinicao =
  | { status: "nao_encontrado" }
  | { status: "nao_admin"; alvo: AlvoRedefinicao }
  | { status: "admin"; alvo: AlvoRedefinicao; sessoesValidas: number };

export type ResultadoRedefinicao =
  | { status: "nao_encontrado" }
  | { status: "nao_admin"; alvo: AlvoRedefinicao }
  | {
      status: "atualizado";
      alvo: AlvoRedefinicao;
      /** Sessões revogadas por ESTA execução. */
      sessoesRevogadas: number;
      /** Sessões ainda utilizáveis medidas depois da revogação (esperado: 0). */
      sessoesRemanescentes: number;
    };

/** `senha`: nada mudou. `revogacao`/`auditoria`: a senha nova JÁ está gravada. */
export type EtapaRedefinicao = "senha" | "revogacao" | "auditoria";

export class FalhaRedefinicaoSenhaAdmin extends Error {
  constructor(
    readonly etapa: EtapaRedefinicao,
    readonly causa: unknown,
  ) {
    super(`Falha na etapa "${etapa}" da redefinição de senha administrativa.`);
    this.name = "FalhaRedefinicaoSenhaAdmin";
  }
}

export interface DadosRedefinicao {
  email: string;
  senha: string;
  /** Quem executou, quando o operador informar. */
  executor: string | null;
}

/**
 * Redefinição de senha de um ADMIN (comando local `admin:reset-password` e `AuthService.redefinirSenhaAdmin`; não há
 * rota HTTP). Altera só `senhaHash`; nunca cria, apaga ou muda outro campo.
 *
 * Ordem: 1) grava o hash novo; 2) revoga TODAS as sessões (refresh tokens) do usuário; 3) mede as sessões ainda
 * válidas e revoga de novo se houver; 4) grava `ADMIN_PASSWORD_RESET` (sem senha, hash ou token). A revogação vem
 * DEPOIS da senha nova: um login concorrente com a senha antiga que passou antes da gravação tem a sessão alcançada
 * pela revogação; um login posterior já exige a senha nova. Resíduo: o access token JWT já emitido vale até expirar.
 *
 * Repetir com os mesmos dados é seguro: o estado final é o mesmo (senha nova, nenhuma sessão válida) e cada execução
 * efetiva fica registrada no seu próprio evento.
 */
@Injectable()
export class RedefinicaoSenhaAdminService {
  constructor(
    private readonly usuariosRepository: UsuariosRepository,
    private readonly refreshTokensRepository: RefreshTokensRepository,
    @InjectModel(EventoAuth.name) private readonly eventoModel: Model<EventoAuthDocument>,
  ) {}

  /** Somente leitura (dry-run). */
  async avaliar(email: string): Promise<AvaliacaoRedefinicao> {
    const usuario = await this.usuariosRepository.encontrarPorEmail(normalizarEmailAdmin(email));
    if (!usuario) return { status: "nao_encontrado" };
    if (usuario.role !== "ADMIN") return { status: "nao_admin", alvo: alvoDe(usuario) };
    const sessoesValidas = await this.refreshTokensRepository.contarValidosDoUsuario(usuario._id, new Date());
    return { status: "admin", alvo: alvoDe(usuario), sessoesValidas };
  }

  /** Lança `FalhaRedefinicaoSenhaAdmin` em falha de persistência, dizendo até onde chegou. */
  async redefinir(dados: DadosRedefinicao): Promise<ResultadoRedefinicao> {
    const usuario = await this.usuariosRepository.encontrarPorEmail(normalizarEmailAdmin(dados.email));
    if (!usuario) return { status: "nao_encontrado" };
    const alvo = alvoDe(usuario);
    if (usuario.role !== "ADMIN") return { status: "nao_admin", alvo };

    try {
      await this.usuariosRepository.atualizarSenhaHash(usuario.id, await gerarHashDeSenha(dados.senha));
    } catch (erro) {
      throw new FalhaRedefinicaoSenhaAdmin("senha", erro);
    }

    let sessoesRevogadas: number;
    let sessoesRemanescentes: number;
    try {
      sessoesRevogadas = await this.refreshTokensRepository.revogarTodosDoUsuario(usuario._id, new Date());
      sessoesRemanescentes = await this.refreshTokensRepository.contarValidosDoUsuario(usuario._id, new Date());
      if (sessoesRemanescentes > 0) {
        sessoesRevogadas += await this.refreshTokensRepository.revogarTodosDoUsuario(usuario._id, new Date());
        sessoesRemanescentes = await this.refreshTokensRepository.contarValidosDoUsuario(usuario._id, new Date());
      }
    } catch (erro) {
      throw new FalhaRedefinicaoSenhaAdmin("revogacao", erro);
    }

    try {
      await this.eventoModel.create({
        usuarioId: usuario._id,
        tipo: "ADMIN_PASSWORD_RESET",
        ip: null,
        userAgent: null,
        origem: ORIGEM_RESET_SENHA_ADMIN,
        ...(dados.executor ? { executor: dados.executor } : {}),
        sessoesRevogadas,
      });
    } catch (erro) {
      throw new FalhaRedefinicaoSenhaAdmin("auditoria", erro);
    }

    return { status: "atualizado", alvo, sessoesRevogadas, sessoesRemanescentes };
  }
}

function alvoDe(usuario: UsuarioDocument): AlvoRedefinicao {
  return { id: usuario.id, codigo: usuario.codigo, email: usuario.email, ativo: usuario.ativo !== false };
}
