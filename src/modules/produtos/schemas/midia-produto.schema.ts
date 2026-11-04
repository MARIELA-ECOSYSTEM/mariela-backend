import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, type Types } from "mongoose";
import { aplicarSerializacaoPadrao } from "../../../database/mongoose-json.util.js";
import { TIPOS_DE_MIDIA, type TipoMidia } from "../../media/media.constants.js";

/** `upload`: arquivo enviado ao R2 e confirmado pelo backend. `legado`: URL externa preservada como estava (sem chave R2). */
export const ORIGENS_MIDIA = ["upload", "legado"] as const;
export type OrigemMidia = (typeof ORIGENS_MIDIA)[number];

/**
 * Fase 60.1 — item da galeria (`Produto.midias[]`). Fica EMBUTIDO no produto (nunca numa coleção própria): toda
 * mutação da galeria — inclusive a desassociação ao remover uma variante — acontece numa única escrita do produto,
 * protegida pelo `__v` de `salvarComRetentativa`, sem transação multi-documento.
 *
 * `_id` é o `uploadId` do registro em `uploads_midia` (string UUID), não um ObjectId gerado: é isso que torna a
 * confirmação idempotente (o mesmo upload nunca entra duas vezes). Só mídias ATIVAS ficam aqui — pendentes e
 * removidas vivem apenas em `uploads_midia`.
 */
@Schema({ _id: false })
export class MidiaProduto {
  @Prop({ type: String, required: true })
  _id!: string;

  @Prop({ type: String, required: true, enum: TIPOS_DE_MIDIA })
  tipo!: TipoMidia;

  /** Chave do objeto no R2; `null` para mídia legada externa. */
  @Prop({ type: String, default: null })
  chave!: string | null;

  /** URL pública montada pelo backend (nunca recebida do cliente em novos uploads). */
  @Prop({ type: String, required: true })
  url!: string;

  @Prop({ type: String, default: null })
  contentType!: string | null;

  /** Bytes; `null` quando desconhecido (mídia legada). */
  @Prop({ type: Number, default: null })
  tamanho!: number | null;

  @Prop({ type: String, default: null })
  nomeOriginal!: string | null;

  @Prop({ type: String, required: true, enum: ORIGENS_MIDIA })
  origem!: OrigemMidia;

  /** Só imagens podem ser associadas a uma variante (vídeo sempre `null`). */
  @Prop({ type: SchemaTypes.ObjectId, default: null })
  varianteId!: Types.ObjectId | null;

  @Prop({ type: Number, required: true, min: 0, validate: { validator: Number.isInteger, message: "ordem deve ser inteira." } })
  ordem!: number;

  @Prop({ type: Date, required: true })
  criadoEm!: Date;

  @Prop({ type: String, default: null })
  criadoPor!: string | null;
}

export const MidiaProdutoSchema = SchemaFactory.createForClass(MidiaProduto);
aplicarSerializacaoPadrao(MidiaProdutoSchema);
