import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import { normalizarCategoria, normalizarCor, normalizarFormaPagamento, normalizarTamanho } from "../produtos/utils/normalizacao.util.js";
import { ID_CONFIGURACAO_GLOBAL, type CampoLista } from "./configuracoes.constants.js";
import type { DadosLoja } from "./configuracoes.types.js";
import { Configuracao, type ConfiguracaoDocument } from "./schemas/configuracao.schema.js";

/**
 * As quatro listas com regra de unicidade case-insensitive (Fase 54.0 —
 * `cores`/`tamanhos`; Fase 55.1 — `categorias`; Fase 55.2 —
 * `formasPagamento`) — cada uma mapeia para seu campo-espelho normalizado
 * (ver `configuracao.schema.ts`) e a função de normalização já estabelecida
 * para o mesmo conceito em Produtos/Vendas (`Variante.corNormalizada`/
 * `Tamanho.tamanho`/`Produto.categoria`/`PagamentoVenda.forma`), nunca uma
 * regra nova e divergente.
 */
const CAMPOS_COM_NORMALIZACAO = {
  cores: { campoNormalizado: "coresNormalizadas", normalizar: normalizarCor },
  tamanhos: { campoNormalizado: "tamanhosNormalizados", normalizar: normalizarTamanho },
  categorias: { campoNormalizado: "categoriasNormalizadas", normalizar: normalizarCategoria },
  formasPagamento: { campoNormalizado: "formasPagamentoNormalizadas", normalizar: normalizarFormaPagamento },
} as const satisfies Partial<Record<CampoLista, { campoNormalizado: string; normalizar: (valor: string) => string }>>;

type CampoComNormalizacao = keyof typeof CAMPOS_COM_NORMALIZACAO;

function temNormalizacao(campo: CampoLista): campo is CampoComNormalizacao {
  return campo in CAMPOS_COM_NORMALIZACAO;
}

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
    const documento = await this.obter();

    if (temNormalizacao(campo)) {
      const { campoNormalizado, normalizar } = CAMPOS_COM_NORMALIZACAO[campo];
      const valorNormalizado = normalizar(valor);
      // Self-heal (idempotente, só ADITIVO via $addToSet — nunca sobrescreve
      // nem remove): cobre o documento singleton já existente em produção,
      // criado antes desta fase, cujo campo-espelho ainda não existe/está
      // incompleto para os itens já cadastrados.
      await this.sincronizarEspelhoNormalizado(documento, campo, campoNormalizado, normalizar);
      return this.configuracaoModel
        .findOneAndUpdate(
          { _id: ID_CONFIGURACAO_GLOBAL, [campoNormalizado]: { $ne: valorNormalizado } },
          { $push: { [campo]: valor, [campoNormalizado]: valorNormalizado } },
          { returnDocument: "after" },
        )
        .exec();
    }

    return this.configuracaoModel
      .findOneAndUpdate({ _id: ID_CONFIGURACAO_GLOBAL, [campo]: { $ne: valor } }, { $push: { [campo]: valor } }, { returnDocument: "after" })
      .exec();
  }

  /**
   * Garante que todo valor já presente em `campo` tem o correspondente
   * normalizado em `campoNormalizado` — sem isso, um documento singleton
   * criado antes da Fase 54.0 permitiria duplicata case-insensitive contra
   * itens antigos (o filtro `$ne` só enxerga o que já está no espelho).
   * `$addToSet`+`$each` é seguro sob concorrência: nunca remove, nunca
   * sobrescreve, e rodar duas vezes com os mesmos valores não cria duplicata
   * no próprio espelho.
   */
  private async sincronizarEspelhoNormalizado(
    documento: ConfiguracaoDocument,
    campo: CampoComNormalizacao,
    campoNormalizado: string,
    normalizar: (valor: string) => string,
  ): Promise<void> {
    const valores = documento[campo as keyof ConfiguracaoDocument] as unknown as string[];
    const jaPresentes = new Set(
      (documento[campoNormalizado as keyof ConfiguracaoDocument] as unknown as string[] | undefined) ?? [],
    );
    const faltantes = [...new Set(valores.map(normalizar))].filter((item) => !jaPresentes.has(item));
    if (faltantes.length === 0) return;
    await this.configuracaoModel
      .updateOne({ _id: ID_CONFIGURACAO_GLOBAL }, { $addToSet: { [campoNormalizado]: { $each: faltantes } } })
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
    const pull: Record<string, unknown> = { [campo]: valor };
    if (temNormalizacao(campo)) {
      const { campoNormalizado, normalizar } = CAMPOS_COM_NORMALIZACAO[campo];
      // Puxa do espelho também; se ainda não estava sincronizado para este
      // valor específico, o `$pull` desse campo simplesmente não casa nada
      // (no-op seguro) — nunca lança erro.
      pull[campoNormalizado] = normalizar(valor);
    }
    return this.configuracaoModel
      .findOneAndUpdate({ _id: ID_CONFIGURACAO_GLOBAL, [campo]: valor }, { $pull: pull }, { returnDocument: "after" })
      .exec();
  }
}
