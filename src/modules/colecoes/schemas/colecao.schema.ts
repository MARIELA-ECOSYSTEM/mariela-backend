import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import type { HydratedDocument } from "mongoose";
import { aplicarSerializacaoPadrao } from "../../../database/mongoose-json.util.js";

/**
 * Contrato alinhado ao tipo `Colecao` já consumido pelo Backoffice
 * (`src/types/colecao.ts`) — nomes de campo em PT-BR preservados de
 * propósito. `produtosVinculados` NÃO é um campo deste schema: é um agregado
 * calculado em tempo de leitura a partir da collection `produtos` (ver
 * `ColecoesService`), mesmo padrão já usado em Fornecedores.
 *
 * Não existe unicidade em `nome` — nenhum sinal disso no contrato real do
 * frontend (ao contrário do telefone em Clientes/Fornecedores).
 */
@Schema({
  collection: "colecoes",
  versionKey: "__v",
  // Sem isto, Mongoose NUNCA lança VersionError em .save() concorrente (o
  // default e apenas incrementar __v, nao checa-lo) -- salvarComRetentativa
  // dependia disto para funcionar de verdade; sem ele, dois saves
  // concorrentes se sobrescreviam silenciosamente (ultimo escreve vence).
  optimisticConcurrency: true,
  timestamps: { createdAt: "criadoEm", updatedAt: "atualizadoEm" },
})
export class Colecao {
  @Prop({ type: String, required: true, unique: true })
  codigo!: string;

  @Prop({ type: String, required: true, trim: true, maxlength: 120 })
  nome!: string;

  @Prop({ type: String, trim: true, maxlength: 400, default: "" })
  descricao!: string;

  @Prop({ type: Date, required: true })
  inicio!: Date;

  @Prop({ type: Date, required: true })
  fim!: Date;

  @Prop({ type: Boolean, default: true })
  ativo!: boolean;

  /** Aparece em áreas de destaque da futura Mariela Vitrine Virtual. */
  @Prop({ type: Boolean, default: false })
  destaque!: boolean;

  /** Aparece em banners/hero sections da vitrine. */
  @Prop({ type: Boolean, default: false })
  banner!: boolean;

  @Prop({ type: String, default: null })
  fotoDestaque!: string | null;

  @Prop({ type: String, default: null })
  fotoBanner!: string | null;

  /** Soft delete — nunca serializado na resposta pública. `null` = ativo. */
  @Prop({ type: Date, default: null })
  excluidoEm!: Date | null;

  criadoEm!: Date;
  atualizadoEm!: Date;
}

export type ColecaoDocument = HydratedDocument<Colecao>;
export const ColecaoSchema = SchemaFactory.createForClass(Colecao);

aplicarSerializacaoPadrao(ColecaoSchema, ["excluidoEm"]);

// Unicidade de `codigo` já vem do `unique: true` do `@Prop` acima (nunca reaproveitado, mesmo excluída).
// Soft delete: toda leitura filtra por ele; index acelera esse filtro sempre presente.
ColecaoSchema.index({ excluidoEm: 1 });
// Ordenação padrão / recência de cadastro (mesma decisão de Produtos/Clientes/Fornecedores: `nome` não é indexado).
ColecaoSchema.index({ criadoEm: 1 });
