import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Error as MongooseErrors, isValidObjectId, type Model } from "mongoose";
import { ApiException } from "../../common/exceptions/api.exception.js";
import { filtroSempreAtivo } from "./colecoes-filtros.util.js";
import type { DadosCriarColecao } from "./colecoes.types.js";
import { Colecao, type ColecaoDocument } from "./schemas/colecao.schema.js";

@Injectable()
export class ColecoesRepository {
  constructor(@InjectModel(Colecao.name) private readonly colecaoModel: Model<ColecaoDocument>) {}

  async criar(dados: DadosCriarColecao): Promise<ColecaoDocument> {
    return this.colecaoModel.create(dados);
  }

  async encontrarPorId(id: string): Promise<ColecaoDocument | null> {
    if (!isValidObjectId(id)) return null;
    return this.colecaoModel.findOne({ _id: id, excluidoEm: null }).exec();
  }

  async encontrarPorIdOuFalhar(id: string): Promise<ColecaoDocument> {
    const colecao = await this.encontrarPorId(id);
    if (!colecao) throw ApiException.notFound("Coleção não encontrada.");
    return colecao;
  }

  /**
   * Todas as coleções ativas que satisfazem `busca` — SEM paginação/
   * ordenação, aplicadas depois em memória (ver `colecoes-filtros.util.ts`
   * para a justificativa: `situacao`/`produtos` dependem de agregados/data
   * atual, não de campos indexáveis diretamente).
   */
  async encontrarTodasAtivas(busca?: string): Promise<ColecaoDocument[]> {
    return this.colecaoModel.find(filtroSempreAtivo(busca)).exec();
  }

  /**
   * Mesmo padrão de concorrência de Produtos/Clientes/Fornecedores: aplica
   * `mutar` e salva com o versionamento otimista do Mongoose (`__v`); se
   * outra requisição alterou o documento entre a leitura e a gravação,
   * `save()` rejeita com `VersionError` e a operação é refeita do zero.
   */
  async salvarComRetentativa(id: string, mutar: (colecao: ColecaoDocument) => void, tentativas = 3): Promise<ColecaoDocument> {
    for (let tentativa = 1; tentativa <= tentativas; tentativa += 1) {
      const colecao = await this.encontrarPorIdOuFalhar(id);
      mutar(colecao);
      try {
        return await colecao.save();
      } catch (erro) {
        if (!(erro instanceof MongooseErrors.VersionError) || tentativa === tentativas) throw erro;
      }
    }
    // Inatingível: o loop sempre retorna ou lança na última tentativa.
    throw ApiException.conflict(
      "Não foi possível salvar as alterações: a coleção foi modificada por outra operação simultânea. Tente novamente.",
    );
  }
}
