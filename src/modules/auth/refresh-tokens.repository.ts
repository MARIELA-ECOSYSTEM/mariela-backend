import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model, Types } from "mongoose";
import { RefreshToken, type RefreshTokenDocument, type SucessorSelado } from "./schemas/refresh-token.schema.js";

@Injectable()
export class RefreshTokensRepository {
  constructor(@InjectModel(RefreshToken.name) private readonly refreshTokenModel: Model<RefreshTokenDocument>) {}

  async criar(dados: {
    usuarioId: Types.ObjectId;
    tokenHash: string;
    expiresAt: Date;
    userAgent: string | null;
    ip: string | null;
    /** Fase 22.8.7.1 — família da sessão; sempre definida pelo servidor (login: nova; rotação: herdada). */
    familiaId: string;
  }): Promise<RefreshTokenDocument> {
    return this.refreshTokenModel.create({ ...dados, revogadoEm: null, rotacionadoEm: null, substituidoPor: null });
  }

  async encontrarPorHash(tokenHash: string): Promise<RefreshTokenDocument | null> {
    return this.refreshTokenModel.findOne({ tokenHash }).exec();
  }

  /**
   * Reivindica o token atomicamente: só revoga (e devolve o estado ANTERIOR,
   * ainda com `expiresAt` original) se ele existir, nunca ter sido revogado e
   * não estar expirado — tudo na MESMA operação do MongoDB. Duas chamadas
   * concorrentes com o mesmo token: só uma vê o documento "antes"; a outra
   * recebe `null` e cai no caminho de reutilização/expiração.
   */
  async revogarSeValido(tokenHash: string, agora: Date): Promise<RefreshTokenDocument | null> {
    return this.refreshTokenModel
      .findOneAndUpdate(
        { tokenHash, revogadoEm: null, expiresAt: { $gt: agora } },
        { $set: { revogadoEm: agora, rotacionadoEm: agora } },
        { returnDocument: "before" },
      )
      .exec();
  }

  /**
   * Fase 22.8.7.2 — a DECISÃO ATÔMICA da rotação: mesmo filtro de `revogarSeValido` (existe, não revogado, não
   * expirado) e, na MESMA operação, aponta `substituidoPor` e — quando houver — grava o material de recuperação
   * (`chaveHash`, `sucessorSelado`, `recuperavelAte`, `recuperacoes: 0`). Assim, qualquer requisição que perca esta
   * corrida e releia o documento já encontra o sucessor e os dados de recuperação completos, nunca um estado parcial.
   * Devolve o estado ANTERIOR (como `revogarSeValido`), ou `null` se outra requisição já venceu.
   */
  async rotacionarSeValido(
    tokenHash: string,
    agora: Date,
    sucessor: {
      substituidoPor: string;
      recuperacao?: { chaveHash: string; sucessorSelado: SucessorSelado; recuperavelAte: Date };
    },
  ): Promise<RefreshTokenDocument | null> {
    const recuperacao = sucessor.recuperacao ? { ...sucessor.recuperacao, recuperacoes: 0 } : {};
    return this.refreshTokenModel
      .findOneAndUpdate(
        { tokenHash, revogadoEm: null, expiresAt: { $gt: agora } },
        { $set: { revogadoEm: agora, rotacionadoEm: agora, substituidoPor: sucessor.substituidoPor, ...recuperacao } },
        { returnDocument: "before" },
      )
      .exec();
  }

  /**
   * Fase 22.8.7.2 — RESERVA atômica de uma recuperação: só incrementa `recuperacoes` se, no mesmo instante, o
   * documento ainda tiver a mesma `chaveHash`, a janela estiver aberta, o contador estiver abaixo do limite e o
   * sucessor selado existir. Duas recuperações concorrentes nunca ultrapassam o limite (o MongoDB serializa as escritas
   * no mesmo documento). A tentativa é contada ANTES da decriptação: uma falha posterior consome a vaga (fecha em
   * segurança). Devolve o documento DEPOIS do incremento, ou `null` se alguma condição falhou.
   */
  async reservarRecuperacao(
    id: Types.ObjectId,
    chaveHash: string,
    agora: Date,
    limite: number,
  ): Promise<RefreshTokenDocument | null> {
    return this.refreshTokenModel
      .findOneAndUpdate(
        {
          _id: id,
          chaveHash,
          revogadoEm: { $ne: null },
          recuperavelAte: { $gt: agora },
          recuperacoes: { $lt: limite },
          sucessorSelado: { $exists: true },
        },
        { $inc: { recuperacoes: 1 } },
        { returnDocument: "after" },
      )
      .exec();
  }

  /**
   * Fase 22.8.7.2 — remove o sucessor cifrado de um documento (limpeza oportunista quando ele deixa de ser
   * recuperável: janela vencida, família revogada, falha de integridade). `chaveHash`, `recuperavelAte` e
   * `recuperacoes` ficam — sem o selo nenhuma recuperação é possível, e repetições continuam classificadas igual.
   */
  async descartarSucessorSelado(id: Types.ObjectId): Promise<void> {
    await this.refreshTokenModel.updateOne({ _id: id }, { $unset: { sucessorSelado: "" } }).exec();
  }

  /**
   * Revoga TODAS as sessões do usuário (todas as famílias). Usado pela desativação administrativa (Fase 60.4.3.1.5),
   * pela redefinição de senha e por um usuário inativo no refresh; devolve quantas sessões foram revogadas agora.
   * Fase 22.8.7.1 — no reuso suspeito, só para documentos LEGADOS sem `familiaId` (com família: `revogarFamilia`).
   */
  async revogarTodosDoUsuario(usuarioId: Types.ObjectId, agora: Date): Promise<number> {
    const resultado = await this.refreshTokenModel.updateMany({ usuarioId, revogadoEm: null }, { $set: { revogadoEm: agora } }).exec();
    return resultado.modifiedCount;
  }

  /**
   * Fase 22.8.7.1 — revoga os tokens ativos de UMA família de sessão (reuso suspeito e logout). O filtro tem SEMPRE os
   * dois escopos — `usuarioId` e `familiaId`, ambos lidos do documento persistido, nunca do cliente — então nunca
   * alcança outra família do mesmo usuário nem de outro usuário. Idempotente; devolve quantos tokens revogou agora.
   */
  async revogarFamilia(usuarioId: Types.ObjectId, familiaId: string, agora: Date): Promise<number> {
    const resultado = await this.refreshTokenModel
      .updateMany({ usuarioId, familiaId, revogadoEm: null }, { $set: { revogadoEm: agora } })
      .exec();
    return resultado.modifiedCount;
  }

  /** Fase 60.4.3.1.5 — sessões ainda utilizáveis do usuário (não revogadas e não expiradas). Somente leitura. */
  async contarValidosDoUsuario(usuarioId: Types.ObjectId, agora: Date): Promise<number> {
    return this.refreshTokenModel.countDocuments({ usuarioId, revogadoEm: null, expiresAt: { $gt: agora } }).exec();
  }

  /** Só para rastreabilidade da cadeia de rotação — nunca usado em validação. */
  async marcarSubstituto(tokenHashAntigo: string, tokenHashNovo: string): Promise<void> {
    await this.refreshTokenModel.updateOne({ tokenHash: tokenHashAntigo }, { $set: { substituidoPor: tokenHashNovo } }).exec();
  }
}
