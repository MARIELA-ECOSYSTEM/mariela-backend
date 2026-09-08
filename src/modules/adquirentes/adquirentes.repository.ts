import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Error as MongooseErrors, isValidObjectId, type Model } from "mongoose";
import { ApiException } from "../../common/exceptions/api.exception.js";
import { Adquirente, type AdquirenteDocument } from "./schemas/adquirente.schema.js";
import type { DadosCriarAdquirente } from "./adquirentes.types.js";

export interface ListaAdquirentesResultado {
  itens: AdquirenteDocument[];
  total: number;
}

@Injectable()
export class AdquirentesRepository {
  constructor(@InjectModel(Adquirente.name) private readonly adquirenteModel: Model<AdquirenteDocument>) {}

  async criar(dados: DadosCriarAdquirente): Promise<AdquirenteDocument> {
    return this.adquirenteModel.create(dados);
  }

  async encontrarPorId(id: string): Promise<AdquirenteDocument | null> {
    if (!isValidObjectId(id)) return null;
    return this.adquirenteModel.findOne({ _id: id, excluidoEm: null }).exec();
  }

  async encontrarPorIdOuFalhar(id: string): Promise<AdquirenteDocument> {
    const adquirente = await this.encontrarPorId(id);
    if (!adquirente) throw ApiException.notFound("Adquirente não encontrada.");
    return adquirente;
  }

  /** Base da checagem de nome duplicado (case-insensitive) — ignora o próprio registro em atualizações. */
  async encontrarPorNomeNormalizado(nomeNormalizado: string, ignorarId?: string): Promise<AdquirenteDocument | null> {
    const filtro: Record<string, unknown> = { nomeNormalizado, excluidoEm: null };
    if (ignorarId) filtro["_id"] = { $ne: ignorarId };
    return this.adquirenteModel.findOne(filtro).exec();
  }

  /** Só adquirentes ATIVAS (nunca excluídas), busca por nome e paginação — tudo resolvido no Mongo (sem agregado cruzando outra collection, ao contrário de Fornecedores). */
  async listarAtivas(busca: string | undefined, page: number, limit: number): Promise<ListaAdquirentesResultado> {
    const filtro: Record<string, unknown> = { excluidoEm: null };
    const termo = busca?.trim();
    if (termo) {
      const regex = new RegExp(termo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filtro["nome"] = regex;
    }

    const [itens, total] = await Promise.all([
      this.adquirenteModel
        .find(filtro)
        .sort({ nome: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.adquirenteModel.countDocuments(filtro).exec(),
    ]);

    return { itens, total };
  }

  /**
   * Mesmo padrão de concorrência de Produtos/Clientes/Fornecedores/Coleções:
   * aplica `mutar` e salva com o versionamento otimista do Mongoose (`__v`);
   * se outra requisição alterou o documento entre a leitura e a gravação,
   * `save()` rejeita com `VersionError` e a operação é refeita do zero.
   */
  async salvarComRetentativa(id: string, mutar: (adquirente: AdquirenteDocument) => void, tentativas = 3): Promise<AdquirenteDocument> {
    for (let tentativa = 1; tentativa <= tentativas; tentativa += 1) {
      const adquirente = await this.encontrarPorIdOuFalhar(id);
      mutar(adquirente);
      try {
        return await adquirente.save();
      } catch (erro) {
        if (!(erro instanceof MongooseErrors.VersionError) || tentativa === tentativas) throw erro;
      }
    }
    // Inatingível: o loop sempre retorna ou lança na última tentativa.
    throw ApiException.conflict(
      "Não foi possível salvar as alterações: a adquirente foi modificada por outra operação simultânea. Tente novamente.",
    );
  }
}
