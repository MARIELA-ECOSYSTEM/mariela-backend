import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model, Types } from "mongoose";
import { RefreshToken, type RefreshTokenDocument } from "./schemas/refresh-token.schema.js";

@Injectable()
export class RefreshTokensRepository {
  constructor(@InjectModel(RefreshToken.name) private readonly refreshTokenModel: Model<RefreshTokenDocument>) {}

  async criar(dados: {
    usuarioId: Types.ObjectId;
    tokenHash: string;
    expiresAt: Date;
    userAgent: string | null;
    ip: string | null;
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

  /** Resposta a uma reutilização detectada: mata toda a família de sessões daquele usuário. */
  async revogarTodosDoUsuario(usuarioId: Types.ObjectId, agora: Date): Promise<void> {
    await this.refreshTokenModel.updateMany({ usuarioId, revogadoEm: null }, { $set: { revogadoEm: agora } }).exec();
  }

  /** Só para rastreabilidade da cadeia de rotação — nunca usado em validação. */
  async marcarSubstituto(tokenHashAntigo: string, tokenHashNovo: string): Promise<void> {
    await this.refreshTokenModel.updateOne({ tokenHash: tokenHashAntigo }, { $set: { substituidoPor: tokenHashNovo } }).exec();
  }
}
