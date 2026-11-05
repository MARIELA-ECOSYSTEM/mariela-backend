import { Injectable, Module, type DynamicModule } from "@nestjs/common";
import { InjectModel, MongooseModule } from "@nestjs/mongoose";
import type { Connection, Model } from "mongoose";
import { Produto, ProdutoSchema, type ProdutoDocument } from "../modules/produtos/schemas/produto.schema.js";
import type { MidiaLegadaNova, ProdutoLegado } from "./migrar-midias-legadas.plano.js";

/**
 * Fase 60.2 — contexto Nest EXCLUSIVO do comando `migrar-midias-legadas` (mesmo endurecimento da Fase 56.4.3.1):
 * conexão própria com `autoIndex`/`autoCreate` desligados, só o model `Produto`, nenhum controller, nenhum
 * repositório com `onModuleInit`, nenhum `AppModule`. Não toca `uploads_midia` nem o storage.
 */

/** Campos lidos — só o necessário para planejar (nunca o documento inteiro). */
const PROJECAO = {
  _id: 1,
  __v: 1,
  codProduto: 1,
  "variantes._id": 1,
  "variantes.foto": 1,
  "variantes.video": 1,
  fotoPrincipalVarianteId: 1,
  midias: 1,
  midiaPrincipalId: 1,
} as const;

/**
 * Leitura e escrita da migração direto na coleção (driver), sem `save()`: a escrita é UM `updateOne` condicional
 * que só acrescenta itens — os campos legados e `atualizadoEm` nem aparecem no comando enviado ao servidor.
 */
@Injectable()
export class MigradorMidiasLegadas {
  constructor(@InjectModel(Produto.name) private readonly produtoModel: Model<ProdutoDocument>) {}

  /** Todos os produtos (inclusive os excluídos logicamente, que preservam seus dados), em ordem estável de `_id`. */
  async listarProdutos(): Promise<ProdutoLegado[]> {
    return this.produtoModel.collection.find<ProdutoLegado>({}, { projection: PROJECAO }).sort({ _id: 1 }).toArray();
  }

  async lerProduto(produtoId: ProdutoLegado["_id"]): Promise<ProdutoLegado | null> {
    return this.produtoModel.collection.findOne<ProdutoLegado>({ _id: produtoId }, { projection: PROJECAO });
  }

  /**
   * Escrita atômica condicionada ao estado lido: mesmo `__v` (concorrência otimista, a mesma versão que
   * `salvarComRetentativa` usa), nenhum dos ids novos já presente e a principal ainda igual à lida. Só `$push`
   * (nunca substitui a galeria existente), `$set` de `midiaPrincipalId` quando aplicável e `$inc` de `__v`.
   * Devolve `false` se o documento mudou desde a leitura (nada é gravado).
   */
  async acrescentarMidias(lido: ProdutoLegado, novas: MidiaLegadaNova[], definirPrincipal: string | null): Promise<boolean> {
    const filtro = {
      _id: lido._id,
      __v: lido.__v === undefined ? { $exists: false } : lido.__v,
      "midias._id": { $nin: novas.map((midia) => midia._id) },
      midiaPrincipalId: lido.midiaPrincipalId ?? null,
    };
    const atualizacao = {
      $push: { midias: { $each: novas } },
      $inc: { __v: 1 },
      ...(definirPrincipal ? { $set: { midiaPrincipalId: definirPrincipal } } : {}),
    };
    const resultado = await this.colecaoParaEscrita().updateOne(filtro, atualizacao);
    return resultado.modifiedCount === 1;
  }

  /** A MESMA coleção do model, tipada só com os campos que a migração escreve (o driver exige o tipo do `$push`). */
  private colecaoParaEscrita() {
    return this.produtoModel.db.collection<{ _id: ProdutoLegado["_id"]; __v?: number; midias?: MidiaLegadaNova[]; midiaPrincipalId?: string | null }>(
      this.produtoModel.collection.collectionName,
    );
  }
}

/** Opções da conexão do comando (repassadas ao driver pelo Mongoose). */
export const OPCOES_DE_CONEXAO_DA_MIGRACAO = {
  autoIndex: false,
  autoCreate: false,
  serverSelectionTimeoutMS: 5_000,
  /** Identifica as operações do comando nos logs/profiler do servidor. */
  appName: "mariela-migracao-midias-legadas",
  /** Habilita os eventos de monitoramento de comandos do driver (sem ouvinte, não fazem nada). */
  monitorCommands: true,
} as const;

@Module({})
export class ComandoMigracaoMidiasModule {
  /** `aoConectar` recebe a conexão logo depois de aberta e ANTES de qualquer model ser compilado (instrumentação). */
  static paraUri(uri: string, aoConectar?: (conexao: Connection) => void): DynamicModule {
    return {
      module: ComandoMigracaoMidiasModule,
      imports: [
        MongooseModule.forRoot(uri, {
          ...OPCOES_DE_CONEXAO_DA_MIGRACAO,
          connectionFactory: (conexao: Connection) => {
            aoConectar?.(conexao);
            return conexao;
          },
        }),
        MongooseModule.forFeature([{ name: Produto.name, schema: ProdutoSchema }]),
      ],
      providers: [MigradorMidiasLegadas],
    };
  }
}
