import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model, Types } from "mongoose";
import { ApiException } from "../../common/exceptions/api.exception.js";
import type { ApiFacets, ApiMeta } from "../../common/types/api-response.interface.js";
import { CaixasRepository } from "../caixas/caixas.repository.js";
import { CaixasService } from "../caixas/caixas.service.js";
import { ClientesRepository } from "../clientes/clientes.repository.js";
import { ProdutosRepository } from "../produtos/produtos.repository.js";
import { ProdutosService } from "../produtos/produtos.service.js";
import { arredondarMoeda, precoEfetivo } from "../produtos/utils/precos.util.js";
import { SequenciasService } from "../sequencias/sequencias.service.js";
import { VendedoresRepository } from "../vendedores/vendedores.repository.js";
import {
  CHAVE_SEQUENCIA_VENDA,
  DIGITOS_CODIGO_VENDA,
  DIGITOS_NUMERO_VENDA,
  PREFIXO_CODIGO_VENDA,
} from "./vendas.constants.js";
import type { SelecaoFacetas } from "./vendas-filtros.util.js";
import { VendasRepository } from "./vendas.repository.js";
import type { BaixarParcelaDto } from "./dto/baixar-parcela.dto.js";
import type { CancelamentoDto } from "./dto/cancelamento.dto.js";
import type { ListarVendasQueryDto } from "./dto/listar-vendas-query.dto.js";
import { EventoVenda, type EventoVendaDocument } from "./schemas/evento-venda.schema.js";
import type { ItemDevolvido, ItemVenda, PagamentoVenda, VendaDocument } from "./schemas/venda.schema.js";
import type { DadosCriarVenda, DadosPersistirVenda } from "./vendas.types.js";

export interface ResultadoListaVendas {
  data: VendaDocument[];
  meta: ApiMeta;
  facets: ApiFacets;
}

function arredondar(valor: number): number {
  return Number(valor.toFixed(2));
}

@Injectable()
export class VendasService {
  constructor(
    private readonly vendasRepository: VendasRepository,
    private readonly produtosService: ProdutosService,
    private readonly produtosRepository: ProdutosRepository,
    private readonly clientesRepository: ClientesRepository,
    private readonly vendedoresRepository: VendedoresRepository,
    private readonly caixasRepository: CaixasRepository,
    private readonly caixasService: CaixasService,
    private readonly sequenciasService: SequenciasService,
    @InjectModel(EventoVenda.name) private readonly eventoModel: Model<EventoVendaDocument>,
  ) {}

  /**
   * Único ponto de criação de venda. NÃO é exposto por nenhuma rota HTTP
   * nesta etapa — a criação pertence ao futuro MARIELA PDV (ver relatório).
   * Usado hoje apenas pelos testes de integração.
   */
  async criar(dados: DadosCriarVenda, usuarioId: string | null): Promise<VendaDocument> {
    if (dados.idempotencyKey) {
      const existente = await this.vendasRepository.encontrarPorIdempotencyKey(dados.idempotencyKey);
      if (existente) return existente;
    }

    if (!dados.itens.length) {
      throw ApiException.validation("Dados inválidos.", [{ field: "itens", message: "A venda precisa de ao menos um item." }]);
    }

    const vendedor = await this.vendedoresRepository.encontrarPorIdOuFalhar(dados.vendedorId);
    if (!vendedor.ativo) throw ApiException.validation("Vendedor(a) inativo(a) não pode registrar vendas.");

    const caixa = await this.caixasRepository.encontrarPorIdOuFalhar(dados.caixaId);
    if (caixa.status !== "aberto") throw ApiException.validation("O caixa informado não está aberto.");

    let clienteNome = "Consumidor final";
    if (dados.clienteId) {
      const cliente = await this.clientesRepository.encontrarPorIdOuFalhar(dados.clienteId);
      clienteNome = cliente.nome;
    }

    // Pré-checagem de saldo de TODOS os itens antes de baixar qualquer
    // estoque — reduz (não elimina, sem transações multi-documento) a chance
    // de baixar parte dos itens e falhar no meio da venda por outro item.
    const produtosCache = new Map<string, Awaited<ReturnType<typeof this.produtosRepository.encontrarPorIdOuFalhar>>>();
    const itensMontados: ItemVenda[] = [];
    for (const solicitado of dados.itens) {
      if (solicitado.quantidade <= 0) {
        throw ApiException.validation("Dados inválidos.", [{ field: "quantidade", message: "A quantidade deve ser maior que zero." }]);
      }
      const produto = produtosCache.get(solicitado.produtoId) ?? (await this.produtosRepository.encontrarPorIdOuFalhar(solicitado.produtoId));
      produtosCache.set(solicitado.produtoId, produto);

      const variante = produto.variantes.find((item) => String(item._id) === solicitado.varianteId);
      if (!variante) throw ApiException.notFound("Variante não encontrada.");
      const tamanho = variante.tamanhos.find((item) => String(item._id) === solicitado.tamanhoId);
      if (!tamanho) throw ApiException.notFound("Tamanho não encontrado.");
      if (tamanho.quantidade < solicitado.quantidade) {
        throw ApiException.validation("Dados inválidos.", [
          { field: "quantidade", message: `Estoque insuficiente para ${produto.nome} (${variante.cor}, ${tamanho.tamanho}). Disponível: ${tamanho.quantidade}.` },
        ]);
      }

      const precoOriginal = produto.precoVenda;
      const precoPraticado = precoEfetivo(produto);
      itensMontados.push({
        produtoId: produto.id,
        codProduto: produto.codProduto,
        nome: produto.nome,
        categoria: produto.categoria,
        varianteId: String(variante._id),
        codVariante: variante.codVariante,
        cor: variante.cor,
        tamanho: tamanho.tamanho,
        foto: variante.foto,
        quantidade: solicitado.quantidade,
        precoOriginal,
        precoPraticado,
        emPromocao: precoPraticado < precoOriginal,
        subtotal: arredondarMoeda(precoPraticado * solicitado.quantidade),
        quantidadeDevolvida: 0,
      } as ItemVenda);
    }

    // Baixa o estoque item a item; se algum falhar (corrida entre a
    // pré-checagem e agora), desfaz (devolve) o que já foi baixado nesta
    // mesma tentativa antes de propagar o erro — nunca deixa a venda "meio
    // baixada". Ver "Pendências" no relatório sobre o limite desta estratégia
    // sem transações multi-documento.
    const baixados: { produtoId: string; varianteId: string; tamanhoId: string; quantidade: number }[] = [];
    try {
      for (const solicitado of dados.itens) {
        await this.produtosService.ajustarQuantidadeTamanho(solicitado.produtoId, solicitado.varianteId, {
          tamanhoId: solicitado.tamanhoId,
          delta: -solicitado.quantidade,
          exigirExistente: true,
        });
        baixados.push(solicitado);
      }
    } catch (erro) {
      for (const item of baixados) {
        await this.produtosService
          .ajustarQuantidadeTamanho(item.produtoId, item.varianteId, { tamanhoId: item.tamanhoId, delta: item.quantidade, exigirExistente: true })
          .catch(() => undefined);
      }
      throw erro;
    }

    const valorBruto = arredondar(itensMontados.reduce((total, item) => total + item.precoOriginal * item.quantidade, 0));
    const descontoPromocional = arredondar(
      itensMontados.reduce((total, item) => total + (item.precoOriginal - item.precoPraticado) * item.quantidade, 0),
    );
    const subtotal = arredondar(valorBruto - descontoPromocional);
    const descontoVenda = arredondar(dados.descontoVenda ?? 0);
    if (descontoVenda < 0 || descontoVenda > subtotal) {
      throw ApiException.validation("Dados inválidos.", [{ field: "descontoVenda", message: "Desconto inválido para o subtotal da venda." }]);
    }
    const valorFinal = arredondar(subtotal - descontoVenda);

    const dataVenda = new Date();
    const pagamentos: PagamentoVenda[] = (dados.pagamentos ?? []).map(
      (pagamento) =>
        ({
          forma: pagamento.forma,
          valor: arredondar(pagamento.valor),
          dataPagamento: dataVenda,
          parcelas: pagamento.parcelas ?? 1,
          observacao: pagamento.observacao ?? null,
        }) as PagamentoVenda,
    );
    const valorPago = arredondar(pagamentos.reduce((total, item) => total + item.valor, 0));
    if (valorPago > valorFinal) {
      throw ApiException.validation("Dados inválidos.", [{ field: "pagamentos", message: "A soma dos pagamentos não pode exceder o valor final." }]);
    }
    const valorPendente = arredondar(Math.max(0, valorFinal - valorPago));

    const parcelas = valorPendente > 0 ? this.montarParcelas(valorPendente, dados.totalParcelas ?? 1, dataVenda) : [];

    const valor = await this.sequenciasService.proximoValor(CHAVE_SEQUENCIA_VENDA);
    const codigo = `${PREFIXO_CODIGO_VENDA}-${dataVenda.toISOString().slice(0, 10)}-${String(valor).padStart(DIGITOS_CODIGO_VENDA, "0")}`;
    const numero = String(valor).padStart(DIGITOS_NUMERO_VENDA, "0");

    const historico = [
      { dataHora: dataVenda, tipo: "criacao" as const, descricao: `Venda registrada no PDV com ${itensMontados.length} item(ns) · estoque baixado`, autor: vendedor.nome },
      ...pagamentos.map((pagamento) => ({
        dataHora: pagamento.dataPagamento,
        tipo: "pagamento" as const,
        descricao: `Pagamento recebido em ${pagamento.forma}`,
        autor: vendedor.nome,
      })),
    ];

    const venda = await this.vendasRepository.criar({
      codigo,
      numero,
      dataVenda,
      clienteId: dados.clienteId ?? null,
      clienteNome,
      vendedorId: vendedor.id,
      vendedorNome: vendedor.nome,
      caixaId: caixa.id,
      caixaCodigo: caixa.codigo,
      itens: itensMontados,
      totalItens: itensMontados.reduce((total, item) => total + item.quantidade, 0),
      valorBruto,
      descontoPromocional,
      descontoVenda,
      descontoTotal: arredondar(descontoPromocional + descontoVenda),
      valorFinal,
      valorPago,
      valorPendente,
      valorDevolvido: 0,
      temPromocao: descontoPromocional > 0,
      temDesconto: descontoVenda > 0,
      formaPagamento: pagamentos[0]?.forma ?? "A definir",
      totalParcelas: parcelas.length || 1,
      parcelasPagas: 0,
      observacao: dados.observacao?.trim() ?? "",
      pagamentos,
      parcelas,
      historico,
      cancelamento: null,
      status: valorPendente > 0 ? "em_pagamento" : "concluida",
      idempotencyKey: dados.idempotencyKey ?? null,
    } satisfies DadosPersistirVenda);

    // Só o que foi EFETIVAMENTE recebido agora entra no caixa.
    if (valorPago > 0) {
      await this.caixasService.registrarMovimentoDeVenda({
        caixaId: caixa.id,
        tipo: "venda",
        descricao: `Venda ${venda.codigo} · ${clienteNome}`,
        referencia: venda.codigo,
        vendaId: venda.id,
        vendaCodigo: venda.codigo,
        formaPagamento: venda.formaPagamento,
        valor: valorPago,
        responsavelId: null,
        responsavelNome: vendedor.nome,
        observacao: "",
      });
    }

    await this.atualizarAgregadosNaCriacao(venda);
    await this.registrarEvento(venda.id, "venda.criada", usuarioId, { codigo: venda.codigo, valorFinal });
    return venda;
  }

  async listar(query: ListarVendasQueryDto): Promise<ResultadoListaVendas> {
    const selecao: SelecaoFacetas = {
      status: query.status,
      periodo: query.periodo,
      vendedor: query.vendedor,
      cliente: query.cliente,
      pagamento: query.pagamento,
      caixa: query.caixa,
      valor: query.valor,
      condicoes: query.condicoes,
      financeiro: query.financeiro,
    };

    const { itens, total, facets } = await this.vendasRepository.listarComFacetas({
      busca: query.busca,
      ordenarPor: query.ordenarPor,
      ordem: query.ordem,
      selecao,
      page: query.page,
      limit: query.limit,
    });

    return {
      data: itens,
      meta: { total, page: query.page, limit: query.limit, totalPages: Math.max(1, Math.ceil(total / query.limit)) },
      facets,
    };
  }

  async obterPorId(id: string): Promise<VendaDocument> {
    return this.vendasRepository.encontrarPorIdOuFalhar(id);
  }

  async estatisticas(): Promise<{
    totalVendas: number;
    faturamento: number;
    ticketMedio: number;
    itensVendidos: number;
    vendasEmPagamento: number;
    valorEmAberto: number;
    vendasCanceladas: number;
    valorCancelado: number;
    descontoConcedido: number;
  }> {
    // `listarComFacetas` pagina — estatísticas precisam do conjunto inteiro,
    // por isso usam uma projeção dedicada (só os campos financeiros, sem
    // itens/histórico) em vez de reaproveitar a listagem paginada.
    const vendas = await this.vendasRepository.encontrarTodasParaEstatisticas();

    const faturaveis = vendas.filter((venda) => venda.status !== "cancelada");
    const canceladas = vendas.filter((venda) => venda.status === "cancelada");
    const emPagamento = vendas.filter((venda) => venda.status === "em_pagamento");
    const faturamento = arredondar(faturaveis.reduce((total, venda) => total + venda.valorFinal - venda.valorDevolvido, 0));

    return {
      totalVendas: vendas.length,
      faturamento,
      ticketMedio: faturaveis.length ? arredondar(faturamento / faturaveis.length) : 0,
      itensVendidos: faturaveis.reduce((total, venda) => total + venda.totalItens, 0),
      vendasEmPagamento: emPagamento.length,
      valorEmAberto: arredondar(emPagamento.reduce((total, venda) => total + venda.valorPendente, 0)),
      vendasCanceladas: canceladas.length,
      valorCancelado: arredondar(canceladas.reduce((total, venda) => total + venda.valorFinal, 0)),
      descontoConcedido: arredondar(faturaveis.reduce((total, venda) => total + venda.descontoTotal, 0)),
    };
  }

  async baixarParcela(vendaId: string, parcelaId: string, dto: BaixarParcelaDto, usuarioId: string | null): Promise<VendaDocument> {
    const vendaAtual = await this.vendasRepository.encontrarPorIdOuFalhar(vendaId);
    if (vendaAtual.status === "cancelada") throw ApiException.validation("Venda cancelada não aceita novas baixas.");

    let formaUsada = "";
    let valorParcela = 0;
    let numeroParcela = 0;
    let totalParcelas = 0;

    const venda = await this.vendasRepository.salvarComRetentativa(vendaId, (documento) => {
      if (documento.status === "cancelada") throw ApiException.validation("Venda cancelada não aceita novas baixas.");
      const parcela = documento.parcelas.find((item) => String(item._id) === parcelaId);
      if (!parcela) throw ApiException.notFound("Parcela não encontrada.");
      if (parcela.pagoEm) throw ApiException.validation("Esta parcela já está baixada.");

      const forma = dto.formaPagamento?.trim() || documento.formaPagamento;
      const agora = new Date();
      parcela.pagoEm = agora;
      parcela.formaPagamento = forma;

      documento.pagamentos.push({
        forma,
        valor: parcela.valor,
        dataPagamento: agora,
        parcelas: parcela.total,
        observacao: `Parcela ${parcela.numero}/${parcela.total} (baixa no backoffice)`,
      } as PagamentoVenda);
      documento.valorPago = arredondar(documento.pagamentos.reduce((total, item) => total + item.valor, 0));
      documento.valorPendente = arredondar(Math.max(0, documento.valorFinal - documento.valorPago));
      documento.parcelasPagas = documento.parcelas.filter((item) => item.pagoEm).length;
      if (documento.valorPendente === 0) documento.status = "concluida";
      documento.historico.push({
        dataHora: agora,
        tipo: "baixa_parcela",
        descricao: `Baixa da parcela ${parcela.numero}/${parcela.total} em ${forma}`,
        autor: "Backoffice",
      });

      formaUsada = forma;
      valorParcela = parcela.valor;
      numeroParcela = parcela.numero;
      totalParcelas = parcela.total;
    });

    if (venda.caixaId) {
      await this.caixasService.registrarMovimentoDeVenda({
        caixaId: venda.caixaId,
        tipo: "recebimento_parcela",
        descricao: `Recebimento da parcela ${numeroParcela}/${totalParcelas} · ${venda.clienteNome}`,
        referencia: venda.codigo,
        vendaId: venda.id,
        vendaCodigo: venda.codigo,
        formaPagamento: formaUsada,
        valor: valorParcela,
        responsavelId: null,
        responsavelNome: "Backoffice",
        observacao: "Baixa registrada no backoffice",
      });
    }

    await this.registrarEvento(venda.id, "venda.parcela_baixada", usuarioId, { parcelaId, valor: valorParcela });
    return venda;
  }

  async cancelar(vendaId: string, dto: CancelamentoDto, usuarioId: string | null): Promise<VendaDocument> {
    const vendaAtual = await this.vendasRepository.encontrarPorIdOuFalhar(vendaId);
    if (vendaAtual.status === "cancelada") throw ApiException.validation("Esta venda já está cancelada.");

    const devolvidos: ItemDevolvido[] = [];
    if (dto.tipo === "integral") {
      for (const item of vendaAtual.itens) {
        const restante = item.quantidade - item.quantidadeDevolvida;
        if (restante <= 0) continue;
        await this.devolverAoEstoque(item, restante);
        devolvidos.push({ itemId: String(item._id), codProduto: item.codProduto, nome: item.nome, quantidade: restante, valor: arredondarMoeda(item.precoPraticado * restante) });
      }
    } else {
      const solicitados = dto.itens ?? [];
      if (!solicitados.length) {
        throw ApiException.validation("Dados inválidos.", [{ field: "itens", message: "Selecione ao menos um item para devolver." }]);
      }
      for (const solicitado of solicitados) {
        const item = vendaAtual.itens.find((registro) => String(registro._id) === solicitado.itemId);
        if (!item) throw ApiException.notFound("Item da venda não encontrado.");
        const restante = item.quantidade - item.quantidadeDevolvida;
        const quantidade = Math.min(Math.max(0, Math.floor(solicitado.quantidade)), restante);
        if (quantidade <= 0) continue;
        await this.devolverAoEstoque(item, quantidade);
        devolvidos.push({ itemId: String(item._id), codProduto: item.codProduto, nome: item.nome, quantidade, valor: arredondarMoeda(item.precoPraticado * quantidade) });
      }
      if (!devolvidos.length) throw ApiException.validation("Nenhuma quantidade disponível para devolução.");
    }

    const valorDevolvido = arredondar(devolvidos.reduce((total, item) => total + item.valor, 0));
    const motivo = dto.motivo.trim();
    const agora = new Date();

    const venda = await this.vendasRepository.salvarComRetentativa(vendaId, (documento) => {
      if (documento.status === "cancelada") throw ApiException.validation("Esta venda já está cancelada.");

      for (const devolvido of devolvidos) {
        const item = documento.itens.find((registro) => String(registro._id) === devolvido.itemId);
        if (item) item.quantidadeDevolvida += devolvido.quantidade;
      }

      documento.valorDevolvido = arredondar(documento.valorDevolvido + valorDevolvido);
      documento.cancelamento = { tipo: dto.tipo, motivo, dataHora: agora, autor: "Backoffice", valorDevolvido, itens: devolvidos } as never;
      documento.historico.push({
        dataHora: agora,
        tipo: dto.tipo === "integral" ? "cancelamento" : "devolucao",
        descricao:
          dto.tipo === "integral" ? `Venda cancelada integralmente · ${motivo}` : `Devolução parcial de ${devolvidos.length} item(ns) · ${motivo}`,
        autor: "Backoffice",
      });

      const todosDevolvidos = documento.itens.every((item) => item.quantidadeDevolvida >= item.quantidade);
      if (dto.tipo === "integral" || todosDevolvidos) {
        documento.status = "cancelada";
        documento.valorPendente = 0;
      }
    });

    const valorParaCaixa = Math.min(valorDevolvido, venda.valorPago);
    if (valorParaCaixa > 0 && venda.caixaId) {
      await this.caixasService.registrarMovimentoDeVenda({
        caixaId: venda.caixaId,
        tipo: dto.tipo === "integral" ? "cancelamento" : "devolucao",
        descricao: dto.tipo === "integral" ? `Cancelamento da venda ${venda.codigo} · ${venda.clienteNome}` : `Devolução parcial da venda ${venda.codigo} · ${venda.clienteNome}`,
        referencia: venda.codigo,
        vendaId: venda.id,
        vendaCodigo: venda.codigo,
        formaPagamento: venda.formaPagamento,
        valor: valorParaCaixa,
        responsavelId: null,
        responsavelNome: "Backoffice",
        observacao: motivo,
      });
    }

    // `vendaAtual` já não podia estar cancelada aqui (a checagem no início da
    // função teria lançado antes) — se `venda.status` virou "cancelada" agora,
    // é esta chamada que fez a transição, e só então os agregados revertem.
    if (venda.status === "cancelada") {
      await this.reverterAgregados(venda);
    }

    await this.registrarEvento(venda.id, dto.tipo === "integral" ? "venda.cancelada" : "venda.devolvida", usuarioId, { valorDevolvido });
    return venda;
  }

  private async devolverAoEstoque(item: ItemVenda, quantidade: number): Promise<void> {
    if (!item.varianteId) return;
    await this.produtosService
      .ajustarQuantidadeTamanho(item.produtoId, item.varianteId, {
        tamanho: item.tamanho ?? undefined,
        delta: quantidade,
        exigirExistente: false,
      })
      .catch(() => undefined); // produto/variante pode ter sido excluído — não impede o cancelamento administrativo.
  }

  private montarParcelas(valorPendente: number, totalParcelas: number, dataVenda: Date) {
    const total = Math.max(1, totalParcelas);
    const valorParcela = arredondar(valorPendente / total);
    return Array.from({ length: total }, (_, indice) => {
      const numero = indice + 1;
      const vencimento = new Date(dataVenda);
      vencimento.setDate(vencimento.getDate() + indice * 30);
      const valor = numero === total ? arredondar(valorPendente - valorParcela * (total - 1)) : valorParcela;
      return { numero, total, valor, vencimento, pagoEm: null, formaPagamento: null };
    }) as never[];
  }

  private async atualizarAgregadosNaCriacao(venda: VendaDocument): Promise<void> {
    await this.vendedoresRepository.salvarComRetentativa(venda.vendedorId, (documento) => {
      documento.vendas += 1;
      documento.totalVendido = arredondar(documento.totalVendido + venda.valorFinal);
      documento.ultimaVenda = venda.dataVenda;
    });
    if (venda.clienteId) {
      await this.clientesRepository.salvarComRetentativa(venda.clienteId, (documento) => {
        documento.compras += 1;
        documento.totalComprado = arredondar(documento.totalComprado + venda.valorFinal);
        documento.ultimaCompra = venda.dataVenda;
      });
    }
  }

  /** Chamado só quando uma venda TRANSITA para cancelada — nunca em devolução parcial que mantém a venda ativa. */
  private async reverterAgregados(venda: VendaDocument): Promise<void> {
    await this.vendedoresRepository.salvarComRetentativa(venda.vendedorId, (documento) => {
      documento.vendas = Math.max(0, documento.vendas - 1);
      documento.totalVendido = arredondar(Math.max(0, documento.totalVendido - venda.valorFinal));
    });
    const ultimaVendedor = await this.vendasRepository.encontrarUltimaValidaPorVendedor(venda.vendedorId);
    await this.vendedoresRepository.salvarComRetentativa(venda.vendedorId, (documento) => {
      documento.ultimaVenda = ultimaVendedor?.dataVenda ?? null;
    });

    if (venda.clienteId) {
      await this.clientesRepository.salvarComRetentativa(venda.clienteId, (documento) => {
        documento.compras = Math.max(0, documento.compras - 1);
        documento.totalComprado = arredondar(Math.max(0, documento.totalComprado - venda.valorFinal));
      });
      const ultimaCliente = await this.vendasRepository.encontrarUltimaValidaPorCliente(venda.clienteId);
      await this.clientesRepository.salvarComRetentativa(venda.clienteId, (documento) => {
        documento.ultimaCompra = ultimaCliente?.dataVenda ?? null;
      });
    }
  }

  private async registrarEvento(vendaId: string | Types.ObjectId, tipo: string, usuarioId: string | null, detalhes: Record<string, unknown>): Promise<void> {
    await this.eventoModel.create({ vendaId, tipo, usuarioId, detalhes });
  }
}
