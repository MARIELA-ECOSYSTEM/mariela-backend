import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model, Types } from "mongoose";
import { VendedorRefreshToken, type VendedorRefreshTokenDocument } from "./schemas/vendedor-refresh-token.schema.js";

/**
 * Persistência de sessões de refresh token do MARIELA PDV — mesmo mecanismo
 * comprovado de `modules/auth/refresh-tokens.repository.ts` (ADMIN), replicado
 * aqui para a coleção `vendedor_refresh_tokens` (ver justificativa de
 * separação em `pdv-auth.constants.ts`).
 */
@Injectable()
export class PdvAuthRepository {
  constructor(
    @InjectModel(VendedorRefreshToken.name) private readonly refreshTokenModel: Model<VendedorRefreshTokenDocument>,
  ) {}

  async criar(dados: {
    vendedorId: Types.ObjectId;
    tokenHash: string;
    expiresAt: Date;
    userAgent: string | null;
    ip: string | null;
  }): Promise<VendedorRefreshTokenDocument> {
    return this.refreshTokenModel.create({ ...dados, revogadoEm: null, rotacionadoEm: null, substituidoPor: null });
  }

  async encontrarPorHash(tokenHash: string): Promise<VendedorRefreshTokenDocument | null> {
    return this.refreshTokenModel.findOne({ tokenHash }).exec();
  }

  /**
   * Reivindica o token atomicamente: só revoga (e devolve o estado ANTERIOR)
   * se ele existir, nunca ter sido revogado e não estar expirado — tudo na
   * MESMA operação do MongoDB. Duas chamadas concorrentes com o mesmo token:
   * só uma vê o documento "antes"; a outra recebe `null`.
   */
  async revogarSeValido(tokenHash: string, agora: Date): Promise<VendedorRefreshTokenDocument | null> {
    return this.refreshTokenModel
      .findOneAndUpdate(
        { tokenHash, revogadoEm: null, expiresAt: { $gt: agora } },
        { $set: { revogadoEm: agora, rotacionadoEm: agora } },
        { returnDocument: "before" },
      )
      .exec();
  }

  /** Resposta a uma reutilização detectada, ou a um vendedor inativado: mata toda a família de sessões dele. */
  async revogarTodosDoVendedor(vendedorId: Types.ObjectId, agora: Date): Promise<void> {
    await this.refreshTokenModel.updateMany({ vendedorId, revogadoEm: null }, { $set: { revogadoEm: agora } }).exec();
  }

  /** Só para rastreabilidade da cadeia de rotação — nunca usado em validação. */
  async marcarSubstituto(tokenHashAntigo: string, tokenHashNovo: string): Promise<void> {
    await this.refreshTokenModel.updateOne({ tokenHash: tokenHashAntigo }, { $set: { substituidoPor: tokenHashNovo } }).exec();
  }
}
