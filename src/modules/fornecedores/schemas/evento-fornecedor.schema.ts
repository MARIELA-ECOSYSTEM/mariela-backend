import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, type HydratedDocument, type Types } from "mongoose";
import { aplicarSerializacaoPadrao } from "../../../database/mongoose-json.util.js";

/**
 * Auditoria mínima do domínio Fornecedores — mesmo padrão de
 * `eventos_produto`/`eventos_cliente`: registro append-only dos eventos
 * relevantes deste módulo.
 */
@Schema({ collection: "eventos_fornecedor", versionKey: false, timestamps: { createdAt: "criadoEm", updatedAt: false } })
export class EventoFornecedor {
  @Prop({ type: SchemaTypes.ObjectId, required: true, index: true })
  fornecedorId!: Types.ObjectId;

  /** Ex.: "fornecedor.criado", "fornecedor.atualizado", "fornecedor.excluido". */
  @Prop({ type: String, required: true, index: true })
  tipo!: string;

  @Prop({ type: String, default: null })
  usuarioId!: string | null;

  @Prop({ type: Object, default: {} })
  detalhes!: Record<string, unknown>;
}

export type EventoFornecedorDocument = HydratedDocument<EventoFornecedor>;
export const EventoFornecedorSchema = SchemaFactory.createForClass(EventoFornecedor);
aplicarSerializacaoPadrao(EventoFornecedorSchema);
