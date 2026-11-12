import { Injectable, type OnModuleInit } from "@nestjs/common";
import { InjectConnection, InjectModel } from "@nestjs/mongoose";
import type { ClientSession, Connection, Model } from "mongoose";
import { ApiException } from "../../common/exceptions/api.exception.js";
import { executarEmTransacao } from "../../database/transacao.util.js";
import { ProdutosRepository } from "../produtos/produtos.repository.js";
import { ProdutosService } from "../produtos/produtos.service.js";
import type { ProdutoDocument } from "../produtos/schemas/produto.schema.js";
import { urlImagemPrincipalDaGaleria, urlsImagensDaGaleria } from "../produtos/utils/midias.util.js";
import { normalizarTamanho } from "../produtos/utils/normalizacao.util.js";
import type { EntradaEstoqueDto } from "./dto/entrada-estoque.dto.js";
import type { ListarEstoqueQueryDto } from "./dto/listar-estoque-query.dto.js";
import type { SaidaEstoqueDto } from "./dto/saida-estoque.dto.js";
import { registrarMovimentacaoEstoque } from "./registrar-movimentacao-estoque.js";
import {
  MovimentacaoEstoque,
  type MovimentacaoEstoqueDocument,
  type OrigemMovimentacaoEstoque,
  type TipoMovimentacaoEstoque,
} from "./schemas/movimentacao-estoque.schema.js";

/**
 * Fase 22.1 — pedido à porta única de movimentação (`EstoqueService.movimentar`). `tamanhoId` OU `tamanho` (nome,
 * só na entrada — cria o tamanho na variante). `idempotencyKey`/`idempotencyAssinatura` só são gravadas quando
 * informadas (operações manuais com chave).
 */
export interface MovimentacaoSolicitada {
  produtoId: string;
  varianteId: string;
  tamanhoId?: string;
  tamanho?: string;
  tipo: TipoMovimentacaoEstoque;
  quantidade: number;
  motivo: string | null;
  usuarioId: string | null;
  origem: OrigemMovimentacaoEstoque;
  vendaId?: string | null;
  /** Repassado a `ajustarQuantidadeTamanho` (Fase 54.2): só a entrada manual exige o tamanho nas configurações. */
  exigirTamanhoCadastrado?: boolean;
  idempotencyKey?: string;
  idempotencyAssinatura?: string;
}

export interface MovimentacaoAplicada {
  produto: ProdutoDocument;
  tamanhoId: string;
  saldoResultante: number;
  movimentacao: MovimentacaoEstoqueDocument;
}

const MENSAGEM_CHAVE_REUSADA =
  "Esta idempotencyKey já foi usada para uma movimentação de estoque diferente. Gere uma nova chave para esta operação.";

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
export class EstoqueService implements OnModuleInit {
  constructor(
    private readonly produtosService: ProdutosService,
    private readonly produtosRepository: ProdutosRepository,
    @InjectModel(MovimentacaoEstoque.name) private readonly movimentacaoModel: Model<MovimentacaoEstoqueDocument>,
    @InjectConnection() private readonly conexao: Connection,
  ) {}

  /**
   * Fase 22.1 — a idempotência das operações manuais depende do índice único parcial de `idempotencyKey`. Aguarda a
   * criação dos índices do model no boot (o mesmo `init()` que o Mongoose já dispara sozinho — aqui só é ESPERADO),
   * para que nenhuma requisição com chave rode antes de o índice existir. Não usa `syncIndexes()`: nunca remove índice.
   */
  async onModuleInit(): Promise<void> {
    await this.movimentacaoModel.init();
  }

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

  /**
   * Fase 22.1 — PORTA ÚNICA de movimentação de estoque: ajusta o saldo do tamanho (pela regra e pela concorrência
   * otimista já existentes em `ProdutosService.ajustarQuantidadeTamanho` — nada duplicado aqui) e grava a linha do
   * ledger `movimentacoes_estoque`, as DUAS escritas na MESMA sessão. A sessão é obrigatória: quem chama abre a
   * transação (`executarEmTransacao`) e qualquer erro aqui — saldo insuficiente, tamanho inexistente, falha do
   * ledger, chave duplicada — propaga e desfaz tudo. Nunca há saldo sem histórico nem histórico sem saldo.
   *
   * Hoje usada pelas entradas/saídas manuais. Vendas e cancelamentos continuam com a gravação própria deles (já
   * transacional desde a F04) — migrá-los para esta porta é uma fase futura, fora do escopo da 22.1.
   */
  async movimentar(dados: MovimentacaoSolicitada, sessao: ClientSession): Promise<MovimentacaoAplicada> {
    if (dados.tipo !== "entrada" && dados.tipo !== "saida") {
      throw ApiException.validation("Dados inválidos.", [{ field: "tipo", message: "Tipo de movimentação inválido." }]);
    }
    if (!Number.isInteger(dados.quantidade) || dados.quantidade <= 0) {
      throw ApiException.validation("Dados inválidos.", [{ field: "quantidade", message: "Quantidade deve ser um inteiro maior que zero." }]);
    }

    const { produto, tamanhoId, saldoResultante } = await this.produtosService.ajustarQuantidadeTamanho(
      dados.produtoId,
      dados.varianteId,
      {
        tamanhoId: dados.tamanhoId,
        tamanho: dados.tamanho,
        delta: dados.tipo === "entrada" ? dados.quantidade : -dados.quantidade,
        // Saída nunca cria tamanho; entrada pode criá-lo pelo nome (comportamento já existente).
        exigirExistente: dados.tipo === "saida",
        exigirTamanhoCadastrado: dados.exigirTamanhoCadastrado ?? false,
      },
      sessao,
    );

    const movimentacao = await registrarMovimentacaoEstoque(
      this.movimentacaoModel,
      {
        produtoId: produto.id,
        varianteId: dados.varianteId,
        tamanhoId,
        tipo: dados.tipo,
        quantidade: dados.quantidade,
        saldoResultante,
        motivo: dados.motivo,
        usuarioId: dados.usuarioId,
        origem: dados.origem,
        vendaId: dados.vendaId ?? null,
        idempotencyKey: dados.idempotencyKey,
        idempotencyAssinatura: dados.idempotencyAssinatura,
      },
      sessao,
    );

    return { produto, tamanhoId, saldoResultante, movimentacao };
  }

  async entrada(dto: EntradaEstoqueDto, usuarioId: string | null): Promise<ProdutoDocument> {
    return this.registrarManual(
      {
        produtoId: dto.produtoId,
        varianteId: dto.varianteId,
        tamanhoId: dto.tamanhoId,
        tamanho: dto.tamanho,
        tipo: "entrada",
        quantidade: dto.quantidade,
        motivo: null,
        usuarioId,
        origem: "manual",
        // Fase 54.2 — só a entrada de estoque (único ponto onde um tamanho
        // pode ser digitado como texto livre, criando-o na hora) exige que
        // ele já esteja em `configuracoes.tamanhos`.
        exigirTamanhoCadastrado: true,
      },
      dto.idempotencyKey,
    );
  }

  async saida(dto: SaidaEstoqueDto, usuarioId: string | null): Promise<ProdutoDocument> {
    return this.registrarManual(
      {
        produtoId: dto.produtoId,
        varianteId: dto.varianteId,
        tamanhoId: dto.tamanhoId,
        tipo: "saida",
        quantidade: dto.quantidade,
        motivo: dto.motivo,
        usuarioId,
        origem: "manual",
      },
      dto.idempotencyKey,
    );
  }

  /**
   * Fase 22.1 — entrada/saída manual pela porta única, numa transação própria, com idempotência OPCIONAL:
   *   - sem chave: comportamento de sempre (cada chamada lança uma movimentação);
   *   - chave já usada com a MESMA assinatura: replay — não lança de novo, devolve o produto no estado atual;
   *   - chave já usada com assinatura DIFERENTE (outra operação, produto, tamanho, quantidade ou motivo): 409;
   *   - duas chamadas simultâneas com a mesma chave: o índice único deixa só uma confirmar; a outra tem a transação
   *     inteira abortada (inclusive o saldo) e cai no replay acima.
   * A chave identifica UMA operação manual de estoque em todo o ledger (mesmo escopo global de `movimentos_caixa`).
   */
  private async registrarManual(dados: MovimentacaoSolicitada, idempotencyKey: string | undefined): Promise<ProdutoDocument> {
    if (!idempotencyKey) {
      const { produto } = await executarEmTransacao(this.conexao, (sessao) => this.movimentar(dados, sessao));
      return produto;
    }

    const assinatura = assinaturaDaOperacaoManual(dados);
    const anterior = await this.replayDaChave(idempotencyKey, assinatura);
    if (anterior) return anterior;

    try {
      const { produto } = await executarEmTransacao(this.conexao, (sessao) =>
        this.movimentar({ ...dados, idempotencyKey, idempotencyAssinatura: assinatura }, sessao),
      );
      return produto;
    } catch (erro) {
      if (ehChaveDeIdempotenciaDuplicada(erro)) {
        const vencedora = await this.replayDaChave(idempotencyKey, assinatura);
        if (vencedora) return vencedora;
      }
      throw erro;
    }
  }

  /** `null` se a chave nunca foi usada; 409 se foi usada para outra operação; senão o produto atual (replay). */
  private async replayDaChave(idempotencyKey: string, assinatura: string): Promise<ProdutoDocument | null> {
    const existente = await this.movimentacaoModel.findOne({ idempotencyKey }).exec();
    if (!existente) return null;
    if (existente.idempotencyAssinatura !== assinatura) throw ApiException.conflict(MENSAGEM_CHAVE_REUSADA);
    return this.produtosService.obterPorId(String(existente.produtoId));
  }
}

/**
 * JSON canônico (ordem fixa de campos) do que define uma operação manual: operação, produto, variante, tamanho
 * (id ou nome normalizado), quantidade e motivo (sem espaços nas pontas). `usuarioId` fica de fora: um retry do
 * mesmo pedido é a mesma operação.
 */
function assinaturaDaOperacaoManual(dados: MovimentacaoSolicitada): string {
  return JSON.stringify({
    operacao: `estoque.${dados.tipo}`,
    produtoId: dados.produtoId,
    varianteId: dados.varianteId,
    tamanhoId: dados.tamanhoId ?? null,
    tamanho: dados.tamanho?.trim() ? normalizarTamanho(dados.tamanho) : null,
    quantidade: dados.quantidade,
    motivo: dados.motivo?.trim() ?? null,
  });
}

/** E11000 especificamente no índice de `idempotencyKey` (nunca mascara outra violação de unicidade). */
function ehChaveDeIdempotenciaDuplicada(erro: unknown): boolean {
  if (typeof erro !== "object" || erro === null || (erro as { code?: unknown }).code !== 11000) return false;
  const keyPattern = (erro as { keyPattern?: Record<string, unknown> }).keyPattern;
  if (keyPattern) return "idempotencyKey" in keyPattern;
  return String((erro as { message?: unknown }).message ?? "").includes("idempotencyKey");
}

function mapearResumo(produto: ProdutoDocument): ResumoEstoqueProduto {
  // Fase 60.1 — com imagens na galeria: `foto` é a principal e `fotos` as imagens pela ordem. Sem galeria, a regra
  // legada exatamente como era (foto da 1ª variante; fotos das variantes que têm foto).
  const fotosDaGaleria = urlsImagensDaGaleria(produto);
  const temGaleria = fotosDaGaleria.length > 0;
  return {
    produtoId: produto.id,
    codProduto: produto.codProduto,
    nome: produto.nome,
    categoria: produto.categoria,
    foto: temGaleria ? urlImagemPrincipalDaGaleria(produto) : (produto.variantes[0]?.foto ?? null),
    fotos: temGaleria ? fotosDaGaleria : produto.variantes.map((variante) => variante.foto).filter((foto): foto is string => Boolean(foto)),
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
