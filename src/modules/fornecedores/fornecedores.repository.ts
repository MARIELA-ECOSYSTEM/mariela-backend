import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Error as MongooseErrors, isValidObjectId, type Model } from "mongoose";
import { ApiException } from "../../common/exceptions/api.exception.js";
import { filtroSempreAtivo } from "./fornecedores-filtros.util.js";
import type { DadosCriarFornecedor } from "./fornecedores.types.js";
import { Fornecedor, type FornecedorDocument } from "./schemas/fornecedor.schema.js";

@Injectable()
export class FornecedoresRepository {
  constructor(@InjectModel(Fornecedor.name) private readonly fornecedorModel: Model<FornecedorDocument>) {}

  async criar(dados: DadosCriarFornecedor): Promise<FornecedorDocument> {
    return this.fornecedorModel.create(dados);
  }

  async encontrarPorId(id: string): Promise<FornecedorDocument | null> {
    if (!isValidObjectId(id)) return null;
    return this.fornecedorModel.findOne({ _id: id, excluidoEm: null }).exec();
  }

  async encontrarPorIdOuFalhar(id: string): Promise<FornecedorDocument> {
    const fornecedor = await this.encontrarPorId(id);
    if (!fornecedor) throw ApiException.notFound("Fornecedor não encontrado.");
    return fornecedor;
  }

  /** Base da checagem de telefone duplicado — ignora o próprio registro em atualizações. */
  async encontrarPorTelefoneNormalizado(telefoneNormalizado: string, ignorarId?: string): Promise<FornecedorDocument | null> {
    const filtro: Record<string, unknown> = { telefoneNormalizado, excluidoEm: null };
    if (ignorarId) filtro["_id"] = { $ne: ignorarId };
    return this.fornecedorModel.findOne(filtro).exec();
  }

  /**
   * Todos os fornecedores ativos que satisfazem `busca` — SEM paginação/
   * ordenação, aplicadas depois em memória (ver `fornecedores-filtros.util.ts`
   * para a justificativa: filtros/ordenação dependem de agregados que não são
   * campos deste schema).
   */
  async encontrarTodosAtivos(busca?: string): Promise<FornecedorDocument[]> {
    return this.fornecedorModel.find(filtroSempreAtivo(busca)).exec();
  }

  /**
   * Mesmo padrão de concorrência de Produtos/Clientes: aplica `mutar` e salva
   * com o versionamento otimista do Mongoose (`__v`); se outra requisição
   * alterou o documento entre a leitura e a gravação, `save()` rejeita com
   * `VersionError` e a operação é refeita do zero.
   */
  async salvarComRetentativa(id: string, mutar: (fornecedor: FornecedorDocument) => void, tentativas = 3): Promise<FornecedorDocument> {
    for (let tentativa = 1; tentativa <= tentativas; tentativa += 1) {
      const fornecedor = await this.encontrarPorIdOuFalhar(id);
      mutar(fornecedor);
      try {
        return await fornecedor.save();
      } catch (erro) {
        if (!(erro instanceof MongooseErrors.VersionError) || tentativa === tentativas) throw erro;
      }
    }
    // Inatingível: o loop sempre retorna ou lança na última tentativa.
    throw ApiException.conflict(
      "Não foi possível salvar as alterações: o fornecedor foi modificado por outra operação simultânea. Tente novamente.",
    );
  }
}
