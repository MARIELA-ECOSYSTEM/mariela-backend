import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import type { HydratedDocument, Schema as MongooseSchema } from "mongoose";

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
 */
@Schema({ collection: "configuracoes", versionKey: false, timestamps: { createdAt: "criadoEm", updatedAt: "atualizadoEm" } })
export class Configuracao {
  @Prop({ type: String, required: true })
  _id!: string;

  @Prop({ type: DadosLojaSubSchema, required: true, default: () => ({}) })
  loja!: DadosLojaSub;

  @Prop({ type: [String], default: [] })
  categorias!: string[];

  @Prop({ type: [String], default: [] })
  tamanhos!: string[];

  @Prop({ type: [String], default: [] })
  cores!: string[];

  @Prop({ type: [String], default: [] })
  formasPagamento!: string[];

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
