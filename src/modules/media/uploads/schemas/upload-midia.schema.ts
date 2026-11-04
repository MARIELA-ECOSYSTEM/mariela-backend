import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, type HydratedDocument, type Types } from "mongoose";
import { aplicarSerializacaoPadrao } from "../../../../database/mongoose-json.util.js";
import { ESTADOS_UPLOAD_MIDIA, TIPOS_DE_MIDIA, type EstadoUploadMidia, type TipoMidia } from "../../media.constants.js";

/**
 * Fase 60.1 — registro de TODA chave de objeto que o backend assinou para a galeria (`uploads_midia`). É a fonte
 * de verdade do ciclo de vida do arquivo no R2: `pendente` (assinado, aguardando confirmação) → `confirmado`
 * (o produto referencia a mídia) → `removido` (saiu da galeria; o objeto NÃO é apagado nesta fase). `descartado`
 * marca uma assinatura que falhou (e, no futuro, a limpeza de pendentes abandonados).
 *
 * `urlExpiraEm` (validade da URL assinada, 10 min) e `limpezaApos` (prazo do registro pendente, 24 h) são
 * conceitos diferentes e nunca compartilham campo. A limpeza futura deve sempre conferir o produto antes de
 * apagar qualquer objeto.
 */
@Schema({ collection: "uploads_midia", versionKey: false })
export class UploadMidia {
  /** `uploadId` (UUID) — também é o `_id` da mídia em `Produto.midias` depois da confirmação. */
  @Prop({ type: String, required: true })
  _id!: string;

  @Prop({ type: SchemaTypes.ObjectId, required: true })
  produtoId!: Types.ObjectId;

  /** `products/{produtoId}/{uploadId}.{ext}` — único (índice abaixo). */
  @Prop({ type: String, required: true })
  chave!: string;

  @Prop({ type: String, required: true, enum: TIPOS_DE_MIDIA })
  tipo!: TipoMidia;

  @Prop({ type: String, required: true })
  contentType!: string;

  @Prop({ type: Number, required: true })
  tamanho!: number;

  @Prop({ type: String, required: true })
  nomeOriginal!: string;

  @Prop({ type: String, required: true, enum: ESTADOS_UPLOAD_MIDIA, default: "pendente" })
  estado!: EstadoUploadMidia;

  @Prop({ type: String, default: null })
  criadoPor!: string | null;

  @Prop({ type: Date, required: true })
  criadoEm!: Date;

  @Prop({ type: Date, required: true })
  urlExpiraEm!: Date;

  @Prop({ type: Date, required: true })
  limpezaApos!: Date;

  @Prop({ type: Date, default: null })
  confirmadoEm!: Date | null;

  @Prop({ type: Date, default: null })
  removidoEm!: Date | null;
}

export type UploadMidiaDocument = HydratedDocument<UploadMidia>;
export const UploadMidiaSchema = SchemaFactory.createForClass(UploadMidia);

aplicarSerializacaoPadrao(UploadMidiaSchema);

// Limpeza futura: pendentes com prazo vencido.
UploadMidiaSchema.index({ estado: 1, limpezaApos: 1 });
// Consultas por produto (ex.: pendentes de um produto).
UploadMidiaSchema.index({ produtoId: 1, estado: 1 });
// Uma chave de objeto nunca é assinada duas vezes.
UploadMidiaSchema.index({ chave: 1 }, { unique: true });
