import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import type { HydratedDocument, Schema as MongooseSchema } from "mongoose";
import { CAMPOS_LISTA, type CampoLista } from "../configuracoes.constants.js";

/** Subdocumento embutido — nunca uma collection própria (`_id: false`, mesmo padrão de `TarifaAplicada` em Vendas). */
@Schema({ _id: false })
export class EnderecoLojaSub {
  @Prop({ type: String, required: true, trim: true, maxlength: 12, default: "" })
  cep!: string;

  @Prop({ type: String, required: true, trim: true, maxlength: 160, default: "" })
  logradouro!: string;

  @Prop({ type: String, required: true, trim: true, maxlength: 20, default: "" })
  numero!: string;

  @Prop({ type: String, required: true, trim: true, maxlength: 80, default: "" })
  complemento!: string;

  @Prop({ type: String, required: true, trim: true, maxlength: 80, default: "" })
  bairro!: string;

  @Prop({ type: String, required: true, trim: true, maxlength: 80, default: "" })
  cidade!: string;

  @Prop({ type: String, required: true, trim: true, maxlength: 2, default: "" })
  estado!: string;
}
export const EnderecoLojaSubSchema = SchemaFactory.createForClass(EnderecoLojaSub);

@Schema({ _id: false })
export class DadosLojaSub {
  @Prop({ type: String, required: true, trim: true, maxlength: 120, default: "" })
  nome!: string;

  /** URL/texto livre — nunca upload/mídia binária (decisão do contrato, Etapa 11.2). */
  @Prop({ type: String, required: true, trim: true, maxlength: 500, default: "" })
  logo!: string;

  @Prop({ type: String, required: true, trim: true, maxlength: 20, default: "" })
  telefone!: string;

  @Prop({ type: String, required: true, trim: true, maxlength: 20, default: "" })
  whatsapp!: string;

  @Prop({ type: String, required: true, trim: true, maxlength: 160, default: "" })
  email!: string;

  @Prop({ type: EnderecoLojaSubSchema, required: true, default: () => ({}) })
  endereco!: EnderecoLojaSub;
}
export const DadosLojaSubSchema = SchemaFactory.createForClass(DadosLojaSub);

/**
 * Fase 56.4.2 — intenção DURÁVEL de uma remoção de item de lista ainda não
 * concluída. Gravada na MESMA operação atômica do `$pull` (ver
 * `ConfiguracoesRepository.removerItemComPendencia`) e encerrada na MESMA
 * operação que finaliza ou restaura o item — se o processo cair no meio, a
 * pendência fica no documento para `ConfiguracoesService.processarRemocoesPendentes`.
 * Interna: nunca exposta na API (fora da lista explícita de `aplicarSerializacaoDeConfiguracao`).
 */
@Schema({ _id: false })
export class RemocaoPendente {
  /** Identificador único da operação (UUID). */
  @Prop({ type: String, required: true })
  opId!: string;

  @Prop({ type: String, required: true, enum: CAMPOS_LISTA })
  lista!: CampoLista;

  /** Valor EXATO removido da lista (o que é restaurado, se houver vínculo). */
  @Prop({ type: String, required: true })
  valor!: string;

  /** `valor` pelo normalizador da lista no momento da remoção (diagnóstico). */
  @Prop({ type: String, required: true })
  normalizado!: string;

  /** Índice do item na lista no momento da remoção; `null` quando desconhecido. */
  @Prop({ type: Number, min: 0, default: null })
  posicao!: number | null;

  @Prop({ type: Date, required: true })
  em!: Date;
}
export const RemocaoPendenteSchema = SchemaFactory.createForClass(RemocaoPendente);

/**
 * Configuração ADMINISTRATIVA global e única da loja (Etapa 11.2) — contrato
 * fechado extraído diretamente do Backoffice já implementado
 * (`mariela-backoffice`): dados da loja + quatro listas simples de string
 * (`categorias`/`tamanhos`/`cores`/`formasPagamento`). Deliberadamente SEM
 * IDs por item de lista, SEM entidades separadas, SEM enforcement contra
 * `Produto.categoria`/`Variante.cor`/`Variante.tamanho` (que continuam
 * strings livres) — tudo isso é decisão explícita desta etapa, não uma
 * omissão.
 *
 * Singleton por `_id` FIXO (`ID_CONFIGURACAO_GLOBAL`, ver
 * `configuracoes.constants.ts`), nunca um ObjectId — o próprio mecanismo de
 * unicidade de `_id` do MongoDB garante que só existe UM documento possível
 * nesta coleção, sem precisar de um índice extra nem de uma checagem
 * "existe outro?" antes de criar.
 *
 * As quatro listas TÊM enforcement (unicidade case-insensitive + proteção de
 * exclusão em uso): `cores`/`tamanhos` desde a Fase 54.0 contra
 * `Variante.cor`/`Variante.tamanho`; `categorias` desde a Fase 55.1 contra
 * `Produto.categoria`; `formasPagamento` desde a Fase 55.2 contra
 * `Venda.formaPagamento`/`pagamentos[].forma`/`parcelas[].formaPagamento` e
 * `MovimentoCaixa.formaPagamento` — nunca contra `modalidade` (classificação
 * técnica fechada, independente desta configuração; ver
 * `docs/configuracoes-cores-tamanhos.md`).
 */
@Schema({ collection: "configuracoes", versionKey: false, timestamps: { createdAt: "criadoEm", updatedAt: "atualizadoEm" } })
export class Configuracao {
  @Prop({ type: String, required: true })
  _id!: string;

  @Prop({ type: DadosLojaSubSchema, required: true, default: () => ({}) })
  loja!: DadosLojaSub;

  @Prop({ type: [String], default: [] })
  categorias!: string[];

  /**
   * Fase 55.1 — espelho de `categorias` só com a forma normalizada
   * (`normalizarCategoria`), mesmo papel de `tamanhosNormalizados`/
   * `coresNormalizadas`: permite a checagem de unicidade case-insensitive de
   * forma atômica (`$ne`/`$push` num único `findOneAndUpdate`) — nunca
   * exposto na API (fora da lista explícita de `aplicarSerializacaoDeConfiguracao`).
   */
  @Prop({ type: [String], default: [] })
  categoriasNormalizadas!: string[];

  @Prop({ type: [String], default: [] })
  tamanhos!: string[];

  /**
   * Fase 54.0 — espelho de `tamanhos` só com a forma normalizada
   * (`normalizarTamanho`, mesma função usada por `Tamanho.tamanho` em
   * Produtos), em paralelo item-a-item. Existe SÓ para permitir a checagem de
   * unicidade case-insensitive de forma atômica (`$ne`/`$push` num único
   * `findOneAndUpdate`, sem ler-modificar-salvar o array inteiro) — nunca
   * exposto na API (fora da lista explícita de `aplicarSerializacaoDeConfiguracao`).
   */
  @Prop({ type: [String], default: [] })
  tamanhosNormalizados!: string[];

  @Prop({ type: [String], default: [] })
  cores!: string[];

  /** Mesmo papel de `tamanhosNormalizados`, para `cores` (via `normalizarCor`). */
  @Prop({ type: [String], default: [] })
  coresNormalizadas!: string[];

  @Prop({ type: [String], default: [] })
  formasPagamento!: string[];

  /**
   * Fase 55.2 — espelho de `formasPagamento` só com a forma normalizada
   * (`normalizarFormaPagamento`), mesmo papel de `tamanhosNormalizados`/
   * `coresNormalizadas`/`categoriasNormalizadas`: permite a checagem de
   * unicidade case-insensitive de forma atômica — nunca exposto na API (fora
   * da lista explícita de `aplicarSerializacaoDeConfiguracao`).
   */
  @Prop({ type: [String], default: [] })
  formasPagamentoNormalizadas!: string[];

  /**
   * Fase 56.4.2 — remoções de itens de lista ainda não concluídas (ver
   * `RemocaoPendente`). Documentos legados não têm o campo: ele nunca é
   * preenchido em massa — surge no primeiro `$push` de uma remoção.
   */
  @Prop({ type: [RemocaoPendenteSchema], default: [] })
  remocoesPendentes!: RemocaoPendente[];

  criadoEm!: Date;
  atualizadoEm!: Date;
}

export type ConfiguracaoDocument = HydratedDocument<Configuracao>;
export const ConfiguracaoSchema = SchemaFactory.createForClass(Configuracao);

/**
 * Serialização DELIBERADAMENTE diferente do padrão `aplicarSerializacaoPadrao`
 * (que sempre expõe `id`): o contrato do Backoffice (`interface Configuracoes`)
 * não tem `id` nem `criadoEm` — só `loja`/`categorias`/`tamanhos`/`cores`/
 * `formasPagamento`/`atualizadoEm`. Expor `id: "global"` (o `_id` sentinela,
 * sem nenhum significado para o frontend) ou `criadoEm` seria adicionar
 * metadados ao contrato sem necessidade real (proibido explicitamente nesta
 * etapa) — por isso este schema monta a resposta com a lista EXATA de campos,
 * em vez de reusar o transform genérico do resto do projeto.
 *
 * Recebe `Schema` (tipo genérico do mongoose, não `Schema<Configuracao>`) de
 * propósito — mesma técnica de `aplicarSerializacaoPadrao` — porque o Mongoose
 * tipa `ret` no transform específico do model de forma estrita demais para
 * devolver um objeto com um formato DIFERENTE do documento original.
 */
function aplicarSerializacaoDeConfiguracao(schema: MongooseSchema): void {
  schema.set("toJSON", {
    virtuals: false,
    versionKey: false,
    transform: (_doc: unknown, ret: Record<string, unknown>) => ({
      loja: ret["loja"],
      categorias: ret["categorias"],
      tamanhos: ret["tamanhos"],
      cores: ret["cores"],
      formasPagamento: ret["formasPagamento"],
      atualizadoEm: ret["atualizadoEm"],
    }),
  });
}
aplicarSerializacaoDeConfiguracao(ConfiguracaoSchema);
