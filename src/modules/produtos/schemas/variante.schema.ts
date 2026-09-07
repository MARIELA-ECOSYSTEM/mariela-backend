import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import type { HydratedDocument, Types } from "mongoose";
import { aplicarSerializacaoPadrao } from "../../../database/mongoose-json.util.js";
import { Tamanho, TamanhoSchema } from "./tamanho.schema.js";

/**
 * Subdocumento com `_id` próprio (ObjectId, exposto como `id`) — mesma
 * justificativa do tamanho: `varianteId` já é referenciado pelo frontend em
 * estoque, foto principal, e futuramente por vendas.
 *
 * `corNormalizada` existe SÓ para permitir uma verificação de unicidade
 * atômica via filtro de query (`$ne` na própria operação de `$push`), sem uma
 * janela de corrida entre "ler variantes" e "gravar nova variante" — nunca é
 * exposta na API (removida por `aplicarSerializacaoPadrao`).
 */
@Schema({ _id: true })
export class Variante {
  @Prop({ type: String, required: true })
  cor!: string;

  @Prop({ type: String, required: true })
  corNormalizada!: string;

  @Prop({ type: String, required: true })
  codVariante!: string;

  @Prop({ type: Number, required: true, min: 0, default: 0 })
  quantidadeVariante!: number;

  @Prop({ type: String, default: null })
  foto!: string | null;

  @Prop({ type: String, default: null })
  video!: string | null;

  @Prop({ type: [TamanhoSchema], default: [] })
  tamanhos!: Types.DocumentArray<Tamanho>;
}

export type VarianteDocument = HydratedDocument<Variante>;
export const VarianteSchema = SchemaFactory.createForClass(Variante);
aplicarSerializacaoPadrao(VarianteSchema, ["corNormalizada"]);
