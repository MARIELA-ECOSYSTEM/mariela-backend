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

  /**
   * `AdquirentesService.criar` já checa nome duplicado ANTES de chamar isto
   * (defesa primária, mensagem de erro melhor). Este `catch` é só a rede de
   * segurança para a corrida rara entre essa checagem e a gravação (duas
   * criações simultâneas com o mesmo nome) — quem perde a corrida esbarra no
   * índice único parcial de `nomeNormalizado` (erro 11000) e, sem isto,
   * receberia um 500 cru em vez do 409 já usado pelo resto do domínio para
   * este mesmo caso (Etapa 18.19, mesmo padrão de
   * `ClientesRepository.criar`/`FornecedoresRepository.criar`/`VendedoresRepository.criar`).
   */
  async criar(dados: DadosCriarAdquirente): Promise<AdquirenteDocument> {
    try {
      return await this.adquirenteModel.create(dados);
    } catch (erro) {
      if (this.ehErroDeNomeDuplicado(erro)) {
        throw ApiException.conflict("Já existe uma adquirente cadastrada com este nome.");
      }
      throw erro;
    }
  }

  private ehErroDeNomeDuplicado(erro: unknown): boolean {
    if (typeof erro !== "object" || erro === null || !("code" in erro) || (erro as { code: unknown }).code !== 11000) {
      return false;
    }
    const keyPattern = (erro as { keyPattern?: Record<string, unknown> }).keyPattern;
    if (keyPattern) return "nomeNormalizado" in keyPattern;
    const mensagem = String((erro as { message?: unknown }).message ?? "");
    return mensagem.includes("nomeNormalizado");
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
   *
   * Etapa 18.19 — além do `VersionError`, este `save()` também pode colidir
   * com o índice único parcial de `nomeNormalizado` (duas adquirentes
   * DIFERENTES atualizadas concorrentemente para o mesmo nome novo — a
   * pré-checagem de `AdquirentesService.garantirNomeDisponivel` não fecha essa
   * janela sozinha, mesma corrida já corrigida em `criar()` acima e em
   * `ClientesRepository`/`FornecedoresRepository`/`VendedoresRepository.salvarComRetentativa`).
   */
  async salvarComRetentativa(id: string, mutar: (adquirente: AdquirenteDocument) => void, tentativas = 3): Promise<AdquirenteDocument> {
    for (let tentativa = 1; tentativa <= tentativas; tentativa += 1) {
      const adquirente = await this.encontrarPorIdOuFalhar(id);
      mutar(adquirente);
      try {
        return await adquirente.save();
      } catch (erro) {
        if (this.ehErroDeNomeDuplicado(erro)) {
          throw ApiException.conflict("Já existe uma adquirente cadastrada com este nome.");
        }
        if (!(erro instanceof MongooseErrors.VersionError) || tentativa === tentativas) throw erro;
      }
    }
    // Inatingível: o loop sempre retorna ou lança na última tentativa.
    throw ApiException.conflict(
      "Não foi possível salvar as alterações: a adquirente foi modificada por outra operação simultânea. Tente novamente.",
    );
  }
}
