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
  type ColecaoComAgregado,
  type SelecaoFacetas,
} from "./colecoes-filtros.util.js";
import {
  CHAVE_SEQUENCIA_COLECAO,
  DIGITOS_CODIGO_COLECAO,
  FACETAS_COLECAO,
  PREFIXO_CODIGO_COLECAO,
  VALORES_BANNER,
  VALORES_DESTAQUE,
  VALORES_PRODUTOS,
  VALORES_SITUACAO,
  type OrdenarColecaoPor,
  type Ordem,
} from "./colecoes.constants.js";
import { ColecoesRepository } from "./colecoes.repository.js";
import type { AlterarStatusColecaoDto } from "./dto/alterar-status-colecao.dto.js";
import type { AtualizarColecaoDto } from "./dto/atualizar-colecao.dto.js";
import type { CriarColecaoDto } from "./dto/criar-colecao.dto.js";
import type { ListarColecoesQueryDto } from "./dto/listar-colecoes-query.dto.js";
import { EventoColecao, type EventoColecaoDocument } from "./schemas/evento-colecao.schema.js";
import type { Colecao, ColecaoDocument } from "./schemas/colecao.schema.js";

/** Espelha `Colecao` do Backoffice (`src/types/colecao.ts`) — inclui o agregado de produtos. */
export interface ColecaoRespostaPublica {
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

export interface ResultadoListaColecoes {
  data: ColecaoRespostaPublica[];
  meta: ApiMeta;
  facets: ApiFacets;
}

@Injectable()
export class ColecoesService {
  constructor(
    private readonly colecoesRepository: ColecoesRepository,
    private readonly produtosRepository: ProdutosRepository,
    private readonly sequenciasService: SequenciasService,
    @InjectModel(EventoColecao.name) private readonly eventoModel: Model<EventoColecaoDocument>,
  ) {}

  async criar(dto: CriarColecaoDto, usuarioId: string | null): Promise<ColecaoRespostaPublica> {
    const { inicio, fim } = this.validarPeriodo(dto.inicio, dto.fim);
    const destaque = dto.destaque ?? false;
    const banner = dto.banner ?? false;

    const codigo = await this.sequenciasService.proximoCodigo(
      CHAVE_SEQUENCIA_COLECAO,
      PREFIXO_CODIGO_COLECAO,
      DIGITOS_CODIGO_COLECAO,
    );

    const colecao = await this.colecoesRepository.criar({
      codigo,
      nome: dto.nome.trim(),
      descricao: dto.descricao?.trim() ?? "",
      inicio,
      fim,
      ativo: dto.ativo ?? true,
      destaque,
      banner,
      // Imagem só faz sentido quando o respectivo uso está habilitado — mesma
      // regra já usada pelo mock (`cadastros.mock.ts#validarPeriodo`).
      fotoDestaque: destaque ? dto.fotoDestaque?.trim() || null : null,
      fotoBanner: banner ? dto.fotoBanner?.trim() || null : null,
      excluidoEm: null,
    });

    await this.registrarEvento(colecao.id, "colecao.criada", usuarioId, { codigo });
    return this.paraRespostaPublica(colecao, 0);
  }

  /**
   * Etapa 15.2 — mesmo padrão já aprovado em `ClientesService.listarTodosAtivos`/
   * `FornecedoresService.listarTodosAtivos` — `GET /colecoes` sem NENHUM
   * parâmetro espera de volta a base INTEIRA de coleções ativas, num array
   * simples, nunca truncada pelo `limit` padrão de `listar()`. Reusa
   * `ColecoesRepository.encontrarTodasAtivas()` e a MESMA função de
   * agregação (`construirMapaDeContagem`) já usada por `listar()` —
   * `produtosVinculados` continua calculado exatamente como hoje, nenhuma
   * regra duplicada.
   */
  async listarTodosAtivos(): Promise<ColecaoRespostaPublica[]> {
    const [colecoesAtivas, produtosAtivos] = await Promise.all([
      this.colecoesRepository.encontrarTodasAtivas(),
      this.produtosRepository.listarTodosAtivos(),
    ]);
    const contagemPorColecao = construirMapaDeContagem(produtosAtivos);
    return colecoesAtivas.map((documento) =>
      this.paraRespostaPublica(documento, contagemPorColecao.get(documento.id) ?? 0),
    );
  }

  async listar(query: ListarColecoesQueryDto): Promise<ResultadoListaColecoes> {
    const [colecoesAtivas, produtosAtivos] = await Promise.all([
      this.colecoesRepository.encontrarTodasAtivas(query.busca),
      this.produtosRepository.listarTodosAtivos(),
    ]);

    const contagemPorColecao = construirMapaDeContagem(produtosAtivos);
    const itens: ColecaoComAgregado[] = colecoesAtivas.map((documento) => ({
      documento: documento.toJSON() as unknown as Colecao & { id: string },
      produtosVinculados: contagemPorColecao.get(documento.id) ?? 0,
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

  async obterPorId(id: string): Promise<ColecaoRespostaPublica> {
    const colecao = await this.colecoesRepository.encontrarPorIdOuFalhar(id);
    const produtosVinculados = await this.contarVinculados(id);
    return this.paraRespostaPublica(colecao, produtosVinculados);
  }

  /** Produtos atualmente vinculados a esta coleção — usado pela tela de detalhe ("Gerenciar produtos"). */
  async listarProdutos(id: string): Promise<ProdutoDocument[]> {
    await this.colecoesRepository.encontrarPorIdOuFalhar(id);
    return this.produtosRepository.listarTodosAtivos({ colecaoId: id });
  }

  async atualizar(id: string, dto: AtualizarColecaoDto, usuarioId: string | null): Promise<ColecaoRespostaPublica> {
    const { inicio, fim } = this.validarPeriodo(dto.inicio, dto.fim);
    const destaque = dto.destaque ?? false;
    const banner = dto.banner ?? false;

    const colecao = await this.colecoesRepository.salvarComRetentativa(id, (documento) => {
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

    await this.registrarEvento(colecao.id, "colecao.atualizada", usuarioId, {});
    const produtosVinculados = await this.contarVinculados(id);
    return this.paraRespostaPublica(colecao, produtosVinculados);
  }

  async alterarStatus(id: string, dto: AlterarStatusColecaoDto, usuarioId: string | null): Promise<ColecaoRespostaPublica> {
    const colecao = await this.colecoesRepository.salvarComRetentativa(id, (documento) => {
      documento.ativo = dto.ativo;
    });
    await this.registrarEvento(colecao.id, dto.ativo ? "colecao.ativada" : "colecao.inativada", usuarioId, {});
    const produtosVinculados = await this.contarVinculados(id);
    return this.paraRespostaPublica(colecao, produtosVinculados);
  }

  /**
   * Coleções com produtos ATIVOS vinculados não podem ser excluídas — mesma
   * regra já aplicada pelo mock (`cadastros.mock.ts`) e replicada em
   * Fornecedores, agora contra dados reais.
   */
  async excluir(id: string, usuarioId: string | null): Promise<void> {
    const colecao = await this.colecoesRepository.encontrarPorIdOuFalhar(id);
    const vinculados = await this.produtosRepository.listarTodosAtivos({ colecaoId: id });
    if (vinculados.length > 0) {
      throw ApiException.validation("Coleção possui produtos vinculados.", [
        { field: "id", message: `${vinculados.length} produto(s) usam esta coleção.` },
      ]);
    }
    colecao.excluidoEm = new Date();
    await colecao.save();
    await this.registrarEvento(colecao.id, "colecao.excluida", usuarioId, {});
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

  private async contarVinculados(colecaoId: string): Promise<number> {
    const produtos = await this.produtosRepository.listarTodosAtivos({ colecaoId });
    return produtos.length;
  }

  private calcularFacets(itens: ColecaoComAgregado[], selecao: SelecaoFacetas, agora: Date): ApiFacets {
    const contarValores = (chave: keyof typeof FACETAS_COLECAO, valores: readonly string[]): { valor: string; count: number }[] => {
      const base = aplicarSelecao(itens, selecao, agora, FACETAS_COLECAO[chave]);
      return valores.map((valor) => ({
        valor,
        count: base.filter((item) => condicaoValor(FACETAS_COLECAO[chave], valor, item, agora)).length,
      }));
    };

    return {
      [FACETAS_COLECAO.situacao]: contarValores("situacao", VALORES_SITUACAO),
      [FACETAS_COLECAO.destaque]: contarValores("destaque", VALORES_DESTAQUE),
      [FACETAS_COLECAO.banner]: contarValores("banner", VALORES_BANNER),
      [FACETAS_COLECAO.produtos]: contarValores("produtos", VALORES_PRODUTOS),
    };
  }

  private paraRespostaPublica(colecao: ColecaoDocument, produtosVinculados: number): ColecaoRespostaPublica {
    const json = colecao.toJSON() as unknown as Omit<ColecaoRespostaPublica, "produtosVinculados">;
    return { ...json, produtosVinculados };
  }

  private async registrarEvento(
    colecaoId: string | Types.ObjectId,
    tipo: string,
    usuarioId: string | null,
    detalhes: Record<string, unknown>,
  ): Promise<void> {
    await this.eventoModel.create({ colecaoId, tipo, usuarioId, detalhes });
  }
}

function construirMapaDeContagem(produtos: ProdutoDocument[]): Map<string, number> {
  const contagem = new Map<string, number>();
  for (const produto of produtos) {
    if (!produto.colecaoId) continue;
    contagem.set(produto.colecaoId, (contagem.get(produto.colecaoId) ?? 0) + 1);
  }
  return contagem;
}

function ordenarItens(itens: ColecaoComAgregado[], campo: OrdenarColecaoPor, ordem: Ordem): ColecaoComAgregado[] {
  const fator = ordem === "desc" ? -1 : 1;
  const porNome = (a: ColecaoComAgregado, b: ColecaoComAgregado) => a.documento.nome.localeCompare(b.documento.nome, "pt-BR");

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
