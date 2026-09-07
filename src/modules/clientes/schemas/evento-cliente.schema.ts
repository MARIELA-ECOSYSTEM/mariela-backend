import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, type HydratedDocument, type Types } from "mongoose";
import { aplicarSerializacaoPadrao } from "../../../database/mongoose-json.util.js";

/**
 * Auditoria mínima do domínio Clientes — mesmo padrão de `eventos_produto`:
 * registro append-only dos eventos relevantes deste módulo, não o módulo
 * `auditoria/` completo (que ainda não existe na arquitetura).
 *
 * `usuarioId` é o id real do usuário autenticado (`JwtPayload.sub`), passado
 * explicitamente pelo controller — nunca inferido, nunca aceito do frontend.
 */
@Schema({ collection: "eventos_cliente", versionKey: false, timestamps: { createdAt: "criadoEm", updatedAt: false } })
export class EventoCliente {
  @Prop({ type: SchemaTypes.ObjectId, required: true, index: true })
  clienteId!: Types.ObjectId;

  /** Ex.: "cliente.criado", "cliente.atualizado", "cliente.excluido". */
  @Prop({ type: String, required: true, index: true })
  tipo!: string;

  @Prop({ type: String, default: null })
  usuarioId!: string | null;

  /** Snapshot pequeno e específico do evento. Nunca CPF/telefone/dados sensíveis. */
  @Prop({ type: Object, default: {} })
  detalhes!: Record<string, unknown>;
}

export type EventoClienteDocument = HydratedDocument<EventoCliente>;
export const EventoClienteSchema = SchemaFactory.createForClass(EventoCliente);
aplicarSerializacaoPadrao(EventoClienteSchema);
