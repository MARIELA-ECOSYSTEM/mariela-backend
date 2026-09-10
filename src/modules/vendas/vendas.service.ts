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
import { precoEfetivo } from "../produtos/utils/precos.util.js";
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
import type { CancelamentoVenda, ItemDevolvido, ItemVenda, PagamentoVenda, VendaDocument } from "./schemas/venda.schema.js";
import type { DadosCriarVenda, DadosPersistirVenda, DadosReceberPagamento, Desconto, PagamentoSolicitado, TarifaAplicada } from "./vendas.types.js";

export interface ResultadoListaVendas {
  data: VendaDocument[];
  meta: ApiMeta;
  facets: ApiFacets;
}

/**
 * Etapa 18.17 — usa `Math.round`, NUNCA `Number(valor.toFixed(2))`: as duas
 * estratégias divergem em valores de meio-centavo exato (ex.: `0.015` vira
 * `0.01` com `toFixed` mas `0.02` com `Math.round`, comprovado empiricamente
 * na Etapa 18.16 para o mesmo problema em `caixas/dinheiro.util.ts`). Aqui o
 * risco é maior que em Caixa: `resolverDesconto` calcula `(base * percentual) / 100`
 * — uma divisão que frequentemente produz um resultado intermediário de
 * mais de 2 casas decimais antes de arredondar — e é exatamente esse tipo de
 * conta que pode pousar num meio-centavo exato. `Math.round` é o mesmo
 * algoritmo de `produtos/utils/precos.util.ts#arredondarMoeda`, a fonte de
 * verdade de arredondamento monetário do projeto.
 */
function arredondar(valor: number): number {
  return Math.round(valor * 100) / 100;
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
      //
      // Etapa 10.14 — CONFLITO DE CHAVE: antes de tratar isto como replay,
      // confirma que `existente` representa a MESMA operação lógica (mesmo
      // vendedor/caixa/itens) — nunca devolve silenciosamente a venda de
      // OUTRO pedido só porque a `idempotencyKey` (uma string arbitrária do
      // chamador) coincidiu. Ver `verificarMesmaOperacaoDeCriacao`.
      if (existente) {
        this.verificarMesmaOperacaoDeCriacao(dados, existente);
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

  /**
   * Etapa 10.14 — verifica que uma venda encontrada por `idempotencyKey`
   * (replay) representa de fato a MESMA operação solicitada agora, não uma
   * OUTRA venda cujo chamador, por coincidência ou erro, reutilizou a mesma
   * chave (`idempotencyKey` é uma string arbitrária do cliente — nada no
   * banco impede reuso indevido). Comparação DELIBERADAMENTE leve
   * (vendedor, caixa e o "formato" dos itens — produto/variante/quantidade,
   * na mesma ordem) — o bastante para detectar com segurança um
   * pedido genuinamente diferente, sem recalcular preço/desconto/tarifa
   * (que já pertencem exclusivamente a `criarInterno`). Diferença encontrada
   * → `ApiException.conflict` (código já existente, reaproveitado — nunca
   * um código novo); nunca devolve silenciosamente o resultado da operação
   * errada.
   */
  private verificarMesmaOperacaoDeCriacao(dados: DadosCriarVenda, existente: VendaDocument): void {
    const itensBatem =
      dados.itens.length === existente.itens.length &&
      dados.itens.every((solicitado, indice) => {
        const persistido = existente.itens[indice];
        return (
          persistido !== undefined &&
          solicitado.produtoId === persistido.produtoId &&
          solicitado.varianteId === persistido.varianteId &&
          solicitado.quantidade === persistido.quantidade
        );
      });

    if (existente.vendedorId !== dados.vendedorId || existente.caixaId !== dados.caixaId || !itensBatem) {
      throw ApiException.conflict(
        "Esta idempotencyKey já foi usada para registrar uma venda diferente. Gere uma nova chave para esta operação.",
      );
    }
  }

  /**
   * Etapa 18.25 — contrato LEGADO do Backoffice (`GET /vendas` sem nenhum
   * query param), mesmo padrão já aprovado em Clientes/Fornecedores/Coleções/
   * Campanhas/Vendedores/Caixas: devolve TODAS as vendas, sem truncar pelo
   * `limit` padrão de `listar()`. Ver `VendasController.listar` para a
   * decisão de qual contrato usar.
   */
  async listarTodas(): Promise<VendaDocument[]> {
    return this.vendasRepository.listarTodas();
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

  /**
   * Baixa de uma parcela pré-calculada em `montarParcelas` — SEMPRE quitada
   * por inteiro (nunca parcialmente; ver "regra de domínio" no relatório da
   * Etapa 10.11 sobre por que não existe baixa parcial de uma parcela
   * individual — isso é papel de `receberPagamento`, que opera sobre
   * `valorPendente` da venda inteira, não sobre uma parcela específica).
   *
   * Etapa 10.11 — PAGAMENTO ESTRUTURADO: `modalidade`/`adquirenteId`/
   * `parcelas` (opcionais, aditivos) são validados e a tarifa é calculada
   * reaproveitando `validarPagamentoEstruturado` — a MESMA função usada por
   * `criar()`/`receberPagamento()`, sem nenhuma regra duplicada. Sem
   * `modalidade` (contrato legado, ex.: `{ formaPagamento: "PIX" }` ou `{}`),
   * o comportamento é idêntico ao de antes desta etapa: `tarifaAplicada`
   * fica `null`.
   *
   * Etapa 10.10/10.11 — CAIXA ATUAL: resolvido uma única vez no início (fail
   * fast), nunca `venda.caixaId` (ver `cancelar`/`receberPagamento`).
   *
   * Idempotência (Etapa 10.11, NOVA): `dto.idempotencyKey`, opcional,
   * fornecida pelo chamador (nunca gerada aqui). Cobre o cenário "processo
   * morreu entre salvar a venda e lançar o movimento de caixa": sem chave,
   * uma segunda tentativa encontraria `parcela.pagoEm` já setado e seria
   * rejeitada como "já baixada" — mesmo que o movimento de caixa nunca
   * tivesse sido criado, deixando a baixa presa sem receita registrada. Com
   * a chave, o replay é detectado ANTES dessa checagem (mesmo padrão de
   * `receberPagamento`) e apenas garante o movimento, sem reaplicar a baixa.
   *
   * Concorrência: preservada — a checagem `parcela.pagoEm` é reavaliada
   * DENTRO do callback de `salvarComRetentativa`, contra o documento
   * recém-lido a cada tentativa; duas baixas concorrentes da MESMA parcela
   * nunca resultam em dois pagamentos (a segunda encontra `pagoEm` já
   * setado e é rejeitada).
   */
  async baixarParcela(vendaId: string, parcelaId: string, dto: BaixarParcelaDto, usuarioId: string | null): Promise<VendaDocument> {
    const vendaAtual = await this.vendasRepository.encontrarPorIdOuFalhar(vendaId);
    if (vendaAtual.status === "cancelada") throw ApiException.validation("Venda cancelada não aceita novas baixas.");

    const caixaAtual = await this.caixasService.obterAtual();
    if (!caixaAtual) {
      throw ApiException.validation("Nenhum caixa aberto. Abra o caixa antes de registrar a baixa.");
    }

    const parcelaAtual = vendaAtual.parcelas.find((item) => String(item._id) === parcelaId);
    if (!parcelaAtual) throw ApiException.notFound("Parcela não encontrada.");

    // Replay: já processado antes (crash entre salvar a venda e lançar o
    // caixa) — só garante o movimento, nunca reaplica a baixa nem recalcula
    // tarifa. Etapa 10.14 — CONFLITO DE CHAVE: um pagamento com esta chave
    // existe, mas a PARCELA pedida agora continua em aberto (`pagoEm: null`)
    // — a chave pertence à baixa de OUTRA parcela desta mesma venda, nunca
    // um replay desta. Nunca reconcilia a parcela errada.
    //
    // Etapa 10.15 — AUDITORIA: `parcelaAtual.pagoEm` truthy sozinho não prova
    // que foi ESTE pagamento que a quitou — a parcela pedida agora pode já
    // ter sido baixada por OUTRO meio (chave diferente) enquanto a chave
    // informada pertence à baixa de uma parcela DIFERENTE desta mesma venda
    // (ex.: caller reaproveita por engano uma `idempotencyKey` já usada numa
    // parcela anterior). `PagamentoVenda` não guarda qual parcela originou o
    // pagamento, então `existente.valor === parcelaAtual.valor` é o proxy
    // mais forte disponível para confirmar que o pagamento encontrado é
    // realmente desta parcela — sem essa checagem, o caller receberia uma
    // resposta "de sucesso" (o estado atual da venda, já pago por outro
    // meio) para uma chave que, na verdade, nunca baixou ESTA parcela.
    if (dto.idempotencyKey) {
      const existente = vendaAtual.pagamentos.find((pagamento) => pagamento.idempotencyKey === dto.idempotencyKey);
      if (existente && parcelaAtual.pagoEm && existente.valor === parcelaAtual.valor) {
        await this.garantirMovimentoDeBaixaParcela(caixaAtual.id, vendaAtual, dto.idempotencyKey, existente, parcelaAtual.numero, parcelaAtual.total);
        return vendaAtual;
      }
      if (existente) {
        throw ApiException.conflict("Esta idempotencyKey já foi usada para baixar outra parcela desta venda. Gere uma nova chave para esta operação.");
      }
    }

    if (parcelaAtual.pagoEm) throw ApiException.validation("Esta parcela já está baixada.");

    // Etapa 10.12 — AUDITORIA: `baixarParcela` só verificava se a PRÓPRIA
    // parcela já estava paga, nunca se a VENDA ainda tinha saldo suficiente
    // para cobri-la. Como `receberPagamento` reduz `valorPendente` sem tocar
    // em `parcelas[]` (separação de responsabilidades aprovada — Etapa
    // 10.11), uma venda podia ter seu saldo quitado via `receberPagamento` e,
    // em seguida, uma parcela ainda marcada como aberta (`pagoEm: null`) podia
    // ser baixada por cima, empurrando `valorPago` para além de `valorFinal`
    // — violação direta do invariante `valorPago <= valorFinal`. Checado aqui
    // (fail fast) e de novo dentro do retry contra o documento fresco.
    if (parcelaAtual.valor > vendaAtual.valorPendente) {
      throw ApiException.validation("Dados inválidos.", [
        {
          field: "valor",
          message: `O valor da parcela (${parcelaAtual.valor.toFixed(2)}) excede o saldo pendente da venda (${vendaAtual.valorPendente.toFixed(2)}).`,
        },
      ]);
    }

    // Uma parcela é quitada por inteiro — `valor`, quando informado, é só uma
    // confirmação defensiva do valor esperado (protege contra um bug de UI
    // enviando a quantia errada), nunca um valor livre/parcial.
    if (dto.valor !== undefined) {
      const valorInformado = arredondar(dto.valor);
      if (valorInformado !== parcelaAtual.valor) {
        throw ApiException.validation("Dados inválidos.", [
          {
            field: "valor",
            message: `O valor informado (${valorInformado.toFixed(2)}) não corresponde ao valor da parcela (${parcelaAtual.valor.toFixed(2)}).`,
          },
        ]);
      }
    }

    const forma = dto.formaPagamento?.trim() || vendaAtual.formaPagamento;
    // Reaproveita EXATAMENTE a mesma validação de modalidade/adquirente/tarifa
    // de `criar()`/`receberPagamento()` — sem `modalidade`, devolve os nulls
    // legados (mesmo contrato de sempre), sem nenhuma lógica duplicada aqui.
    const adquirentesCache = new Map<string, AdquirenteRespostaPublica>();
    const estruturado = await this.validarPagamentoEstruturado(
      { forma, valor: parcelaAtual.valor, modalidade: dto.modalidade, adquirenteId: dto.adquirenteId, parcelas: dto.parcelas, observacao: dto.observacao },
      adquirentesCache,
    );

    let pagamentoAplicado: PagamentoVenda | null = null;

    const venda = await this.vendasRepository.salvarComRetentativa(vendaId, (documento) => {
      if (documento.status === "cancelada") throw ApiException.validation("Venda cancelada não aceita novas baixas.");
      const parcela = documento.parcelas.find((item) => String(item._id) === parcelaId);
      if (!parcela) throw ApiException.notFound("Parcela não encontrada.");
      if (dto.idempotencyKey) {
        const existentePagamento = documento.pagamentos.find((pagamento) => pagamento.idempotencyKey === dto.idempotencyKey);
        // Etapa 10.15 — mesmo raciocínio do fail-fast acima: só reconhece
        // como replay se o VALOR do pagamento encontrado bater com o desta
        // parcela (proxy de que é realmente o pagamento DELA, não de outra
        // parcela desta venda que coincidentemente também já está paga).
        if (existentePagamento && parcela.pagoEm && existentePagamento.valor === parcela.valor) {
          // Concorrência: outra tentativa com a MESMA chave já baixou ESTA
          // parcela enquanto esta rodava — reconhece como replay.
          pagamentoAplicado = existentePagamento;
          return;
        }
        if (existentePagamento) {
          throw ApiException.conflict("Esta idempotencyKey já foi usada para baixar outra parcela desta venda. Gere uma nova chave para esta operação.");
        }
      }
      if (parcela.pagoEm) throw ApiException.validation("Esta parcela já está baixada.");
      // Reavaliado contra o documento FRESCO a cada tentativa (Etapa 10.12) —
      // mesma proteção do fail-fast acima, mas agora segura sob concorrência
      // real (ex.: um `receberPagamento` concorrente reduzindo o saldo entre
      // a checagem inicial e esta tentativa).
      if (parcela.valor > documento.valorPendente) {
        throw ApiException.validation("Dados inválidos.", [
          {
            field: "valor",
            message: `O valor da parcela (${parcela.valor.toFixed(2)}) excede o saldo pendente da venda (${documento.valorPendente.toFixed(2)}).`,
          },
        ]);
      }

      const agora = new Date();
      parcela.pagoEm = agora;
      parcela.formaPagamento = forma;

      documento.pagamentos.push({
        forma,
        valor: parcela.valor,
        dataPagamento: agora,
        parcelas: estruturado.parcelas,
        observacao: dto.observacao?.trim() || `Parcela ${parcela.numero}/${parcela.total} (baixa no backoffice)`,
        modalidade: estruturado.modalidade,
        adquirenteId: estruturado.adquirenteId,
        tarifaAplicada: estruturado.tarifaAplicada,
        idempotencyKey: dto.idempotencyKey ?? null,
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

      pagamentoAplicado = documento.pagamentos[documento.pagamentos.length - 1]!;
    });

    if (pagamentoAplicado) {
      await this.garantirMovimentoDeBaixaParcela(caixaAtual.id, venda, dto.idempotencyKey, pagamentoAplicado, parcelaAtual.numero, parcelaAtual.total);
    }

    await this.registrarEvento(venda.id, "venda.parcela_baixada", usuarioId, { parcelaId, valor: parcelaAtual.valor });
    return venda;
  }

  /**
   * Registra um RECEBIMENTO POSTERIOR contra o saldo pendente de uma venda já
   * criada (Etapa 10.8) — mecanismo isolado e ADICIONAL a `baixarParcela`
   * (que só quita o valor FIXO de uma parcela pré-calculada em
   * `montarParcelas`): aqui o valor é livre — qualquer quantia, desde que não
   * ultrapasse `valorPendente` — com suporte completo a modalidade/
   * adquirente/tarifa, reaproveitando `validarPagamentoEstruturado` sem
   * duplicar NENHUMA das regras das Etapas 10.4/10.5.
   *
   * Ordem de validação (seção 21 do pedido — nenhum efeito colateral antes de
   * qualquer rejeição): venda existe → não cancelada → (replay de
   * idempotência, se houver) → valor > 0 → modalidade/adquirente/tarifa
   * válidos → dentro do retry de concorrência: não cancelada (de novo, contra
   * o documento fresco) → ainda há saldo pendente → valor não excede o saldo
   * → só then persiste. Não baixa estoque (já baixado na criação — seção 14)
   * nem recalcula desconto/preço praticado (seção 15): o valor devido já
   * pertence ao snapshot da venda.
   *
   * Concorrência: mesmo padrão de `baixarParcela`/`cancelar` — a validação
   * "valor não excede o saldo" é reavaliada DENTRO do callback de
   * `salvarComRetentativa`, contra o documento recém-lido a cada tentativa
   * (nunca contra uma cópia capturada antes do loop). Sob duas requisições
   * concorrentes disputando o mesmo saldo, a que perder a corrida de escrita
   * relê o saldo já reduzido pela vencedora e rejeita corretamente se o seu
   * valor não couber mais — nunca ultrapassa `valorFinal` nem deixa
   * `valorPendente` negativo.
   *
   * Idempotência: chave DETERMINÍSTICA fornecida pelo chamador
   * (`dados.idempotencyKey`, mesmo padrão de `DadosCriarVenda` — nunca um
   * UUID gerado aqui). Se um pagamento com essa chave já existe na venda, a
   * operação é um NO-OP para o valorPago/valorPendente (nunca reaplicada) —
   * mas o movimento de caixa correspondente é sempre RE-GARANTIDO (chave
   * derivada `${idempotencyKey}:recebimento`, idempotente por construção via
   * `MovimentosCaixaRepository`), cobrindo o mesmo cenário "processo morreu
   * entre salvar a venda e lançar o caixa" já tratado em
   * `garantirMovimentosDeCaixa`. Sem `idempotencyKey`, nenhuma deduplicação é
   * aplicada (mesmo comportamento de sempre para chamadas sem chave).
   *
   * Atomicidade: a venda é salva PRIMEIRO; o movimento de caixa é lançado
   * DEPOIS — mesma ordem e mesma limitação já aceitas em `criarInterno` (sem
   * transação multi-documento nesta etapa; ver "Riscos" no relatório).
   *
   * Etapa 10.10 — CAIXA ATUAL, nunca `venda.caixaId`: o recebimento é lançado
   * no caixa ATUALMENTE aberto, resolvido uma única vez logo no início (antes
   * de qualquer mutação da venda). Motivo: `registrarMovimentoDeVenda` rejeita
   * lançamento num caixa fechado (`exigirAberto`), e o caixa em que a venda
   * original foi criada quase certamente já está fechado quando o cliente
   * volta, dias ou semanas depois, para pagar o saldo — usar `venda.caixaId`
   * (como a Etapa 10.8 fazia) tornava essa chamada permanentemente impossível
   * de completar assim que esse caixa fechasse (o erro só aconteceria DEPOIS
   * de `valorPago` já ter sido incrementado e salvo, deixando a venda com o
   * pagamento aplicado mas sem o movimento correspondente). Resolver o caixa
   * ANTES da mutação evita esse estado parcial no caminho comum; a única
   * janela residual (caixa fecha entre esta checagem e o lançamento do
   * movimento, alguns milissegundos depois) é recuperável por retry com a
   * mesma `idempotencyKey` — mesma classe de limitação já aceita em toda
   * operação financeira deste serviço sem transação multi-documento.
   */
  async receberPagamento(vendaId: string, dados: DadosReceberPagamento, usuarioId: string | null): Promise<VendaDocument> {
    const vendaAtual = await this.vendasRepository.encontrarPorIdOuFalhar(vendaId);
    if (vendaAtual.status === "cancelada") {
      throw ApiException.validation("Venda cancelada não aceita novos recebimentos.");
    }

    const caixaAtual = await this.caixasService.obterAtual();
    if (!caixaAtual) {
      throw ApiException.validation("Nenhum caixa aberto. Abra o caixa antes de registrar o recebimento.");
    }

    const valor = arredondar(dados.valor);
    if (!Number.isFinite(valor) || valor <= 0) {
      throw ApiException.validation("Dados inválidos.", [{ field: "valor", message: "O valor recebido deve ser maior que zero." }]);
    }

    // Etapa 10.14 — CONFLITO DE CHAVE: um pagamento com esta chave já existe,
    // mas com um valor DIFERENTE do pedido agora — a chave foi reaproveitada
    // para um recebimento genuinamente diferente desta mesma venda. Nunca
    // reconcilia como se fosse o mesmo pedido.
    if (dados.idempotencyKey) {
      const existente = vendaAtual.pagamentos.find((pagamento) => pagamento.idempotencyKey === dados.idempotencyKey);
      if (existente && existente.valor === valor) {
        await this.garantirMovimentoDeRecebimento(caixaAtual.id, vendaAtual, dados.idempotencyKey, existente);
        return vendaAtual;
      }
      if (existente) {
        throw ApiException.conflict("Esta idempotencyKey já foi usada para um recebimento com valor diferente. Gere uma nova chave para esta operação.");
      }
    }

    // Reaproveita EXATAMENTE a mesma validação de modalidade/adquirente/tarifa
    // da criação (Etapas 10.4/10.5) — não depende de nada específico da
    // criação da venda, por isso é seguro chamar aqui sem duplicar a regra.
    const adquirentesCache = new Map<string, AdquirenteRespostaPublica>();
    const estruturado = await this.validarPagamentoEstruturado(dados, adquirentesCache);

    const dataRecebimento = new Date();
    let pagamentoAplicado: PagamentoVenda | null = null;

    const venda = await this.vendasRepository.salvarComRetentativa(vendaId, (documento) => {
      if (documento.status === "cancelada") {
        throw ApiException.validation("Venda cancelada não aceita novos recebimentos.");
      }
      if (dados.idempotencyKey) {
        const existente = documento.pagamentos.find((pagamento) => pagamento.idempotencyKey === dados.idempotencyKey);
        if (existente && existente.valor === valor) {
          // Concorrência: outra tentativa com a MESMA chave e o MESMO valor
          // já aplicou este recebimento enquanto esta rodava — replay.
          pagamentoAplicado = existente;
          return;
        }
        if (existente) {
          throw ApiException.conflict("Esta idempotencyKey já foi usada para um recebimento com valor diferente. Gere uma nova chave para esta operação.");
        }
      }
      if (documento.valorPendente <= 0) {
        throw ApiException.validation("Dados inválidos.", [
          { field: "valor", message: "Esta venda já está quitada; nenhum recebimento é necessário." },
        ]);
      }
      if (valor > documento.valorPendente) {
        throw ApiException.validation("Dados inválidos.", [
          { field: "valor", message: `Recebimento maior que o saldo pendente (${documento.valorPendente.toFixed(2)}).` },
        ]);
      }

      documento.pagamentos.push({
        forma: dados.forma,
        valor,
        dataPagamento: dataRecebimento,
        parcelas: estruturado.parcelas,
        observacao: dados.observacao ?? null,
        modalidade: estruturado.modalidade,
        adquirenteId: estruturado.adquirenteId,
        tarifaAplicada: estruturado.tarifaAplicada,
        idempotencyKey: dados.idempotencyKey ?? null,
      } as PagamentoVenda);
      // Sempre sobre o valor BRUTO (seções 1/4/17 do pedido) — a tarifa
      // (`estruturado.tarifaAplicada`) nunca entra nesta soma.
      documento.valorPago = arredondar(documento.valorPago + valor);
      documento.valorPendente = arredondar(Math.max(0, documento.valorFinal - documento.valorPago));
      if (documento.valorPendente === 0) documento.status = "concluida";
      documento.historico.push({
        dataHora: dataRecebimento,
        tipo: "pagamento",
        descricao: `Recebimento posterior de ${valor.toFixed(2)} em ${dados.forma}`,
        autor: "Backoffice",
      });

      pagamentoAplicado = documento.pagamentos[documento.pagamentos.length - 1]!;
    });

    if (pagamentoAplicado) {
      await this.garantirMovimentoDeRecebimento(caixaAtual.id, venda, dados.idempotencyKey, pagamentoAplicado);
    }

    await this.registrarEvento(venda.id, "venda.recebimento_registrado", usuarioId, { valor, idempotencyKey: dados.idempotencyKey ?? null });
    return venda;
  }

  /**
   * Cancelamento/devolução — ver histórico de correções nas Etapas 10.9
   * (valor devolvido correto) e 10.11 (caixa atual, nunca `venda.caixaId`).
   *
   * Etapa 10.13 — IDEMPOTÊNCIA E RECUPERAÇÃO:
   *
   * 1. REPLAY: se `dto.idempotencyKey` for informada e a venda já estiver
   *    cancelada com essa MESMA chave (`venda.cancelamento.idempotencyKey`),
   *    a chamada é a MESMA operação lógica repetida — em vez de rejeitar com
   *    "já cancelada", RECONCILIA efeitos ainda faltantes (estoque/caixa, ver
   *    `reconciliarCancelamento`) e devolve a venda. Uma venda cancelada por
   *    OUTRA chave (ou sem chave) continua rejeitando normalmente — nunca
   *    permite dois cancelamentos DIFERENTES. Sem `idempotencyKey` (contrato
   *    legado), o comportamento é IDÊNTICO ao de antes: sempre rejeita.
   *
   * 2. RECUPERAÇÃO GRANULAR DE ESTOQUE: fecha a janela "venda salva como
   *    cancelada → processo cai → estoque nunca restaurado → retry rejeitado
   *    antes de terminar". Cada linha de `cancelamento.itens` carrega seu
   *    próprio `restaurado: boolean`, `false` na gravação inicial e só vira
   *    `true` depois que `ProdutosService.ajustarQuantidadeTamanho` roda de
   *    fato para aquela linha (nunca junto com a gravação do cancelamento em
   *    si) — ver `restaurarEstoquePendente`. A "reivindicação" de cada item é
   *    atômica (`VendasRepository.marcarItemDevolvidoRestaurado`), então a
   *    mesma unidade nunca é devolvida duas vezes mesmo sob duas chamadas
   *    (replay + concorrência) rodando ao mesmo tempo.
   *
   * 3. MOVIMENTO DE CAIXA: sempre re-garantido via
   *    `garantirMovimentoDeCancelamento` — idempotente por chave GLOBAL
   *    derivada `${vendaId}:cancelamento:${idempotencyKey}` (não mais
   *    escopada por caixa, ver `movimento-caixa.schema.ts`) — chamar de novo
   *    (replay/reconciliação) nunca duplica, mesmo que o caixa atualmente
   *    aberto seja outro.
   *
   * 4. CONCORRÊNCIA: a decisão de "o que devolver" continua tomada DENTRO do
   *    `salvarComRetentativa`, contra o documento fresco a cada tentativa
   *    (Etapa 10.9, preservada). Uma tentativa que perde a corrida de escrita
   *    para OUTRA com a MESMA `idempotencyKey` reconhece isso como replay
   *    dentro do próprio callback (`eraReplayConcorrente`), em vez de lançar
   *    "já cancelada" para uma operação que, na prática, é a sua própria.
   *
   * Atomicidade: mesma limitação já aceita em `criarInterno`/`receberPagamento`
   * — sem transação multi-documento (Venda e Produto são coleções
   * diferentes); a idempotência acima é o que torna essa limitação segura de
   * conviver com um crash, não uma transação.
   */
  async cancelar(vendaId: string, dto: CancelamentoDto, usuarioId: string | null): Promise<VendaDocument> {
    const vendaAtual = await this.vendasRepository.encontrarPorIdOuFalhar(vendaId);

    // Etapa 10.14 — a checagem de replay/conflito por `idempotencyKey` roda
    // ANTES de olhar `status`: uma devolução PARCIAL bem-sucedida deixa a
    // venda em "em_pagamento" (nunca "cancelada"), então um retry dessa MESMA
    // operação (ou um reaproveitamento indevido da chave para uma operação
    // DIFERENTE) precisa ser reconhecido independentemente do status atual —
    // não só quando o cancelamento anterior fechou a venda por completo.
    if (dto.idempotencyKey && vendaAtual.cancelamento?.idempotencyKey === dto.idempotencyKey) {
      this.verificarMesmaOperacaoDeCancelamento(vendaAtual.cancelamento, dto);
      return this.reconciliarCancelamento(vendaAtual, dto.idempotencyKey);
    }
    if (vendaAtual.status === "cancelada") {
      throw ApiException.validation("Esta venda já está cancelada.");
    }

    const caixaAtual = await this.caixasService.obterAtual();
    if (!caixaAtual) {
      throw ApiException.validation("Nenhum caixa aberto. Abra o caixa antes de registrar o cancelamento.");
    }

    if (dto.tipo === "parcial" && !(dto.itens ?? []).length) {
      throw ApiException.validation("Dados inválidos.", [{ field: "itens", message: "Selecione ao menos um item para devolver." }]);
    }

    const motivo = dto.motivo.trim();
    const agora = new Date();
    let eraReplayConcorrente = false;

    const venda = await this.vendasRepository.salvarComRetentativa(vendaId, (documento) => {
      // Mesma checagem de replay/conflito da entrada da função, agora contra
      // o documento FRESCO desta tentativa — cobre a corrida onde outra
      // chamada com a MESMA chave (replay concorrente genuíno, ou reuso
      // indevido para operação diferente) venceu a escrita entre a leitura
      // inicial e agora.
      if (dto.idempotencyKey && documento.cancelamento?.idempotencyKey === dto.idempotencyKey) {
        this.verificarMesmaOperacaoDeCancelamento(documento.cancelamento, dto);
        // É a MESMA operação — não muta de novo; a reconciliação fora deste
        // callback cuida do resto (estoque/caixa).
        eraReplayConcorrente = true;
        return;
      }
      if (documento.status === "cancelada") {
        throw ApiException.validation("Esta venda já está cancelada.");
      }

      const devolvidosDaTentativa: ItemDevolvido[] = [];
      if (dto.tipo === "integral") {
        for (const item of documento.itens) {
          const restante = item.quantidade - item.quantidadeDevolvida;
          if (restante <= 0) continue;
          devolvidosDaTentativa.push({
            itemId: String(item._id),
            codProduto: item.codProduto,
            nome: item.nome,
            quantidade: restante,
            valor: this.calcularValorDevolucaoItem(documento, item, restante),
            restaurado: false,
          } as ItemDevolvido);
        }
      } else {
        for (const solicitado of dto.itens ?? []) {
          const item = documento.itens.find((registro) => String(registro._id) === solicitado.itemId);
          if (!item) throw ApiException.notFound("Item da venda não encontrado.");
          const restante = item.quantidade - item.quantidadeDevolvida;
          const quantidade = Math.min(Math.max(0, Math.floor(solicitado.quantidade)), restante);
          if (quantidade <= 0) continue;
          devolvidosDaTentativa.push({
            itemId: String(item._id),
            codProduto: item.codProduto,
            nome: item.nome,
            quantidade,
            valor: this.calcularValorDevolucaoItem(documento, item, quantidade),
            restaurado: false,
          } as ItemDevolvido);
        }
        if (!devolvidosDaTentativa.length) throw ApiException.validation("Nenhuma quantidade disponível para devolução.");
      }

      for (const devolvido of devolvidosDaTentativa) {
        const item = documento.itens.find((registro) => String(registro._id) === devolvido.itemId);
        if (item) item.quantidadeDevolvida += devolvido.quantidade;
      }

      const valorDevolvidoDaTentativa = arredondar(devolvidosDaTentativa.reduce((total, item) => total + item.valor, 0));
      documento.valorDevolvido = arredondar(documento.valorDevolvido + valorDevolvidoDaTentativa);
      documento.cancelamento = {
        tipo: dto.tipo,
        motivo,
        dataHora: agora,
        autor: "Backoffice",
        valorDevolvido: valorDevolvidoDaTentativa,
        itens: devolvidosDaTentativa,
        idempotencyKey: dto.idempotencyKey ?? null,
      } as never;
      documento.historico.push({
        dataHora: agora,
        tipo: dto.tipo === "integral" ? "cancelamento" : "devolucao",
        descricao:
          dto.tipo === "integral"
            ? `Venda cancelada integralmente · ${motivo}`
            : `Devolução parcial de ${devolvidosDaTentativa.length} item(ns) · ${motivo}`,
        autor: "Backoffice",
      });

      const todosDevolvidos = documento.itens.every((item) => item.quantidadeDevolvida >= item.quantidade);
      if (dto.tipo === "integral" || todosDevolvidos) {
        documento.status = "cancelada";
        documento.valorPendente = 0;
      }
    });

    // Estoque e movimento de caixa passam SEMPRE pela mesma via de
    // reconciliação (idempotente item a item / por chave global) usada num
    // replay explícito — cobre também a corrida "perdi a gravação, mas a
    // operação é minha" (`eraReplayConcorrente`) sem nenhum código duplicado.
    await this.restaurarEstoquePendente(venda);
    await this.garantirMovimentoDeCancelamento(caixaAtual.id, venda, dto.idempotencyKey);

    // `vendaAtual` já não podia estar cancelada aqui (a checagem no início da
    // função teria lançado ou reconciliado antes) — os agregados revertem só
    // na tentativa que efetivamente fez a transição, nunca num replay.
    if (!eraReplayConcorrente && venda.status === "cancelada") {
      await this.reverterAgregados(venda);
    }

    await this.registrarEvento(venda.id, dto.tipo === "integral" ? "venda.cancelada" : "venda.devolvida", usuarioId, {
      valorDevolvido: venda.cancelamento?.valorDevolvido ?? 0,
    });
    return venda;
  }

  /**
   * Etapa 10.14 — confirma que uma `idempotencyKey` reencontrada em
   * `venda.cancelamento` representa a MESMA operação pedida agora, nunca
   * apenas "a mesma chave". Um cancelamento PARCIAL bem-sucedido não fecha a
   * venda (status continua "em_pagamento"), então nada além desta checagem
   * impediria reaproveitar a chave para um `tipo`/conjunto de itens
   * diferente enquanto a venda seguir aberta. `tipo` precisa bater sempre; um
   * "parcial" também precisa pedir exatamente o mesmo conjunto
   * itemId+quantidade já persistido — reusa `ApiException.conflict` (mesmo
   * código de erro já usado para o conflito de criação/recebimento/parcela).
   */
  private verificarMesmaOperacaoDeCancelamento(existente: CancelamentoVenda, dto: CancelamentoDto): void {
    const mensagem = "Esta idempotencyKey já foi usada para um cancelamento diferente. Gere uma nova chave para esta operação.";
    if (existente.tipo !== dto.tipo) {
      throw ApiException.conflict(mensagem);
    }
    if (dto.tipo === "parcial") {
      const solicitados = [...(dto.itens ?? [])].sort((a, b) => a.itemId.localeCompare(b.itemId));
      const persistidos = [...existente.itens].sort((a, b) => a.itemId.localeCompare(b.itemId));
      const itensBatem =
        solicitados.length === persistidos.length &&
        solicitados.every((solicitado, indice) => {
          const persistido = persistidos[indice];
          return persistido !== undefined && solicitado.itemId === persistido.itemId && solicitado.quantidade === persistido.quantidade;
        });
      if (!itensBatem) {
        throw ApiException.conflict(mensagem);
      }
    }
  }

  /**
   * Reconcilia uma venda JÁ cancelada pela MESMA `idempotencyKey` (Etapa
   * 10.13) — chamado quando `cancelar()` detecta, ANTES de qualquer
   * mutação, que a operação já foi persistida (crash ou retry de rede
   * depois do `salvarComRetentativa` original). Só completa o que faltar
   * (estoque/caixa); nunca reaplica o cancelamento em si — o snapshot em
   * `venda.cancelamento` já existe e é imutável a partir daqui.
   */
  private async reconciliarCancelamento(venda: VendaDocument, idempotencyKey: string): Promise<VendaDocument> {
    const caixaAtual = await this.caixasService.obterAtual();
    if (!caixaAtual) {
      throw ApiException.validation("Nenhum caixa aberto. Abra o caixa antes de concluir o cancelamento.");
    }
    await this.restaurarEstoquePendente(venda);
    await this.garantirMovimentoDeCancelamento(caixaAtual.id, venda, idempotencyKey);
    return this.vendasRepository.encontrarPorIdOuFalhar(venda.id);
  }

  /**
   * Restaura o estoque de cada linha de `cancelamento.itens` que AINDA não
   * tiver sido restaurada (Etapa 10.13) — sempre relê a venda antes de
   * decidir (nunca confia num snapshot potencialmente desatualizado sob
   * concorrência) e usa `VendasRepository.marcarItemDevolvidoRestaurado`
   * como uma reivindicação ATÔMICA por item: só quem GANHA a reivindicação
   * chama `devolverAoEstoque` para aquela linha — a mesma unidade nunca é
   * devolvida duas vezes, mesmo com replay e concorrência reais disputando a
   * MESMA venda cancelada ao mesmo tempo.
   */
  private async restaurarEstoquePendente(venda: VendaDocument): Promise<void> {
    const atual = await this.vendasRepository.encontrarPorIdOuFalhar(venda.id);
    if (!atual.cancelamento) return;
    for (const devolvido of atual.cancelamento.itens) {
      if (devolvido.restaurado) continue;
      const reivindicado = await this.vendasRepository.marcarItemDevolvidoRestaurado(venda.id, devolvido.itemId);
      if (!reivindicado) continue; // outra chamada já reivindicou (ou já concluiu) este item.
      const item = atual.itens.find((registro) => String(registro._id) === devolvido.itemId);
      if (item) await this.devolverAoEstoque(item, devolvido.quantidade);
    }
  }

  /**
   * Garante o movimento de caixa do cancelamento/devolução — sempre a partir
   * do snapshot JÁ PERSISTIDO em `venda.cancelamento` (nunca de um valor
   * calculado ad-hoc pelo chamador), para que chamar isto de novo
   * (replay/reconciliação) seja idempotente por construção. Chave DERIVADA
   * GLOBAL (Etapa 10.13) `${vendaId}:cancelamento:${idempotencyKey}` — nunca
   * duplica mesmo que o caixa atualmente aberto seja outro (ver
   * `movimento-caixa.schema.ts`). Sem `idempotencyKey`, nenhuma deduplicação
   * (mesmo padrão do resto do projeto).
   */
  private async garantirMovimentoDeCancelamento(caixaId: string, venda: VendaDocument, idempotencyKey: string | undefined): Promise<void> {
    const atual = await this.vendasRepository.encontrarPorIdOuFalhar(venda.id);
    if (!atual.cancelamento) return;
    const valorParaCaixa = arredondar(Math.min(atual.cancelamento.valorDevolvido, atual.valorPago));
    if (valorParaCaixa <= 0) return;
    await this.caixasService.registrarMovimentoDeVenda({
      caixaId,
      // Etapa 18.2 — o Caixa não distingue mais cancelamento total de
      // devolução parcial (ambos são `tipo: "cancelamento"`, sentido saída);
      // essa distinção continua existindo aqui, só em `atual.cancelamento.tipo`
      // (autoridade comercial de Vendas), refletida na descrição do lançamento.
      tipo: "cancelamento",
      descricao:
        atual.cancelamento.tipo === "integral"
          ? `Cancelamento da venda ${atual.codigo} · ${atual.clienteNome}`
          : `Devolução parcial da venda ${atual.codigo} · ${atual.clienteNome}`,
      referencia: atual.codigo,
      vendaId: atual.id,
      vendaCodigo: atual.codigo,
      formaPagamento: atual.formaPagamento,
      valor: valorParaCaixa,
      observacao: atual.cancelamento.motivo,
      idempotencyKey: idempotencyKey ? `${venda.id}:cancelamento:${idempotencyKey}` : null,
    });
  }

  /**
   * Valor econômico devolvido para `quantidade` unidades de um item (Etapa
   * 10.9) — SEMPRE a partir do snapshot já persistido, nunca do preço/
   * promoção/tarifa atuais (seção 3 do pedido):
   *
   * 1. Valor unitário EFETIVO = `item.subtotal / item.quantidade` — `subtotal`
   *    já é `precoPraticado × quantidade − descontoItem` (resolvido na
   *    criação, ver `criarInterno`), então dividir pela quantidade ORIGINAL
   *    da linha (nunca a quantidade sendo devolvida agora) dá o valor por
   *    unidade já líquido de `descontoItem` e de promoção — sem recalcular
   *    percentual nenhum, só usando o campo que já existe.
   * 2. Rateio de `descontoVenda` (seção 6 do pedido — nenhuma regra de rateio
   *    existia antes desta etapa): proporcional ao peso de CADA item no
   *    subtotal da venda (soma de `item.subtotal`, recomputada aqui a partir
   *    dos itens persistidos — nunca um campo `subtotalVenda` armazenado, que
   *    não existe no schema). Com `descontoVenda = 0` (o caso comum, todas as
   *    vendas de todas as etapas anteriores), o fator é exatamente 1 e o
   *    valor não muda em nada — retrocompatível por construção.
   *
   * Tarifa de adquirente (Etapa 10.5) NUNCA entra aqui (seção 9 do pedido): a
   * tarifa é custo de operação sobre o PAGAMENTO, não sobre o item vendido —
   * o valor devolvido ao cliente é sempre bruto, nunca `valorLiquido`.
   */
  private calcularValorDevolucaoItem(documento: VendaDocument, item: ItemVenda, quantidade: number): number {
    const valorUnitarioEfetivo = item.quantidade > 0 ? item.subtotal / item.quantidade : 0;
    const valorBrutoDevolucao = valorUnitarioEfetivo * quantidade;

    const subtotalVenda = documento.itens.reduce((total, atual) => total + atual.subtotal, 0);
    const fatorDescontoVenda = subtotalVenda > 0 ? (subtotalVenda - documento.descontoVenda) / subtotalVenda : 1;

    return arredondar(valorBrutoDevolucao * fatorDescontoVenda);
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
        observacao: "",
        idempotencyKey: `${chaveBase}:pagamento:${indice}`,
      });
    }
  }

  /**
   * Lança no Caixa o movimento de um RECEBIMENTO POSTERIOR (Etapa 10.8) —
   * Etapa 18.2: usa `tipo: "venda"` (o Caixa não distingue mais "venda à
   * vista" de "recebimento de parcela" — qualquer entrada de dinheiro de uma
   * venda é só "venda", ver `caixas.constants.ts`). Recebe `caixaId`
   * explicitamente — desde a Etapa 10.10, é sempre o caixa ATUALMENTE aberto
   * (resolvido pelo chamador antes de qualquer mutação da venda), nunca
   * `venda.caixaId` (ver comentário completo em `receberPagamento`).
   * Idempotente por chave DERIVADA (`${venda.id}:recebimento:${idempotencyKey}`)
   * quando o chamador informou uma — sem chave, nenhuma deduplicação (mesmo
   * padrão do resto do projeto). Prefixar com `venda.id` (Etapa 10.13) é o
   * que sustenta a unicidade GLOBAL do índice de `MovimentoCaixa` (não mais
   * por caixa — ver `movimento-caixa.schema.ts`): sem isso, a mesma
   * `idempotencyKey` bruta usada por engano em duas vendas diferentes
   * colidiria uma com a outra. Sempre o valor BRUTO do pagamento, nunca o
   * líquido pós-tarifa (seção 10 do pedido).
   */
  private async garantirMovimentoDeRecebimento(caixaId: string, venda: VendaDocument, idempotencyKey: string | undefined, pagamento: PagamentoVenda): Promise<void> {
    if (pagamento.valor <= 0) return;
    await this.caixasService.registrarMovimentoDeVenda({
      caixaId,
      tipo: "venda",
      descricao: `Recebimento posterior da venda ${venda.codigo} · ${venda.clienteNome} · ${pagamento.forma}`,
      referencia: venda.codigo,
      vendaId: venda.id,
      vendaCodigo: venda.codigo,
      formaPagamento: pagamento.forma,
      valor: pagamento.valor,
      observacao: pagamento.observacao ?? "",
      idempotencyKey: idempotencyKey ? `${venda.id}:recebimento:${idempotencyKey}` : null,
    });
  }

  /**
   * Lança no Caixa o movimento de uma BAIXA DE PARCELA (`baixarParcela`) —
   * Etapa 18.2: `tipo: "venda"` (mesma unificação de `garantirMovimentoDeRecebimento`),
   * agora no caixa ATUALMENTE aberto (Etapa 10.10/10.11), nunca `venda.caixaId`.
   * Idempotente por chave DERIVADA (`${venda.id}:parcela:${idempotencyKey}`,
   * prefixada pela venda desde a Etapa 10.13 para sustentar a unicidade
   * GLOBAL do índice — ver `garantirMovimentoDeRecebimento`) quando o
   * chamador informou uma — cobre "processo morreu entre salvar a venda e
   * lançar o caixa" sem duplicar o movimento num retry. Sempre o valor
   * BRUTO do pagamento (nunca o líquido pós-tarifa).
   */
  private async garantirMovimentoDeBaixaParcela(
    caixaId: string,
    venda: VendaDocument,
    idempotencyKey: string | undefined,
    pagamento: PagamentoVenda,
    numeroParcela: number,
    totalParcelas: number,
  ): Promise<void> {
    if (pagamento.valor <= 0) return;
    await this.caixasService.registrarMovimentoDeVenda({
      caixaId,
      tipo: "venda",
      descricao: `Recebimento da parcela ${numeroParcela}/${totalParcelas} · ${venda.clienteNome}`,
      referencia: venda.codigo,
      vendaId: venda.id,
      vendaCodigo: venda.codigo,
      formaPagamento: pagamento.forma,
      valor: pagamento.valor,
      observacao: pagamento.observacao ?? "Baixa registrada no backoffice",
      idempotencyKey: idempotencyKey ? `${venda.id}:parcela:${idempotencyKey}` : null,
    });
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
