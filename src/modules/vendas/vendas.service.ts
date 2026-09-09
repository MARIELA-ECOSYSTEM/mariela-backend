import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model, Types } from "mongoose";
import { ApiException } from "../../common/exceptions/api.exception.js";
import type { ApiFacets, ApiMeta } from "../../common/types/api-response.interface.js";
import { AdquirentesService, type AdquirenteRespostaPublica } from "../adquirentes/adquirentes.service.js";
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
  MODALIDADES_PAGAMENTO,
  PREFIXO_CODIGO_VENDA,
  type ModalidadePagamento,
} from "./vendas.constants.js";
import type { SelecaoFacetas } from "./vendas-filtros.util.js";
import { VendasRepository } from "./vendas.repository.js";
import type { BaixarParcelaDto } from "./dto/baixar-parcela.dto.js";
import type { CancelamentoDto } from "./dto/cancelamento.dto.js";
import type { ListarVendasQueryDto } from "./dto/listar-vendas-query.dto.js";
import { EventoVenda, type EventoVendaDocument } from "./schemas/evento-venda.schema.js";
import type { ItemDevolvido, ItemVenda, PagamentoVenda, VendaDocument } from "./schemas/venda.schema.js";
import type { DadosCriarVenda, DadosPersistirVenda, Desconto, PagamentoSolicitado, TarifaAplicada } from "./vendas.types.js";

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
  /**
   * Deduplicação de criação EM MEMÓRIA, por processo — ver `criar()`. Mesma
   * limitação já aceita em outros pontos do projeto (`LoginThrottleService`):
   * não coordena entre múltiplas instâncias; aceitável para o estágio atual
   * (instância única). Chave = `idempotencyKey`; valor = a Promise da
   * execução em andamento, para que uma segunda chamada com a MESMA chave,
   * chegando enquanto a primeira ainda está no meio da baixa de estoque/
   * lançamento no caixa, espere o MESMO resultado em vez de reexecutar tudo
   * do zero (ver "Problemas encontrados" no relatório da Etapa 05 do PDV).
   */
  private readonly criacoesEmAndamento = new Map<string, Promise<VendaDocument>>();

  constructor(
    private readonly vendasRepository: VendasRepository,
    private readonly produtosService: ProdutosService,
    private readonly produtosRepository: ProdutosRepository,
    private readonly clientesRepository: ClientesRepository,
    private readonly vendedoresRepository: VendedoresRepository,
    private readonly caixasRepository: CaixasRepository,
    private readonly caixasService: CaixasService,
    private readonly sequenciasService: SequenciasService,
    private readonly adquirentesService: AdquirentesService,
    @InjectModel(EventoVenda.name) private readonly eventoModel: Model<EventoVendaDocument>,
  ) {}

  /**
   * Único ponto de criação de venda. Exposto ao MARIELA PDV via
   * `POST /pdv/vendas` (`PdvVendasService`) — nunca por nenhuma rota
   * administrativa do Backoffice.
   *
   * Camada FINA de deduplicação em torno de `criarInterno` (que contém toda a
   * regra de negócio, inalterada): se já existe uma execução em andamento
   * para a MESMA `idempotencyKey` (duas requisições praticamente simultâneas
   * — ex.: duplo toque no PDV), a segunda chamada aguarda e devolve o MESMO
   * resultado da primeira, em vez de baixar estoque/lançar caixa/atualizar
   * agregados duas vezes. Sem chave, nenhuma deduplicação é aplicada (mesmo
   * comportamento de sempre — usado hoje também pelos testes de integração).
   */
  async criar(dados: DadosCriarVenda, usuarioId: string | null): Promise<VendaDocument> {
    if (!dados.idempotencyKey) return this.criarInterno(dados, usuarioId);

    const chave = dados.idempotencyKey;
    const emAndamento = this.criacoesEmAndamento.get(chave);
    if (emAndamento) return emAndamento;

    const execucao = this.criarInterno(dados, usuarioId);
    this.criacoesEmAndamento.set(chave, execucao);
    try {
      return await execucao;
    } finally {
      this.criacoesEmAndamento.delete(chave);
    }
  }

  private async criarInterno(dados: DadosCriarVenda, usuarioId: string | null): Promise<VendaDocument> {
    if (dados.idempotencyKey) {
      const existente = await this.vendasRepository.encontrarPorIdempotencyKey(dados.idempotencyKey);
      // Etapa 10.6: a Venda já existe (retry) — NÃO cria outra, mas ainda
      // assim garante os movimentos de caixa dela (idempotentes por chave
      // determinística). Cobre o cenário "processo morreu entre persistir a
      // Venda e criar todos os movimentos": o retry cai aqui, encontra a
      // Venda pronta e só recria o que faltar — nunca duplica o que já existe.
      if (existente) {
        await this.garantirMovimentosDeCaixa(existente);
        return existente;
      }
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

      // Ordem obrigatória (seção 1 da Etapa 10.3): precoOriginal → precoPraticado
      // (promoção) → desconto do ITEM (sempre sobre o preço PRATICADO, nunca
      // sobre o de tabela — evita contar a promoção duas vezes) → subtotal do
      // item. Cada etapa é arredondada individualmente para não acumular erro
      // de ponto flutuante (mesmo padrão `Number(valor.toFixed(2))` já usado
      // em todo o projeto).
      const precoOriginal = arredondar(produto.precoVenda);
      const precoPraticado = arredondar(precoEfetivo(produto));
      const valorBrutoItem = arredondar(precoPraticado * solicitado.quantidade);
      const descontoItem = this.resolverDesconto(solicitado.desconto, valorBrutoItem, "itens");
      const subtotalItem = arredondar(valorBrutoItem - descontoItem);

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
        descontoItem,
        subtotal: subtotalItem,
        quantidadeDevolvida: 0,
      } as ItemVenda);
    }

    const valorBruto = arredondar(itensMontados.reduce((total, item) => total + item.precoOriginal * item.quantidade, 0));
    const descontoPromocional = arredondar(
      itensMontados.reduce((total, item) => total + (item.precoOriginal - item.precoPraticado) * item.quantidade, 0),
    );
    const descontoItensTotal = arredondar(itensMontados.reduce((total, item) => total + item.descontoItem, 0));
    // Subtotal da venda = soma dos subtotais dos itens (seção 1, passo 5) —
    // já reflete promoção E desconto de item; o desconto da venda incide
    // sobre ESTE valor, nunca sobre `valorBruto` diretamente.
    const subtotalVenda = arredondar(itensMontados.reduce((total, item) => total + item.subtotal, 0));
    const descontoVenda = this.resolverDesconto(dados.descontoVenda, subtotalVenda, "descontoVenda");
    const valorFinal = arredondar(subtotalVenda - descontoVenda);

    // Validação de pagamentos (Etapa 10.4: inclui modalidade/adquirente/
    // parcelamento estruturados) ANTES de qualquer baixa de estoque — nunca
    // vale a pena baixar estoque só para descobrir depois que o pagamento
    // era inválido (adquirente inexistente/inativa, parcelamento não
    // configurado, etc.). `adquirentesCache` evita consultar a mesma
    // adquirente mais de uma vez quando a venda tem múltiplos pagamentos
    // apontando para o mesmo `adquirenteId` (mesmo padrão de `produtosCache`
    // acima, para o mesmo tipo de motivo).
    const dataVenda = new Date();
    const adquirentesCache = new Map<string, AdquirenteRespostaPublica>();
    const pagamentos: PagamentoVenda[] = [];
    for (const pagamento of dados.pagamentos ?? []) {
      const estruturado = await this.validarPagamentoEstruturado(pagamento, adquirentesCache);
      pagamentos.push({
        forma: pagamento.forma,
        valor: arredondar(pagamento.valor),
        dataPagamento: dataVenda,
        parcelas: estruturado.parcelas,
        observacao: pagamento.observacao ?? null,
        modalidade: estruturado.modalidade,
        adquirenteId: estruturado.adquirenteId,
        tarifaAplicada: estruturado.tarifaAplicada,
      } as PagamentoVenda);
    }
    const valorPago = arredondar(pagamentos.reduce((total, item) => total + item.valor, 0));
    if (valorPago > valorFinal) {
      throw ApiException.validation("Dados inválidos.", [{ field: "pagamentos", message: "A soma dos pagamentos não pode exceder o valor final." }]);
    }
    const valorPendente = arredondar(Math.max(0, valorFinal - valorPago));

    // Etapa 10.7: venda fiada exige um cliente identificável — nunca uma
    // dívida lançada para "Consumidor final", que não é rastreável. Checado
    // ANTES de baixar estoque/persistir (nenhuma escrita ainda ocorreu neste
    // ponto — nem venda, nem movimento de caixa, nem estoque). `!dados.clienteId`
    // cobre ausente/`null`/`""` uniformemente (mesmo critério de truthiness
    // já usado para resolver `clienteNome` acima); a tarifa (Etapa 10.5)
    // nunca entra nesta conta — `valorPendente` já é calculado sobre o valor
    // BRUTO pago, exatamente como antes desta etapa.
    if (valorPendente > 0 && !dados.clienteId) {
      throw ApiException.validation("Dados inválidos.", [
        { field: "clienteId", message: "Cliente é obrigatório para vendas com saldo pendente (venda fiada)." },
      ]);
    }

    const parcelas = valorPendente > 0 ? this.montarParcelas(valorPendente, dados.totalParcelas ?? 1, dataVenda) : [];

    // Baixa o estoque item a item; se algum falhar (corrida entre a
    // pré-checagem e agora), desfaz (devolve) o que já foi baixado nesta
    // mesma tentativa antes de propagar o erro — nunca deixa a venda "meio
    // baixada". Ver "Pendências" no relatório sobre o limite desta estratégia
    // sem transações multi-documento. Deliberadamente a ÚLTIMA validação
    // antes de qualquer escrita (Etapa 10.4, seção 19/21 do pedido): todos os
    // dados (itens, descontos, pagamentos/adquirente/parcelamento) já foram
    // validados acima sem nenhum efeito colateral no banco.
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
      // Agora soma as TRÊS fontes de desconto (promocional + item + venda) —
      // generalização direta da fórmula já existente (antes só promocional +
      // venda, porque desconto de item não existia). Preserva o invariante
      // `valorFinal = valorBruto - descontoTotal` usado pelo Backoffice
      // (`descontoConcedido` em `estatisticas()`).
      descontoTotal: arredondar(descontoPromocional + descontoItensTotal + descontoVenda),
      valorFinal,
      valorPago,
      valorPendente,
      valorDevolvido: 0,
      temPromocao: descontoPromocional > 0,
      // Passa a refletir QUALQUER desconto manual (item OU venda), não só o
      // da venda — mesmo princípio de `temPromocao`, mas para desconto
      // operado pelo vendedor em vez de automático.
      temDesconto: descontoItensTotal > 0 || descontoVenda > 0,
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

    // Etapa 10.6: 1 movimento de caixa POR PAGAMENTO (nunca mais um único
    // agregado usando só a primeira forma) — ver `garantirMovimentosDeCaixa`.
    await this.garantirMovimentosDeCaixa(venda);

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

  /**
   * Resolve a INTENÇÃO de desconto (percentual ou valor absoluto — seção 2 da
   * Etapa 10.3) num valor MONETÁRIO concreto, validado contra a base sobre a
   * qual incide. Compartilhado entre desconto de item (`base` = preço
   * praticado × quantidade dessa linha) e desconto da venda (`base` =
   * subtotal da venda, já com os descontos de item aplicados) — mesma regra,
   * duas bases diferentes, nunca duas implementações.
   *
   * Retrocompatibilidade: um `number` puro é tratado como
   * `{ tipo: "valor", valor }` — o contrato que `descontoVenda` sempre teve
   * antes desta etapa continua funcionando sem nenhuma mudança no chamador.
   *
   * Nunca persiste o percentual como autoridade: o retorno é sempre o valor
   * monetário já resolvido e arredondado.
   */
  private resolverDesconto(bruto: number | Desconto | null | undefined, base: number, campo: string): number {
    if (bruto === undefined || bruto === null) return 0;
    const desconto: Desconto = typeof bruto === "number" ? { tipo: "valor", valor: bruto } : bruto;

    if (!Number.isFinite(desconto.valor) || desconto.valor < 0) {
      throw ApiException.validation("Dados inválidos.", [{ field: campo, message: "Desconto não pode ser negativo." }]);
    }

    let valorMonetario: number;
    if (desconto.tipo === "percentual") {
      if (desconto.valor > 100) {
        throw ApiException.validation("Dados inválidos.", [{ field: campo, message: "Percentual de desconto não pode ultrapassar 100%." }]);
      }
      valorMonetario = arredondar((base * desconto.valor) / 100);
    } else {
      valorMonetario = arredondar(desconto.valor);
    }

    if (valorMonetario > base) {
      throw ApiException.validation("Dados inválidos.", [
        { field: campo, message: "Desconto não pode ultrapassar o valor sobre o qual está sendo aplicado." },
      ]);
    }

    return valorMonetario;
  }

  /**
   * Resolve e valida a modalidade estruturada de um pagamento (Etapa 10.4) e,
   * quando débito/crédito, calcula e devolve o snapshot da tarifa aplicada
   * (Etapa 10.5). NUNCA confia no que o PDV exibiu como opções válidas —
   * sempre consulta o `AdquirentesService` de novo (nunca acesso direto ao
   * Mongo de Adquirentes a partir daqui). `forma` continua sendo só o texto
   * histórico/apresentacional e nunca é usado para decidir nenhuma regra
   * abaixo.
   *
   * Retrocompatível: `modalidade` ausente/`null` = pagamento LEGADO — nenhuma
   * das regras novas se aplica, `modalidade`/`adquirenteId`/`tarifaAplicada`
   * são persistidos como `null` e `parcelas` mantém o comportamento de sempre
   * (`?? 1`). Idem para "dinheiro"/"pix": nunca têm `tarifaAplicada` (nunca um
   * objeto com percentual/valores zerados fingindo que houve tarifa).
   *
   * O cálculo (`valorTarifa = valorBruto × percentual / 100`,
   * `valorLiquido = valorBruto - valorTarifa`) NUNCA reduz `pagamento.valor`
   * — `valorPago`/`valorPendente`/`valorFinal` continuam inteiramente sobre o
   * valor BRUTO (seção 1 do pedido); a tarifa é só informação financeira
   * adicional guardada dentro do próprio pagamento.
   */
  private async validarPagamentoEstruturado(
    pagamento: PagamentoSolicitado,
    adquirentesCache: Map<string, AdquirenteRespostaPublica>,
  ): Promise<{ modalidade: ModalidadePagamento | null; adquirenteId: string | null; parcelas: number; tarifaAplicada: TarifaAplicada | null }> {
    if (pagamento.modalidade === undefined || pagamento.modalidade === null) {
      return { modalidade: null, adquirenteId: null, parcelas: pagamento.parcelas ?? 1, tarifaAplicada: null };
    }

    if (!(MODALIDADES_PAGAMENTO as readonly string[]).includes(pagamento.modalidade)) {
      throw ApiException.validation("Dados inválidos.", [{ field: "pagamentos", message: "Modalidade de pagamento inválida." }]);
    }
    const modalidade = pagamento.modalidade;

    // "debito"/"credito" são exatamente as modalidades que existem na tabela
    // de tarifas de um Adquirente (`MODALIDADES_TARIFA`) — é essa mesma lista
    // (importada em `vendas.constants.ts`) que decide se a modalidade exige
    // adquirente, nunca uma segunda lista hardcoded aqui.
    const exigeAdquirente = modalidade === "debito" || modalidade === "credito";

    if (!exigeAdquirente) {
      if (pagamento.adquirenteId) {
        throw ApiException.validation("Dados inválidos.", [
          { field: "pagamentos", message: `Adquirente não deve ser informado para pagamento em ${modalidade === "dinheiro" ? "dinheiro" : "PIX"}.` },
        ]);
      }
      return { modalidade, adquirenteId: null, parcelas: pagamento.parcelas ?? 1, tarifaAplicada: null };
    }

    if (!pagamento.adquirenteId) {
      throw ApiException.validation("Dados inválidos.", [
        { field: "pagamentos", message: `Adquirente é obrigatório para pagamento no ${modalidade === "credito" ? "crédito" : "débito"}.` },
      ]);
    }

    let adquirente = adquirentesCache.get(pagamento.adquirenteId);
    if (!adquirente) {
      // `AdquirentesService.obterPorId` já lança NOT_FOUND se não existir —
      // mesmo padrão de erro já usado em todo o projeto, sem código novo.
      adquirente = await this.adquirentesService.obterPorId(pagamento.adquirenteId);
      adquirentesCache.set(pagamento.adquirenteId, adquirente);
    }
    if (!adquirente.ativo) {
      throw ApiException.validation("Dados inválidos.", [{ field: "pagamentos", message: "A adquirente informada está inativa." }]);
    }

    let parcelas: number;
    if (modalidade === "debito") {
      parcelas = pagamento.parcelas ?? 1;
      if (parcelas !== 1) {
        throw ApiException.validation("Dados inválidos.", [{ field: "pagamentos", message: "Pagamento no débito deve ser em 1 parcela." }]);
      }
    } else {
      if (pagamento.parcelas === undefined || pagamento.parcelas === null) {
        throw ApiException.validation("Dados inválidos.", [{ field: "pagamentos", message: "Parcelamento no crédito deve ser informado." }]);
      }
      if (pagamento.parcelas < 1 || pagamento.parcelas > 24) {
        throw ApiException.validation("Dados inválidos.", [
          { field: "pagamentos", message: "Parcelamento no crédito deve estar entre 1 e 24 parcelas." },
        ]);
      }
      parcelas = pagamento.parcelas;
    }

    // A CONFIGURAÇÃO é a autoridade (seção 5 do pedido) — 6x só é válido se a
    // adquirente tiver, de fato, uma tarifa cadastrada para (modalidade,
    // parcelas), mesmo que 6 esteja dentro do intervalo genérico 1–24. Usa
    // `find` (não `some`) porque a Etapa 10.5 precisa do `percentual` da
    // entrada encontrada para calcular a tarifa logo abaixo — mesma consulta,
    // sem uma segunda busca.
    const entradaTarifa = adquirente.tabelaTarifas.find((tarifa) => tarifa.modalidade === modalidade && tarifa.parcelas === parcelas);
    if (!entradaTarifa) {
      const rotulo = modalidade === "credito" ? `Crédito em ${parcelas}x` : "Pagamento no débito";
      throw ApiException.validation("Dados inválidos.", [
        { field: "pagamentos", message: `${rotulo} não está configurado para esta adquirente.` },
      ]);
    }

    // Etapa 10.5: `valorBruto` aqui é o mesmo `arredondar(pagamento.valor)`
    // que o chamador (`criarInterno`) usa para `PagamentoVenda.valor` — a
    // tarifa é calculada sobre o valor bruto DESTE pagamento, nunca sobre o
    // total da venda (seção 10 do pedido: cada pagamento é independente).
    const valorBruto = arredondar(pagamento.valor);
    const valorTarifa = arredondar((valorBruto * entradaTarifa.percentual) / 100);
    const valorLiquido = arredondar(valorBruto - valorTarifa);

    const tarifaAplicada: TarifaAplicada = {
      adquirenteId: adquirente.id,
      adquirenteNome: adquirente.nome,
      modalidade,
      parcelas,
      percentual: entradaTarifa.percentual,
      valorBruto,
      valorTarifa,
      valorLiquido,
    };

    return { modalidade, adquirenteId: pagamento.adquirenteId, parcelas, tarifaAplicada };
  }

  /**
   * Etapa 10.6 — 1 movimento de caixa POR PAGAMENTO da venda (nunca mais um
   * único movimento agregado usando só a primeira forma de pagamento).
   * Idempotente por pagamento via uma chave DETERMINÍSTICA (nunca UUID
   * aleatório — precisa ser reproduzível em qualquer retry):
   *
   *   `${venda.idempotencyKey ?? venda.id}:pagamento:${indice}`
   *
   * Chamado em DOIS pontos de `criarInterno`: (1) logo após persistir uma
   * venda nova, e (2) quando um retry encontra a venda JÁ existente
   * (idempotência de Venda) — nos dois casos o efeito é o mesmo: cada
   * pagamento tenta criar seu movimento; o que já existe (mesma chave) é
   * devolvido sem duplicar pelo mecanismo já corrigido na Etapa 10.2
   * (`MovimentosCaixaRepository.criar` captura o erro 11000 de
   * `idempotencyKey` e devolve o vencedor da corrida). Isso cobre
   * exatamente o cenário "processo morreu entre persistir a Venda e criar
   * todos os movimentos": o retry não recria a venda, e recria só os
   * movimentos que estiverem faltando — os que já existem são ignorados
   * pela idempotência, nunca duplicados.
   *
   * A tarifa (Etapa 10.5) NUNCA altera o valor do movimento: cada movimento
   * sempre representa o valor BRUTO daquele pagamento (`pagamento.valor`),
   * nunca o valor líquido pós-tarifa — o Caixa reflete o que o cliente
   * efetivamente pagou, não a liquidação da adquirente.
   */
  private async garantirMovimentosDeCaixa(venda: VendaDocument): Promise<void> {
    if (!venda.caixaId) return;
    const chaveBase = venda.idempotencyKey ?? venda.id;

    for (let indice = 0; indice < venda.pagamentos.length; indice += 1) {
      const pagamento = venda.pagamentos[indice]!;
      if (pagamento.valor <= 0) continue; // defensivo — o DTO já exige valor positivo em cada pagamento.

      await this.caixasService.registrarMovimentoDeVenda({
        caixaId: venda.caixaId,
        tipo: "venda",
        descricao: `Venda ${venda.codigo} · ${venda.clienteNome} · ${pagamento.forma}`,
        referencia: venda.codigo,
        vendaId: venda.id,
        vendaCodigo: venda.codigo,
        formaPagamento: pagamento.forma,
        valor: pagamento.valor,
        responsavelId: null,
        responsavelNome: venda.vendedorNome,
        observacao: "",
        idempotencyKey: `${chaveBase}:pagamento:${indice}`,
      });
    }
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
