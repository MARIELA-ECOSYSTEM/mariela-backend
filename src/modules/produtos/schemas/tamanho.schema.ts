import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import type { HydratedDocument } from "mongoose";
import { aplicarSerializacaoPadrao } from "../../../database/mongoose-json.util.js";

/**
 * Subdocumento com `_id` próprio (ObjectId, exposto como `id`): o frontend já
 * referencia tamanhos por id em entrada/saída de estoque e exclusão, e IDs
 * estáveis também importam para o futuro histórico de movimentação e vendas.
 */
@Schema({ _id: true })
export class Tamanho {
  @Prop({ type: String, required: true })
  tamanho!: string;

  @Prop({ type: Number, required: true, min: 0, default: 0 })
  quantidade!: number;
}

export type TamanhoDocument = HydratedDocument<Tamanho>;
export const TamanhoSchema = SchemaFactory.createForClass(Tamanho);
aplicarSerializacaoPadrao(TamanhoSchema);
