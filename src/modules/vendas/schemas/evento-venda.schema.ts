import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, type HydratedDocument, type Types } from "mongoose";
import { aplicarSerializacaoPadrao } from "../../../database/mongoose-json.util.js";

/**
 * Auditoria técnica do domínio Vendas — mesmo padrão append-only dos demais
 * módulos. Diferente de `Venda.historico` (narrativa de negócio embutida,
 * com `autor` como nome de exibição): aqui `usuarioId` é sempre o id real do
 * autenticado (`JwtPayload.sub`) quando a operação vem do Backoffice, ou
 * `null` quando a operação de criação vier futuramente do PDV antes de sua
 * própria identidade estar implementada.
 */
@Schema({ collection: "eventos_venda", versionKey: false, timestamps: { createdAt: "criadoEm", updatedAt: false } })
export class EventoVenda {
  @Prop({ type: SchemaTypes.ObjectId, required: true, index: true })
  vendaId!: Types.ObjectId;

  /** Ex.: "venda.criada", "venda.parcela_baixada", "venda.cancelada", "venda.devolvida". */
  @Prop({ type: String, required: true, index: true })
  tipo!: string;

  @Prop({ type: String, default: null })
  usuarioId!: string | null;

  @Prop({ type: Object, default: {} })
  detalhes!: Record<string, unknown>;
}

export type EventoVendaDocument = HydratedDocument<EventoVenda>;
export const EventoVendaSchema = SchemaFactory.createForClass(EventoVenda);
aplicarSerializacaoPadrao(EventoVendaSchema);
