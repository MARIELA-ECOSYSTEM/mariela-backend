import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import { RefreshTokensRepository } from "./refresh-tokens.repository.js";
import { EventoAuth, type EventoAuthDocument } from "./schemas/evento-auth.schema.js";
import type { UsuarioDocument } from "./schemas/usuario.schema.js";
import { UsuariosRepository } from "./usuarios.repository.js";

/** Valor de `EventoAuth.origem` dos eventos gravados por este serviço. */
export const ORIGEM_DESATIVACAO_ADMIN = "comando:admin:desativar";

/** Mesma regra de `AuthService.normalizarEmail` (trim + minúsculas): o e-mail gravado já está normalizado. */
export function normalizarEmailAdmin(email: string): string {
  return email.trim().toLowerCase();
}

/** Identificação NÃO sensível do usuário alvo (nunca senha, hash ou token). */
export interface AlvoDesativacao {
  id: string;
  codigo: string;
  email: string;
}

export type AvaliacaoDesativacao =
  | { status: "nao_encontrado" }
  | { status: "nao_admin"; alvo: AlvoDesativacao }
  | { status: "ativo" | "inativo"; alvo: AlvoDesativacao; sessoesValidas: number; auditoriaRegistrada: boolean };

/** `registrada`: evento gravado pela execução que desativou; `reconciliada`: por uma execução posterior; `ja_registrada`: já existia. */
export type DesfechoAuditoria = "registrada" | "reconciliada" | "ja_registrada";

export type ResultadoDesativacao =
  | { status: "nao_encontrado" }
  | { status: "nao_admin"; alvo: AlvoDesativacao }
  | {
      status: "desativado" | "ja_inativo";
      alvo: AlvoDesativacao;
      /** Sessões revogadas por ESTA execução. */
      sessoesRevogadas: number;
      /** Sessões ainda utilizáveis medidas depois da revogação (esperado: 0). */
      sessoesRemanescentes: number;
      auditoria: DesfechoAuditoria;
      /** `true` se esta execução gravou `ADMIN_SESSIONS_REVOKED` (usuário já inativo com sessões remanescentes). */
      eventoDeSessoes: boolean;
    };

export type EtapaDesativacao = "transicao" | "revogacao" | "verificacao" | "auditoria";

/**
 * Falha de persistência no meio da desativação. `usuarioInativo` diz se `ativo: false` já está gravado (a partir
 * daí login e refresh já são recusados pelo `AuthService`); `reivindicacaoPresa` indica que a marca de auditoria
 * não pôde ser desfeita e uma nova execução NÃO regravará o evento sozinha (intervenção manual).
 */
export class FalhaDesativacaoAdmin extends Error {
  constructor(
    readonly etapa: EtapaDesativacao,
    readonly usuarioInativo: boolean,
    readonly causa: unknown,
    readonly reivindicacaoPresa = false,
  ) {
    super(`Falha na etapa "${etapa}" da desativação administrativa.`);
    this.name = "FalhaDesativacaoAdmin";
  }
}

export interface DadosDesativacao {
  email: string;
  motivo: string;
  /** Quem executou, quando o operador informar. */
  executor: string | null;
}

/**
 * Fase 60.4.3.1.5 — desativação administrativa de um ADMIN (usada só pelo comando local `admin:desativar`; não há
 * rota HTTP). Preserva o documento, a senha, o perfil e todo o histórico: só grava `ativo: false`, revoga as
 * sessões e audita.
 *
 * Ordem (sem transações — MongoDB standalone): 1) `ativo: false` por escrita condicional (só uma execução faz a
 * transição); 2) revoga TODAS as sessões (`revogarTodosDoUsuario`); 3) mede as sessões ainda válidas e revoga de
 * novo se houver; 4) grava `ADMIN_DEACTIVATED` uma única vez (reivindicação condicional no próprio usuário).
 *
 * Por que essa ordem fecha a corrida com login/refresh: o `AuthService` relê o usuário DEPOIS de gravar uma sessão
 * nova (login: releitura após `emitirTokens`; refresh: o candidato é gravado antes da leitura de `ativo`). Como
 * `ativo: false` é gravado ANTES da revogação, toda sessão nova ou foi gravada antes da revogação (e é revogada por
 * ela), ou depois de `ativo: false` (e o próprio login/refresh a enxerga inativo e a revoga). Resíduo inevitável:
 * um access token JWT emitido antes da desativação continua válido até expirar (o guard é stateless).
 */
@Injectable()
export class DesativacaoAdminService {
  constructor(
    private readonly usuariosRepository: UsuariosRepository,
    private readonly refreshTokensRepository: RefreshTokensRepository,
    @InjectModel(EventoAuth.name) private readonly eventoModel: Model<EventoAuthDocument>,
  ) {}

  /** Somente leitura (dry-run): estado atual e o que a desativação faria. */
  async avaliar(email: string): Promise<AvaliacaoDesativacao> {
    const usuario = await this.usuariosRepository.encontrarPorEmail(normalizarEmailAdmin(email));
    if (!usuario) return { status: "nao_encontrado" };
    if (usuario.role !== "ADMIN") return { status: "nao_admin", alvo: alvoDe(usuario) };
    const sessoesValidas = await this.refreshTokensRepository.contarValidosDoUsuario(usuario._id, new Date());
    return {
      status: usuario.ativo === false ? "inativo" : "ativo",
      alvo: alvoDe(usuario),
      sessoesValidas,
      auditoriaRegistrada: usuario.desativacaoAuditadaEm != null,
    };
  }

  /** Desativa (idempotente). Lança `FalhaDesativacaoAdmin` em falha de persistência, dizendo até onde chegou. */
  async desativar(dados: DadosDesativacao): Promise<ResultadoDesativacao> {
    const agora = new Date();
    const usuario = await this.usuariosRepository.encontrarPorEmail(normalizarEmailAdmin(dados.email));
    if (!usuario) return { status: "nao_encontrado" };
    if (usuario.role !== "ADMIN") return { status: "nao_admin", alvo: alvoDe(usuario) };
    const alvo = alvoDe(usuario);

    let transicao: UsuarioDocument | null;
    try {
      transicao = await this.usuariosRepository.desativarSeAtivo(usuario.id, agora);
    } catch (erro) {
      throw new FalhaDesativacaoAdmin("transicao", false, erro);
    }
    if (!transicao) {
      // Nenhuma transição: confirma por que (já inativo é o único caso que prossegue).
      const atual = await this.usuariosRepository.encontrarPorId(usuario.id);
      if (!atual) return { status: "nao_encontrado" };
      if (atual.role !== "ADMIN") return { status: "nao_admin", alvo };
      if (atual.ativo !== false) throw new FalhaDesativacaoAdmin("transicao", false, new Error("O usuário continua ativo depois da transição condicional."));
    }

    let sessoesRevogadas: number;
    try {
      sessoesRevogadas = await this.refreshTokensRepository.revogarTodosDoUsuario(usuario._id, agora);
    } catch (erro) {
      throw new FalhaDesativacaoAdmin("revogacao", true, erro);
    }

    let sessoesRemanescentes: number;
    try {
      sessoesRemanescentes = await this.refreshTokensRepository.contarValidosDoUsuario(usuario._id, new Date());
      if (sessoesRemanescentes > 0) {
        sessoesRevogadas += await this.refreshTokensRepository.revogarTodosDoUsuario(usuario._id, new Date());
        sessoesRemanescentes = await this.refreshTokensRepository.contarValidosDoUsuario(usuario._id, new Date());
      }
    } catch (erro) {
      throw new FalhaDesativacaoAdmin("verificacao", true, erro);
    }

    const auditoria = await this.auditarDesativacao(usuario, transicao !== null, sessoesRevogadas, dados);

    // Usuário que JÁ estava inativo e ainda tinha sessões: a revogação desta execução também é auditada (uma vez por
    // execução que de fato revogou algo; nenhuma execução sem efeito grava evento).
    let eventoDeSessoes = false;
    if (transicao === null && auditoria === "ja_registrada" && sessoesRevogadas > 0) {
      try {
        await this.eventoModel.create({
          usuarioId: usuario._id,
          tipo: "ADMIN_SESSIONS_REVOKED",
          ip: null,
          userAgent: null,
          motivo: dados.motivo,
          ...(dados.executor ? { executor: dados.executor } : {}),
          origem: ORIGEM_DESATIVACAO_ADMIN,
          sessoesRevogadas,
        });
      } catch (erro) {
        throw new FalhaDesativacaoAdmin("auditoria", true, erro);
      }
      eventoDeSessoes = true;
    }

    return { status: transicao ? "desativado" : "ja_inativo", alvo, sessoesRevogadas, sessoesRemanescentes, auditoria, eventoDeSessoes };
  }

  /** Grava `ADMIN_DEACTIVATED` no máximo uma vez por usuário, mesmo com execuções concorrentes ou repetidas. */
  private async auditarDesativacao(usuario: UsuarioDocument, fezTransicao: boolean, sessoesRevogadas: number, dados: DadosDesativacao): Promise<DesfechoAuditoria> {
    const marca = new Date();
    let reivindicado: UsuarioDocument | null;
    try {
      reivindicado = await this.usuariosRepository.reivindicarAuditoriaDesativacao(usuario.id, marca);
    } catch (erro) {
      throw new FalhaDesativacaoAdmin("auditoria", true, erro);
    }
    if (!reivindicado) return "ja_registrada";

    try {
      await this.eventoModel.create({
        usuarioId: usuario._id,
        tipo: "ADMIN_DEACTIVATED",
        ip: null,
        userAgent: null,
        motivo: dados.motivo,
        ...(dados.executor ? { executor: dados.executor } : {}),
        origem: ORIGEM_DESATIVACAO_ADMIN,
        sessoesRevogadas,
        ...(reivindicado.desativadoEm ? { desativadoEm: reivindicado.desativadoEm } : {}),
        reconciliado: !fezTransicao,
      });
    } catch (erro) {
      let liberada = false;
      try {
        liberada = await this.usuariosRepository.liberarAuditoriaDesativacao(usuario.id, marca);
      } catch {
        liberada = false;
      }
      throw new FalhaDesativacaoAdmin("auditoria", true, erro, !liberada);
    }
    return fezTransicao ? "registrada" : "reconciliada";
  }
}

function alvoDe(usuario: UsuarioDocument): AlvoDesativacao {
  return { id: usuario.id, codigo: usuario.codigo, email: usuario.email };
}
