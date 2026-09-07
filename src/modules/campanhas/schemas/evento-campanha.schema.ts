import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, type HydratedDocument, type Types } from "mongoose";
import { aplicarSerializacaoPadrao } from "../../../database/mongoose-json.util.js";

/**
 * Auditoria mínima do domínio Campanhas — mesmo padrão de
 * `eventos_produto`/`eventos_cliente`/`eventos_fornecedor`/`eventos_colecao`:
 * registro append-only dos eventos relevantes deste módulo.
 */
@Schema({ collection: "eventos_campanha", versionKey: false, timestamps: { createdAt: "criadoEm", updatedAt: false } })
export class EventoCampanha {
  @Prop({ type: SchemaTypes.ObjectId, required: true, index: true })
  campanhaId!: Types.ObjectId;

  /** Ex.: "campanha.criada", "campanha.atualizada", "campanha.excluida". */
  @Prop({ type: String, required: true, index: true })
  tipo!: string;

  @Prop({ type: String, default: null })
  usuarioId!: string | null;

  @Prop({ type: Object, default: {} })
  detalhes!: Record<string, unknown>;
}

export type EventoCampanhaDocument = HydratedDocument<EventoCampanha>;
export const EventoCampanhaSchema = SchemaFactory.createForClass(EventoCampanha);
aplicarSerializacaoPadrao(EventoCampanhaSchema);
