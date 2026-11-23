import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, type HydratedDocument, type Types } from "mongoose";
import { aplicarSerializacaoPadrao } from "../../../database/mongoose-json.util.js";
import {
  ORIGENS_BLOQUEIO_WHATSAPP,
  TIPOS_CHAVE_BLOQUEIO_WHATSAPP,
  type OrigemBloqueioWhatsapp,
  type TipoChaveBloqueioWhatsapp,
} from "../envios/envios-whatsapp.constants.js";

/**
 * Fase 22.8.9.10.3 — lista de bloqueio de WhatsApp (`whatsapp_bloqueios`): pedidos de não contato, POR NÚMERO.
 *
 * - Independe do cadastro: `clienteId` é só referência (pode ser `null`, ex.: número sem cliente ativo). Excluir e
 *   recadastrar o cliente não remove o bloqueio — ele vale para QUALQUER cliente com aquele número.
 * - `chave` é o E.164 normalizado (`tipoChave: "E164"`) ou um `waId` devolvido pelo provedor (`"WAID"`). Não há
 *   correspondência aproximada entre números (nem variante do nono dígito — decisão da Fase 22.8.9.10.3).
 * - Desbloquear NÃO apaga: grava `ativo: false` e os campos de desbloqueio. No máximo UM bloqueio ATIVO por chave
 *   (índice único parcial); o histórico pode ter vários inativos.
 */
@Schema({ collection: "whatsapp_bloqueios", versionKey: false })
export class BloqueioWhatsapp {
  @Prop({ type: String, required: true })
  chave!: string;

  @Prop({ type: String, required: true, enum: TIPOS_CHAVE_BLOQUEIO_WHATSAPP })
  tipoChave!: TipoChaveBloqueioWhatsapp;

  @Prop({ type: Boolean, required: true })
  ativo!: boolean;

  @Prop({ type: SchemaTypes.ObjectId, default: null })
  clienteId!: Types.ObjectId | null;

  @Prop({ type: String, required: true, enum: ORIGENS_BLOQUEIO_WHATSAPP })
  origem!: OrigemBloqueioWhatsapp;

  @Prop({ type: String, default: null })
  motivo!: string | null;

  @Prop({ type: String, default: null })
  usuarioId!: string | null;

  @Prop({ type: Date, required: true })
  criadoEm!: Date;

  @Prop({ type: Date, default: null })
  desbloqueadoEm!: Date | null;

  @Prop({ type: String, default: null })
  desbloqueadoPor!: string | null;

  @Prop({ type: String, default: null })
  motivoDesbloqueio!: string | null;
}

export type BloqueioWhatsappDocument = HydratedDocument<BloqueioWhatsapp>;
export const BloqueioWhatsappSchema = SchemaFactory.createForClass(BloqueioWhatsapp);

aplicarSerializacaoPadrao(BloqueioWhatsappSchema);

// No máximo um bloqueio ATIVO por número/waId (bloquear de novo é idempotente).
BloqueioWhatsappSchema.index(
  { chave: 1 },
  { unique: true, name: "chave_ativa_unica", partialFilterExpression: { ativo: true } },
);
BloqueioWhatsappSchema.index({ clienteId: 1 });
BloqueioWhatsappSchema.index({ criadoEm: -1 });
