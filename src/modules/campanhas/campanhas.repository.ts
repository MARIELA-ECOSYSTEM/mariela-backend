import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Error as MongooseErrors, isValidObjectId, type Model } from "mongoose";
import { ApiException } from "../../common/exceptions/api.exception.js";
import { filtroSempreAtivo } from "./campanhas-filtros.util.js";
import type { DadosCriarCampanha } from "./campanhas.types.js";
import { Campanha, type CampanhaDocument } from "./schemas/campanha.schema.js";

@Injectable()
export class CampanhasRepository {
  constructor(@InjectModel(Campanha.name) private readonly campanhaModel: Model<CampanhaDocument>) {}

  async criar(dados: DadosCriarCampanha): Promise<CampanhaDocument> {
    return this.campanhaModel.create(dados);
  }

  async encontrarPorId(id: string): Promise<CampanhaDocument | null> {
    if (!isValidObjectId(id)) return null;
    return this.campanhaModel.findOne({ _id: id, excluidoEm: null }).exec();
  }

  async encontrarPorIdOuFalhar(id: string): Promise<CampanhaDocument> {
    const campanha = await this.encontrarPorId(id);
    if (!campanha) throw ApiException.notFound("Campanha não encontrada.");
    return campanha;
  }

  /**
   * Todas as campanhas ativas que satisfazem `busca` — SEM paginação/
   * ordenação, aplicadas depois em memória (ver `campanhas-filtros.util.ts`
   * para a justificativa: `situacao`/`produtos` dependem de agregados/data
   * atual, não de campos indexáveis diretamente).
   */
  async encontrarTodasAtivas(busca?: string): Promise<CampanhaDocument[]> {
    return this.campanhaModel.find(filtroSempreAtivo(busca)).exec();
  }

  /**
   * Mesmo padrão de concorrência de Produtos/Clientes/Fornecedores/Coleções:
   * aplica `mutar` e salva com o versionamento otimista do Mongoose (`__v`);
   * se outra requisição alterou o documento entre a leitura e a gravação,
   * `save()` rejeita com `VersionError` e a operação é refeita do zero.
   */
  async salvarComRetentativa(id: string, mutar: (campanha: CampanhaDocument) => void, tentativas = 3): Promise<CampanhaDocument> {
    for (let tentativa = 1; tentativa <= tentativas; tentativa += 1) {
      const campanha = await this.encontrarPorIdOuFalhar(id);
      mutar(campanha);
      try {
        return await campanha.save();
      } catch (erro) {
        if (!(erro instanceof MongooseErrors.VersionError) || tentativa === tentativas) throw erro;
      }
    }
    // Inatingível: o loop sempre retorna ou lança na última tentativa.
    throw ApiException.conflict(
      "Não foi possível salvar as alterações: a campanha foi modificada por outra operação simultânea. Tente novamente.",
    );
  }
}
