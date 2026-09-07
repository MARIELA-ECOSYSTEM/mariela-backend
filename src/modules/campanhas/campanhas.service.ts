import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model, Types } from "mongoose";
import { ApiException } from "../../common/exceptions/api.exception.js";
import type { ApiFacets, ApiMeta } from "../../common/types/api-response.interface.js";
import { ProdutosRepository } from "../produtos/produtos.repository.js";
import type { ProdutoDocument } from "../produtos/schemas/produto.schema.js";
import { SequenciasService } from "../sequencias/sequencias.service.js";
import {
  aplicarSelecao,
  condicaoValor,
  type CampanhaComAgregado,
  type SelecaoFacetas,
} from "./campanhas-filtros.util.js";
import {
  CHAVE_SEQUENCIA_CAMPANHA,
  DIGITOS_CODIGO_CAMPANHA,
  FACETAS_CAMPANHA,
  PREFIXO_CODIGO_CAMPANHA,
  VALORES_BANNER,
  VALORES_DESTAQUE,
  VALORES_PRODUTOS,
  VALORES_SITUACAO,
  type OrdenarCampanhaPor,
  type Ordem,
} from "./campanhas.constants.js";
import { CampanhasRepository } from "./campanhas.repository.js";
import type { AlterarStatusCampanhaDto } from "./dto/alterar-status-campanha.dto.js";
import type { AtualizarCampanhaDto } from "./dto/atualizar-campanha.dto.js";
import type { CriarCampanhaDto } from "./dto/criar-campanha.dto.js";
import type { ListarCampanhasQueryDto } from "./dto/listar-campanhas-query.dto.js";
import { EventoCampanha, type EventoCampanhaDocument } from "./schemas/evento-campanha.schema.js";
import type { Campanha, CampanhaDocument } from "./schemas/campanha.schema.js";

/** Espelha `Campanha` do Backoffice (`src/types/campanha.ts`) — inclui o agregado de produtos. */
export interface CampanhaRespostaPublica {
  id: string;
  codigo: string;
  nome: string;
  descricao: string;
  inicio: Date;
  fim: Date;
  ativo: boolean;
  destaque: boolean;
  banner: boolean;
  fotoDestaque: string | null;
  fotoBanner: string | null;
  criadoEm: Date;
  atualizadoEm: Date;
  produtosVinculados: number;
}

export interface ResultadoListaCampanhas {
  data: CampanhaRespostaPublica[];
  meta: ApiMeta;
  facets: ApiFacets;
}

@Injectable()
export class CampanhasService {
  constructor(
    private readonly campanhasRepository: CampanhasRepository,
    private readonly produtosRepository: ProdutosRepository,
    private readonly sequenciasService: SequenciasService,
    @InjectModel(EventoCampanha.name) private readonly eventoModel: Model<EventoCampanhaDocument>,
  ) {}

  async criar(dto: CriarCampanhaDto, usuarioId: string | null): Promise<CampanhaRespostaPublica> {
    const { inicio, fim } = this.validarPeriodo(dto.inicio, dto.fim);
    const destaque = dto.destaque ?? false;
    const banner = dto.banner ?? false;

    const codigo = await this.sequenciasService.proximoCodigo(
      CHAVE_SEQUENCIA_CAMPANHA,
      PREFIXO_CODIGO_CAMPANHA,
      DIGITOS_CODIGO_CAMPANHA,
    );

    const campanha = await this.campanhasRepository.criar({
      codigo,
      nome: dto.nome.trim(),
      descricao: dto.descricao?.trim() ?? "",
      inicio,
      fim,
      ativo: dto.ativo ?? true,
      destaque,
      banner,
      // Imagem só faz sentido quando o respectivo uso está habilitado — mesma
      // regra já usada pelo mock (`cadastros.mock.ts#validarPeriodo`) e em Coleções.
      fotoDestaque: destaque ? dto.fotoDestaque?.trim() || null : null,
      fotoBanner: banner ? dto.fotoBanner?.trim() || null : null,
      excluidoEm: null,
    });

    await this.registrarEvento(campanha.id, "campanha.criada", usuarioId, { codigo });
    return this.paraRespostaPublica(campanha, 0);
  }

  async listar(query: ListarCampanhasQueryDto): Promise<ResultadoListaCampanhas> {
    const [campanhasAtivas, produtosAtivos] = await Promise.all([
      this.campanhasRepository.encontrarTodasAtivas(query.busca),
      this.produtosRepository.listarTodosAtivos(),
    ]);

    const contagemPorCampanha = construirMapaDeContagem(produtosAtivos);
    const itens: CampanhaComAgregado[] = campanhasAtivas.map((documento) => ({
      documento: documento.toJSON() as unknown as Campanha & { id: string },
      produtosVinculados: contagemPorCampanha.get(documento.id) ?? 0,
    }));

    const selecao: SelecaoFacetas = {
      situacao: query.situacao,
      destaque: query.destaque,
      banner: query.banner,
      produtos: query.produtos,
    };

    const agora = new Date();
    const facets = this.calcularFacets(itens, selecao, agora);
    const filtrados = aplicarSelecao(itens, selecao, agora);
    const ordenados = ordenarItens(filtrados, query.ordenarPor, query.ordem);

    const total = ordenados.length;
    const totalPages = Math.max(1, Math.ceil(total / query.limit));
    const inicio = (query.page - 1) * query.limit;
    const pagina = ordenados.slice(inicio, inicio + query.limit);

    return {
      data: pagina.map((item) => ({ ...item.documento, produtosVinculados: item.produtosVinculados })),
      meta: { total, page: query.page, limit: query.limit, totalPages },
      facets,
    };
  }

  async obterPorId(id: string): Promise<CampanhaRespostaPublica> {
    const campanha = await this.campanhasRepository.encontrarPorIdOuFalhar(id);
    const produtosVinculados = await this.contarVinculados(id);
    return this.paraRespostaPublica(campanha, produtosVinculados);
  }

  /** Produtos atualmente vinculados a esta campanha — usado pela tela de detalhe ("Gerenciar produtos"). */
  async listarProdutos(id: string): Promise<ProdutoDocument[]> {
    await this.campanhasRepository.encontrarPorIdOuFalhar(id);
    return this.produtosRepository.listarTodosAtivos({ campanhaId: id });
  }

  async atualizar(id: string, dto: AtualizarCampanhaDto, usuarioId: string | null): Promise<CampanhaRespostaPublica> {
    const { inicio, fim } = this.validarPeriodo(dto.inicio, dto.fim);
    const destaque = dto.destaque ?? false;
    const banner = dto.banner ?? false;

    const campanha = await this.campanhasRepository.salvarComRetentativa(id, (documento) => {
      documento.nome = dto.nome.trim();
      documento.descricao = dto.descricao?.trim() ?? "";
      documento.inicio = inicio;
      documento.fim = fim;
      documento.ativo = dto.ativo ?? true;
      documento.destaque = destaque;
      documento.banner = banner;
      documento.fotoDestaque = destaque ? dto.fotoDestaque?.trim() || null : null;
      documento.fotoBanner = banner ? dto.fotoBanner?.trim() || null : null;
    });

    await this.registrarEvento(campanha.id, "campanha.atualizada", usuarioId, {});
    const produtosVinculados = await this.contarVinculados(id);
    return this.paraRespostaPublica(campanha, produtosVinculados);
  }

  async alterarStatus(id: string, dto: AlterarStatusCampanhaDto, usuarioId: string | null): Promise<CampanhaRespostaPublica> {
    const campanha = await this.campanhasRepository.salvarComRetentativa(id, (documento) => {
      documento.ativo = dto.ativo;
    });
    await this.registrarEvento(campanha.id, dto.ativo ? "campanha.ativada" : "campanha.inativada", usuarioId, {});
    const produtosVinculados = await this.contarVinculados(id);
    return this.paraRespostaPublica(campanha, produtosVinculados);
  }

  /**
   * Campanhas com produtos ATIVOS vinculados não podem ser excluídas — mesma
   * regra já aplicada pelo mock (`cadastros.mock.ts`) e replicada em
   * Fornecedores/Coleções, agora contra dados reais.
   */
  async excluir(id: string, usuarioId: string | null): Promise<void> {
    const campanha = await this.campanhasRepository.encontrarPorIdOuFalhar(id);
    const vinculados = await this.produtosRepository.listarTodosAtivos({ campanhaId: id });
    if (vinculados.length > 0) {
      throw ApiException.validation("Campanha possui produtos vinculados.", [
        { field: "id", message: `${vinculados.length} produto(s) usam esta campanha.` },
      ]);
    }
    campanha.excluidoEm = new Date();
    await campanha.save();
    await this.registrarEvento(campanha.id, "campanha.excluida", usuarioId, {});
  }

  /** `fim` precisa ser maior ou igual a `inicio` — regra cruzando dois campos, validada aqui (não no DTO). */
  private validarPeriodo(inicioIso: string, fimIso: string): { inicio: Date; fim: Date } {
    const inicio = new Date(inicioIso);
    const fim = new Date(fimIso);
    if (fim < inicio) {
      throw ApiException.validation("Dados inválidos.", [
        { field: "fim", message: "A data de fim deve ser posterior ao início." },
      ]);
    }
    return { inicio, fim };
  }

  private async contarVinculados(campanhaId: string): Promise<number> {
    const produtos = await this.produtosRepository.listarTodosAtivos({ campanhaId });
    return produtos.length;
  }

  private calcularFacets(itens: CampanhaComAgregado[], selecao: SelecaoFacetas, agora: Date): ApiFacets {
    const contarValores = (chave: keyof typeof FACETAS_CAMPANHA, valores: readonly string[]): { valor: string; count: number }[] => {
      const base = aplicarSelecao(itens, selecao, agora, FACETAS_CAMPANHA[chave]);
      return valores.map((valor) => ({
        valor,
        count: base.filter((item) => condicaoValor(FACETAS_CAMPANHA[chave], valor, item, agora)).length,
      }));
    };

    return {
      [FACETAS_CAMPANHA.situacao]: contarValores("situacao", VALORES_SITUACAO),
      [FACETAS_CAMPANHA.destaque]: contarValores("destaque", VALORES_DESTAQUE),
      [FACETAS_CAMPANHA.banner]: contarValores("banner", VALORES_BANNER),
      [FACETAS_CAMPANHA.produtos]: contarValores("produtos", VALORES_PRODUTOS),
    };
  }

  private paraRespostaPublica(campanha: CampanhaDocument, produtosVinculados: number): CampanhaRespostaPublica {
    const json = campanha.toJSON() as unknown as Omit<CampanhaRespostaPublica, "produtosVinculados">;
    return { ...json, produtosVinculados };
  }

  private async registrarEvento(
    campanhaId: string | Types.ObjectId,
    tipo: string,
    usuarioId: string | null,
    detalhes: Record<string, unknown>,
  ): Promise<void> {
    await this.eventoModel.create({ campanhaId, tipo, usuarioId, detalhes });
  }
}

function construirMapaDeContagem(produtos: ProdutoDocument[]): Map<string, number> {
  const contagem = new Map<string, number>();
  for (const produto of produtos) {
    if (!produto.campanhaId) continue;
    contagem.set(produto.campanhaId, (contagem.get(produto.campanhaId) ?? 0) + 1);
  }
  return contagem;
}

function ordenarItens(itens: CampanhaComAgregado[], campo: OrdenarCampanhaPor, ordem: Ordem): CampanhaComAgregado[] {
  const fator = ordem === "desc" ? -1 : 1;
  const porNome = (a: CampanhaComAgregado, b: CampanhaComAgregado) => a.documento.nome.localeCompare(b.documento.nome, "pt-BR");

  return [...itens].sort((a, b) => {
    switch (campo) {
      case "inicio":
        return (new Date(a.documento.inicio).getTime() - new Date(b.documento.inicio).getTime()) * fator || porNome(a, b);
      case "fim":
        return (new Date(a.documento.fim).getTime() - new Date(b.documento.fim).getTime()) * fator || porNome(a, b);
      case "criadoEm":
        return (new Date(a.documento.criadoEm).getTime() - new Date(b.documento.criadoEm).getTime()) * fator || porNome(a, b);
      default:
        return porNome(a, b) * fator;
    }
  });
}
