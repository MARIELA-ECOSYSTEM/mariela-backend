import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model, Types } from "mongoose";
import { ApiException } from "../../common/exceptions/api.exception.js";
import type { ApiFacets, ApiMeta } from "../../common/types/api-response.interface.js";
import { SequenciasService } from "../sequencias/sequencias.service.js";
import { VendedoresRepository } from "../vendedores/vendedores.repository.js";
import {
  CHAVE_SEQUENCIA_CAIXA,
  DIGITOS_CODIGO_CAIXA,
  DIFERENCA_TOLERANCIA,
  FACETAS_CAIXA,
  FAIXAS_SALDO,
  PREFIXO_CODIGO_CAIXA,
  STATUS_CAIXA,
  VALORES_DIFERENCA,
  VALORES_PERIODO,
  type ChaveFacetaCaixa,
  type Ordem,
  type OrdenarCaixaPor,
  type TipoMovimentacaoCaixa,
} from "./caixas.constants.js";
import {
  aplicarSelecao,
  condicaoValor,
  filtroBusca,
  situacaoDiferenca,
  type CaixaComResumo,
  type SelecaoFacetas,
} from "./caixas-filtros.util.js";
import { arredondar } from "./dinheiro.util.js";
import { CaixasRepository } from "./caixas.repository.js";
import { MovimentosCaixaRepository } from "./movimentos-caixa.repository.js";
import type { AbrirCaixaDto } from "./dto/abrir-caixa.dto.js";
import type { EntradaCaixaDto } from "./dto/entrada-caixa.dto.js";
import type { SaidaCaixaDto } from "./dto/saida-caixa.dto.js";
import type { FechamentoCaixaDto } from "./dto/fechamento-caixa.dto.js";
import type { ListarCaixasQueryDto } from "./dto/listar-caixas-query.dto.js";
import type { ListarMovimentosQueryDto } from "./dto/listar-movimentos-query.dto.js";
import { EventoCaixa, type EventoCaixaDocument } from "./schemas/evento-caixa.schema.js";
import type { CaixaDocument } from "./schemas/caixa.schema.js";
import type { MovimentoCaixaDocument } from "./schemas/movimento-caixa.schema.js";
import type { ResumoCaixaCalculado } from "./caixas.types.js";
import { MOVIMENTOS_RECENTES_NO_DETALHE } from "./caixas.constants.js";

export interface CaixaRespostaPublica {
  id: string;
  codigo: string;
  status: string;
  abertura: unknown;
  fechamento: unknown;
  resumo: ResumoCaixaCalculado;
}

export interface CaixaDetalheResposta extends CaixaRespostaPublica {
  movimentacoes: MovimentoCaixaDocument[];
  vendas: never[];
  recebimentos: never[];
}

export interface ResultadoListaCaixas {
  data: CaixaRespostaPublica[];
  meta: ApiMeta;
  facets: ApiFacets;
}

@Injectable()
export class CaixasService {
  constructor(
    private readonly caixasRepository: CaixasRepository,
    private readonly movimentosRepository: MovimentosCaixaRepository,
    private readonly vendedoresRepository: VendedoresRepository,
    private readonly sequenciasService: SequenciasService,
    @InjectModel(EventoCaixa.name) private readonly eventoModel: Model<EventoCaixaDocument>,
  ) {}

  async abrir(dto: AbrirCaixaDto, usuarioId: string | null): Promise<CaixaDetalheResposta> {
    const autor = await this.resolverResponsavel(dto.responsavelId);
    const codigo = await this.sequenciasService.proximoCodigo(CHAVE_SEQUENCIA_CAIXA, PREFIXO_CODIGO_CAIXA, DIGITOS_CODIGO_CAIXA);

    const caixa = await this.caixasRepository.criar({
      codigo,
      status: "aberto",
      abertura: {
        dataHora: new Date(),
        responsavelId: autor.id,
        responsavelNome: autor.nome,
        valorInicial: arredondar(dto.valorInicial),
        observacao: dto.observacao?.trim() ?? "",
      },
      fechamento: null,
    });

    await this.registrarEvento(caixa.id, "caixa.aberto", usuarioId, { codigo });
    return this.obterDetalhe(caixa.id);
  }

  async listar(query: ListarCaixasQueryDto): Promise<ResultadoListaCaixas> {
    const [caixas, movimentos] = await Promise.all([
      this.caixasRepository.listarTodos(),
      this.movimentosRepository.listarTodos(),
    ]);

    const movimentosPorCaixa = new Map<string, MovimentoCaixaDocument[]>();
    for (const movimento of movimentos) {
      const chave = String(movimento.caixaId);
      const lista = movimentosPorCaixa.get(chave) ?? [];
      lista.push(movimento);
      movimentosPorCaixa.set(chave, lista);
    }

    const itens: CaixaComResumo[] = caixas.map((documento) => ({
      documento: documento as CaixaDocument & { id: string },
      resumo: this.calcularResumo(movimentosPorCaixa.get(documento.id) ?? [], documento.abertura.valorInicial),
    }));

    const selecao: SelecaoFacetas = {
      status: query.status,
      periodo: query.periodo,
      responsavel: query.responsavel,
      diferenca: query.diferenca,
      saldo: query.saldo,
    };
    const agora = new Date();

    const base = filtroBusca(itens, query.busca);
    const filtrados = aplicarSelecao(base, selecao, agora);
    const ordenados = this.ordenarItens(filtrados, query.ordenarPor, query.ordem);

    const total = ordenados.length;
    const inicio = (query.page - 1) * query.limit;
    const pagina = ordenados.slice(inicio, inicio + query.limit);

    return {
      data: pagina.map((item) => this.paraRespostaPublica(item.documento, item.resumo)),
      meta: {
        total,
        page: query.page,
        limit: query.limit,
        totalPages: Math.max(1, Math.ceil(total / query.limit)),
      },
      facets: this.calcularFacets(base, selecao, agora),
    };
  }

  async obterDetalhe(id: string): Promise<CaixaDetalheResposta> {
    const caixa = await this.caixasRepository.encontrarPorIdOuFalhar(id);
    const [movimentosTodos, recentes] = await Promise.all([
      this.movimentosRepository.listarTodosPorCaixa(id),
      this.movimentosRepository.recentesPorCaixa(id, MOVIMENTOS_RECENTES_NO_DETALHE),
    ]);
    const resumo = this.calcularResumo(movimentosTodos, caixa.abertura.valorInicial);

    return {
      ...this.paraRespostaPublica(caixa, resumo),
      movimentacoes: recentes,
      vendas: [],
      recebimentos: [],
    };
  }

  async obterAtual(): Promise<CaixaDetalheResposta | null> {
    const caixa = await this.caixasRepository.encontrarAberto();
    if (!caixa) return null;
    return this.obterDetalhe(caixa.id);
  }

  async listarMovimentos(caixaId: string, query: ListarMovimentosQueryDto): Promise<{ data: MovimentoCaixaDocument[]; meta: ApiMeta }> {
    await this.caixasRepository.encontrarPorIdOuFalhar(caixaId);
    const { itens, total } = await this.movimentosRepository.listarPaginadoPorCaixa(caixaId, {
      tipo: query.tipo,
      responsavelId: query.responsavelId,
      ordem: query.ordem,
      page: query.page,
      limit: query.limit,
    });
    return {
      data: itens,
      meta: { total, page: query.page, limit: query.limit, totalPages: Math.max(1, Math.ceil(total / query.limit)) },
    };
  }

  /**
   * Histórico de vendas do caixa. O módulo de Vendas ainda não existe nesta
   * etapa — por isso sempre devolve uma lista vazia (nunca inventa dados de
   * venda). Continua validando que o caixa existe, para preservar o 404 já
   * esperado pelo Backoffice quando o id é inválido.
   */
  async listarVendas(id: string): Promise<{ data: never[]; meta: ApiMeta }> {
    await this.caixasRepository.encontrarPorIdOuFalhar(id);
    return { data: [], meta: { total: 0 } };
  }

  async listarRecebimentos(id: string): Promise<{ data: never[]; meta: ApiMeta }> {
    await this.caixasRepository.encontrarPorIdOuFalhar(id);
    return { data: [], meta: { total: 0 } };
  }

  async estatisticas(): Promise<{
    caixasAbertos: number;
    caixasFechados: number;
    entradasHoje: number;
    saidasHoje: number;
    vendasHoje: number;
    recebimentosHoje: number;
    devolucoesHoje: number;
    saldoEsperadoAtual: number;
    diferencaAcumulada: number;
  }> {
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);
    const amanha = new Date(hoje);
    amanha.setDate(amanha.getDate() + 1);

    const [caixasAbertos, caixasFechados, doDia, diferencaAcumulada, caixaAberto] = await Promise.all([
      this.caixasRepository.contarPorStatus("aberto"),
      this.caixasRepository.contarPorStatus("fechado"),
      this.movimentosRepository.listarDoDia(hoje, amanha),
      this.caixasRepository.somarDiferencaFechados(),
      this.caixasRepository.encontrarAberto(),
    ]);

    const somar = (predicado: (movimento: MovimentoCaixaDocument) => boolean) =>
      arredondar(doDia.filter(predicado).reduce((total, item) => total + item.valor, 0));

    let saldoEsperadoAtual = 0;
    if (caixaAberto) {
      const movimentos = await this.movimentosRepository.listarTodosPorCaixa(caixaAberto.id);
      saldoEsperadoAtual = this.calcularResumo(movimentos, caixaAberto.abertura.valorInicial).saldoEsperado;
    }

    return {
      caixasAbertos,
      caixasFechados,
      entradasHoje: somar((item) => item.sentido === "entrada"),
      saidasHoje: somar((item) => item.sentido === "saida"),
      vendasHoje: somar((item) => item.tipo === "venda"),
      recebimentosHoje: somar((item) => item.tipo === "recebimento_parcela"),
      devolucoesHoje: somar((item) => item.tipo === "devolucao" || item.tipo === "cancelamento"),
      saldoEsperadoAtual,
      diferencaAcumulada: arredondar(diferencaAcumulada),
    };
  }

  /**
   * Ponto de integração para o futuro módulo de Vendas: registra `venda`
   * (entrada à vista), `recebimento_parcela` (entrada — baixa de parcela) ou
   * `devolucao`/`cancelamento` (saída — sempre limitada pelo chamador ao que
   * foi de fato recebido, nunca validado aqui). Não passa pelas regras de
   * `EntradaCaixaDto`/`SaidaCaixaDto` (não há "motivo" obrigatório nem
   * responsável "backoffice" por padrão) porque a origem já é outro domínio,
   * não uma movimentação manual do ADMIN.
   */
  async registrarMovimentoDeVenda(dados: {
    caixaId: string;
    tipo: Extract<TipoMovimentacaoCaixa, "venda" | "recebimento_parcela" | "devolucao" | "cancelamento">;
    descricao: string;
    referencia: string | null;
    vendaId: string;
    vendaCodigo: string;
    formaPagamento: string;
    valor: number;
    responsavelId: string | null;
    responsavelNome: string;
    observacao: string;
    idempotencyKey?: string | null;
  }): Promise<void> {
    const caixa = await this.caixasRepository.encontrarPorIdOuFalhar(dados.caixaId);
    this.exigirAberto(caixa);

    const sentido = dados.tipo === "devolucao" || dados.tipo === "cancelamento" ? "saida" : "entrada";
    const origem = dados.tipo === "recebimento_parcela" ? "parcela" : dados.tipo;

    await this.movimentosRepository.criar({
      caixaId: dados.caixaId,
      dataHora: new Date(),
      tipo: dados.tipo,
      origem,
      descricao: dados.descricao,
      referencia: dados.referencia,
      vendaId: dados.vendaId,
      vendaCodigo: dados.vendaCodigo,
      formaPagamento: dados.formaPagamento,
      valor: arredondar(dados.valor),
      sentido,
      responsavelId: dados.responsavelId,
      responsavelNome: dados.responsavelNome,
      observacao: dados.observacao,
      motivo: sentido === "saida" ? dados.observacao || null : null,
      idempotencyKey: dados.idempotencyKey ?? null,
    });
  }

  async registrarMovimento(
    caixaId: string,
    tipo: "entrada" | "saida",
    dto: EntradaCaixaDto | SaidaCaixaDto,
    usuarioId: string | null,
  ): Promise<CaixaDetalheResposta> {
    const caixa = await this.caixasRepository.encontrarPorIdOuFalhar(caixaId);
    this.exigirAberto(caixa);

    const valor = arredondar(dto.valor);
    if (tipo === "saida") {
      const movimentos = await this.movimentosRepository.listarTodosPorCaixa(caixaId);
      const saldo = this.calcularResumo(movimentos, caixa.abertura.valorInicial).saldoEsperado;
      if (valor > saldo) {
        throw ApiException.validation("Dados inválidos.", [
          { field: "valor", message: `Saída maior que o saldo disponível (${saldo.toFixed(2)}).` },
        ]);
      }
    }

    const autor = await this.resolverResponsavel(dto.responsavelId ?? caixa.abertura.responsavelId);
    const motivo = tipo === "saida" ? (dto as SaidaCaixaDto).motivo.trim() : null;

    const { movimento, duplicado } = await this.movimentosRepository.criar({
      caixaId,
      dataHora: new Date(),
      tipo,
      origem: "manual",
      descricao: dto.descricao.trim(),
      referencia: null,
      vendaId: null,
      vendaCodigo: null,
      formaPagamento: dto.formaPagamento.trim(),
      valor,
      sentido: tipo,
      responsavelId: autor.id,
      responsavelNome: autor.nome,
      observacao: dto.observacao?.trim() ?? "",
      motivo,
      idempotencyKey: dto.idempotencyKey ?? null,
    });

    if (!duplicado) {
      await this.registrarEvento(caixaId, "caixa.movimento_criado", usuarioId, { tipo, valor: movimento.valor });
    }

    return this.obterDetalhe(caixaId);
  }

  async fechar(id: string, dto: FechamentoCaixaDto, usuarioId: string | null): Promise<CaixaDetalheResposta> {
    const caixa = await this.caixasRepository.encontrarPorIdOuFalhar(id);
    this.exigirAberto(caixa);

    const movimentos = await this.movimentosRepository.listarTodosPorCaixa(id);
    const valorEsperado = this.calcularResumo(movimentos, caixa.abertura.valorInicial).saldoEsperado;
    const diferenca = arredondar(dto.valorInformado - valorEsperado);
    const observacao = dto.observacao?.trim() ?? "";

    if (Math.abs(diferenca) >= DIFERENCA_TOLERANCIA && !observacao) {
      throw ApiException.validation("Dados inválidos.", [
        { field: "observacao", message: "Justifique a diferença encontrada na conferência." },
      ]);
    }

    const autor = await this.resolverResponsavel(dto.responsavelId ?? caixa.abertura.responsavelId);
    const atualizado = await this.caixasRepository.fecharAtomico(id, {
      dataHora: new Date(),
      responsavelId: autor.id,
      responsavelNome: autor.nome,
      valorInformado: arredondar(dto.valorInformado),
      valorEsperado,
      diferenca,
      observacao,
    });

    if (!atualizado) {
      throw ApiException.conflict("Este caixa já está fechado.");
    }

    await this.registrarEvento(id, "caixa.fechado", usuarioId, { diferenca });
    return this.obterDetalhe(id);
  }

  /** Caixa FECHADO é histórico imutável: nenhum lançamento novo é aceito. */
  private exigirAberto(caixa: CaixaDocument): void {
    if (caixa.status === "fechado") {
      throw ApiException.validation("Este caixa está fechado e é imutável. Registre o ajuste em um novo caixa.");
    }
  }

  /** `null`/ausente = o próprio ADMIN (Backoffice); um id = Vendedor real, validado e com nome capturado (snapshot). */
  private async resolverResponsavel(responsavelId: string | null | undefined): Promise<{ id: string | null; nome: string }> {
    if (!responsavelId) return { id: null, nome: "Backoffice" };
    const vendedor = await this.vendedoresRepository.encontrarPorIdOuFalhar(responsavelId);
    return { id: vendedor.id, nome: vendedor.nome };
  }

  /** Resumo SEMPRE derivado das movimentações — nunca de um campo persistido (mesma regra do contrato de frontend). */
  private calcularResumo(movimentos: MovimentoCaixaDocument[], valorAbertura: number): ResumoCaixaCalculado {
    const somar = (tipos: string[]) => arredondar(movimentos.filter((item) => tipos.includes(item.tipo)).reduce((total, item) => total + item.valor, 0));

    const totalVendas = somar(["venda"]);
    const recebimentos = somar(["recebimento_parcela"]);
    const entradasManuais = somar(["entrada"]);
    const saidasManuais = somar(["saida"]);
    const devolucoes = somar(["devolucao", "cancelamento"]);
    const totalEntradas = arredondar(totalVendas + recebimentos + entradasManuais);
    const totalSaidas = arredondar(saidasManuais + devolucoes);

    return {
      valorAbertura,
      totalVendas,
      recebimentos,
      entradasManuais,
      totalEntradas,
      saidasManuais,
      devolucoes,
      totalSaidas,
      saldoEsperado: arredondar(valorAbertura + totalEntradas - totalSaidas),
      quantidadeVendas: new Set(movimentos.filter((item) => item.tipo === "venda").map((item) => item.vendaId)).size,
      quantidadeMovimentacoes: movimentos.length,
    };
  }

  private ordenarItens(itens: CaixaComResumo[], campo: OrdenarCaixaPor, ordem: Ordem): CaixaComResumo[] {
    const fator = ordem === "desc" ? -1 : 1;
    const copia = [...itens];
    switch (campo) {
      case "faturamento":
        return copia.sort((a, b) => ((a.resumo.totalVendas + a.resumo.recebimentos) - (b.resumo.totalVendas + b.resumo.recebimentos)) * fator);
      case "saldo":
        return copia.sort((a, b) => (a.resumo.saldoEsperado - b.resumo.saldoEsperado) * fator);
      case "diferenca":
        return copia.sort(
          (a, b) => (Math.abs(a.documento.fechamento?.diferenca ?? 0) - Math.abs(b.documento.fechamento?.diferenca ?? 0)) * fator,
        );
      case "vendas":
        return copia.sort((a, b) => (a.resumo.quantidadeVendas - b.resumo.quantidadeVendas) * fator);
      case "data":
      default:
        return copia.sort((a, b) => (a.documento.abertura.dataHora.getTime() - b.documento.abertura.dataHora.getTime()) * fator);
    }
  }

  private calcularFacets(base: CaixaComResumo[], selecao: SelecaoFacetas, agora: Date): ApiFacets {
    const contarValores = (chave: ChaveFacetaCaixa, valores: readonly string[]) => {
      const universo = aplicarSelecao(base, selecao, agora, chave);
      return valores.map((valor) => ({ valor, count: universo.filter((item) => condicaoValor(chave, valor, item, agora)).length }));
    };

    const universoResponsavel = aplicarSelecao(base, selecao, agora, FACETAS_CAIXA.responsavel);
    const contagemResponsavel = new Map<string, number>();
    for (const item of universoResponsavel) {
      const nome = item.documento.abertura.responsavelNome;
      contagemResponsavel.set(nome, (contagemResponsavel.get(nome) ?? 0) + 1);
    }
    const responsaveis = Array.from(contagemResponsavel.entries())
      .map(([valor, count]) => ({ valor, count }))
      .sort((a, b) => a.valor.localeCompare(b.valor, "pt-BR"));

    return {
      [FACETAS_CAIXA.status]: contarValores(FACETAS_CAIXA.status, STATUS_CAIXA),
      [FACETAS_CAIXA.periodo]: contarValores(FACETAS_CAIXA.periodo, VALORES_PERIODO),
      [FACETAS_CAIXA.responsavel]: responsaveis,
      [FACETAS_CAIXA.diferenca]: contarValores(FACETAS_CAIXA.diferenca, VALORES_DIFERENCA),
      [FACETAS_CAIXA.saldo]: contarValores(
        FACETAS_CAIXA.saldo,
        FAIXAS_SALDO.map((faixa) => faixa.valor),
      ),
    };
  }

  private paraRespostaPublica(caixa: CaixaDocument, resumo: ResumoCaixaCalculado): CaixaRespostaPublica {
    const json = caixa.toJSON() as unknown as { id: string; codigo: string; status: string; abertura: unknown; fechamento: unknown };
    return { id: json.id, codigo: json.codigo, status: json.status, abertura: json.abertura, fechamento: json.fechamento, resumo };
  }

  private async registrarEvento(
    caixaId: string | Types.ObjectId,
    tipo: string,
    usuarioId: string | null,
    detalhes: Record<string, unknown>,
  ): Promise<void> {
    await this.eventoModel.create({ caixaId, tipo, usuarioId, detalhes });
  }
}

// Re-exportado para os specs — evita repetir a lógica de arredondamento nos testes.
export { situacaoDiferenca };
