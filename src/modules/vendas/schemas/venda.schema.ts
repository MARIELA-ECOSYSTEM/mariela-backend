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

  /**
   * Chave de idempotência do RECEBIMENTO POSTERIOR que originou este
   * pagamento (Etapa 10.8, `VendasService.receberPagamento`) — `null` para
   * todo pagamento registrado na CRIAÇÃO da venda (que já tem sua própria
   * idempotência por Venda inteira) e para qualquer venda anterior a esta
   * etapa. Permite detectar retry de um mesmo recebimento sem duplicar o
   * pagamento nem recontar `valorPago`.
   */
  @Prop({ type: String, default: null })
  idempotencyKey!: string | null;
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

  /**
   * Etapa 10.13 — marca se o estoque desta linha JÁ foi fisicamente
   * devolvido (`ProdutosService.ajustarQuantidadeTamanho`). `false` até a
   * restauração de fato acontecer; vira `true` via uma atualização atômica
   * dedicada (`VendasRepository.marcarItemRestaurado`), NUNCA junto
   * com a gravação do cancelamento em si — isso é o que permite recuperar um
   * cancelamento que persistiu mas caiu antes de restaurar o estoque (ou
   * restaurou só parte dos itens) sem jamais devolver a mesma unidade duas
   * vezes num retry/reconciliação. `default: true` para qualquer venda
   * cancelada ANTES desta etapa (nunca existiram sem estoque já restaurado
   * pelo fluxo síncrono antigo) — nunca reabre uma restauração antiga.
   *
   * Etapa 10.22 — CORREÇÃO: só vira `true` DEPOIS que
   * `ProdutosService.ajustarQuantidadeTamanho` confirma sucesso (nunca antes,
   * como acontecia até esta etapa). Ver `restaurando` abaixo para a
   * reivindicação que torna isso seguro sob concorrência.
   */
  @Prop({ type: Boolean, default: true })
  restaurado!: boolean;

  /**
   * Etapa 10.22 — reivindicação EM ANDAMENTO desta linha: `true` entre o
   * momento em que uma chamada "ganha o direito" de tentar restaurar o
   * estoque físico (CAS `restaurado:false AND restaurando≠true` →
   * `restaurando:true`, ver `VendasRepository.reivindicarRestauracaoDeItem`)
   * e o momento em que essa tentativa termina (sucesso → `restaurado:true`;
   * falha → volta a `false`, liberando para nova tentativa). Sem este campo,
   * a reivindicação teria que virar `restaurado:true` imediatamente — a
   * causa raiz do bug corrigido nesta etapa (item marcado restaurado sem o
   * estoque físico ter sido de fato incrementado). `default: false` — nunca
   * existe reivindicação em andamento para vendas anteriores a esta etapa.
   *
   * Risco residual aceito (mesma classe de limitação já assumida em todo o
   * módulo sem transação multi-documento): um crash do processo exatamente
   * entre a reivindicação e a finalização deixaria este campo preso em
   * `true` para sempre, sem retry automático — nenhum mecanismo de
   * expiração/lease foi introduzido (fora do escopo desta correção).
   */
  @Prop({ type: Boolean, default: false })
  restaurando!: boolean;
}
export const ItemDevolvidoSchema = SchemaFactory.createForClass(ItemDevolvido);

/**
 * Etapa 10.22 — CORREÇÃO: um EVENTO de cancelamento/devolução (nunca mais "o"
 * cancelamento da venda — uma venda pode ter vários, um por devolução
 * parcial). Agora vive em `Venda.cancelamentos` (array, append-only) em vez
 * de um único campo sobrescrito a cada chamada — ver histórico do bug
 * corrigido no relatório desta etapa. `_id: true` (mudou de `false`): cada
 * evento precisa de identidade própria e estável para que
 * `VendasRepository.reivindicarRestauracaoDeItem`/`marcarItemRestaurado`
 * consigam escopar corretamente `arrayFilters` de DOIS níveis (evento + item)
 * — o mesmo `itemId` pode aparecer em mais de um evento (devoluções parciais
 * sucessivas do mesmo item da venda).
 */
@Schema({ _id: true })
export class CancelamentoVenda {
  /** Identidade própria do evento (`_id: true`) — atribuída pelo Mongoose, nunca por `@Prop` (mesmo padrão de `criadoEm`/`atualizadoEm` em `Venda`). */
  _id!: Types.ObjectId;

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

  /**
   * Chave de idempotência do CANCELAMENTO (Etapa 10.13) — `null` para
   * cancelamentos legados (sem chave) ou qualquer venda anterior a esta
   * etapa. Permite reconhecer um retry da MESMA operação lógica (mesmo
   * `vendaId` + mesma chave) e reconciliar efeitos faltantes (estoque/caixa)
   * em vez de rejeitar com "venda já cancelada" ou, pior, tentar cancelar de
   * novo.
   */
  @Prop({ type: String, default: null })
  idempotencyKey!: string | null;
}
export const CancelamentoVendaSchema = SchemaFactory.createForClass(CancelamentoVenda);
aplicarSerializacaoPadrao(CancelamentoVendaSchema);

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

  /**
   * LEGADO — campo congelado a partir da Etapa 10.22, nunca mais escrito.
   * Existia como "o" (único) cancelamento da venda antes desta etapa;
   * substituído por `cancelamentos` (array, abaixo) porque um objeto único
   * sobrescrito a cada devolução parcial perdia histórico e podia perder o
   * rastreamento de itens ainda pendentes de restauração de estoque (ver
   * relatório da correção). Mantido só para permitir LEITURA de qualquer
   * documento eventualmente já persistido antes desta etapa — nenhuma
   * migração foi executada (sem acesso a produção neste ambiente; ver
   * relatório, seção "Compatibilidade com documentos existentes").
   */
  @Prop({ type: CancelamentoVendaSchema, default: null })
  cancelamento!: CancelamentoVenda | null;

  /**
   * Etapa 10.22 — histórico completo de eventos de cancelamento/devolução
   * (substituiu `cancelamento`, acima). Append-only: `VendasService.cancelar`
   * sempre ADICIONA um novo evento, nunca sobrescreve os anteriores — uma
   * venda pode acumular várias devoluções parciais ao longo do tempo, cada
   * uma preservada com seus próprios itens e seu próprio estado de
   * restauração de estoque por item.
   */
  @Prop({ type: [CancelamentoVendaSchema], default: [] })
  cancelamentos!: Types.DocumentArray<CancelamentoVenda>;

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
