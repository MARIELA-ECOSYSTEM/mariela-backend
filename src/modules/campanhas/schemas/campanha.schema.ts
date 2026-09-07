import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import type { HydratedDocument } from "mongoose";
import { aplicarSerializacaoPadrao } from "../../../database/mongoose-json.util.js";

/**
 * Contrato alinhado ao tipo `Campanha` já consumido pelo Backoffice
 * (`src/types/campanha.ts`) — nomes de campo em PT-BR preservados de
 * propósito. Estruturalmente idêntico a `Colecao` (mesmos componentes
 * compartilhados no frontend — `PeriodoCard`/`PeriodoDialog`): a auditoria
 * confirmou que NÃO existe, no contrato real, nenhum campo de desconto/
 * percentual/valor promocional — Campanha é um agrupamento administrativo
 * por período+vitrine, não um mecanismo de precificação. Se essa integração
 * for necessária no futuro, é uma extensão nova, não uma correção deste módulo.
 *
 * `produtosVinculados` NÃO é um campo deste schema: é um agregado calculado
 * em tempo de leitura a partir da collection `produtos` (ver
 * `CampanhasService`), mesmo padrão já usado em Fornecedores/Coleções.
 */
@Schema({
  collection: "campanhas",
  versionKey: "__v",
  // Sem isto, Mongoose NUNCA lança VersionError em .save() concorrente (o
  // default e apenas incrementar __v, nao checa-lo) -- salvarComRetentativa
  // dependia disto para funcionar de verdade; sem ele, dois saves
  // concorrentes se sobrescreviam silenciosamente (ultimo escreve vence).
  optimisticConcurrency: true,
  timestamps: { createdAt: "criadoEm", updatedAt: "atualizadoEm" },
})
export class Campanha {
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

export type CampanhaDocument = HydratedDocument<Campanha>;
export const CampanhaSchema = SchemaFactory.createForClass(Campanha);

aplicarSerializacaoPadrao(CampanhaSchema, ["excluidoEm"]);

// Unicidade de `codigo` já vem do `unique: true` do `@Prop` acima (nunca reaproveitado, mesmo excluída).
// Soft delete: toda leitura filtra por ele; index acelera esse filtro sempre presente.
CampanhaSchema.index({ excluidoEm: 1 });
// Ordenação padrão / recência de cadastro (mesma decisão de Produtos/Clientes/Fornecedores/Coleções: `nome` não é indexado).
CampanhaSchema.index({ criadoEm: 1 });
