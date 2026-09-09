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

  /**
   * `FornecedoresService.criar` já checa telefone duplicado ANTES de chamar
   * isto (defesa primária, mensagem de erro melhor). Este `catch` é só a
   * rede de segurança para a corrida rara entre essa checagem e a gravação
   * (duas criações simultâneas com o mesmo telefone) — quem perde a corrida
   * esbarra no índice único parcial de `telefoneNormalizado` (`erro 11000`)
   * e, sem isto, receberia um 500 cru em vez do 409 já usado pelo resto do
   * domínio para este mesmo caso (Etapa 14.2, mesmo padrão de
   * `ClientesRepository.criar`). Nunca mascara outro tipo de erro: só
   * traduz especificamente a colisão desse índice.
   */
  async criar(dados: DadosCriarFornecedor): Promise<FornecedorDocument> {
    try {
      return await this.fornecedorModel.create(dados);
    } catch (erro) {
      if (this.ehErroDeTelefoneDuplicado(erro)) {
        throw ApiException.conflict("Já existe um fornecedor cadastrado com este telefone.");
      }
      throw erro;
    }
  }

  private ehErroDeTelefoneDuplicado(erro: unknown): boolean {
    if (typeof erro !== "object" || erro === null || !("code" in erro) || (erro as { code: unknown }).code !== 11000) {
      return false;
    }
    const keyPattern = (erro as { keyPattern?: Record<string, unknown> }).keyPattern;
    if (keyPattern) return "telefoneNormalizado" in keyPattern;
    const mensagem = String((erro as { message?: unknown }).message ?? "");
    return mensagem.includes("telefoneNormalizado");
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
