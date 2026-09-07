import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, type HydratedDocument, type Types } from "mongoose";
import { aplicarSerializacaoPadrao } from "../../../database/mongoose-json.util.js";

/**
 * Auditoria mínima do domínio Vendedores — mesmo padrão de `eventos_cliente`:
 * registro append-only dos eventos relevantes deste módulo.
 *
 * `usuarioId` é o id real do ADMIN autenticado (`JwtPayload.sub`), passado
 * explicitamente pelo controller — nunca inferido, nunca aceito do frontend.
 * `detalhes` nunca guarda senha ou hash, mesmo em eventos de redefinição.
 */
@Schema({ collection: "eventos_vendedor", versionKey: false, timestamps: { createdAt: "criadoEm", updatedAt: false } })
export class EventoVendedor {
  @Prop({ type: SchemaTypes.ObjectId, required: true, index: true })
  vendedorId!: Types.ObjectId;

  /** Ex.: "vendedor.criado", "vendedor.atualizado", "vendedor.senha_redefinida", "vendedor.excluido". */
  @Prop({ type: String, required: true, index: true })
  tipo!: string;

  @Prop({ type: String, default: null })
  usuarioId!: string | null;

  @Prop({ type: Object, default: {} })
  detalhes!: Record<string, unknown>;
}

export type EventoVendedorDocument = HydratedDocument<EventoVendedor>;
export const EventoVendedorSchema = SchemaFactory.createForClass(EventoVendedor);
aplicarSerializacaoPadrao(EventoVendedorSchema);
