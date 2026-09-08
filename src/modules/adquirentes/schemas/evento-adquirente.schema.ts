import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, type HydratedDocument, type Types } from "mongoose";
import { aplicarSerializacaoPadrao } from "../../../database/mongoose-json.util.js";

/**
 * Auditoria mínima do domínio Adquirentes — mesmo padrão de
 * `eventos_colecao`/`eventos_campanha`/`eventos_fornecedor`: registro
 * append-only dos eventos relevantes deste módulo.
 */
@Schema({ collection: "eventos_adquirente", versionKey: false, timestamps: { createdAt: "criadoEm", updatedAt: false } })
export class EventoAdquirente {
  @Prop({ type: SchemaTypes.ObjectId, required: true, index: true })
  adquirenteId!: Types.ObjectId;

  /** Ex.: "adquirente.criada", "adquirente.atualizada", "adquirente.excluida". */
  @Prop({ type: String, required: true, index: true })
  tipo!: string;

  @Prop({ type: String, default: null })
  usuarioId!: string | null;

  @Prop({ type: Object, default: {} })
  detalhes!: Record<string, unknown>;
}

export type EventoAdquirenteDocument = HydratedDocument<EventoAdquirente>;
export const EventoAdquirenteSchema = SchemaFactory.createForClass(EventoAdquirente);
aplicarSerializacaoPadrao(EventoAdquirenteSchema);
