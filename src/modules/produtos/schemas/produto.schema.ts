import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, type HydratedDocument, type Types } from "mongoose";
import { aplicarSerializacaoPadrao } from "../../../database/mongoose-json.util.js";
import { Variante, VarianteSchema } from "./variante.schema.js";

/**
 * Contrato alinhado ao tipo `Produto` já consumido pelo Backoffice
 * (`src/types/produto.ts`) — nomes de campo em PT-BR preservados de propósito.
 *
 * Não existem campos `marca`/`imagemCapa`/`status`: não fazem parte do
 * contrato hoje usado pelo frontend e seriam campos inventados sem consumidor.
 * A disponibilidade continua derivada de `quantidadeTotal` (nunca um campo
 * manual). `excluidoEm` é o único campo "de estado" novo: soft delete interno,
 * nunca serializado na resposta pública (ver `aplicarSerializacaoPadrao`).
 */
@Schema({
  collection: "produtos",
  versionKey: "__v",
  // Sem isto, Mongoose NUNCA lança VersionError em .save() concorrente (o
  // default e apenas incrementar __v, nao checa-lo) -- salvarComRetentativa
  // dependia disto para funcionar de verdade; sem ele, dois saves
  // concorrentes se sobrescreviam silenciosamente (ultimo escreve vence).
  optimisticConcurrency: true,
  timestamps: { createdAt: "criadoEm", updatedAt: "atualizadoEm" },
})
export class Produto {
  @Prop({ type: String, required: true, unique: true })
  codProduto!: string;

  @Prop({ type: String, required: true, trim: true, maxlength: 120 })
  nome!: string;

  @Prop({ type: String, trim: true, maxlength: 1000, default: "" })
  descricao!: string;

  @Prop({ type: String, required: true, trim: true })
  categoria!: string;

  /**
   * Referências livres (string), não `ref` do Mongoose: os módulos de
   * Coleções/Campanhas/Fornecedores ainda não existem no backend. Quando
   * existirem, isso pode evoluir para `SchemaTypes.ObjectId` com `ref`.
   */
  @Prop({ type: String, default: null })
  colecaoId!: string | null;

  @Prop({ type: String, default: null })
  campanhaId!: string | null;

  @Prop({ type: String, default: null })
  fornecedorId!: string | null;

  @Prop({ type: Number, required: true, min: 0.01 })
  precoCusto!: number;

  @Prop({ type: Number, required: true, min: 0.01 })
  precoVenda!: number;

  /** Sempre recalculada pelo service — nunca aceita do cliente. */
  @Prop({ type: Number, default: 0 })
  margemLucro!: number;

  @Prop({ type: Boolean, default: false })
  ehNovidade!: boolean;

  @Prop({ type: Boolean, default: false })
  ehPromocao!: boolean;

  @Prop({ type: Number, default: null })
  precoPromocional!: number | null;

  /** Sempre recalculada a partir de `variantes[].tamanhos[].quantidade` — nunca aceita do cliente. */
  @Prop({ type: Number, default: 0 })
  quantidadeTotal!: number;

  @Prop({ type: SchemaTypes.ObjectId, default: null })
  fotoPrincipalVarianteId!: Types.ObjectId | null;

  /**
   * Só é preenchida quando um produto que JÁ TEVE estoque volta a zero —
   * nunca no cadastro inicial (que já nasce com `quantidadeTotal = 0`).
   * Volta a `null` assim que o produto tem estoque novamente. Prepara o
   * terreno para um futuro job de expurgo (30 dias sem estoque) — o job em
   * si (BullMQ) não é implementado agora.
   */
  @Prop({ type: Date, default: null })
  estoqueZeradoEm!: Date | null;

  /** Soft delete — nunca serializado na resposta pública. `null` = ativo. */
  @Prop({ type: Date, default: null })
  excluidoEm!: Date | null;

  @Prop({ type: [VarianteSchema], default: [] })
  variantes!: Types.DocumentArray<Variante>;

  criadoEm!: Date;
  atualizadoEm!: Date;
}

export type ProdutoDocument = HydratedDocument<Produto>;
export const ProdutoSchema = SchemaFactory.createForClass(Produto);

aplicarSerializacaoPadrao(ProdutoSchema, ["excluidoEm"]);

// Unicidade do código do produto já é criada pelo `unique: true` do `@Prop` acima.
// Unicidade do código de variante — inclusive entre produtos diferentes.
// `sparse` porque produtos sem variantes não têm essa chave no array.
ProdutoSchema.index({ "variantes.codVariante": 1 }, { unique: true, sparse: true });
// Soft delete: toda leitura filtra por ele; index acelera esse filtro sempre presente.
ProdutoSchema.index({ excluidoEm: 1 });
// Filtros de listagem mais comuns.
ProdutoSchema.index({ categoria: 1 });
ProdutoSchema.index({ colecaoId: 1 });
ProdutoSchema.index({ campanhaId: 1 });
ProdutoSchema.index({ fornecedorId: 1 });
ProdutoSchema.index({ quantidadeTotal: 1 });
ProdutoSchema.index({ criadoEm: 1 });
