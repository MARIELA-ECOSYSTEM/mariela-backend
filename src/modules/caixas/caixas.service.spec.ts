import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { JwtModule } from "@nestjs/jwt";
import { getConnectionToken, getModelToken } from "@nestjs/mongoose";
import { Test, type TestingModule } from "@nestjs/testing";
import { Types, type Connection, type Model } from "mongoose";
import { mongooseModuloDeTeste } from "../../test-utils/mongo-teste.util.js";
import { garantirItemConfiguracao } from "../../test-utils/configuracoes-teste.util.js";
import { ApiException } from "../../common/exceptions/api.exception.js";
import { ConfiguracoesService } from "../configuracoes/configuracoes.service.js";
import type { ListarCaixasQueryDto } from "./dto/listar-caixas-query.dto.js";
import type { ListarMovimentosQueryDto } from "./dto/listar-movimentos-query.dto.js";
import { CaixasModule } from "./caixas.module.js";
import { SENTIDO_POR_TIPO, type TipoMovimentacaoCaixa } from "./caixas.constants.js";
import { CaixasService } from "./caixas.service.js";
import { MovimentosCaixaRepository, ordenacaoPorDataHora } from "./movimentos-caixa.repository.js";
import { Caixa, type CaixaDocument } from "./schemas/caixa.schema.js";
import { MovimentoCaixa, type MovimentoCaixaDocument } from "./schemas/movimento-caixa.schema.js";

const JWT_MODULO_DE_TESTE = JwtModule.register({
  global: true,
  secret: "segredo-de-teste",
  signOptions: { expiresIn: "15m" },
});

function queryCaixasPadrao(extra: Partial<ListarCaixasQueryDto> = {}): ListarCaixasQueryDto {
  return {
    ordenarPor: "data",
    ordem: "desc",
    status: [],
    periodo: [],
    diferenca: [],
    saldo: [],
    page: 1,
    limit: 20,
    ...extra,
  };
}

function queryMovimentosPadrao(extra: Partial<ListarMovimentosQueryDto> = {}): ListarMovimentosQueryDto {
  return { tipo: [], ordem: "desc", page: 1, limit: 50, ...extra };
}

/**
 * Etapa 18.2 — Caixa Geral da Loja: sem vínculo de vendedor, 4 tipos de
 * movimento (`injecao`/`sangria`/`venda`/`cancelamento`), saldo negativo
 * permitido. `service.registrarMovimento`/`registrarMovimentoDeVenda`
 * continuam os pontos de entrada testados aqui; `venda`/`cancelamento` são
 * exercitados via chamada direta a `registrarMovimentoDeVenda` (o mesmo
 * método que `VendasService` usa) — nenhuma venda real é necessária para
 * testar o comportamento do Caixa em si (isso é feito separadamente em
 * `vendas.service.spec.ts`, que exercita a integração ponta a ponta).
 */
describe("CaixasService (integração — MongoDB real)", () => {
  let moduleRef: TestingModule;
  let service: CaixasService;
  let connection: Connection;
  let contadorVenda = 0;

  /** Id no formato real de ObjectId (como toda `venda.id` de verdade) mas sem documento correspondente — exercita a integração sem depender de uma Venda real persistida. */
  function vendaFake(): { vendaId: string; vendaCodigo: string } {
    contadorVenda += 1;
    return { vendaId: new Types.ObjectId().toString(), vendaCodigo: `VENDA-FAKE-${contadorVenda}` };
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [mongooseModuloDeTeste(), JWT_MODULO_DE_TESTE, CaixasModule],
    }).compile();
    service = moduleRef.get(CaixasService);
    connection = moduleRef.get(getConnectionToken());
    // Fase 55.2 — pré-requisito para `service.registrarMovimento` (forma de pagamento passou a ser validada).
    await garantirItemConfiguracao(moduleRef.get(ConfiguracoesService), "formasPagamento", "Dinheiro");
  });

  afterAll(async () => {
    await connection.collection("caixas").deleteMany({});
    await connection.collection("movimentos_caixa").deleteMany({});
    await connection.collection("eventos_caixa").deleteMany({});
    await connection.collection("sequencias").deleteMany({ _id: "caixa" });
    await moduleRef.close();
  });

  /** Sempre fecha qualquer caixa aberto ao final de um teste — o índice único parcial só permite um por vez. */
  async function fecharTudoQueEstiverAberto(): Promise<void> {
    await connection.collection("caixas").updateMany({ status: "aberto" }, { $set: { status: "fechado" } });
  }

  describe("abertura, código e concorrência", () => {
    it("abre um caixa com código sequencial e resumo zerado além do valor inicial", async () => {
      const caixa = await service.abrir({ valorInicial: 200 }, null);
      expect(caixa.codigo).toMatch(/^CAIXA-\d{4}$/);
      expect(caixa.resumo.valorAbertura).toBe(200);
      expect(caixa.resumo.saldoEsperado).toBe(200);
      expect(caixa.resumo.quantidadeMovimentacoes).toBe(0);
      await fecharTudoQueEstiverAberto();
    });

    it("Caixa não tem vínculo de vendedor: responsavelId enviado é aceito (compat de payload) mas totalmente ignorado", async () => {
      const caixa = await service.abrir({ valorInicial: 100, responsavelId: "65f1a2b3c4d5e6f7a8b9c0d1" }, null);
      // Nunca lança, mesmo com um id que não corresponde a nenhum vendedor real —
      // a diferença central desta etapa: o Caixa não valida/persiste isso mais.
      expect(caixa.abertura.responsavelNome).toBe("Loja");
      expect(caixa.abertura.responsavelId).toBeNull();
      await fecharTudoQueEstiverAberto();
    });

    it("rejeita abrir um segundo caixa enquanto o primeiro está aberto", async () => {
      await service.abrir({ valorInicial: 100 }, null);
      await expect(service.abrir({ valorInicial: 50 }, null)).rejects.toThrow(ApiException);
      await fecharTudoQueEstiverAberto();
    });

    it("duas aberturas concorrentes: só UMA vence, garantido pelo índice único parcial (não por checagem de aplicação)", async () => {
      const resultados = await Promise.allSettled([
        service.abrir({ valorInicial: 100 }, null),
        service.abrir({ valorInicial: 200 }, null),
      ]);

      const sucesso = resultados.filter((r) => r.status === "fulfilled");
      const falha = resultados.filter((r) => r.status === "rejected");
      expect(sucesso).toHaveLength(1);
      expect(falha).toHaveLength(1);

      const abertos = await connection.collection("caixas").countDocuments({ status: "aberto" });
      expect(abertos).toBe(1);
      await fecharTudoQueEstiverAberto();
    });

    it("registra o evento caixa.aberto com o usuário autenticado", async () => {
      const caixa = await service.abrir({ valorInicial: 100 }, "admin-teste-1");
      const eventos = await connection.collection("eventos_caixa").find({ tipo: "caixa.aberto" }).toArray();
      expect(eventos.some((item) => String(item["caixaId"]) === caixa.id && item["usuarioId"] === "admin-teste-1")).toBe(true);
      await fecharTudoQueEstiverAberto();
    });
  });

  describe("injeção (entrada manual)", () => {
    it("injeção aumenta o saldo esperado", async () => {
      const caixa = await service.abrir({ valorInicial: 100 }, null);
      const atualizado = await service.registrarMovimento(
        caixa.id,
        "entrada",
        { descricao: "Suprimento", valor: 50, formaPagamento: "Dinheiro" },
        null,
      );
      expect(atualizado.resumo.entradasManuais).toBe(50);
      expect(atualizado.resumo.saldoEsperado).toBe(150);
      expect(atualizado.movimentacoes[0]?.tipo).toBe("injecao");
      await fecharTudoQueEstiverAberto();
    });

    it("rejeita valor zero/negativo (validado no DTO, não neste teste — aqui confirmamos que o service não reintroduz limite de saldo)", async () => {
      const caixa = await service.abrir({ valorInicial: 0 }, null);
      const atualizado = await service.registrarMovimento(caixa.id, "entrada", { descricao: "Ajuste", valor: 200, formaPagamento: "Dinheiro" }, null);
      expect(atualizado.resumo.saldoEsperado).toBe(200);
      await fecharTudoQueEstiverAberto();
    });
  });

  describe("sangria (saída manual) — saldo negativo permitido", () => {
    it("sangria reduz o saldo esperado e exige motivo", async () => {
      const caixa = await service.abrir({ valorInicial: 100 }, null);
      const atualizado = await service.registrarMovimento(
        caixa.id,
        "saida",
        { descricao: "Compra", valor: 30, formaPagamento: "Dinheiro", motivo: "Material" },
        null,
      );
      expect(atualizado.resumo.saidasManuais).toBe(30);
      expect(atualizado.resumo.saldoEsperado).toBe(70);
      expect(atualizado.movimentacoes[0]?.tipo).toBe("sangria");
      await fecharTudoQueEstiverAberto();
    });

    it("sangria MAIOR que o saldo disponível É PERMITIDA — saldo fica negativo", async () => {
      const caixa = await service.abrir({ valorInicial: 100 }, null);
      const atualizado = await service.registrarMovimento(
        caixa.id,
        "saida",
        { descricao: "Retirada grande", valor: 500, formaPagamento: "Dinheiro", motivo: "Teste" },
        null,
      );
      expect(atualizado.resumo.saldoEsperado).toBe(-400);
      await fecharTudoQueEstiverAberto();
    });

    it("sangrias sucessivas podem levar o saldo cada vez mais negativo, sem bloqueio", async () => {
      const caixa = await service.abrir({ valorInicial: 100 }, null);
      await service.registrarMovimento(caixa.id, "saida", { descricao: "Sangria 1", valor: 100, formaPagamento: "Dinheiro", motivo: "Teste" }, null);
      const atualizado = await service.registrarMovimento(caixa.id, "saida", { descricao: "Sangria 2", valor: 200, formaPagamento: "Dinheiro", motivo: "Teste" }, null);
      expect(atualizado.resumo.saldoEsperado).toBe(-200);
      await fecharTudoQueEstiverAberto();
    });

    it("rejeita movimentação em caixa fechado", async () => {
      const caixa = await service.abrir({ valorInicial: 100 }, null);
      await service.fechar(caixa.id, { valorInformado: 100 }, null);
      await expect(
        service.registrarMovimento(caixa.id, "entrada", { descricao: "Tarde demais", valor: 10, formaPagamento: "Dinheiro" }, null),
      ).rejects.toThrow(ApiException);
    });

    it("idempotencyKey repetida devolve o mesmo movimento em vez de duplicar", async () => {
      const caixa = await service.abrir({ valorInicial: 100 }, null);
      const chave = `teste-idem-${Date.now()}`;
      await service.registrarMovimento(caixa.id, "entrada", { descricao: "Ajuste", valor: 20, formaPagamento: "Dinheiro", idempotencyKey: chave }, null);
      const repetido = await service.registrarMovimento(
        caixa.id,
        "entrada",
        { descricao: "Ajuste (retry)", valor: 20, formaPagamento: "Dinheiro", idempotencyKey: chave },
        null,
      );
      expect(repetido.resumo.entradasManuais).toBe(20);
      expect(repetido.resumo.quantidadeMovimentacoes).toBe(1);
      await fecharTudoQueEstiverAberto();
    });
  });

  describe("venda e cancelamento (integração com Vendas via registrarMovimentoDeVenda)", () => {
    it("venda registra tipo=venda vinculado à venda, aumenta o saldo", async () => {
      const caixa = await service.abrir({ valorInicial: 0 }, null);
      const { vendaId, vendaCodigo } = vendaFake();
      await service.registrarMovimentoDeVenda({
        caixaId: caixa.id,
        tipo: "venda",
        descricao: "Venda de teste",
        referencia: vendaCodigo,
        vendaId,
        vendaCodigo,
        formaPagamento: "Dinheiro",
        valor: 250,
        observacao: "",
      });
      const detalhe = await service.obterDetalhe(caixa.id);
      expect(detalhe.resumo.totalVendas).toBe(250);
      expect(detalhe.resumo.saldoEsperado).toBe(250);
      expect(detalhe.movimentacoes[0]?.tipo).toBe("venda");
      expect(detalhe.movimentacoes[0]?.vendaId).toBe(vendaId);
      await fecharTudoQueEstiverAberto();
    });

    it("múltiplos pagamentos da MESMA venda geram movimentos VENDA distintos, todos somados no saldo", async () => {
      const caixa = await service.abrir({ valorInicial: 0 }, null);
      const { vendaId, vendaCodigo } = vendaFake();
      await service.registrarMovimentoDeVenda({ caixaId: caixa.id, tipo: "venda", descricao: "Parcela 1", referencia: vendaCodigo, vendaId, vendaCodigo, formaPagamento: "Dinheiro", valor: 200, observacao: "" });
      await service.registrarMovimentoDeVenda({ caixaId: caixa.id, tipo: "venda", descricao: "Parcela 2", referencia: vendaCodigo, vendaId, vendaCodigo, formaPagamento: "Dinheiro", valor: 300, observacao: "" });

      const detalhe = await service.obterDetalhe(caixa.id);
      expect(detalhe.resumo.totalVendas).toBe(500);
      expect(detalhe.resumo.saldoEsperado).toBe(500);
      expect(detalhe.resumo.quantidadeVendas).toBe(1); // uma única venda, dois movimentos
      expect(detalhe.movimentacoes).toHaveLength(2);
      await fecharTudoQueEstiverAberto();
    });

    it("cancelamento (total ou parcial) registra tipo=cancelamento, sentido saída, vinculado à venda", async () => {
      const caixa = await service.abrir({ valorInicial: 0 }, null);
      const { vendaId, vendaCodigo } = vendaFake();
      await service.registrarMovimentoDeVenda({ caixaId: caixa.id, tipo: "venda", descricao: "Venda", referencia: vendaCodigo, vendaId, vendaCodigo, formaPagamento: "Dinheiro", valor: 200, observacao: "" });
      await service.registrarMovimentoDeVenda({ caixaId: caixa.id, tipo: "cancelamento", descricao: "Cancelamento", referencia: vendaCodigo, vendaId, vendaCodigo, formaPagamento: "Dinheiro", valor: 200, observacao: "Cliente desistiu" });

      const detalhe = await service.obterDetalhe(caixa.id);
      expect(detalhe.resumo.devolucoes).toBe(200);
      expect(detalhe.resumo.saldoEsperado).toBe(0);
      const cancelamento = detalhe.movimentacoes.find((m) => m.tipo === "cancelamento");
      expect(cancelamento?.vendaId).toBe(vendaId);
      await fecharTudoQueEstiverAberto();
    });

    it("cancelamento pode deixar o saldo negativo (nunca bloqueado por falta de cobertura)", async () => {
      const caixa = await service.abrir({ valorInicial: 0 }, null);
      const { vendaId, vendaCodigo } = vendaFake();
      await service.registrarMovimentoDeVenda({ caixaId: caixa.id, tipo: "venda", descricao: "Venda", referencia: vendaCodigo, vendaId, vendaCodigo, formaPagamento: "Dinheiro", valor: 200, observacao: "" });
      // Sangria "leva embora" o dinheiro da venda antes do cancelamento chegar.
      await service.registrarMovimento(caixa.id, "saida", { descricao: "Sangria", valor: 200, formaPagamento: "Dinheiro", motivo: "Retirada" }, null);
      await service.registrarMovimentoDeVenda({ caixaId: caixa.id, tipo: "cancelamento", descricao: "Cancelamento", referencia: vendaCodigo, vendaId, vendaCodigo, formaPagamento: "Dinheiro", valor: 200, observacao: "Devolução" });

      const detalhe = await service.obterDetalhe(caixa.id);
      expect(detalhe.resumo.saldoEsperado).toBe(-200);
      await fecharTudoQueEstiverAberto();
    });

    it("movimento original da venda permanece intacto após o cancelamento (nunca editado/apagado)", async () => {
      const caixa = await service.abrir({ valorInicial: 0 }, null);
      const { vendaId, vendaCodigo } = vendaFake();
      await service.registrarMovimentoDeVenda({ caixaId: caixa.id, tipo: "venda", descricao: "Venda original", referencia: vendaCodigo, vendaId, vendaCodigo, formaPagamento: "Dinheiro", valor: 200, observacao: "" });
      await service.registrarMovimentoDeVenda({ caixaId: caixa.id, tipo: "cancelamento", descricao: "Cancelamento", referencia: vendaCodigo, vendaId, vendaCodigo, formaPagamento: "Dinheiro", valor: 200, observacao: "Devolução" });

      const detalhe = await service.obterDetalhe(caixa.id);
      expect(detalhe.movimentacoes).toHaveLength(2);
      const original = detalhe.movimentacoes.find((m) => m.tipo === "venda");
      expect(original?.descricao).toBe("Venda original");
      expect(original?.valor).toBe(200);
      await fecharTudoQueEstiverAberto();
    });

    it("rejeita registrar venda/cancelamento em caixa fechado", async () => {
      const caixa = await service.abrir({ valorInicial: 0 }, null);
      await service.fechar(caixa.id, { valorInformado: 0 }, null);
      const { vendaId, vendaCodigo } = vendaFake();
      await expect(
        service.registrarMovimentoDeVenda({ caixaId: caixa.id, tipo: "venda", descricao: "Tarde demais", referencia: vendaCodigo, vendaId, vendaCodigo, formaPagamento: "Dinheiro", valor: 100, observacao: "" }),
      ).rejects.toThrow(ApiException);
    });
  });

  describe("fechamento", () => {
    it("caixa conferido (sem diferença) não exige observação", async () => {
      const caixa = await service.abrir({ valorInicial: 100 }, null);
      const fechado = await service.fechar(caixa.id, { valorInformado: 100 }, null);
      expect(fechado.status).toBe("fechado");
      expect(fechado.fechamento?.diferenca).toBe(0);
    });

    it("exige observação quando há diferença de caixa", async () => {
      const caixa = await service.abrir({ valorInicial: 100 }, null);
      await expect(service.fechar(caixa.id, { valorInformado: 90 }, null)).rejects.toThrow(ApiException);
      await fecharTudoQueEstiverAberto();
    });

    it("registra sobra/falta corretamente com observação", async () => {
      const caixa = await service.abrir({ valorInicial: 100 }, null);
      const fechado = await service.fechar(caixa.id, { valorInformado: 120, observacao: "Sobrou dinheiro" }, null);
      expect(fechado.fechamento?.diferenca).toBe(20);
    });

    it("fecha caixa com saldo esperado ZERO", async () => {
      const caixa = await service.abrir({ valorInicial: 0 }, null);
      const fechado = await service.fechar(caixa.id, { valorInformado: 0 }, null);
      expect(fechado.status).toBe("fechado");
      expect(fechado.fechamento?.valorEsperado).toBe(0);
    });

    it("fecha caixa com saldo esperado NEGATIVO — sem bloqueio, snapshot reflete o negativo", async () => {
      const caixa = await service.abrir({ valorInicial: 100 }, null);
      await service.registrarMovimento(caixa.id, "saida", { descricao: "Sangria grande", valor: 300, formaPagamento: "Dinheiro", motivo: "Teste" }, null);
      const fechado = await service.fechar(caixa.id, { valorInformado: -200, observacao: "Conferido negativo" }, null);
      expect(fechado.status).toBe("fechado");
      expect(fechado.fechamento?.valorEsperado).toBe(-200);
      expect(fechado.fechamento?.valorInformado).toBe(-200);
      expect(fechado.fechamento?.diferenca).toBe(0);
    });

    // Etapa 18.4, seção 5 — exemplo literal do enunciado: inicial 200, venda
    // +200, sangria -400 → esperado = 0. Sem piso zero em lugar nenhum:
    // informar 50 no fechamento produz diferença POSITIVA de 50 (sobra),
    // nunca "diferenca: 0" nem um esperado recalculado a partir do informado.
    it("Etapa 18.4 — exemplo do enunciado: esperado=0 (200 +200 -400), informado=50 → diferença=+50", async () => {
      const caixa = await service.abrir({ valorInicial: 200 }, null);
      const { vendaId, vendaCodigo } = vendaFake();
      await service.registrarMovimentoDeVenda({ caixaId: caixa.id, tipo: "venda", descricao: "Venda", referencia: vendaCodigo, vendaId, vendaCodigo, formaPagamento: "Dinheiro", valor: 200, observacao: "" });
      await service.registrarMovimento(caixa.id, "saida", { descricao: "Sangria", valor: 400, formaPagamento: "Dinheiro", motivo: "Teste 18.4" }, null);

      const detalhe = await service.obterDetalhe(caixa.id);
      expect(detalhe.resumo.saldoEsperado).toBe(0);

      const fechado = await service.fechar(caixa.id, { valorInformado: 50, observacao: "Sobra de 50 na conferência" }, null);
      expect(fechado.fechamento?.valorEsperado).toBe(0);
      expect(fechado.fechamento?.valorInformado).toBe(50);
      expect(fechado.fechamento?.diferenca).toBe(50);
      await fecharTudoQueEstiverAberto();
    });

    // Etapa 18.4, seção 5 — segundo exemplo do enunciado: inicial 200, venda
    // +200, sangria -400, cancelamento -200 → esperado = -200 (negativo).
    // Informando 0 no fechamento, diferença = 0 - (-200) = +200 — nunca capada
    // nem tratada como "diferenca: 0" só porque o esperado é negativo.
    it("Etapa 18.4 — exemplo do enunciado: esperado=-200 (200 +200 -400 -200), informado=0 → diferença=+200", async () => {
      const caixa = await service.abrir({ valorInicial: 200 }, null);
      const { vendaId, vendaCodigo } = vendaFake();
      await service.registrarMovimentoDeVenda({ caixaId: caixa.id, tipo: "venda", descricao: "Venda", referencia: vendaCodigo, vendaId, vendaCodigo, formaPagamento: "Dinheiro", valor: 200, observacao: "" });
      await service.registrarMovimento(caixa.id, "saida", { descricao: "Sangria", valor: 400, formaPagamento: "Dinheiro", motivo: "Teste 18.4" }, null);
      await service.registrarMovimentoDeVenda({ caixaId: caixa.id, tipo: "cancelamento", descricao: "Cancelamento", referencia: vendaCodigo, vendaId, vendaCodigo, formaPagamento: "Dinheiro", valor: 200, observacao: "Devolução" });

      const detalhe = await service.obterDetalhe(caixa.id);
      expect(detalhe.resumo.saldoEsperado).toBe(-200);

      const fechado = await service.fechar(caixa.id, { valorInformado: 0, observacao: "Faltou dinheiro na conferência" }, null);
      expect(fechado.fechamento?.valorEsperado).toBe(-200);
      expect(fechado.fechamento?.valorInformado).toBe(0);
      expect(fechado.fechamento?.diferenca).toBe(200);
      await fecharTudoQueEstiverAberto();
    });

    it("rejeita fechar um caixa já fechado (checagem de estado sequencial)", async () => {
      const caixa = await service.abrir({ valorInicial: 100 }, null);
      await service.fechar(caixa.id, { valorInformado: 100 }, null);
      await expect(service.fechar(caixa.id, { valorInformado: 100 }, null)).rejects.toThrow(ApiException);
    });

    it("duas chamadas de fechamento concorrentes: só UMA fecha, a outra é rejeitada pela guarda atômica (não pela checagem de estado)", async () => {
      const caixa = await service.abrir({ valorInicial: 100 }, null);
      const resultados = await Promise.allSettled([
        service.fechar(caixa.id, { valorInformado: 100 }, null),
        service.fechar(caixa.id, { valorInformado: 100 }, null),
      ]);

      const sucesso = resultados.filter((r) => r.status === "fulfilled");
      const falha = resultados.filter((r) => r.status === "rejected");
      expect(sucesso).toHaveLength(1);
      expect(falha).toHaveLength(1);

      const bruto = await connection.collection("caixas").findOne({ codigo: caixa.codigo });
      expect(bruto?.["status"]).toBe("fechado");
    });

    it("libera abrir um novo caixa depois do anterior ser fechado, SEM herdar o saldo negativo do anterior", async () => {
      const caixa = await service.abrir({ valorInicial: 100 }, null);
      await service.registrarMovimento(caixa.id, "saida", { descricao: "Sangria grande", valor: 300, formaPagamento: "Dinheiro", motivo: "Teste" }, null);
      await service.fechar(caixa.id, { valorInformado: -200, observacao: "Negativo" }, null);

      const novo = await service.abrir({ valorInicial: 50 }, null);
      expect(novo.codigo).not.toBe(caixa.codigo);
      expect(novo.resumo.valorAbertura).toBe(50);
      expect(novo.resumo.saldoEsperado).toBe(50); // não herda o -200 do caixa anterior

      const anterior = await service.obterDetalhe(caixa.id);
      expect(anterior.status).toBe("fechado");
      expect(anterior.fechamento?.valorEsperado).toBe(-200); // permanece consultável
      await fecharTudoQueEstiverAberto();
    });
  });

  describe("consulta: atual, detalhe, estatísticas", () => {
    it("obterAtual devolve null quando nenhum caixa está aberto", async () => {
      await fecharTudoQueEstiverAberto();
      const atual = await service.obterAtual();
      expect(atual).toBeNull();
    });

    it("obterAtual devolve o caixa aberto com resumo calculado", async () => {
      const caixa = await service.abrir({ valorInicial: 100 }, null);
      const atual = await service.obterAtual();
      expect(atual?.id).toBe(caixa.id);
      await fecharTudoQueEstiverAberto();
    });

    it("obterDetalhe lança NOT_FOUND para um caixa inexistente", async () => {
      await expect(service.obterDetalhe("65f1a2b3c4d5e6f7a8b9c0d1")).rejects.toThrow(ApiException);
    });

    it("obterDetalhe: vendas vinculadas ficam vazias quando a venda referenciada não existe de verdade (consulta real, nunca inventa dado)", async () => {
      const caixa = await service.abrir({ valorInicial: 0 }, null);
      const { vendaId, vendaCodigo } = vendaFake(); // id no formato ObjectId, mas sem documento em `vendas`
      await service.registrarMovimentoDeVenda({ caixaId: caixa.id, tipo: "venda", descricao: "Venda", referencia: vendaCodigo, vendaId, vendaCodigo, formaPagamento: "Dinheiro", valor: 100, observacao: "" });
      const detalhe = await service.obterDetalhe(caixa.id);
      expect(detalhe.vendas).toEqual([]); // consulta real: vendaId não existe em `vendas`, então não aparece
      expect(detalhe.recebimentos).toEqual([]); // conceito retirado do domínio — sempre vazio
      await fecharTudoQueEstiverAberto();
    });

    it("obterDetalhe: nunca lança/quebra quando vendaId não tem formato de ObjectId válido (defensivo)", async () => {
      const caixa = await service.abrir({ valorInicial: 0 }, null);
      await service.registrarMovimentoDeVenda({
        caixaId: caixa.id,
        tipo: "venda",
        descricao: "Venda com id malformado",
        referencia: "REF",
        vendaId: "id-nao-e-objectid",
        vendaCodigo: "VENDA-X",
        formaPagamento: "Dinheiro",
        valor: 100,
        observacao: "",
      });
      const detalhe = await service.obterDetalhe(caixa.id);
      expect(detalhe.vendas).toEqual([]);
      await fecharTudoQueEstiverAberto();
    });

    it("estatisticas soma entradas/saídas do dia e caixasAbertos/Fechados", async () => {
      const caixa = await service.abrir({ valorInicial: 100 }, null);
      await service.registrarMovimento(caixa.id, "entrada", { descricao: "Ajuste", valor: 40, formaPagamento: "Dinheiro" }, null);
      const stats = await service.estatisticas();
      expect(stats.caixasAbertos).toBeGreaterThanOrEqual(1);
      expect(stats.entradasHoje).toBeGreaterThanOrEqual(40);
      expect(stats.recebimentosHoje).toBe(0); // conceito retirado do domínio
      await fecharTudoQueEstiverAberto();
    });
  });

  describe("listagem completa sem paginação (contrato legado do Backoffice — Etapa 18.2)", () => {
    it("listarTodos() devolve todos os caixas, sem truncar por um limite padrão", async () => {
      const prefixo = `Full${Date.now()}`;
      for (let indice = 0; indice < 25; indice += 1) {
        const caixa = await service.abrir({ valorInicial: 10 }, null);
        await service.fechar(caixa.id, { valorInformado: 10 }, null);
        void prefixo; // apenas para manter o padrão de nomeação dos outros módulos; caixas não têm campo "nome" para filtrar por prefixo.
      }
      const todos = await service.listarTodos();
      expect(todos.length).toBeGreaterThanOrEqual(25); // nunca truncado em 20 (LIMITE_PADRAO), ao contrário de listar()
    });
  });

  describe("movimentações paginadas", () => {
    it("pagina o histórico de movimentações de um caixa", async () => {
      const caixa = await service.abrir({ valorInicial: 100 }, null);
      for (let indice = 0; indice < 5; indice += 1) {
        await service.registrarMovimento(caixa.id, "entrada", { descricao: `Ajuste ${indice}`, valor: 10, formaPagamento: "Dinheiro" }, null);
      }
      const primeira = await service.listarMovimentos(caixa.id, queryMovimentosPadrao({ limit: 2, page: 1 }));
      expect(primeira.data).toHaveLength(2);
      expect(primeira.meta.total).toBe(5);
      expect(primeira.meta.totalPages).toBe(3);
      await fecharTudoQueEstiverAberto();
    });

    it("filtra movimentações por tipo", async () => {
      const caixa = await service.abrir({ valorInicial: 100 }, null);
      await service.registrarMovimento(caixa.id, "entrada", { descricao: "Entrada", valor: 10, formaPagamento: "Dinheiro" }, null);
      await service.registrarMovimento(caixa.id, "saida", { descricao: "Saída", valor: 5, formaPagamento: "Dinheiro", motivo: "Teste" }, null);
      const apenasSangrias = await service.listarMovimentos(caixa.id, queryMovimentosPadrao({ tipo: ["sangria"] }));
      expect(apenasSangrias.data).toHaveLength(1);
      expect(apenasSangrias.data[0]?.tipo).toBe("sangria");
      await fecharTudoQueEstiverAberto();
    });
  });

  /**
   * Fase 55.6 — empates de `dataHora` (resolução de milissegundo; uma venda
   * com vários pagamentos grava vários movimentos em sequência). O serviço
   * sempre grava `new Date()`, por isso a fixture insere direto pelo model
   * (com validação do schema) para controlar `dataHora` e `_id`. Os `_id` são
   * gerados em ordem crescente e inseridos numa permutação determinística NÃO
   * monotônica (passo 7 módulo n): nem a ordem de inserção nem a física do
   * índice coincidem com a de `_id` em nenhuma direção de varredura, então a
   * ordem esperada só bate se o desempate for de fato por `_id`. (Inserir em
   * ordem simplesmente invertida não serve: a varredura do índice nos dois
   * sentidos reproduz a ordem de `_id` por coincidência.)
   * Data no passado: não interfere nas estatísticas "do dia" de outros testes.
   */
  describe("ordenação determinística com empates de dataHora (Fase 55.6)", () => {
    type Fixture = { caixaId: string; asc: string[]; tipoPorId: Map<string, TipoMovimentacaoCaixa> };

    const TIPOS_FIXTURE: TipoMovimentacaoCaixa[] = ["injecao", "sangria", "venda", "cancelamento", "injecao"];

    /** `grupos` instantes distintos × `porGrupo` movimentos com a MESMA `dataHora` em cada um. */
    async function criarMovimentosEmpatados(grupos: number, porGrupo: number): Promise<Fixture> {
      await fecharTudoQueEstiverAberto();
      const caixa = await service.abrir({ valorInicial: 0 }, null);
      await fecharTudoQueEstiverAberto();

      const movimentoModel = moduleRef.get<Model<MovimentoCaixaDocument>>(getModelToken(MovimentoCaixa.name));
      const documentos: Record<string, unknown>[] = [];
      for (let grupo = 0; grupo < grupos; grupo += 1) {
        const dataHora = new Date(Date.UTC(2025, 0, 15, 12, 0, grupo));
        for (let indice = 0; indice < porGrupo; indice += 1) {
          const tipo = TIPOS_FIXTURE[(grupo * porGrupo + indice) % TIPOS_FIXTURE.length]!;
          documentos.push({
            _id: new Types.ObjectId(),
            caixaId: new Types.ObjectId(caixa.id),
            dataHora,
            tipo,
            origem: tipo === "venda" || tipo === "cancelamento" ? tipo : "manual",
            descricao: `Empate ${grupo}-${indice}`,
            formaPagamento: "Dinheiro",
            valor: 1,
            sentido: SENTIDO_POR_TIPO[tipo],
          });
        }
      }
      // Gerados em ordem crescente de `_id` (dentro de cada `dataHora`) = ordem `asc` esperada.
      const asc = documentos.map((documento) => String(documento["_id"]));
      const tipoPorId = new Map(documentos.map((documento) => [String(documento["_id"]), documento["tipo"] as TipoMovimentacaoCaixa]));
      // Passo 7 é coprimo com os tamanhos usados (15 e 200), então percorre todos os índices.
      const ordemDeInsercao = documentos.map((_, indice) => documentos[(indice * 7) % documentos.length]!);
      expect(new Set(ordemDeInsercao).size).toBe(documentos.length);
      await movimentoModel.insertMany(ordemDeInsercao); // `ordered` (padrão): grava na ordem do array
      return { caixaId: caixa.id, asc, tipoPorId };
    }

    async function removerFixture(fixture: Fixture): Promise<void> {
      await connection.collection("movimentos_caixa").deleteMany({ caixaId: new Types.ObjectId(fixture.caixaId) });
    }

    /** Percorre todas as páginas de `listarMovimentos` e devolve os ids na ordem recebida. */
    async function paginarTudo(caixaId: string, extra: Partial<ListarMovimentosQueryDto>): Promise<string[]> {
      const ids: string[] = [];
      for (let page = 1, totalPages = 1; page <= totalPages; page += 1) {
        const resultado = await service.listarMovimentos(caixaId, queryMovimentosPadrao({ ...extra, page }));
        ids.push(...resultado.data.map((movimento) => String(movimento._id)));
        totalPages = resultado.meta.totalPages ?? page;
      }
      return ids;
    }

    it("sem paginação: asc segue dataHora e, no empate, _id crescente; desc é exatamente o inverso", async () => {
      const fixture = await criarMovimentosEmpatados(3, 5);
      try {
        const asc = await service.listarMovimentos(fixture.caixaId, queryMovimentosPadrao({ ordem: "asc" }), false);
        expect(asc.data.map((movimento) => String(movimento._id))).toEqual(fixture.asc);

        const desc = await service.listarMovimentos(fixture.caixaId, queryMovimentosPadrao({ ordem: "desc" }), false);
        expect(desc.data.map((movimento) => String(movimento._id))).toEqual([...fixture.asc].reverse());
      } finally {
        await removerFixture(fixture);
      }
    });

    it("paginado sem filtro de tipo: empates na fronteira entre páginas nunca duplicam nem omitem registros", async () => {
      const fixture = await criarMovimentosEmpatados(3, 5); // grupos de 5 empatados
      try {
        // limit 2/4/7 cortam DENTRO de um grupo empatado; 5 coincide com a fronteira dos grupos.
        for (const limit of [2, 4, 5, 7]) {
          for (const ordem of ["asc", "desc"] as const) {
            const esperado = ordem === "asc" ? fixture.asc : [...fixture.asc].reverse();
            const ids = await paginarTudo(fixture.caixaId, { ordem, limit });
            expect(new Set(ids).size).toBe(ids.length); // sem duplicados
            expect(ids).toEqual(esperado); // sem omitidos, na ordem exata
          }
        }
      } finally {
        await removerFixture(fixture);
      }
    });

    it("paginado com filtro de tipo: mesma ordem composta, sem duplicados nem omitidos", async () => {
      const fixture = await criarMovimentosEmpatados(3, 5);
      try {
        const tipos: TipoMovimentacaoCaixa[] = ["injecao", "sangria"];
        const filtradoAsc = fixture.asc.filter((id) => tipos.includes(fixture.tipoPorId.get(id)!));
        expect(filtradoAsc.length).toBeGreaterThan(3); // a fixture precisa produzir mais de uma página
        for (const ordem of ["asc", "desc"] as const) {
          const esperado = ordem === "asc" ? filtradoAsc : [...filtradoAsc].reverse();
          const ids = await paginarTudo(fixture.caixaId, { ordem, limit: 3, tipo: tipos });
          expect(new Set(ids).size).toBe(ids.length);
          expect(ids).toEqual(esperado);
        }
      } finally {
        await removerFixture(fixture);
      }
    });

    it("recentesPorCaixa: o top-N cortando um grupo empatado inclui exatamente os de maior (dataHora, _id)", async () => {
      const fixture = await criarMovimentosEmpatados(3, 5);
      try {
        const repositorio = moduleRef.get(MovimentosCaixaRepository);
        // N = 7 → os 5 do instante mais recente + os 2 de maior _id do instante anterior.
        const recentes = await repositorio.recentesPorCaixa(fixture.caixaId, 7);
        expect(recentes.map((movimento) => String(movimento._id))).toEqual([...fixture.asc].reverse().slice(0, 7));
      } finally {
        await removerFixture(fixture);
      }
    });

    it("com o plano alternativo forçado (índice { caixaId, tipo } + SORT em memória), a ordenação composta pagina sem duplicar nem omitir", async () => {
      // Reproduz o cenário da auditoria da Fase 55.5 independentemente do plano
      // que o MongoDB escolheria sozinho: o `hint` força o índice de `tipo`, que
      // não entrega `dataHora` ordenada, então o MongoDB ordena em memória.
      const fixture = await criarMovimentosEmpatados(4, 50);
      try {
        const movimentoModel = moduleRef.get<Model<MovimentoCaixaDocument>>(getModelToken(MovimentoCaixa.name));
        const tipos: TipoMovimentacaoCaixa[] = ["injecao", "venda", "sangria"];
        const filtro = { caixaId: new Types.ObjectId(fixture.caixaId), tipo: { $in: tipos } };
        const hint = { caixaId: 1, tipo: 1 };

        const plano = (await movimentoModel.find(filtro).sort(ordenacaoPorDataHora(-1)).hint(hint).skip(10).limit(10).explain("queryPlanner")) as unknown;
        const planoVencedor = JSON.stringify((plano as { queryPlanner: { winningPlan: unknown } }).queryPlanner.winningPlan);
        expect(planoVencedor).toContain('"SORT"'); // o plano alternativo está mesmo em uso
        expect(planoVencedor).toContain("caixaId_1_tipo_1");

        const filtradoAsc = fixture.asc.filter((id) => tipos.includes(fixture.tipoPorId.get(id)!));
        for (const limit of [7, 10, 13]) {
          for (const direcao of [1, -1] as const) {
            const ids: string[] = [];
            for (let skip = 0; skip < filtradoAsc.length; skip += limit) {
              const pagina = await movimentoModel.find(filtro).sort(ordenacaoPorDataHora(direcao)).hint(hint).skip(skip).limit(limit).lean().exec();
              ids.push(...pagina.map((movimento) => String(movimento._id)));
            }
            expect(new Set(ids).size).toBe(ids.length);
            expect(ids).toEqual(direcao === 1 ? filtradoAsc : [...filtradoAsc].reverse());
          }
        }
      } finally {
        await removerFixture(fixture);
      }
    });
  });

  /**
   * Fase 55.7 — ordem total dos caixas. A fixture grava direto pelos models
   * (com validação do schema) para controlar `dataAbertura`, `codigo`, status
   * e diferença — o serviço sempre usa `new Date()` e a sequência. Códigos
   * altos (≥ 9994) nunca colidem com os gerados pela sequência neste arquivo.
   * As asserções olham a ordem RELATIVA dos caixas da fixture na resposta
   * pública completa de `listar()` (como a ordem é total, ela não depende de
   * outros caixas). O `beforeAll` remove caixas/movimentos de grupos já
   * encerrados (o Bun roda cada `describe` como unidade contígua; cada teste
   * dos outros grupos cria seus próprios dados) só para manter a paginação com
   * `limit` pequeno barata — `listar()` carrega todos os caixas e movimentos.
   */
  describe("ordenação determinística dos caixas (Fase 55.7)", () => {
    beforeAll(async () => {
      await connection.collection("movimentos_caixa").deleteMany({});
      await connection.collection("caixas").deleteMany({});
    });

    type DefinicaoCaixa = {
      codigo: string;
      dataAbertura: Date;
      status?: "aberto" | "fechado";
      valorInicial?: number;
      diferenca?: number;
      vendas?: number[]; // um movimento de venda (com vendaId próprio) por valor
    };

    async function criarCaixasFixture(definicoes: DefinicaoCaixa[]): Promise<() => Promise<void>> {
      await fecharTudoQueEstiverAberto(); // o índice único parcial só permite um caixa aberto
      const caixaModel = moduleRef.get<Model<CaixaDocument>>(getModelToken(Caixa.name));
      const movimentoModel = moduleRef.get<Model<MovimentoCaixaDocument>>(getModelToken(MovimentoCaixa.name));
      const ids: Types.ObjectId[] = [];
      for (const definicao of definicoes) {
        const aberto = definicao.status === "aberto";
        const caixa = await caixaModel.create({
          codigo: definicao.codigo,
          status: definicao.status ?? "fechado",
          valorInicial: definicao.valorInicial ?? 100,
          dataAbertura: definicao.dataAbertura,
          dataFechamento: aberto ? null : definicao.dataAbertura,
          valorInformado: aberto ? null : 0,
          valorEsperado: aberto ? null : 0,
          diferenca: aberto ? null : (definicao.diferenca ?? 0),
        });
        ids.push(caixa._id);
        for (const valor of definicao.vendas ?? []) {
          await movimentoModel.create({
            caixaId: caixa._id,
            dataHora: definicao.dataAbertura,
            tipo: "venda",
            origem: "venda",
            descricao: "Venda fixture",
            vendaId: new Types.ObjectId().toString(),
            vendaCodigo: "VENDA-FIXTURE",
            formaPagamento: "Dinheiro",
            valor,
            sentido: SENTIDO_POR_TIPO.venda,
          });
        }
      }
      return async () => {
        await connection.collection("movimentos_caixa").deleteMany({ caixaId: { $in: ids } });
        await connection.collection("caixas").deleteMany({ _id: { $in: ids } });
      };
    }

    /** Percorre todas as páginas de `listar()`: códigos na ordem recebida e o `meta.total` informado. */
    async function paginarCaixas(extra: Partial<ListarCaixasQueryDto>): Promise<{ codigos: string[]; total: number }> {
      const codigos: string[] = [];
      let total: number | undefined;
      for (let page = 1, totalPages = 1; page <= totalPages; page += 1) {
        const resultado = await service.listar(queryCaixasPadrao({ ...extra, page }));
        codigos.push(...resultado.data.map((caixa) => caixa.codigo));
        totalPages = resultado.meta.totalPages ?? page;
        total ??= resultado.meta.total;
      }
      if (total === undefined) throw new Error("listar() não informou meta.total");
      return { codigos, total };
    }

    async function listarTodosOsCodigos(extra: Partial<ListarCaixasQueryDto>): Promise<string[]> {
      return (await paginarCaixas(extra)).codigos;
    }

    function ordemDaFixture(codigos: string[], daFixture: string[]): string[] {
      return codigos.filter((codigo) => daFixture.includes(codigo));
    }

    const D0 = new Date(Date.UTC(2024, 2, 10, 9, 0, 0));
    const D1 = new Date(Date.UTC(2024, 2, 11, 9, 0, 0));
    const D2 = new Date(Date.UTC(2024, 2, 12, 9, 0, 0));
    const D3 = new Date(Date.UTC(2024, 2, 13, 9, 0, 0));

    it("os cinco critérios, asc e desc: empate por dataAbertura DESC e depois pelo número do código (CAIXA-10000 depois de CAIXA-9999), com aberto/fechado empatando na diferença", async () => {
      // F, D, B, A e C empatam em saldo (150), vendas (1), faturamento (50) e
      // diferença (0 — F está ABERTO, diferença null tratada como 0). A e B
      // empatam também em dataAbertura (D1): só o número do código decide.
      // E é maior em todos os critérios.
      const limpar = await criarCaixasFixture([
        { codigo: "CAIXA-9999", dataAbertura: D1, vendas: [50] }, // A
        { codigo: "CAIXA-10000", dataAbertura: D1, vendas: [50] }, // B
        { codigo: "CAIXA-10001", dataAbertura: D0, vendas: [50] }, // C
        { codigo: "CAIXA-9998", dataAbertura: D2, vendas: [50] }, // D
        { codigo: "CAIXA-20000", dataAbertura: D0, valorInicial: 500, diferenca: -30, vendas: [100, 100] }, // E
        { codigo: "CAIXA-20001", dataAbertura: D3, status: "aberto", vendas: [50] }, // F
      ]);
      try {
        const daFixture = ["CAIXA-9999", "CAIXA-10000", "CAIXA-10001", "CAIXA-9998", "CAIXA-20000", "CAIXA-20001"];
        // Entre empatados: o mais recente primeiro, em QUALQUER direção → F, D, B (10000), A (9999), C.
        const empatados = ["CAIXA-20001", "CAIXA-9998", "CAIXA-10000", "CAIXA-9999", "CAIXA-10001"];
        for (const ordenarPor of ["saldo", "vendas", "faturamento", "diferenca"] as const) {
          expect(ordemDaFixture(await listarTodosOsCodigos({ ordenarPor, ordem: "asc", limit: 100 }), daFixture)).toEqual([...empatados, "CAIXA-20000"]);
          expect(ordemDaFixture(await listarTodosOsCodigos({ ordenarPor, ordem: "desc", limit: 100 }), daFixture)).toEqual(["CAIXA-20000", ...empatados]);
        }
        // data: dataAbertura e número do código, ambos na direção pedida.
        const dataAsc = ["CAIXA-10001", "CAIXA-20000", "CAIXA-9999", "CAIXA-10000", "CAIXA-9998", "CAIXA-20001"];
        expect(ordemDaFixture(await listarTodosOsCodigos({ ordenarPor: "data", ordem: "asc", limit: 100 }), daFixture)).toEqual(dataAsc);
        expect(ordemDaFixture(await listarTodosOsCodigos({ ordenarPor: "data", ordem: "desc", limit: 100 }), daFixture)).toEqual([...dataAsc].reverse());
      } finally {
        await limpar();
      }
    });

    it("paginação com empates na fronteira entre páginas: sem duplicados, sem omitidos, mesma ordem entre requisições", async () => {
      // 12 caixas empatados em saldo/vendas/faturamento/diferença, em 3 datas
      // com 4 caixas cada. O grupo do meio (9998, 9999, 10000, 10001) mistura
      // 4 e 5 dígitos na MESMA data: só a comparação numérica do código acerta.
      const definicoes: DefinicaoCaixa[] = Array.from({ length: 12 }, (_, indice) => ({
        codigo: `CAIXA-${9994 + indice}`,
        dataAbertura: [D0, D1, D2][Math.floor(indice / 4)]!,
      }));
      const limpar = await criarCaixasFixture(definicoes);
      try {
        const daFixture = definicoes.map((definicao) => definicao.codigo);
        // Mais recente primeiro; na mesma data, maior número primeiro.
        const esperadoEmpate = [...definicoes]
          .sort((a, b) => b.dataAbertura.getTime() - a.dataAbertura.getTime() || Number(b.codigo.slice(6)) - Number(a.codigo.slice(6)))
          .map((definicao) => definicao.codigo);
        for (const limit of [3, 5, 7]) {
          for (const ordenarPor of ["saldo", "vendas", "faturamento", "diferenca", "data"] as const) {
            for (const ordem of ["asc", "desc"] as const) {
              const { codigos, total } = await paginarCaixas({ ordenarPor, ordem, limit });
              expect(new Set(codigos).size).toBe(codigos.length); // nenhum duplicado em toda a listagem
              expect(codigos.length).toBe(total); // nenhum omitido
              const daFixtureNaOrdem = ordemDaFixture(codigos, daFixture);
              if (ordenarPor === "data") {
                const dataAsc = [...esperadoEmpate].reverse();
                expect(daFixtureNaOrdem).toEqual(ordem === "asc" ? dataAsc : esperadoEmpate);
              } else {
                expect(daFixtureNaOrdem).toEqual(esperadoEmpate);
              }
              if (limit === 5) expect(await listarTodosOsCodigos({ ordenarPor, ordem, limit })).toEqual(codigos); // estável entre requisições
            }
          }
        }
      } finally {
        await limpar();
      }
    });

    /**
     * Fase 55.7.1 — `listarTodos()` (contrato legado de `GET /caixas` sem
     * parâmetros, usado pelo Backoffice) com a ordem-base `dataAbertura` DESC
     * → número do código DESC. A fixture é inserida na ordem INVERSA da
     * esperada: como a ordem natural do MongoDB é a de inserção, a
     * implementação anterior (sem ordenação) devolveria exatamente o oposto.
     */
    describe("listarTodos() — ordem-base determinística (Fase 55.7.1)", () => {
      // Inserção: mais antigo primeiro (ordem natural = esta).
      const DEFINICOES: DefinicaoCaixa[] = [
        { codigo: "CAIXA-10001", dataAbertura: D0, vendas: [70] },
        { codigo: "LEGADO-X", dataAbertura: D1 },
        { codigo: "CAIXA-9999", dataAbertura: D1, diferenca: -5 },
        { codigo: "CAIXA-10000", dataAbertura: D1, vendas: [30, 20] },
        { codigo: "CAIXA-9998", dataAbertura: D2, valorInicial: 250 },
        { codigo: "CAIXA-20001", dataAbertura: D3, status: "aberto" },
      ];
      const DA_FIXTURE = DEFINICOES.map((definicao) => definicao.codigo);
      // D3 (aberto) → D2 → D1: 10000, 9999 (numérico: 10000 > 9999), LEGADO-X (inválido fica depois dos válidos no DESC) → D0.
      const ESPERADO = ["CAIXA-20001", "CAIXA-9998", "CAIXA-10000", "CAIXA-9999", "LEGADO-X", "CAIXA-10001"];

      it("mais recente primeiro; mesma data pelo número do código DESC (CAIXA-10000 antes de CAIXA-9999); código inválido consistente com o comparador; aberto e fechados presentes", async () => {
        const limpar = await criarCaixasFixture(DEFINICOES);
        try {
          const todos = await service.listarTodos();
          const codigos = todos.map((caixa) => caixa.codigo);
          expect(ordemDaFixture(codigos, DA_FIXTURE)).toEqual(ESPERADO);
          expect(ordemDaFixture(codigos, DA_FIXTURE)).not.toEqual(DA_FIXTURE); // ≠ ordem de inserção (natural)

          const porCodigo = new Map(todos.map((caixa) => [caixa.codigo, caixa]));
          expect(porCodigo.get("CAIXA-20001")?.status).toBe("aberto");
          expect(porCodigo.get("CAIXA-20001")?.fechamento).toBeNull();
          for (const codigo of DA_FIXTURE.filter((item) => item !== "CAIXA-20001")) {
            expect(porCodigo.get(codigo)?.status).toBe("fechado");
          }
        } finally {
          await limpar();
        }
      });

      it("só a ordem muda: cada item é idêntico ao do mesmo caixa em listar(), e chamadas repetidas devolvem exatamente a mesma sequência", async () => {
        const limpar = await criarCaixasFixture(DEFINICOES);
        try {
          const primeira = await service.listarTodos();
          const daFixtureEmTodos = primeira.filter((caixa) => DA_FIXTURE.includes(caixa.codigo));
          expect(daFixtureEmTodos).toHaveLength(DA_FIXTURE.length);

          const paginado = await service.listar(queryCaixasPadrao({ ordenarPor: "data", ordem: "desc", limit: 100 }));
          const porCodigoEmListar = new Map(paginado.data.map((caixa) => [caixa.codigo, caixa]));
          for (const caixa of daFixtureEmTodos) {
            expect(caixa).toEqual(porCodigoEmListar.get(caixa.codigo)!); // mesmo conteúdo (resumo, abertura, fechamento…)
          }
          // Resumo derivado dos movimentos preservado (não só a ordem): 30 + 20 em vendas.
          expect(daFixtureEmTodos.find((caixa) => caixa.codigo === "CAIXA-10000")?.resumo.totalVendas).toBe(50);

          for (let repeticao = 0; repeticao < 3; repeticao += 1) {
            expect(await service.listarTodos()).toEqual(primeira);
          }
        } finally {
          await limpar();
        }
      });
    });

    it("códigos fora do formato nunca viram 0: ficam antes dos válidos (como os mais antigos) e se ordenam entre si pela string", async () => {
      const limpar = await criarCaixasFixture([
        { codigo: "CAIXA-0002", dataAbertura: D1 },
        { codigo: "LEGADO-B", dataAbertura: D1 },
        { codigo: "CAIXA-0010", dataAbertura: D1 },
        { codigo: "LEGADO-A", dataAbertura: D1 },
      ]);
      try {
        const daFixture = ["CAIXA-0002", "LEGADO-B", "CAIXA-0010", "LEGADO-A"];
        expect(ordemDaFixture(await listarTodosOsCodigos({ ordenarPor: "data", ordem: "asc", limit: 100 }), daFixture)).toEqual([
          "LEGADO-A",
          "LEGADO-B",
          "CAIXA-0002",
          "CAIXA-0010",
        ]);
        // Critério financeiro empatado: código DESC → válidos (maior número primeiro), depois inválidos.
        expect(ordemDaFixture(await listarTodosOsCodigos({ ordenarPor: "saldo", ordem: "asc", limit: 100 }), daFixture)).toEqual([
          "CAIXA-0010",
          "CAIXA-0002",
          "LEGADO-B",
          "LEGADO-A",
        ]);
      } finally {
        await limpar();
      }
    });
  });

  describe("movimentações — contrato duplo (Etapa 20.01A)", () => {
    it("paginado=false devolve TODO o histórico, sem truncar pelo limite padrão (50)", async () => {
      const caixa = await service.abrir({ valorInicial: 100 }, null);
      const quantidade = 55;
      for (let indice = 0; indice < quantidade; indice += 1) {
        await service.registrarMovimento(caixa.id, "entrada", { descricao: `Ajuste ${indice}`, valor: 1, formaPagamento: "Dinheiro" }, null);
      }

      const todos = await service.listarMovimentos(caixa.id, queryMovimentosPadrao(), false);
      expect(todos.data).toHaveLength(quantidade);
      expect(todos.meta.total).toBe(quantidade);
      expect(todos.meta.limit).toBe(quantidade);
      expect(todos.meta.totalPages).toBe(1);
      await fecharTudoQueEstiverAberto();
    });

    it("paginado=true (default) continua truncando pelo limit informado", async () => {
      const caixa = await service.abrir({ valorInicial: 100 }, null);
      for (let indice = 0; indice < 5; indice += 1) {
        await service.registrarMovimento(caixa.id, "entrada", { descricao: `Ajuste ${indice}`, valor: 1, formaPagamento: "Dinheiro" }, null);
      }

      const pagina = await service.listarMovimentos(caixa.id, queryMovimentosPadrao({ limit: 2, page: 1 }));
      expect(pagina.data).toHaveLength(2);
      expect(pagina.meta.total).toBe(5);
      expect(pagina.meta.totalPages).toBe(3);
      await fecharTudoQueEstiverAberto();
    });
  });

  describe("listagem: busca, paginação, ordenação e facetas", () => {
    it("busca por código do caixa encontra o registro", async () => {
      const caixa = await service.abrir({ valorInicial: 100 }, null);
      const resultado = await service.listar(queryCaixasPadrao({ busca: caixa.codigo }));
      expect(resultado.data).toHaveLength(1);
      await fecharTudoQueEstiverAberto();
    });

    it("filtro status=fechado só retorna caixas fechados", async () => {
      const caixa = await service.abrir({ valorInicial: 100 }, null);
      await service.fechar(caixa.id, { valorInformado: 100 }, null);
      const resultado = await service.listar(queryCaixasPadrao({ busca: caixa.codigo, status: ["fechado"] }));
      expect(resultado.data).toHaveLength(1);
      expect(resultado.data[0]?.status).toBe("fechado");
    });

    it("filtro diferenca=sobra só retorna caixas fechados com sobra", async () => {
      const caixa = await service.abrir({ valorInicial: 100 }, null);
      await service.fechar(caixa.id, { valorInformado: 130, observacao: "Sobra" }, null);
      const resultado = await service.listar(queryCaixasPadrao({ busca: caixa.codigo, diferenca: ["sobra"] }));
      expect(resultado.data).toHaveLength(1);
    });

    it("facets não têm mais grupo 'responsavel' (Caixa não tem vínculo de vendedor)", async () => {
      const caixa = await service.abrir({ valorInicial: 100 }, null);
      const resultado = await service.listar(queryCaixasPadrao({ busca: caixa.codigo }));
      expect(resultado.facets["responsavel"]).toBeUndefined();
      expect(resultado.facets["status"]).toBeTruthy();
      await fecharTudoQueEstiverAberto();
    });

    it("ordena por saldo (asc/desc)", async () => {
      const caixaMenor = await service.abrir({ valorInicial: 50 }, null);
      await service.fechar(caixaMenor.id, { valorInformado: 50 }, null);
      const caixaMaior = await service.abrir({ valorInicial: 500 }, null);
      await service.fechar(caixaMaior.id, { valorInformado: 500 }, null);

      // Fase 55.4 — percorre TODAS as páginas: com `--randomize`, outros testes
      // deste arquivo já podiam ter fechado caixas suficientes para empurrar o
      // de saldo 50 para fora da primeira página (indexOf === -1).
      const codigos: string[] = [];
      for (let page = 1, totalPages = 1; page <= totalPages; page += 1) {
        const desc = await service.listar(
          queryCaixasPadrao({ busca: undefined, ordenarPor: "saldo", ordem: "desc", status: ["fechado"], page, limit: 100 }),
        );
        codigos.push(...desc.data.map((item) => item.codigo));
        totalPages = desc.meta.totalPages ?? page;
      }
      expect(codigos.indexOf(caixaMenor.codigo)).toBeGreaterThan(-1);
      expect(codigos.indexOf(caixaMaior.codigo)).toBeLessThan(codigos.indexOf(caixaMenor.codigo));
    });
  });

  /**
   * Etapa 18.3 — concorrência, atomicidade e integridade. Testes A (abertura
   * concorrente) e B (fechamento concorrente) já existem nos describes
   * "abertura, código e concorrência" e "fechamento" acima (inalterados
   * desde a 18.2) — não duplicados aqui. Este bloco cobre C–I.
   */
  describe("concorrência avançada (Etapa 18.3)", () => {
    async function movimentosDoCaixa(caixaId: string) {
      return connection.collection("movimentos_caixa").find({ caixaId: new Types.ObjectId(caixaId) }).toArray();
    }

    // Teste C — múltiplas sangrias concorrentes: cada uma é um INSERT
    // independente (o saldo nunca é um contador mutável, sempre somado em
    // tempo de leitura — ver `calcularResumo`), então não há "lost update"
    // possível aqui por construção. Este teste confirma isso na prática.
    it("C. 10 sangrias concorrentes de 50 a partir de saldo=100: todas persistem, saldo final = -400", async () => {
      const caixa = await service.abrir({ valorInicial: 100 }, null);

      const resultados = await Promise.allSettled(
        Array.from({ length: 10 }, (_, indice) =>
          service.registrarMovimento(caixa.id, "saida", { descricao: `Sangria concorrente ${indice}`, valor: 50, formaPagamento: "Dinheiro", motivo: "Teste C" }, null),
        ),
      );

      expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(10);

      const movimentos = await movimentosDoCaixa(caixa.id);
      expect(movimentos.filter((m) => m["tipo"] === "sangria")).toHaveLength(10); // nenhum movimento perdido

      const detalhe = await service.obterDetalhe(caixa.id);
      expect(detalhe.resumo.saldoEsperado).toBe(-400);
      await fecharTudoQueEstiverAberto();
    });

    // Teste D — movimento manual concorrente com fechamento. A corrida real
    // (janela entre o insert do movimento e a checagem de compensação em
    // `garantirCaixaAindaAbertoOuReverter`) é estreita demais para forçar
    // deterministicamente via Promise.all — por isso repetimos várias vezes
    // e, a cada rodada, validamos o INVARIANTE que deve valer
    // independentemente de quem "venceu": se a operação de movimento
    // reportou sucesso, o movimento existe no banco; se reportou erro,
    // NENHUM movimento órfão foi deixado para trás. Nunca os dois ao mesmo tempo.
    it("D. injeção concorrente com fechamento: nunca fica um movimento órfão associado a um caixa fechado", async () => {
      for (let rodada = 0; rodada < 25; rodada += 1) {
        const caixa = await service.abrir({ valorInicial: 100 }, null);
        try {
          // `observacao` sempre enviada: a injeção pode ou não ter sido
          // contabilizada antes de `fechar()` ler os movimentos (depende de
          // qual dos dois o event loop agenda primeiro) — sem isto, o
          // fechamento poderia esbarrar em "justifique a diferença" quando a
          // injeção vence a corrida de leitura mas ainda perde a de gravação.
          const [resultadoMovimento] = await Promise.allSettled([
            service.registrarMovimento(caixa.id, "entrada", { descricao: `Injeção rodada ${rodada}`, valor: 10, formaPagamento: "Dinheiro" }, null),
            service.fechar(caixa.id, { valorInformado: 100, observacao: "Teste D — concorrência" }, null),
          ]);

          const movimentos = await movimentosDoCaixa(caixa.id);
          const caixaFinal = await connection.collection("caixas").findOne({ _id: new Types.ObjectId(caixa.id) });
          expect(caixaFinal?.["status"]).toBe("fechado"); // o fechamento nunca perde para o movimento manual

          if (resultadoMovimento.status === "fulfilled") {
            expect(movimentos).toHaveLength(1); // a injeção venceu a corrida: existe, contabilizada
          } else {
            expect(movimentos).toHaveLength(0); // a injeção perdeu: NENHUM movimento órfão restou
          }
        } finally {
          // Rede de segurança: garante que uma falha de asserção numa rodada
          // não deixe um caixa aberto vazando para a rodada seguinte (ou para
          // os próximos testes do arquivo, que dependem de "no máximo 1 aberto").
          await fecharTudoQueEstiverAberto();
        }
      }
    });

    // Teste E — venda concorrente com fechamento, exercitando
    // `registrarMovimentoDeVenda` (o mesmo método usado por VendasService)
    // diretamente, sem depender de uma Venda real persistida.
    it("E. venda concorrente com fechamento: nunca fica um movimento de venda órfão em caixa fechado", async () => {
      for (let rodada = 0; rodada < 25; rodada += 1) {
        const caixa = await service.abrir({ valorInicial: 0 }, null);
        try {
          const vendaId = new Types.ObjectId().toString();
          const vendaCodigo = `VENDA-D-${rodada}`;

          const [resultadoVenda] = await Promise.allSettled([
            service.registrarMovimentoDeVenda({ caixaId: caixa.id, tipo: "venda", descricao: "Venda concorrente", referencia: vendaCodigo, vendaId, vendaCodigo, formaPagamento: "Dinheiro", valor: 100, observacao: "" }),
            service.fechar(caixa.id, { valorInformado: 0, observacao: "Teste E — concorrência" }, null),
          ]);

          const movimentos = await movimentosDoCaixa(caixa.id);
          const caixaFinal = await connection.collection("caixas").findOne({ _id: new Types.ObjectId(caixa.id) });
          expect(caixaFinal?.["status"]).toBe("fechado");

          if (resultadoVenda.status === "fulfilled") {
            expect(movimentos.filter((m) => m["tipo"] === "venda")).toHaveLength(1);
          } else {
            expect(movimentos.filter((m) => m["tipo"] === "venda")).toHaveLength(0);
          }
        } finally {
          await fecharTudoQueEstiverAberto();
        }
      }
    });

    // Teste F — mesmo princípio do E, para cancelamento.
    it("F. cancelamento concorrente com fechamento: nunca fica um movimento de cancelamento órfão em caixa fechado", async () => {
      for (let rodada = 0; rodada < 25; rodada += 1) {
        const caixa = await service.abrir({ valorInicial: 200 }, null);
        try {
          const vendaId = new Types.ObjectId().toString();
          const vendaCodigo = `VENDA-F-${rodada}`;

          const [resultadoCancelamento] = await Promise.allSettled([
            service.registrarMovimentoDeVenda({ caixaId: caixa.id, tipo: "cancelamento", descricao: "Cancelamento concorrente", referencia: vendaCodigo, vendaId, vendaCodigo, formaPagamento: "Dinheiro", valor: 100, observacao: "Teste F" }),
            service.fechar(caixa.id, { valorInformado: 200, observacao: "Teste F — concorrência" }, null),
          ]);

          const movimentos = await movimentosDoCaixa(caixa.id);
          const caixaFinal = await connection.collection("caixas").findOne({ _id: new Types.ObjectId(caixa.id) });
          expect(caixaFinal?.["status"]).toBe("fechado");

          if (resultadoCancelamento.status === "fulfilled") {
            expect(movimentos.filter((m) => m["tipo"] === "cancelamento")).toHaveLength(1);
          } else {
            expect(movimentos.filter((m) => m["tipo"] === "cancelamento")).toHaveLength(0);
          }
        } finally {
          await fecharTudoQueEstiverAberto();
        }
      }
    });

    // Teste G — idempotência sob concorrência real, no nível do SERVICE
    // (`registrarMovimento`), complementando a cobertura já exaustiva de
    // `movimentos-caixa.repository.spec.ts` (que testa `MovimentosCaixaRepository`
    // isoladamente). 5 chamadas simultâneas da MESMA operação (mesma
    // idempotencyKey) — exatamente 1 movimento, nunca 5.
    it("G. idempotência 5x no nível do service: 5 chamadas concorrentes da mesma injeção geram exatamente 1 movimento", async () => {
      const caixa = await service.abrir({ valorInicial: 0 }, null);
      const chave = `idem-5x-${Date.now()}`;

      const resultados = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          service.registrarMovimento(caixa.id, "entrada", { descricao: "Injeção 5x", valor: 100, formaPagamento: "Dinheiro", idempotencyKey: chave }, null),
        ),
      );
      expect(resultados.every((r) => r.status === "fulfilled")).toBe(true); // idempotência = sucesso repetido, nunca erro

      const movimentos = await movimentosDoCaixa(caixa.id);
      expect(movimentos.filter((m) => m["idempotencyKey"] === chave)).toHaveLength(1);

      const detalhe = await service.obterDetalhe(caixa.id);
      expect(detalhe.resumo.saldoEsperado).toBe(100); // nunca 500 (5×100)
      await fecharTudoQueEstiverAberto();
    });

    // Teste H — idempotência após troca de caixa: a MESMA chave, reutilizada
    // depois que o caixa original fechou e outro abriu, continua impedindo
    // duplicação — mesmo comportamento documentado em `movimento-caixa.schema.ts`
    // desde a Etapa 10.13 (índice GLOBAL, nunca por caixa), agora confirmado
    // também para o novo domínio de 4 tipos.
    it("H. idempotência global sobrevive à troca de caixa: mesma chave em caixa diferente nunca duplica", async () => {
      const caixaA = await service.abrir({ valorInicial: 0 }, null);
      const chave = `idem-troca-caixa-${Date.now()}`;

      await service.registrarMovimento(caixaA.id, "entrada", { descricao: "Injeção original", valor: 100, formaPagamento: "Dinheiro", idempotencyKey: chave }, null);
      await service.fechar(caixaA.id, { valorInformado: 100 }, null);
      const caixaB = await service.abrir({ valorInicial: 0 }, null);

      // Retry da MESMA operação, agora com o caixa ATUAL sendo B — a chave é
      // global, então o resultado é o movimento original (ainda em A),
      // NUNCA um segundo movimento criado em B.
      const retry = await service.registrarMovimento(caixaB.id, "entrada", { descricao: "Injeção original (retry)", valor: 100, formaPagamento: "Dinheiro", idempotencyKey: chave }, null);

      const total = await connection.collection("movimentos_caixa").countDocuments({ idempotencyKey: chave });
      expect(total).toBe(1);
      const movimentoUnico = await connection.collection("movimentos_caixa").findOne({ idempotencyKey: chave });
      expect(String(movimentoUnico?.["caixaId"])).toBe(caixaA.id); // permanece no caixa ORIGINAL, nunca migra para B
      expect(retry.resumo.quantidadeMovimentacoes).toBe(0); // caixa B nunca recebeu o movimento

      await fecharTudoQueEstiverAberto();
    });

    // Teste I — operações diferentes (chaves diferentes) nunca são
    // confundidas entre si, mesmo lançadas concorrentemente.
    it("I. operações diferentes com chaves diferentes são sempre independentes, mesmo concorrentes", async () => {
      const caixa = await service.abrir({ valorInicial: 500 }, null);
      const vendaA = new Types.ObjectId().toString();
      const vendaB = new Types.ObjectId().toString();
      const cancelamentoA = new Types.ObjectId().toString();

      const resultados = await Promise.allSettled([
        service.registrarMovimentoDeVenda({ caixaId: caixa.id, tipo: "venda", descricao: "Venda A", referencia: "VENDA-A", vendaId: vendaA, vendaCodigo: "VENDA-A", formaPagamento: "Dinheiro", valor: 100, observacao: "", idempotencyKey: `${vendaA}:pagamento:0` }),
        service.registrarMovimentoDeVenda({ caixaId: caixa.id, tipo: "venda", descricao: "Venda B", referencia: "VENDA-B", vendaId: vendaB, vendaCodigo: "VENDA-B", formaPagamento: "PIX", valor: 200, observacao: "", idempotencyKey: `${vendaB}:pagamento:0` }),
        service.registrarMovimentoDeVenda({ caixaId: caixa.id, tipo: "cancelamento", descricao: "Cancelamento A", referencia: "VENDA-A", vendaId: cancelamentoA, vendaCodigo: "VENDA-A", formaPagamento: "Dinheiro", valor: 50, observacao: "Teste I", idempotencyKey: `${cancelamentoA}:cancelamento:0` }),
        service.registrarMovimento(caixa.id, "entrada", { descricao: "Pagamento manual A", valor: 30, formaPagamento: "Dinheiro", idempotencyKey: "pagamento-manual-A" }),
      ]);

      expect(resultados.every((r) => r.status === "fulfilled")).toBe(true);

      const movimentos = await movimentosDoCaixa(caixa.id);
      expect(movimentos).toHaveLength(4); // 4 operações distintas, 4 movimentos, nenhuma confundida com outra

      const detalhe = await service.obterDetalhe(caixa.id);
      // 500 + (100 venda A) + (200 venda B) + (30 injeção) - (50 cancelamento) = 780
      expect(detalhe.resumo.saldoEsperado).toBe(780);
      await fecharTudoQueEstiverAberto();
    });
  });

  /**
   * Etapa 18.4, seção 9 — "auditar reconciliação": prova, por leitura direta
   * dos movimentos PERSISTIDOS (nunca de um campo materializado), que
   * `saldoEsperado === valorInicial + soma(entradas) - soma(saidas)` em toda
   * combinação de tipo isolada, em saldo zero/positivo/negativo, numa
   * sequência mista longa e sob concorrência real — não introduz nenhum
   * comportamento novo (a fórmula já é a única usada por `calcularResumo`
   * desde a Etapa 18.2), só comprova o invariante de forma explícita e
   * exaustiva, como pedido.
   */
  describe("reconciliação financeira (Etapa 18.4)", () => {
    async function movimentosDoCaixa(caixaId: string) {
      return connection.collection("movimentos_caixa").find({ caixaId: new Types.ObjectId(caixaId) }).toArray();
    }

    it("somente valor inicial (nenhum movimento): saldoEsperado = valorInicial", async () => {
      const caixa = await service.abrir({ valorInicial: 437.5 }, null);
      const detalhe = await service.obterDetalhe(caixa.id);
      expect(detalhe.resumo.quantidadeMovimentacoes).toBe(0);
      expect(detalhe.resumo.saldoEsperado).toBe(437.5);
      await fecharTudoQueEstiverAberto();
    });

    it("somente injeções: saldoEsperado = valorInicial + soma das injeções", async () => {
      const caixa = await service.abrir({ valorInicial: 100 }, null);
      await service.registrarMovimento(caixa.id, "entrada", { descricao: "Injeção 1", valor: 50, formaPagamento: "Dinheiro" }, null);
      await service.registrarMovimento(caixa.id, "entrada", { descricao: "Injeção 2", valor: 75, formaPagamento: "Dinheiro" }, null);
      const detalhe = await service.obterDetalhe(caixa.id);
      expect(detalhe.resumo.saldoEsperado).toBe(225); // 100 + 50 + 75
      await fecharTudoQueEstiverAberto();
    });

    it("somente vendas: saldoEsperado = valorInicial + soma das vendas", async () => {
      const caixa = await service.abrir({ valorInicial: 0 }, null);
      const v1 = vendaFake();
      const v2 = vendaFake();
      await service.registrarMovimentoDeVenda({ caixaId: caixa.id, tipo: "venda", descricao: "Venda 1", referencia: v1.vendaCodigo, ...v1, formaPagamento: "Dinheiro", valor: 250, observacao: "" });
      await service.registrarMovimentoDeVenda({ caixaId: caixa.id, tipo: "venda", descricao: "Venda 2", referencia: v2.vendaCodigo, ...v2, formaPagamento: "PIX", valor: 150, observacao: "" });
      const detalhe = await service.obterDetalhe(caixa.id);
      expect(detalhe.resumo.saldoEsperado).toBe(400); // 0 + 250 + 150
      await fecharTudoQueEstiverAberto();
    });

    it("somente sangrias: saldoEsperado = valorInicial - soma das sangrias (pode ficar negativo)", async () => {
      const caixa = await service.abrir({ valorInicial: 100 }, null);
      await service.registrarMovimento(caixa.id, "saida", { descricao: "Sangria 1", valor: 60, formaPagamento: "Dinheiro", motivo: "Teste" }, null);
      await service.registrarMovimento(caixa.id, "saida", { descricao: "Sangria 2", valor: 90, formaPagamento: "Dinheiro", motivo: "Teste" }, null);
      const detalhe = await service.obterDetalhe(caixa.id);
      expect(detalhe.resumo.saldoEsperado).toBe(-50); // 100 - 60 - 90
      await fecharTudoQueEstiverAberto();
    });

    it("somente cancelamentos: saldoEsperado = valorInicial - soma dos cancelamentos (pode ficar negativo)", async () => {
      const caixa = await service.abrir({ valorInicial: 100 }, null);
      const v1 = vendaFake();
      await service.registrarMovimentoDeVenda({ caixaId: caixa.id, tipo: "cancelamento", descricao: "Cancelamento", referencia: v1.vendaCodigo, ...v1, formaPagamento: "Dinheiro", valor: 180, observacao: "Devolução" });
      const detalhe = await service.obterDetalhe(caixa.id);
      expect(detalhe.resumo.saldoEsperado).toBe(-80); // 100 - 180
      await fecharTudoQueEstiverAberto();
    });

    it("saldo exatamente zero por composição (não é o caso trivial de nenhum movimento)", async () => {
      const caixa = await service.abrir({ valorInicial: 100 }, null);
      await service.registrarMovimento(caixa.id, "entrada", { descricao: "Injeção", valor: 50, formaPagamento: "Dinheiro" }, null);
      await service.registrarMovimento(caixa.id, "saida", { descricao: "Sangria", valor: 150, formaPagamento: "Dinheiro", motivo: "Teste" }, null);
      const detalhe = await service.obterDetalhe(caixa.id);
      expect(detalhe.resumo.saldoEsperado).toBe(0); // 100 + 50 - 150
      await fecharTudoQueEstiverAberto();
    });

    // Sequência do enunciado (seção 9): Inicial +500, Injeção +300, Venda
    // +250, Venda +150, Sangria -700, Venda +400, Cancelamento -200, Injeção
    // +100, Sangria -500 → saldo esperado +300. Cada movimento é lido
    // diretamente de `movimentos_caixa` (via `obterDetalhe`/`calcularResumo`),
    // nunca de um valor acumulado incrementalmente em memória pelo teste.
    it("sequência mista completa do enunciado: 500+300+250+150-700+400-200+100-500 = 300", async () => {
      const caixa = await service.abrir({ valorInicial: 500 }, null);
      const vA = vendaFake();
      const vB = vendaFake();
      const vC = vendaFake();
      const vCancelada = vendaFake();

      await service.registrarMovimento(caixa.id, "entrada", { descricao: "Injeção", valor: 300, formaPagamento: "Dinheiro" }, null);
      await service.registrarMovimentoDeVenda({ caixaId: caixa.id, tipo: "venda", descricao: "Venda A", referencia: vA.vendaCodigo, ...vA, formaPagamento: "Dinheiro", valor: 250, observacao: "" });
      await service.registrarMovimentoDeVenda({ caixaId: caixa.id, tipo: "venda", descricao: "Venda B", referencia: vB.vendaCodigo, ...vB, formaPagamento: "PIX", valor: 150, observacao: "" });
      await service.registrarMovimento(caixa.id, "saida", { descricao: "Sangria grande", valor: 700, formaPagamento: "Dinheiro", motivo: "Teste" }, null);
      await service.registrarMovimentoDeVenda({ caixaId: caixa.id, tipo: "venda", descricao: "Venda C", referencia: vC.vendaCodigo, ...vC, formaPagamento: "Débito", valor: 400, observacao: "" });
      await service.registrarMovimentoDeVenda({ caixaId: caixa.id, tipo: "cancelamento", descricao: "Cancelamento", referencia: vCancelada.vendaCodigo, ...vCancelada, formaPagamento: "Dinheiro", valor: 200, observacao: "Devolução" });
      await service.registrarMovimento(caixa.id, "entrada", { descricao: "Injeção 2", valor: 100, formaPagamento: "Dinheiro" }, null);
      await service.registrarMovimento(caixa.id, "saida", { descricao: "Sangria final", valor: 500, formaPagamento: "Dinheiro", motivo: "Teste" }, null);

      const movimentos = await movimentosDoCaixa(caixa.id);
      expect(movimentos).toHaveLength(8);

      const detalhe = await service.obterDetalhe(caixa.id);
      expect(detalhe.resumo.saldoEsperado).toBe(300);

      // Reconciliação independente: soma bruta lida diretamente da coleção,
      // sem passar por `calcularResumo` — confirma que o resultado do service
      // não é um artefato de uma fórmula errada coincidentemente simétrica.
      const somaBruta = movimentos.reduce((total, m) => total + (m["sentido"] === "entrada" ? Number(m["valor"]) : -Number(m["valor"])), 500);
      expect(somaBruta).toBe(300);
      await fecharTudoQueEstiverAberto();
    });

    it("múltiplas operações idênticas (mesmo tipo/valor/forma) contam cada uma independentemente, nunca deduplicadas por coincidência de valor", async () => {
      const caixa = await service.abrir({ valorInicial: 0 }, null);
      for (let i = 0; i < 4; i += 1) {
        await service.registrarMovimento(caixa.id, "entrada", { descricao: `Injeção repetida ${i}`, valor: 25, formaPagamento: "Dinheiro" }, null);
      }
      const movimentos = await movimentosDoCaixa(caixa.id);
      expect(movimentos).toHaveLength(4); // 4 documentos distintos, nenhum idempotencyKey em comum
      const detalhe = await service.obterDetalhe(caixa.id);
      expect(detalhe.resumo.saldoEsperado).toBe(100); // 4 × 25, nunca colapsado em 1
      await fecharTudoQueEstiverAberto();
    });

    it("operações concorrentes de tipos diferentes: saldo final reconcilia exatamente com a soma dos movimentos persistidos, independentemente da ordem de chegada", async () => {
      const caixa = await service.abrir({ valorInicial: 500 }, null);
      const vVenda = vendaFake();
      const vCancelamento = vendaFake();

      const resultados = await Promise.allSettled([
        service.registrarMovimentoDeVenda({ caixaId: caixa.id, tipo: "venda", descricao: "Venda concorrente", referencia: vVenda.vendaCodigo, ...vVenda, formaPagamento: "Dinheiro", valor: 250 + 150, observacao: "" }),
        service.registrarMovimento(caixa.id, "entrada", { descricao: "Injeção concorrente", valor: 300, formaPagamento: "Dinheiro" }, null),
        service.registrarMovimento(caixa.id, "saida", { descricao: "Sangria concorrente", valor: 700, formaPagamento: "Dinheiro", motivo: "Teste" }, null),
        service.registrarMovimentoDeVenda({ caixaId: caixa.id, tipo: "cancelamento", descricao: "Cancelamento concorrente", referencia: vCancelamento.vendaCodigo, ...vCancelamento, formaPagamento: "Dinheiro", valor: 200, observacao: "Devolução" }),
      ]);
      expect(resultados.every((r) => r.status === "fulfilled")).toBe(true);

      const movimentos = await movimentosDoCaixa(caixa.id);
      expect(movimentos).toHaveLength(4);

      const somaBruta = movimentos.reduce((total, m) => total + (m["sentido"] === "entrada" ? Number(m["valor"]) : -Number(m["valor"])), 500);
      const detalhe = await service.obterDetalhe(caixa.id);
      // 500 + 400 (venda) + 300 (injeção) - 700 (sangria) - 200 (cancelamento) = 300
      expect(detalhe.resumo.saldoEsperado).toBe(300);
      expect(somaBruta).toBe(detalhe.resumo.saldoEsperado); // a leitura do service bate com a soma independente dos documentos crus
      await fecharTudoQueEstiverAberto();
    });
  });

  describe("validação de forma de pagamento contra configuracoes (Fase 55.2)", () => {
    const MENSAGEM_FORMA_NAO_CADASTRADA =
      "Esta forma de pagamento não está cadastrada nas configurações da loja. Cadastre a forma de pagamento antes de utilizá-la em uma operação financeira.";

    async function movimentosDoCaixa(caixaId: string) {
      return connection.collection("movimentos_caixa").find({ caixaId: new Types.ObjectId(caixaId) }).toArray();
    }

    it("registra movimentação manual com forma de pagamento existente nas configurações", async () => {
      const caixa = await service.abrir({ valorInicial: 0 }, null);
      const atualizado = await service.registrarMovimento(caixa.id, "entrada", { descricao: "Suprimento", valor: 50, formaPagamento: "Dinheiro" }, null);
      expect(atualizado.movimentacoes[0]?.formaPagamento).toBe("Dinheiro");
      await fecharTudoQueEstiverAberto();
    });

    it("rejeita movimentação manual com forma de pagamento inexistente nas configurações, com a mensagem de negócio exata", async () => {
      const caixa = await service.abrir({ valorInicial: 0 }, null);
      const formaInexistente = `FormaCaixaNuncaCadastrada-${Date.now()}`;

      await expect(
        service.registrarMovimento(caixa.id, "entrada", { descricao: "Suprimento", valor: 50, formaPagamento: formaInexistente }, null),
      ).rejects.toThrow(MENSAGEM_FORMA_NAO_CADASTRADA);

      await fecharTudoQueEstiverAberto();
    });

    it("reconhece variações de maiúsculas/minúsculas/acentos/espaços da mesma forma cadastrada", async () => {
      const caixa = await service.abrir({ valorInicial: 0 }, null);
      const atualizado = await service.registrarMovimento(
        caixa.id,
        "entrada",
        { descricao: "Suprimento", valor: 50, formaPagamento: "  DINHEIRO  " }, // "Dinheiro" já está cadastrado (beforeAll)
        null,
      );
      expect(atualizado.movimentacoes[0]?.formaPagamento).toBe("DINHEIRO"); // só trim é aplicado na gravação — apresentação original (maiúsculas) preservada
      await fecharTudoQueEstiverAberto();
    });

    it("a validação acontece ANTES da gravação: nenhuma movimentação é criada quando a forma é rejeitada", async () => {
      const caixa = await service.abrir({ valorInicial: 0 }, null);
      const formaInexistente = `FormaAntesDaGravacao-${Date.now()}`;

      await expect(
        service.registrarMovimento(caixa.id, "saida", { descricao: "Sangria", valor: 50, formaPagamento: formaInexistente, motivo: "Teste" }, null),
      ).rejects.toThrow(ApiException);

      const movimentos = await movimentosDoCaixa(caixa.id);
      expect(movimentos).toHaveLength(0); // nenhum documento foi inserido, nem para depois ser revertido
      const detalhe = await service.obterDetalhe(caixa.id);
      expect(detalhe.resumo.saldoEsperado).toBe(0); // saldo nunca foi afetado

      await fecharTudoQueEstiverAberto();
    });

    it("preserva movimentações originadas de venda (registrarMovimentoDeVenda) com forma não cadastrada — nunca revalida, confia na validação já feita pelo fluxo de Vendas", async () => {
      const caixa = await service.abrir({ valorInicial: 0 }, null);
      const vVenda = vendaFake();
      const formaHistoricaNuncaCadastradaAqui = `FormaDeVendaNaoRevalidada-${Date.now()}`;

      // `registrarMovimentoDeVenda` nunca valida `formaPagamento` (a validação
      // é responsabilidade exclusiva de `VendasService`, que já rodou antes de
      // chegar aqui no fluxo real — ver `CaixasService.validarFormaPagamentoCadastrada`,
      // usada SÓ por `registrarMovimento`). Confirma aqui que isso continua
      // true mesmo para uma forma que nunca foi cadastrada nesta suíte.
      await service.registrarMovimentoDeVenda({
        caixaId: caixa.id,
        tipo: "venda",
        descricao: "Venda (forma não cadastrada, mas não é revalidada aqui)",
        referencia: vVenda.vendaCodigo,
        ...vVenda,
        formaPagamento: formaHistoricaNuncaCadastradaAqui,
        valor: 100,
        observacao: "",
      });

      const movimentos = await movimentosDoCaixa(caixa.id);
      expect(movimentos).toHaveLength(1);
      expect(movimentos[0]?.["formaPagamento"]).toBe(formaHistoricaNuncaCadastradaAqui);
      await fecharTudoQueEstiverAberto();
    });
  });
});
