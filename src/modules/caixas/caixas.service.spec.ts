import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { JwtModule } from "@nestjs/jwt";
import { getConnectionToken } from "@nestjs/mongoose";
import { Test, type TestingModule } from "@nestjs/testing";
import type { Connection } from "mongoose";
import { mongooseModuloDeTeste } from "../../test-utils/mongo-teste.util.js";
import { ApiException } from "../../common/exceptions/api.exception.js";
import { VendedoresService } from "../vendedores/vendedores.service.js";
import type { CriarVendedorDto } from "../vendedores/dto/criar-vendedor.dto.js";
import type { ListarCaixasQueryDto } from "./dto/listar-caixas-query.dto.js";
import type { ListarMovimentosQueryDto } from "./dto/listar-movimentos-query.dto.js";
import { CaixasModule } from "./caixas.module.js";
import { CaixasService } from "./caixas.service.js";

const JWT_MODULO_DE_TESTE = JwtModule.register({
  global: true,
  secret: "segredo-de-teste",
  signOptions: { expiresIn: "15m" },
});

let contadorTelefone = 0;
function telefoneUnico(): string {
  contadorTelefone += 1;
  return `1180${String(contadorTelefone).padStart(6, "0")}`;
}

function payloadVendedor(sufixo: string): CriarVendedorDto {
  return { nome: `Vendedor Caixa ${sufixo}`, telefone: telefoneUnico(), ativo: true, senha: "senha123" };
}

function queryCaixasPadrao(extra: Partial<ListarCaixasQueryDto> = {}): ListarCaixasQueryDto {
  return {
    ordenarPor: "data",
    ordem: "desc",
    status: [],
    periodo: [],
    responsavel: [],
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

describe("CaixasService (integração — MongoDB real)", () => {
  let moduleRef: TestingModule;
  let service: CaixasService;
  let vendedoresService: VendedoresService;
  let connection: Connection;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [mongooseModuloDeTeste(), JWT_MODULO_DE_TESTE, CaixasModule],
    }).compile();
    service = moduleRef.get(CaixasService);
    vendedoresService = moduleRef.get(VendedoresService);
    connection = moduleRef.get(getConnectionToken());
  });

  afterAll(async () => {
    await connection.collection("caixas").deleteMany({});
    await connection.collection("movimentos_caixa").deleteMany({});
    await connection.collection("eventos_caixa").deleteMany({});
    await connection.collection("sequencias").deleteMany({ _id: { $in: ["caixa", "vendedor"] } });
    await connection.collection("vendedores").deleteMany({});
    await connection.collection("eventos_vendedor").deleteMany({});
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

    it("responsavelId ausente vira responsavelNome 'Backoffice'", async () => {
      const caixa = await service.abrir({ valorInicial: 100 }, null);
      expect((caixa.abertura as { responsavelId: string | null }).responsavelId).toBeNull();
      expect((caixa.abertura as { responsavelNome: string }).responsavelNome).toBe("Backoffice");
      await fecharTudoQueEstiverAberto();
    });

    it("responsavelId de um vendedor real captura o nome no momento da abertura", async () => {
      const vendedor = await vendedoresService.criar(payloadVendedor("A"), null);
      const caixa = await service.abrir({ valorInicial: 100, responsavelId: vendedor.id }, null);
      expect((caixa.abertura as { responsavelNome: string }).responsavelNome).toBe(vendedor.nome);
      await fecharTudoQueEstiverAberto();
    });

    it("rejeita responsavelId de um vendedor inexistente", async () => {
      await expect(service.abrir({ valorInicial: 100, responsavelId: "65f1a2b3c4d5e6f7a8b9c0d1" }, null)).rejects.toThrow(ApiException);
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

  describe("entrada e saída", () => {
    it("entrada aumenta o saldo esperado", async () => {
      const caixa = await service.abrir({ valorInicial: 100 }, null);
      const atualizado = await service.registrarMovimento(
        caixa.id,
        "entrada",
        { descricao: "Suprimento", valor: 50, formaPagamento: "Dinheiro" },
        null,
      );
      expect(atualizado.resumo.entradasManuais).toBe(50);
      expect(atualizado.resumo.saldoEsperado).toBe(150);
      await fecharTudoQueEstiverAberto();
    });

    it("saída reduz o saldo esperado e exige motivo", async () => {
      const caixa = await service.abrir({ valorInicial: 100 }, null);
      const atualizado = await service.registrarMovimento(
        caixa.id,
        "saida",
        { descricao: "Compra", valor: 30, formaPagamento: "Dinheiro", motivo: "Material" },
        null,
      );
      expect(atualizado.resumo.saidasManuais).toBe(30);
      expect(atualizado.resumo.saldoEsperado).toBe(70);
      await fecharTudoQueEstiverAberto();
    });

    it("rejeita saída maior que o saldo disponível", async () => {
      const caixa = await service.abrir({ valorInicial: 100 }, null);
      await expect(
        service.registrarMovimento(caixa.id, "saida", { descricao: "Compra grande", valor: 500, formaPagamento: "Dinheiro", motivo: "Teste" }, null),
      ).rejects.toThrow(ApiException);
      await fecharTudoQueEstiverAberto();
    });

    it("responsavelId ausente na movimentação herda o responsável da abertura do caixa", async () => {
      const vendedor = await vendedoresService.criar(payloadVendedor("B"), null);
      const caixa = await service.abrir({ valorInicial: 100, responsavelId: vendedor.id }, null);
      const atualizado = await service.registrarMovimento(caixa.id, "entrada", { descricao: "Ajuste", valor: 10, formaPagamento: "Dinheiro" }, null);
      const movimento = atualizado.movimentacoes[0]!;
      expect(movimento.responsavelNome).toBe(vendedor.nome);
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

  describe("fechamento", () => {
    it("caixa conferido (sem diferença) não exige observação", async () => {
      const caixa = await service.abrir({ valorInicial: 100 }, null);
      const fechado = await service.fechar(caixa.id, { valorInformado: 100 }, null);
      expect(fechado.status).toBe("fechado");
      expect((fechado.fechamento as { diferenca: number }).diferenca).toBe(0);
    });

    it("exige observação quando há diferença de caixa", async () => {
      const caixa = await service.abrir({ valorInicial: 100 }, null);
      await expect(service.fechar(caixa.id, { valorInformado: 90 }, null)).rejects.toThrow(ApiException);
      // A rejeição não fecha o caixa — limpa explicitamente para não vazar
      // estado "aberto" para os próximos testes (índice único permite só um).
      await fecharTudoQueEstiverAberto();
    });

    it("registra sobra/falta corretamente com observação", async () => {
      const caixa = await service.abrir({ valorInicial: 100 }, null);
      const fechado = await service.fechar(caixa.id, { valorInformado: 120, observacao: "Sobrou dinheiro" }, null);
      expect((fechado.fechamento as { diferenca: number }).diferenca).toBe(20);
    });

    it("rejeita fechar um caixa já fechado (checagem de estado sequencial)", async () => {
      const caixa = await service.abrir({ valorInicial: 100 }, null);
      await service.fechar(caixa.id, { valorInformado: 100 }, null);
      await expect(service.fechar(caixa.id, { valorInformado: 100 }, null)).rejects.toThrow(ApiException);
    });

    it("duas chamadas de fechamento concorrentes: só UMA fecha, a outra é rejeitada pela guarda atômica (não pela checagem de estado)", async () => {
      const caixa = await service.abrir({ valorInicial: 100 }, null);
      // As duas leituras iniciais (dentro de `fechar`) veem o caixa ainda
      // "aberto" — a corrida real acontece no `findOneAndUpdate` atômico do
      // repository, não na checagem de estado sequencial do teste anterior.
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

    it("libera abrir um novo caixa depois do anterior ser fechado", async () => {
      const caixa = await service.abrir({ valorInicial: 100 }, null);
      await service.fechar(caixa.id, { valorInformado: 100 }, null);
      const novo = await service.abrir({ valorInicial: 50 }, null);
      expect(novo.codigo).not.toBe(caixa.codigo);
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

    it("estatisticas soma entradas/saídas do dia e caixasAbertos/Fechados", async () => {
      const caixa = await service.abrir({ valorInicial: 100 }, null);
      await service.registrarMovimento(caixa.id, "entrada", { descricao: "Ajuste", valor: 40, formaPagamento: "Dinheiro" }, null);
      const stats = await service.estatisticas();
      expect(stats.caixasAbertos).toBeGreaterThanOrEqual(1);
      expect(stats.entradasHoje).toBeGreaterThanOrEqual(40);
      await fecharTudoQueEstiverAberto();
    });
  });

  describe("histórico de vendas/recebimentos (Vendas ainda não implementado)", () => {
    it("devolve lista vazia para vendas e recebimentos de um caixa existente", async () => {
      const caixa = await service.abrir({ valorInicial: 100 }, null);
      const vendas = await service.listarVendas(caixa.id);
      const recebimentos = await service.listarRecebimentos(caixa.id);
      expect(vendas.data).toEqual([]);
      expect(recebimentos.data).toEqual([]);
      await fecharTudoQueEstiverAberto();
    });

    it("lança NOT_FOUND para um caixa inexistente", async () => {
      await expect(service.listarVendas("65f1a2b3c4d5e6f7a8b9c0d1")).rejects.toThrow(ApiException);
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
      const apenasSaidas = await service.listarMovimentos(caixa.id, queryMovimentosPadrao({ tipo: ["saida"] }));
      expect(apenasSaidas.data).toHaveLength(1);
      expect(apenasSaidas.data[0]?.tipo).toBe("saida");
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

    it("facet de responsável é dinâmico (nomes reais, com contagem)", async () => {
      const vendedor = await vendedoresService.criar(payloadVendedor("C"), null);
      const caixa = await service.abrir({ valorInicial: 100, responsavelId: vendedor.id }, null);
      const resultado = await service.listar(queryCaixasPadrao({ busca: caixa.codigo }));
      const responsavel = resultado.facets["responsavel"] ?? [];
      expect(responsavel.some((opcao) => opcao.valor === vendedor.nome && opcao.count === 1)).toBe(true);
      await fecharTudoQueEstiverAberto();
    });

    it("ordena por saldo (asc/desc)", async () => {
      const caixaMenor = await service.abrir({ valorInicial: 50 }, null);
      await service.fechar(caixaMenor.id, { valorInformado: 50 }, null);
      const caixaMaior = await service.abrir({ valorInicial: 500 }, null);
      await service.fechar(caixaMaior.id, { valorInformado: 500 }, null);

      const desc = await service.listar(
        queryCaixasPadrao({ busca: undefined, ordenarPor: "saldo", ordem: "desc", status: ["fechado"], limit: 100 }),
      );
      const codigos = desc.data.map((item) => item.codigo);
      expect(codigos.indexOf(caixaMaior.codigo)).toBeLessThan(codigos.indexOf(caixaMenor.codigo));
    });
  });
});
