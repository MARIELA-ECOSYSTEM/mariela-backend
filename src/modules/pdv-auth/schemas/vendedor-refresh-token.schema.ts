import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, type HydratedDocument, type Types } from "mongoose";
import { aplicarSerializacaoPadrao } from "../../../database/mongoose-json.util.js";

/**
 * Sessão de refresh token do MARIELA PDV — coleção PRÓPRIA (`vendedor_refresh_tokens`),
 * nunca a mesma `refresh_tokens` do ADMIN: `vendedorId` referencia `Vendedor`,
 * nunca `Usuario`. Mesmo mecanismo comprovado do ADMIN (ver
 * `modules/auth/schemas/refresh-token.schema.ts`): o token opaco em si nunca é
 * persistido, só o hash HMAC-SHA256 (`tokenHash`); TTL automático por
 * `expiresAt`.
 */
@Schema({ collection: "vendedor_refresh_tokens", timestamps: { createdAt: "criadoEm", updatedAt: false } })
export class VendedorRefreshToken {
  @Prop({ type: SchemaTypes.ObjectId, required: true, index: true })
  vendedorId!: Types.ObjectId;

  @Prop({ type: String, required: true, unique: true })
  tokenHash!: string;

  @Prop({ type: Date, required: true })
  expiresAt!: Date;

  @Prop({ type: Date, default: null })
  revogadoEm!: Date | null;

  @Prop({ type: Date, default: null })
  rotacionadoEm!: Date | null;

  @Prop({ type: String, default: null })
  substituidoPor!: string | null;

  @Prop({ type: String, default: null })
  userAgent!: string | null;

  @Prop({ type: String, default: null })
  ip!: string | null;

  criadoEm!: Date;
}

export type VendedorRefreshTokenDocument = HydratedDocument<VendedorRefreshToken>;
export const VendedorRefreshTokenSchema = SchemaFactory.createForClass(VendedorRefreshToken);
aplicarSerializacaoPadrao(VendedorRefreshTokenSchema);

// TTL sobre data absoluta — mesmo idioma do ADMIN (`expireAfterSeconds: 0`).
VendedorRefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
