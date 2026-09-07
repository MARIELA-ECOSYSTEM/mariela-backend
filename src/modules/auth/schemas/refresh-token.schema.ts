import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, type HydratedDocument, type Types } from "mongoose";
import { aplicarSerializacaoPadrao } from "../../../database/mongoose-json.util.js";

/**
 * Sessão de refresh token — o token opaco (aleatório) em si NUNCA é
 * persistido; só o hash SHA-256 dele (`tokenHash`). Um índice TTL em
 * `expiresAt` limpa tokens expirados automaticamente.
 *
 * `revogadoEm` não-nulo = token não pode mais ser usado (logout, rotação, ou
 * resposta a uma reutilização detectada). `substituidoPor` amarra a cadeia de
 * rotação (token novo gerado a partir deste) — só para rastreabilidade em
 * caso de investigação de comprometimento, não é usado em nenhuma validação.
 */
@Schema({ collection: "refresh_tokens", timestamps: { createdAt: "criadoEm", updatedAt: false } })
export class RefreshToken {
  @Prop({ type: SchemaTypes.ObjectId, required: true, index: true })
  usuarioId!: Types.ObjectId;

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

export type RefreshTokenDocument = HydratedDocument<RefreshToken>;
export const RefreshTokenSchema = SchemaFactory.createForClass(RefreshToken);
aplicarSerializacaoPadrao(RefreshTokenSchema);

// TTL: o MongoDB apaga o documento sozinho quando `expiresAt` (timestamp
// absoluto) fica no passado — `expireAfterSeconds: 0` é o idioma correto para
// TTL sobre uma data absoluta (diferente de "N segundos após a criação").
RefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
