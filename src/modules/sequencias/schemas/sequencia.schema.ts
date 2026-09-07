import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import type { HydratedDocument } from "mongoose";

/**
 * Um documento por entidade codificada (`produto`, `cliente`, `colecao`…).
 * `_id` é a própria chave da entidade — não um ObjectId — e `valor` é o
 * contador monotônico. Nunca decrementado, nunca reaproveitado.
 */
@Schema({ collection: "sequencias", versionKey: false })
export class Sequencia {
  @Prop({ type: String, required: true })
  _id!: string;

  @Prop({ type: Number, required: true, default: 0 })
  valor!: number;
}

export type SequenciaDocument = HydratedDocument<Sequencia>;
export const SequenciaSchema = SchemaFactory.createForClass(Sequencia);
