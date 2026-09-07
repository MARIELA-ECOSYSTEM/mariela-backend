import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, type HydratedDocument, type Types } from "mongoose";
import { aplicarSerializacaoPadrao } from "../../../database/mongoose-json.util.js";

/**
 * Auditoria mínima do domínio Caixa — mesmo padrão de `eventos_cliente`:
 * registro append-only dos eventos relevantes deste módulo.
 *
 * `usuarioId` é o id real do ADMIN autenticado (`JwtPayload.sub`), passado
 * explicitamente pelo controller — nunca inferido, nunca aceito do frontend.
 */
@Schema({ collection: "eventos_caixa", versionKey: false, timestamps: { createdAt: "criadoEm", updatedAt: false } })
export class EventoCaixa {
  @Prop({ type: SchemaTypes.ObjectId, required: true, index: true })
  caixaId!: Types.ObjectId;

  /** Ex.: "caixa.aberto", "caixa.movimento_criado", "caixa.fechado". */
  @Prop({ type: String, required: true, index: true })
  tipo!: string;

  @Prop({ type: String, default: null })
  usuarioId!: string | null;

  @Prop({ type: Object, default: {} })
  detalhes!: Record<string, unknown>;
}

export type EventoCaixaDocument = HydratedDocument<EventoCaixa>;
export const EventoCaixaSchema = SchemaFactory.createForClass(EventoCaixa);
aplicarSerializacaoPadrao(EventoCaixaSchema);
