import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import { ID_CONFIGURACAO_GLOBAL, type CampoLista } from "./configuracoes.constants.js";
import type { DadosLoja } from "./configuracoes.types.js";
import { Configuracao, type ConfiguracaoDocument } from "./schemas/configuracao.schema.js";

@Injectable()
export class ConfiguracoesRepository {
  constructor(@InjectModel(Configuracao.name) private readonly configuracaoModel: Model<ConfiguracaoDocument>) {}

  /**
   * Devolve o documento singleton, criando-o com os defaults do schema na
   * PRIMEIRA chamada de todo o sistema — `findOneAndUpdate` com `upsert` e um
   * `_id` fixo é uma única operação atômica no MongoDB (nunca duas leituras +
   * uma escrita): mesmo sob concorrência real (duas requisições simultâneas
   * batendo em `GET /configuracoes` antes de o documento existir), o próprio
   * MongoDB serializa as duas tentativas de upsert no mesmo `_id` — só uma
   * cria, a outra apenas lê o que a primeira criou. Nunca lança erro de chave
   * duplicada (ao contrário de um `create()` ingênuo).
   */
  async obter(): Promise<ConfiguracaoDocument> {
    const documento = await this.configuracaoModel
      .findOneAndUpdate(
        { _id: ID_CONFIGURACAO_GLOBAL },
        { $setOnInsert: { _id: ID_CONFIGURACAO_GLOBAL } },
        { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
      )
      .exec();
    return documento!;
  }

  /**
   * Substitui `loja` por inteiro (contrato: `PUT /configuracoes/loja` recebe
   * `DadosLoja` completo, nunca um patch parcial). `upsert: true` aqui é
   * seguro (ao contrário de `adicionarItemLista`/`removerItemLista` abaixo)
   * porque o filtro é só `{_id}`, sem nenhuma condição extra que possa falhar
   * contra um documento já existente — nunca há risco de tentar inserir um
   * segundo documento com o mesmo `_id`.
   */
  async atualizarLoja(loja: DadosLoja): Promise<ConfiguracaoDocument> {
    const documento = await this.configuracaoModel
      .findOneAndUpdate(
        { _id: ID_CONFIGURACAO_GLOBAL },
        { $set: { loja } },
        { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
      )
      .exec();
    return documento!;
  }

  /**
   * Adiciona `valor` à lista `campo` de forma ATÔMICA — nunca lê o array
   * inteiro em memória para depois salvar de volta (isso teria uma janela de
   * "lost update" sob duas adições concorrentes). O filtro
   * `{ [campo]: { $ne: valor } }` combinado com `$push` é uma única operação
   * Mongo: só encontra e modifica o documento se `valor` AINDA não estiver na
   * lista — duas chamadas concorrentes adicionando o MESMO valor nunca
   * resultam em duas entradas (o MongoDB serializa escritas no mesmo
   * documento). Devolve `null` quando `valor` já existia (o service traduz
   * isso em conflito).
   *
   * Deliberadamente SEM `upsert` aqui: a chamada a `obter()` acima já assegura que
   * o singleton existe ANTES desta chamada. Combinar `upsert: true` com um
   * filtro que inclui a condição `$ne` seria perigoso — se o documento já
   * existe mas `valor` JÁ está na lista, o filtro não bate no documento
   * existente, e `upsert` tentaria inserir um SEGUNDO documento com o mesmo
   * `_id`, causando um erro de chave duplicada em vez do "já existe" que o
   * chamador espera.
   */
  async adicionarItemLista(campo: CampoLista, valor: string): Promise<ConfiguracaoDocument | null> {
    await this.obter();
    return this.configuracaoModel
      .findOneAndUpdate({ _id: ID_CONFIGURACAO_GLOBAL, [campo]: { $ne: valor } }, { $push: { [campo]: valor } }, { returnDocument: "after" })
      .exec();
  }

  /**
   * Remove `valor` da lista `campo` de forma atômica — mesma técnica de
   * `adicionarItemLista`, espelhada: o filtro exige que `valor` ESTEJA na
   * lista para que `$pull` rode; devolve `null` quando não estava (o service
   * traduz isso em "não encontrado"). Mesmo motivo para não usar `upsert`.
   */
  async removerItemLista(campo: CampoLista, valor: string): Promise<ConfiguracaoDocument | null> {
    await this.obter();
    return this.configuracaoModel
      .findOneAndUpdate({ _id: ID_CONFIGURACAO_GLOBAL, [campo]: valor }, { $pull: { [campo]: valor } }, { returnDocument: "after" })
      .exec();
  }
}
