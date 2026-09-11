import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model, Types } from "mongoose";
import { ApiException } from "../../common/exceptions/api.exception.js";
import type { ApiFacets, ApiMeta } from "../../common/types/api-response.interface.js";
import { SequenciasService } from "../sequencias/sequencias.service.js";
import type { VendaDocument } from "../vendas/schemas/venda.schema.js";
import { VendasRepository } from "../vendas/vendas.repository.js";
import {
  CHAVE_SEQUENCIA_CAIXA,
  DIFERENCA_TOLERANCIA,
  DIGITOS_CODIGO_CAIXA,
  FACETAS_CAIXA,
  FAIXAS_SALDO,
  PREFIXO_CODIGO_CAIXA,
  SENTIDO_POR_TIPO,
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
import type { ResumoCaixaCalculado, VendaResumoDoCaixa } from "./caixas.types.js";
import { MOVIMENTOS_RECENTES_NO_DETALHE } from "./caixas.constants.js";

/**
 * Etapa 18.2 — formato de resposta `abertura`/`fechamento` PRESERVADO
 * (aninhado, com `responsavelId`/`responsavelNome`) por compatibilidade com
 * o Backoffice (`caixa.index.tsx`/`caixa.$id.tsx` leem
 * `caixa.abertura.responsavelNome` diretamente). O domínio persistido
 * (`schemas/caixa.schema.ts`) NÃO tem mais esse conceito — `responsavelNome`
 * aqui é sempre a string fixa `"Loja"`, nunca um vendedor real, nunca
 * validado, nunca usado para filtrar/particionar caixas. Esta é a camada de
 * LEITURA reconstruindo um formato de tela a partir de um domínio mais
 * simples — não uma reintrodução do vínculo de vendedor.
 */
export interface AberturaCaixaResposta {
  dataHora: Date;
  responsavelId: null;
  responsavelNome: string;
  valorInicial: number;
  observacao: string;
}

export interface FechamentoCaixaResposta {
  dataHora: Date;
  responsavelId: null;
  responsavelNome: string;
  valorInformado: number;
  valorEsperado: number;
  diferenca: number;
  observacao: string;
}

export interface CaixaRespostaPublica {
  id: string;
  codigo: string;
  status: string;
  abertura: AberturaCaixaResposta;
  fechamento: FechamentoCaixaResposta | null;
  resumo: ResumoCaixaCalculado;
}

export interface CaixaDetalheResposta extends CaixaRespostaPublica {
  movimentacoes: MovimentoCaixaDocument[];
  vendas: VendaResumoDoCaixa[];
  /**
   * Etapa 18.2 — o conceito de "recebimento" (baixa de parcela como
   * movimento distinto de "venda") foi RETIRADO do domínio Caixa: toda
   * entrada de venda, à vista ou parcelada, agora é só `tipo: "venda"` (ver
   * `caixas.constants.ts`). Este campo permanece SEMPRE `[]`,
   * deliberadamente — não é um bug a corrigir, é a ausência intencional de
   * um conceito que não existe mais. Mantido só para não quebrar
   * `caixa.$id.tsx`, que ainda lê `caixa.recebimentos.length`; a remoção
   * dessa seção da UI é trabalho de uma futura etapa Lovable, fora do
   * escopo desta refatoração de backend.
   */
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
    private readonly vendasRepository: VendasRepository,
    private readonly sequenciasService: SequenciasService,
    @InjectModel(EventoCaixa.name) private readonly eventoModel: Model<EventoCaixaDocument>,
  ) {}

  /**
   * `dto.responsavelId` é aceito (nunca rejeitado por `forbidNonWhitelisted`,
   * preservando o payload atual do Backoffice) mas inteiramente IGNORADO: o
   * Caixa Geral da Loja não tem vínculo de vendedor/responsável (Etapa 18.2).
   * `autorId` só alimenta o evento de auditoria (`caixa.aberto`), nunca o
   * documento financeiro.
   */
  async abrir(dto: AbrirCaixaDto, autorId: string | null): Promise<CaixaDetalheResposta> {
    const codigo = await this.sequenciasService.proximoCodigo(CHAVE_SEQUENCIA_CAIXA, PREFIXO_CODIGO_CAIXA, DIGITOS_CODIGO_CAIXA);

    const caixa = await this.caixasRepository.criar({
      codigo,
      status: "aberto",
      valorInicial: arredondar(dto.valorInicial),
      dataAbertura: new Date(),
      observacaoAbertura: dto.observacao?.trim() ?? "",
      dataFechamento: null,
      valorInformado: null,
      valorEsperado: null,
      diferenca: null,
      observacaoFechamento: "",
    });

    await this.registrarEvento(caixa.id, "caixa.aberto", autorId, { codigo });
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
      resumo: this.calcularResumo(movimentosPorCaixa.get(documento.id) ?? [], documento.valorInicial),
    }));

    const selecao: SelecaoFacetas = {
      status: query.status,
      periodo: query.periodo,
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

  /**
   * Etapa 18.2 — contrato LEGADO do Backoffice, mesmo padrão já aprovado em
   * Clientes/Fornecedores/Coleções/Campanhas/Vendedores: `GET /caixas` sem
   * NENHUM parâmetro espera de volta a base INTEIRA de caixas (histórico
   * completo, não só os ativos — Caixa não tem soft delete), num array
   * simples, nunca truncada pelo `limit` padrão de `listar()`.
   */
  async listarTodos(): Promise<CaixaRespostaPublica[]> {
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

    return caixas.map((documento) =>
      this.paraRespostaPublica(documento as CaixaDocument & { id: string }, this.calcularResumo(movimentosPorCaixa.get(documento.id) ?? [], documento.valorInicial)),
    );
  }

  async obterDetalhe(id: string): Promise<CaixaDetalheResposta> {
    const caixa = await this.caixasRepository.encontrarPorIdOuFalhar(id);
    const [movimentosTodos, recentes] = await Promise.all([
      this.movimentosRepository.listarTodosPorCaixa(id),
      this.movimentosRepository.recentesPorCaixa(id, MOVIMENTOS_RECENTES_NO_DETALHE),
    ]);
    const resumo = this.calcularResumo(movimentosTodos, caixa.valorInicial);
    const vendas = await this.buscarVendasDoCaixa(movimentosTodos);

    return {
      ...this.paraRespostaPublica(caixa, resumo),
      movimentacoes: recentes,
      vendas,
      recebimentos: [],
    };
  }

  async obterAtual(): Promise<CaixaDetalheResposta | null> {
    const caixa = await this.caixasRepository.encontrarAberto();
    if (!caixa) return null;
    return this.obterDetalhe(caixa.id);
  }

  /**
   * Etapa 20.01A — `paginado` decide se o histórico é truncado por
   * `page`/`limit` ou devolvido por completo; ver `CaixasController
   * .movimentacoes` para o critério de quando cada modo é usado. Filtro por
   * `tipo` e `ordem` são aplicados da mesma forma nos dois modos.
   */
  async listarMovimentos(
    caixaId: string,
    query: ListarMovimentosQueryDto,
    paginado = true,
  ): Promise<{ data: MovimentoCaixaDocument[]; meta: ApiMeta }> {
    await this.caixasRepository.encontrarPorIdOuFalhar(caixaId);
    const { itens, total } = await this.movimentosRepository.listarPaginadoPorCaixa(
      caixaId,
      { tipo: query.tipo, ordem: query.ordem, page: query.page, limit: query.limit },
      paginado,
    );

    if (!paginado) {
      return { data: itens, meta: { total, page: 1, limit: total, totalPages: 1 } };
    }

    return {
      data: itens,
      meta: { total, page: query.page, limit: query.limit, totalPages: Math.max(1, Math.ceil(total / query.limit)) },
    };
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
      saldoEsperadoAtual = this.calcularResumo(movimentos, caixaAberto.valorInicial).saldoEsperado;
    }

    return {
      caixasAbertos,
      caixasFechados,
      entradasHoje: somar((item) => item.sentido === "entrada"),
      saidasHoje: somar((item) => item.sentido === "saida"),
      vendasHoje: somar((item) => item.tipo === "venda"),
      // Etapa 18.2 — "recebimento" não é mais um tipo distinto (ver `caixas.constants.ts`); sempre 0.
      recebimentosHoje: 0,
      devolucoesHoje: somar((item) => item.tipo === "cancelamento"),
      saldoEsperadoAtual,
      diferencaAcumulada: arredondar(diferencaAcumulada),
    };
  }

  /**
   * Ponto de integração com Vendas: registra `venda` (QUALQUER impacto
   * financeiro positivo — à vista ou baixa de parcela, o Caixa não distingue
   * mais os dois) ou `cancelamento` (QUALQUER impacto financeiro negativo —
   * total ou parcial). Nunca chamado por uma rota HTTP genérica: só
   * `VendasService` decide quando um pagamento está efetivamente PAGO e
   * chama isto — o Caixa nunca implementa lógica de parcela/cancelamento,
   * só registra o valor já autorizado.
   *
   * O vendedor NUNCA é copiado para cá — quem quiser saber quem vendeu
   * consulta a Venda via `vendaId` (ver `buscarVendasDoCaixa`).
   */
  async registrarMovimentoDeVenda(dados: {
    caixaId: string;
    tipo: Extract<TipoMovimentacaoCaixa, "venda" | "cancelamento">;
    descricao: string;
    referencia: string | null;
    vendaId: string;
    vendaCodigo: string;
    formaPagamento: string;
    valor: number;
    observacao: string;
    idempotencyKey?: string | null;
  }): Promise<void> {
    const caixa = await this.caixasRepository.encontrarPorIdOuFalhar(dados.caixaId);
    this.exigirAberto(caixa);

    const { movimento, duplicado } = await this.movimentosRepository.criar({
      caixaId: dados.caixaId,
      dataHora: new Date(),
      tipo: dados.tipo,
      origem: dados.tipo,
      descricao: dados.descricao,
      referencia: dados.referencia,
      vendaId: dados.vendaId,
      vendaCodigo: dados.vendaCodigo,
      formaPagamento: dados.formaPagamento,
      valor: arredondar(dados.valor),
      sentido: SENTIDO_POR_TIPO[dados.tipo],
      observacao: dados.observacao,
      motivo: dados.tipo === "cancelamento" ? dados.observacao || null : null,
      idempotencyKey: dados.idempotencyKey ?? null,
    });

    await this.garantirCaixaAindaAbertoOuReverter(dados.caixaId, movimento, duplicado);
  }

  /**
   * `entrada`/`saida` são os nomes de ROTA (preservados por compatibilidade
   * com `POST /:id/entrada`/`POST /:id/saida` já consumidos pelo
   * Backoffice) — internamente mapeiam para `tipo: "injecao"`/`"sangria"`.
   * O cliente NUNCA escolhe o `tipo`: o endpoint chamado é que determina.
   *
   * Etapa 18.2 — SANGRIA não bloqueia mais por saldo insuficiente: o Caixa
   * pode ficar negativo (decisão de domínio explícita). Etapa 18.3 —
   * a proteção contra "movimento em caixa já fechado" não depende mais de
   * saldo nem de um gate ANTES da gravação: ver `garantirCaixaAindaAbertoOuReverter`.
   */
  async registrarMovimento(
    caixaId: string,
    rota: "entrada" | "saida",
    dto: EntradaCaixaDto | SaidaCaixaDto,
    usuarioId: string | null,
  ): Promise<CaixaDetalheResposta> {
    const tipo: TipoMovimentacaoCaixa = rota === "entrada" ? "injecao" : "sangria";
    const caixa = await this.caixasRepository.encontrarPorIdOuFalhar(caixaId);
    this.exigirAberto(caixa);

    const valor = arredondar(dto.valor);
    const motivo = tipo === "sangria" ? (dto as SaidaCaixaDto).motivo.trim() : null;

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
      sentido: SENTIDO_POR_TIPO[tipo],
      observacao: dto.observacao?.trim() ?? "",
      motivo,
      idempotencyKey: dto.idempotencyKey ?? null,
    });

    await this.garantirCaixaAindaAbertoOuReverter(caixaId, movimento, duplicado);

    if (!duplicado) {
      await this.registrarEvento(caixaId, "caixa.movimento_criado", usuarioId, { tipo, valor: movimento.valor });
    }

    return this.obterDetalhe(caixaId);
  }

  /**
   * Etapa 18.3 — fecha, sem transação Mongo, a corrida entre "gravar um
   * movimento" e "fechar o caixa" (seção 10/12 do pedido da 18.3).
   *
   * POR QUE NÃO UM GATE ANTES DA GRAVAÇÃO (como a 18.2 tinha com
   * `confirmarAberto`): um gate atômico ANTES do insert só reduz a janela,
   * nunca a fecha — entre o gate e o `movimentosRepository.criar()` (duas
   * operações em COLEÇÕES diferentes) sempre sobra um intervalo onde
   * `fecharAtomico` pode intercalar. A 18.2 já documentava isso
   * honestamente como limitação aceita; a 18.3 fecha essa lacuna sem
   * transação, verificando DEPOIS do insert em vez de antes.
   *
   * ALGORITMO (compensação, não transação):
   * 1. O movimento já foi inserido (`movimento`/`duplicado` vêm de
   *    `MovimentosCaixaRepository.criar`).
   * 2. Se `duplicado === true`: NADA a fazer. O documento já existia — ele
   *    só pode ter sido criado por uma chamada anterior que, para existir
   *    com sucesso, já passou por ESTA MESMA verificação em seu próprio
   *    momento de criação (indução: todo movimento não removido já foi
   *    validado por este método quando nasceu). Reverificar aqui poderia
   *    inclusive APAGAR incorretamente um movimento legítimo e antigo só
   *    porque o caixa fechou muito depois.
   * 3. Se `duplicado === false` (nós acabamos de inserir): relê o Caixa
   *    agora. Se `status === "fechado"`, esta gravação perdeu a corrida
   *    contra um `fechar()` concorrente — o movimento nunca deveria ter
   *    sido criado. Apaga (`removerPorId`, compensação — nunca visível
   *    como uma resposta de sucesso para quem chamou) e lança erro. Se
   *    ainda `"aberto"`, a gravação é legítima.
   *
   * GARANTIA: como a checagem é feita comparando o ESTADO ATUAL do Caixa
   * (não um timestamp nem uma versão capturada antes), o resultado nunca
   * depende de relógio de parede nem de ordenação de eventos — só do valor
   * de `status` no momento em que este código realmente executa, que o
   * MongoDB garante ser consistente para leituras de um único documento.
   *
   * LIMITE HONESTO (documentado, não corrigido — ver relatório da 18.3,
   * seção "Estratégia de atomicidade"): existe uma janela residual,
   * extremamente estreita, envolvendo TRÊS eventos simultâneos (duas
   * chamadas com a MESMA `idempotencyKey` colidindo + um fechamento
   * concorrente) em que o "perdedor" da colisão de chave poderia, por uma
   * fração de milissegundo, enxergar o movimento antes da compensação do
   * "vencedor" apagá-lo. Fechar isso por completo exigiria uma transação
   * multi-documento — inviável hoje porque `mariela_dev_local` é um MongoDB
   * standalone (transações exigem replica set). Ver justificativa completa
   * no relatório da Etapa 18.3.
   */
  private async garantirCaixaAindaAbertoOuReverter(caixaId: string, movimento: MovimentoCaixaDocument, duplicado: boolean): Promise<void> {
    if (duplicado) return;

    const caixaAtual = await this.caixasRepository.encontrarPorId(caixaId);
    if (caixaAtual && caixaAtual.status === "fechado") {
      await this.movimentosRepository.removerPorId(movimento.id);
      throw ApiException.validation(
        "Este caixa foi fechado durante o registro desta operação. Nenhum valor foi salvo — tente novamente (o caixa atualmente aberto, se houver, será usado).",
      );
    }
  }

  /**
   * Etapa 18.2 — saldo negativo é um estado válido: fechamento permitido com
   * `valorEsperado`/`diferenca` negativos, sem nenhum limite inferior.
   * `valorEsperado` continua SEMPRE recalculado pelo backend a partir de
   * `movimentos_caixa` — nunca aceito do payload (`FechamentoCaixaDto` não
   * tem esse campo).
   */
  async fechar(id: string, dto: FechamentoCaixaDto, usuarioId: string | null): Promise<CaixaDetalheResposta> {
    const caixa = await this.caixasRepository.encontrarPorIdOuFalhar(id);
    this.exigirAberto(caixa);

    const movimentos = await this.movimentosRepository.listarTodosPorCaixa(id);
    const valorEsperado = this.calcularResumo(movimentos, caixa.valorInicial).saldoEsperado;
    const diferenca = arredondar(dto.valorInformado - valorEsperado);
    const observacao = dto.observacao?.trim() ?? "";

    if (Math.abs(diferenca) >= DIFERENCA_TOLERANCIA && !observacao) {
      throw ApiException.validation("Dados inválidos.", [
        { field: "observacao", message: "Justifique a diferença encontrada na conferência." },
      ]);
    }

    const atualizado = await this.caixasRepository.fecharAtomico(id, {
      dataFechamento: new Date(),
      valorInformado: arredondar(dto.valorInformado),
      valorEsperado,
      diferenca,
      observacaoFechamento: observacao,
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

  /**
   * Camada de CONSULTA (Etapa 18.2, princípio "Vendas = autoridade
   * comercial"): resolve as vendas distintas referenciadas pelos movimentos
   * `venda`/`cancelamento` deste caixa. Nunca duplica dado de Venda no
   * documento do Caixa — só busca e projeta no momento da leitura.
   */
  private async buscarVendasDoCaixa(movimentos: MovimentoCaixaDocument[]): Promise<VendaResumoDoCaixa[]> {
    const ids = Array.from(
      new Set(
        movimentos
          .filter((movimento) => (movimento.tipo === "venda" || movimento.tipo === "cancelamento") && movimento.vendaId)
          .map((movimento) => movimento.vendaId as string),
      ),
    );
    const vendas = await this.vendasRepository.encontrarPorIds(ids);
    return vendas.map((venda) => this.paraResumoVenda(venda));
  }

  private paraResumoVenda(venda: VendaDocument): VendaResumoDoCaixa {
    return {
      id: venda.id,
      codigo: venda.codigo,
      numero: venda.numero,
      dataVenda: venda.dataVenda,
      clienteId: venda.clienteId,
      clienteNome: venda.clienteNome,
      vendedorId: venda.vendedorId,
      vendedorNome: venda.vendedorNome,
      caixaId: venda.caixaId,
      caixaCodigo: venda.caixaCodigo,
      totalItens: venda.totalItens,
      valorBruto: venda.valorBruto,
      descontoPromocional: venda.descontoPromocional,
      descontoVenda: venda.descontoVenda,
      descontoTotal: venda.descontoTotal,
      valorFinal: venda.valorFinal,
      valorPago: venda.valorPago,
      valorPendente: venda.valorPendente,
      valorDevolvido: venda.valorDevolvido,
      temPromocao: venda.temPromocao,
      temDesconto: venda.temDesconto,
      formaPagamento: venda.formaPagamento,
      totalParcelas: venda.totalParcelas,
      parcelasPagas: venda.parcelasPagas,
      status: venda.status,
    };
  }

  /**
   * Resumo SEMPRE derivado das movimentações — nunca de um campo
   * persistido. Etapa 18.2 — sem `Math.max(0, ...)`: `saldoEsperado` pode
   * ser negativo (sangria/cancelamento sem cobertura de saldo é permitido).
   */
  private calcularResumo(movimentos: MovimentoCaixaDocument[], valorInicial: number): ResumoCaixaCalculado {
    const somar = (tipos: TipoMovimentacaoCaixa[]) =>
      arredondar(movimentos.filter((item) => tipos.includes(item.tipo)).reduce((total, item) => total + item.valor, 0));

    const totalVendas = somar(["venda"]);
    const recebimentos = 0; // Etapa 18.2 — conceito retirado, sempre incluído em totalVendas.
    const entradasManuais = somar(["injecao"]);
    const saidasManuais = somar(["sangria"]);
    const devolucoes = somar(["cancelamento"]);
    const totalEntradas = arredondar(totalVendas + recebimentos + entradasManuais);
    const totalSaidas = arredondar(saidasManuais + devolucoes);

    return {
      valorAbertura: valorInicial,
      totalVendas,
      recebimentos,
      entradasManuais,
      totalEntradas,
      saidasManuais,
      devolucoes,
      totalSaidas,
      saldoEsperado: arredondar(valorInicial + totalEntradas - totalSaidas),
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
        return copia.sort((a, b) => (Math.abs(a.documento.diferenca ?? 0) - Math.abs(b.documento.diferenca ?? 0)) * fator);
      case "vendas":
        return copia.sort((a, b) => (a.resumo.quantidadeVendas - b.resumo.quantidadeVendas) * fator);
      case "data":
      default:
        return copia.sort((a, b) => (a.documento.dataAbertura.getTime() - b.documento.dataAbertura.getTime()) * fator);
    }
  }

  private calcularFacets(base: CaixaComResumo[], selecao: SelecaoFacetas, agora: Date): ApiFacets {
    const contarValores = (chave: ChaveFacetaCaixa, valores: readonly string[]) => {
      const universo = aplicarSelecao(base, selecao, agora, chave);
      return valores.map((valor) => ({ valor, count: universo.filter((item) => condicaoValor(chave, valor, item, agora)).length }));
    };

    return {
      [FACETAS_CAIXA.status]: contarValores(FACETAS_CAIXA.status, STATUS_CAIXA),
      [FACETAS_CAIXA.periodo]: contarValores(FACETAS_CAIXA.periodo, VALORES_PERIODO),
      [FACETAS_CAIXA.diferenca]: contarValores(FACETAS_CAIXA.diferenca, VALORES_DIFERENCA),
      [FACETAS_CAIXA.saldo]: contarValores(
        FACETAS_CAIXA.saldo,
        FAIXAS_SALDO.map((faixa) => faixa.valor),
      ),
    };
  }

  private paraRespostaPublica(caixa: CaixaDocument, resumo: ResumoCaixaCalculado): CaixaRespostaPublica {
    const json = caixa.toJSON() as unknown as {
      id: string;
      codigo: string;
      status: string;
      valorInicial: number;
      dataAbertura: Date;
      observacaoAbertura: string;
      dataFechamento: Date | null;
      valorInformado: number | null;
      valorEsperado: number | null;
      diferenca: number | null;
      observacaoFechamento: string;
    };

    return {
      id: json.id,
      codigo: json.codigo,
      status: json.status,
      abertura: {
        dataHora: json.dataAbertura,
        responsavelId: null,
        responsavelNome: "Loja",
        valorInicial: json.valorInicial,
        observacao: json.observacaoAbertura,
      },
      fechamento:
        json.status === "fechado"
          ? {
              dataHora: json.dataFechamento as Date,
              responsavelId: null,
              responsavelNome: "Loja",
              valorInformado: json.valorInformado as number,
              valorEsperado: json.valorEsperado as number,
              diferenca: json.diferenca as number,
              observacao: json.observacaoFechamento,
            }
          : null,
      resumo,
    };
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
