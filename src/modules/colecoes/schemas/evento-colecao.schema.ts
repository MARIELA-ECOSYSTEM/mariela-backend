import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, type HydratedDocument, type Types } from "mongoose";
import { aplicarSerializacaoPadrao } from "../../../database/mongoose-json.util.js";

/**
 * Auditoria mínima do domínio Coleções — mesmo padrão de
 * `eventos_produto`/`eventos_cliente`/`eventos_fornecedor`: registro
 * append-only dos eventos relevantes deste módulo.
 */
@Schema({ collection: "eventos_colecao", versionKey: false, timestamps: { createdAt: "criadoEm", updatedAt: false } })
export class EventoColecao {
  @Prop({ type: SchemaTypes.ObjectId, required: true, index: true })
  colecaoId!: Types.ObjectId;

  /** Ex.: "colecao.criada", "colecao.atualizada", "colecao.excluida". */
  @Prop({ type: String, required: true, index: true })
  tipo!: string;

  @Prop({ type: String, default: null })
  usuarioId!: string | null;

  @Prop({ type: Object, default: {} })
  detalhes!: Record<string, unknown>;
}

export type EventoColecaoDocument = HydratedDocument<EventoColecao>;
export const EventoColecaoSchema = SchemaFactory.createForClass(EventoColecao);
aplicarSerializacaoPadrao(EventoColecaoSchema);
