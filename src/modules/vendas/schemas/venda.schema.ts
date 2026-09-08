import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import type { HydratedDocument, Types } from "mongoose";
import { aplicarSerializacaoPadrao } from "../../../database/mongoose-json.util.js";
import { MODALIDADES_TARIFA, type ModalidadeTarifa } from "../../adquirentes/adquirentes.constants.js";
import { STATUS_VENDA, TIPOS_EVENTO_VENDA, MODALIDADES_PAGAMENTO, type ModalidadePagamento, type StatusVenda, type TipoEventoVenda } from "../vendas.constants.js";

/**
 * Item vendido — SNAPSHOT histórico: preços, nome e categoria são copiados no
 * momento da venda e NUNCA recalculados depois. Uma alteração futura no
 * produto (nome, preço, categoria) não altera este item.
 */
@Schema({ _id: true })
export class ItemVenda {
  @Prop({ type: String, required: true })
  produtoId!: string;

  @Prop({ type: String, required: true })
  codProduto!: string;

  @Prop({ type: String, required: true })
  nome!: string;

  @Prop({ type: String, required: true })
  categoria!: string;

  @Prop({ type: String, default: null })
  varianteId!: string | null;

  @Prop({ type: String, default: null })
  codVariante!: string | null;

  @Prop({ type: String, default: null })
  cor!: string | null;

  @Prop({ type: String, default: null })
  tamanho!: string | null;

  @Prop({ type: String, default: null })
  foto!: string | null;

  @Prop({ type: Number, required: true, min: 1 })
  quantidade!: number;

  /** Preço de tabela vigente no momento da venda. */
  @Prop({ type: Number, required: true })
  precoOriginal!: number;

  /** Preço efetivamente praticado (promoção da época já aplicada). */
  @Prop({ type: Number, required: true })
  precoPraticado!: number;

  @Prop({ type: Boolean, default: false })
  emPromocao!: boolean;

  /**
   * Valor MONETÁRIO efetivamente descontado nesta linha (já considerando a
   * quantidade) — nunca o percentual solicitado, que não é autoridade do
   * resultado. `0` quando nenhum desconto de item foi aplicado.
   */
  @Prop({ type: Number, default: 0 })
  descontoItem!: number;

  @Prop({ type: Number, required: true })
  subtotal!: number;

  /** Quantidade já devolvida deste item — nunca excede `quantidade`. */
  @Prop({ type: Number, default: 0 })
  quantidadeDevolvida!: number;
}
export const ItemVendaSchema = SchemaFactory.createForClass(ItemVenda);
aplicarSerializacaoPadrao(ItemVendaSchema);

/**
 * Snapshot histórico da tarifa aplicada a um pagamento débito/crédito (Etapa
 * 10.5) — NUNCA recalculado depois de persistido, mesmo que a tabela de
 * tarifas do adquirente mude no futuro (mesmo princípio de `ItemVenda`).
 * `_id: false`: valor embutido, não uma entidade endereçável (mesmo padrão
 * de `ItemDevolvido`/`CancelamentoVenda` abaixo) — por isso também não passa
 * por `aplicarSerializacaoPadrao` (não há `_id`/`__v` para remover).
 */
@Schema({ _id: false })
export class TarifaAplicada {
  @Prop({ type: String, required: true })
  adquirenteId!: string;

  @Prop({ type: String, required: true })
  adquirenteNome!: string;

  @Prop({ type: String, required: true, enum: MODALIDADES_TARIFA })
  modalidade!: ModalidadeTarifa;

  @Prop({ type: Number, required: true })
  parcelas!: number;

  @Prop({ type: Number, required: true })
  percentual!: number;

  @Prop({ type: Number, required: true })
  valorBruto!: number;

  @Prop({ type: Number, required: true })
  valorTarifa!: number;

  @Prop({ type: Number, required: true })
  valorLiquido!: number;
}
export const TarifaAplicadaSchema = SchemaFactory.createForClass(TarifaAplicada);

@Schema({ _id: true })
export class PagamentoVenda {
  @Prop({ type: String, required: true })
  forma!: string;

  @Prop({ type: Number, required: true })
  valor!: number;

  @Prop({ type: Date, required: true })
  dataPagamento!: Date;

  @Prop({ type: Number, default: 1 })
  parcelas!: number;

  @Prop({ type: String, default: null })
  observacao!: string | null;

  /**
   * Modalidade estruturada (Etapa 10.4) — ADITIVA e OPCIONAL: `null` em
   * pagamentos legados (só `forma` livre, sem nenhuma das novas regras) e nos
   * dois únicos casos sem adquirente (`dinheiro`/`pix`, onde não é obrigatória
   * mas pode ser informada). Quando presente, é a AUTORIDADE para as regras
   * de adquirente/parcelamento — `forma` continua sendo só o texto histórico/
   * apresentacional, nunca usado para decidir regra de negócio.
   */
  @Prop({ type: String, enum: [...MODALIDADES_PAGAMENTO, null], default: null })
  modalidade!: ModalidadePagamento | null;

  /** Obrigatório quando `modalidade` é "debito"/"credito"; sempre `null` para "dinheiro"/"pix"/legado. */
  @Prop({ type: String, default: null })
  adquirenteId!: string | null;

  /**
   * Snapshot da tarifa (Etapa 10.5) — só existe quando `modalidade` é
   * "debito"/"credito"; sempre `null` para "dinheiro"/"pix"/legado (nunca um
   * objeto com percentual/valores zerados fingindo que houve tarifa).
   */
  @Prop({ type: TarifaAplicadaSchema, default: null })
  tarifaAplicada!: TarifaAplicada | null;
}
export const PagamentoVendaSchema = SchemaFactory.createForClass(PagamentoVenda);
aplicarSerializacaoPadrao(PagamentoVendaSchema);

@Schema({ _id: true })
export class ParcelaVenda {
  @Prop({ type: Number, required: true })
  numero!: number;

  @Prop({ type: Number, required: true })
  total!: number;

  @Prop({ type: Number, required: true })
  valor!: number;

  @Prop({ type: Date, required: true })
  vencimento!: Date;

  /** `null` enquanto em aberto — imutável após a baixa (nunca reaberta). */
  @Prop({ type: Date, default: null })
  pagoEm!: Date | null;

  @Prop({ type: String, default: null })
  formaPagamento!: string | null;
}
export const ParcelaVendaSchema = SchemaFactory.createForClass(ParcelaVenda);
aplicarSerializacaoPadrao(ParcelaVendaSchema);

@Schema({ _id: false })
export class EventoHistoricoVenda {
  @Prop({ type: Date, required: true })
  dataHora!: Date;

  @Prop({ type: String, required: true, enum: TIPOS_EVENTO_VENDA })
  tipo!: TipoEventoVenda;

  @Prop({ type: String, required: true })
  descricao!: string;

  /** Nome de exibição (vendedor ou "Backoffice") — narrativa da venda, não auditoria técnica (ver `eventos_venda`). */
  @Prop({ type: String, required: true })
  autor!: string;
}
export const EventoHistoricoVendaSchema = SchemaFactory.createForClass(EventoHistoricoVenda);

@Schema({ _id: false })
export class ItemDevolvido {
  @Prop({ type: String, required: true })
  itemId!: string;

  @Prop({ type: String, required: true })
  codProduto!: string;

  @Prop({ type: String, required: true })
  nome!: string;

  @Prop({ type: Number, required: true })
  quantidade!: number;

  @Prop({ type: Number, required: true })
  valor!: number;
}
export const ItemDevolvidoSchema = SchemaFactory.createForClass(ItemDevolvido);

@Schema({ _id: false })
export class CancelamentoVenda {
  @Prop({ type: String, required: true, enum: ["integral", "parcial"] })
  tipo!: "integral" | "parcial";

  @Prop({ type: String, required: true })
  motivo!: string;

  @Prop({ type: Date, required: true })
  dataHora!: Date;

  @Prop({ type: String, required: true })
  autor!: string;

  @Prop({ type: Number, required: true })
  valorDevolvido!: number;

  @Prop({ type: [ItemDevolvidoSchema], default: [] })
  itens!: ItemDevolvido[];
}
export const CancelamentoVendaSchema = SchemaFactory.createForClass(CancelamentoVenda);

/**
 * Contrato alinhado a `VendaDetalhe`/`VendaResumo` (`src/types/venda.ts`).
 * A venda é criada exclusivamente pelo futuro MARIELA PDV (ver
 * `VendasService.criar` — não exposto por nenhuma rota HTTP nesta etapa); o
 * Backoffice só consulta e administra baixa de parcela/cancelamento.
 *
 * Documento único por venda (itens/pagamentos/parcelas/histórico embutidos):
 * volume real de uma boutique não justifica collections separadas.
 */
@Schema({
  collection: "vendas",
  versionKey: "__v",
  // Sem isto, Mongoose NUNCA lança VersionError em .save() concorrente (o
  // default e apenas incrementar __v, nao checa-lo) -- salvarComRetentativa
  // dependia disto para funcionar de verdade; sem ele, dois saves
  // concorrentes se sobrescreviam silenciosamente (ultimo escreve vence).
  optimisticConcurrency: true,
  timestamps: { createdAt: "criadoEm", updatedAt: "atualizadoEm" },
})
export class Venda {
  @Prop({ type: String, required: true, unique: true })
  codigo!: string;

  /** Mesmo valor numérico de `codigo`, formatado com 6 dígitos para exibição ao operador do PDV. */
  @Prop({ type: String, required: true, unique: true })
  numero!: string;

  @Prop({ type: Date, required: true })
  dataVenda!: Date;

  @Prop({ type: String, default: null })
  clienteId!: string | null;

  @Prop({ type: String, required: true })
  clienteNome!: string;

  @Prop({ type: String, required: true })
  vendedorId!: string;

  @Prop({ type: String, required: true })
  vendedorNome!: string;

  @Prop({ type: String, default: null })
  caixaId!: string | null;

  @Prop({ type: String, default: null })
  caixaCodigo!: string | null;

  @Prop({ type: [ItemVendaSchema], default: [] })
  itens!: Types.DocumentArray<ItemVenda>;

  @Prop({ type: Number, required: true })
  totalItens!: number;

  @Prop({ type: Number, required: true })
  valorBruto!: number;

  @Prop({ type: Number, default: 0 })
  descontoPromocional!: number;

  /** Desconto concedido pelo operador no momento da venda — campo já previsto no contrato, não recalculado. */
  @Prop({ type: Number, default: 0 })
  descontoVenda!: number;

  @Prop({ type: Number, default: 0 })
  descontoTotal!: number;

  @Prop({ type: Number, required: true })
  valorFinal!: number;

  @Prop({ type: Number, default: 0 })
  valorPago!: number;

  @Prop({ type: Number, default: 0 })
  valorPendente!: number;

  @Prop({ type: Number, default: 0 })
  valorDevolvido!: number;

  @Prop({ type: Boolean, default: false })
  temPromocao!: boolean;

  @Prop({ type: Boolean, default: false })
  temDesconto!: boolean;

  /** Forma de pagamento principal (a primeira/única) — exibida na listagem sem precisar abrir o detalhe. */
  @Prop({ type: String, required: true })
  formaPagamento!: string;

  @Prop({ type: Number, default: 1 })
  totalParcelas!: number;

  @Prop({ type: Number, default: 0 })
  parcelasPagas!: number;

  @Prop({ type: String, trim: true, maxlength: 400, default: "" })
  observacao!: string;

  @Prop({ type: [PagamentoVendaSchema], default: [] })
  pagamentos!: Types.DocumentArray<PagamentoVenda>;

  @Prop({ type: [ParcelaVendaSchema], default: [] })
  parcelas!: Types.DocumentArray<ParcelaVenda>;

  @Prop({ type: [EventoHistoricoVendaSchema], default: [] })
  historico!: EventoHistoricoVenda[];

  @Prop({ type: CancelamentoVendaSchema, default: null })
  cancelamento!: CancelamentoVenda | null;

  @Prop({ type: String, required: true, enum: STATUS_VENDA, default: "em_pagamento" })
  status!: StatusVenda;

  /** Protege a CRIAÇÃO (futuro PDV) contra retry/duplicidade — único quando informado. */
  @Prop({ type: String, default: null })
  idempotencyKey!: string | null;

  criadoEm!: Date;
  atualizadoEm!: Date;
}

export type VendaDocument = HydratedDocument<Venda>;
export const VendaSchema = SchemaFactory.createForClass(Venda);
aplicarSerializacaoPadrao(VendaSchema);

VendaSchema.index({ status: 1 });
VendaSchema.index({ criadoEm: 1 });
VendaSchema.index({ dataVenda: 1 });
VendaSchema.index({ vendedorId: 1 });
VendaSchema.index({ clienteId: 1 });
VendaSchema.index({ caixaId: 1 });
VendaSchema.index({ idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } });
