import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import { ProdutosRepository } from "../produtos/produtos.repository.js";
import { ProdutosService } from "../produtos/produtos.service.js";
import type { ProdutoDocument } from "../produtos/schemas/produto.schema.js";
import type { EntradaEstoqueDto } from "./dto/entrada-estoque.dto.js";
import type { ListarEstoqueQueryDto } from "./dto/listar-estoque-query.dto.js";
import type { SaidaEstoqueDto } from "./dto/saida-estoque.dto.js";
import { MovimentacaoEstoque, type MovimentacaoEstoqueDocument } from "./schemas/movimentacao-estoque.schema.js";

/** Espelha `ResumoEstoqueProduto` (`src/types/estoque.ts`) — a tela de Estoque não vê o produto inteiro. */
export interface ResumoEstoqueProduto {
  produtoId: string;
  codProduto: string;
  nome: string;
  categoria: string;
  foto: string | null;
  fotos: string[];
  cores: {
    varianteId: string;
    cor: string;
    quantidade: number;
    tamanhos: { id: string; tamanho: string; quantidade: number }[];
  }[];
  colecaoId: string | null;
  campanhaId: string | null;
  quantidadeTotal: number;
  totalVariantes: number;
  estoqueZeradoEm: string | null;
}

@Injectable()
export class EstoqueService {
  constructor(
    private readonly produtosService: ProdutosService,
    private readonly produtosRepository: ProdutosRepository,
    @InjectModel(MovimentacaoEstoque.name) private readonly movimentacaoModel: Model<MovimentacaoEstoqueDocument>,
  ) {}

  async listar(query: ListarEstoqueQueryDto): Promise<ResumoEstoqueProduto[]> {
    const filtro: Record<string, unknown> = {};
    const termo = query.busca?.trim();
    if (termo) {
      const regex = new RegExp(termo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filtro["$or"] = [{ nome: regex }, { codProduto: regex }];
    }
    if (query.disponibilidade === "disponivel") filtro["quantidadeTotal"] = { $gt: 0 };
    if (query.disponibilidade === "sem-estoque") filtro["quantidadeTotal"] = { $lte: 0 };

    const produtos = await this.produtosRepository.listarTodosAtivos(filtro);
    return produtos.map(mapearResumo);
  }

  async entrada(dto: EntradaEstoqueDto, usuarioId: string | null): Promise<ProdutoDocument> {
    const { produto, tamanhoId, saldoResultante } = await this.produtosService.ajustarQuantidadeTamanho(
      dto.produtoId,
      dto.varianteId,
      { tamanhoId: dto.tamanhoId, tamanho: dto.tamanho, delta: dto.quantidade, exigirExistente: false },
    );

    await this.movimentacaoModel.create({
      produtoId: produto.id,
      varianteId: dto.varianteId,
      tamanhoId,
      tipo: "entrada",
      quantidade: dto.quantidade,
      saldoResultante,
      motivo: null,
      usuarioId,
    });

    return produto;
  }

  async saida(dto: SaidaEstoqueDto, usuarioId: string | null): Promise<ProdutoDocument> {
    const { produto, tamanhoId, saldoResultante } = await this.produtosService.ajustarQuantidadeTamanho(
      dto.produtoId,
      dto.varianteId,
      { tamanhoId: dto.tamanhoId, delta: -dto.quantidade, exigirExistente: true },
    );

    await this.movimentacaoModel.create({
      produtoId: produto.id,
      varianteId: dto.varianteId,
      tamanhoId,
      tipo: "saida",
      quantidade: dto.quantidade,
      saldoResultante,
      motivo: dto.motivo,
      usuarioId,
    });

    return produto;
  }
}

function mapearResumo(produto: ProdutoDocument): ResumoEstoqueProduto {
  return {
    produtoId: produto.id,
    codProduto: produto.codProduto,
    nome: produto.nome,
    categoria: produto.categoria,
    foto: produto.variantes[0]?.foto ?? null,
    fotos: produto.variantes.map((variante) => variante.foto).filter((foto): foto is string => Boolean(foto)),
    cores: produto.variantes.map((variante) => ({
      varianteId: String(variante._id),
      cor: variante.cor,
      quantidade: variante.quantidadeVariante,
      tamanhos: variante.tamanhos.map((tamanho) => ({
        id: String(tamanho._id),
        tamanho: tamanho.tamanho,
        quantidade: tamanho.quantidade,
      })),
    })),
    colecaoId: produto.colecaoId,
    campanhaId: produto.campanhaId,
    quantidadeTotal: produto.quantidadeTotal,
    totalVariantes: produto.variantes.length,
    estoqueZeradoEm: produto.estoqueZeradoEm ? produto.estoqueZeradoEm.toISOString() : null,
  };
}
