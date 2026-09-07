import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, type HydratedDocument, type Types } from "mongoose";
import { aplicarSerializacaoPadrao } from "../../../database/mongoose-json.util.js";

/**
 * Auditoria mínima do domínio Produtos — não é o módulo `auditoria/` completo
 * previsto na arquitetura de referência (isso viria com seu próprio domínio,
 * retenção, consulta, etc.), apenas um registro append-only dos eventos
 * relevantes deste módulo, pronto para evoluir quando aquele módulo existir.
 *
 * `usuarioId` é o id real do usuário autenticado (`JwtPayload.sub`), passado
 * explicitamente pelo controller — nunca inferido. `null` só quando a rota
 * genuinamente não tem usuário autenticado (não deve mais acontecer nas
 * mutações, hoje todas protegidas por `JwtAuthGuard`).
 */
@Schema({ collection: "eventos_produto", versionKey: false, timestamps: { createdAt: "criadoEm", updatedAt: false } })
export class EventoProduto {
  @Prop({ type: SchemaTypes.ObjectId, required: true, index: true })
  produtoId!: Types.ObjectId;

  @Prop({ type: String, default: null })
  varianteId!: string | null;

  /** Ex.: "produto.criado", "variante.excluida", "estoque.saida"… */
  @Prop({ type: String, required: true, index: true })
  tipo!: string;

  @Prop({ type: String, default: null })
  usuarioId!: string | null;

  /** Snapshot pequeno e específico do evento (ex.: quantidades antes/depois). Nunca dados sensíveis. */
  @Prop({ type: Object, default: {} })
  detalhes!: Record<string, unknown>;
}

export type EventoProdutoDocument = HydratedDocument<EventoProduto>;
export const EventoProdutoSchema = SchemaFactory.createForClass(EventoProduto);
aplicarSerializacaoPadrao(EventoProdutoSchema);
