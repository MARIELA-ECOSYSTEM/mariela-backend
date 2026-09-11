import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { getConnectionToken } from "@nestjs/mongoose";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import type { AddressInfo } from "node:net";
import type { Connection } from "mongoose";
import { AppModule } from "../../app.module.js";
import { HttpExceptionFilter } from "../../common/filters/http-exception.filter.js";
import { ResponseInterceptor } from "../../common/interceptors/response.interceptor.js";
import { validationExceptionFactory } from "../../common/pipes/validation-exception-factory.js";
import { MONGODB_URI_TESTE } from "../../test-utils/mongo-teste.util.js";
import { AuthService } from "../auth/auth.service.js";

/**
 * Sobe a aplicação HTTP DE VERDADE (mesmos guards, mesmo pipeline de
 * exceções, mesmo prefixo global) — mesmo padrão de `clientes.http.e2e.spec.ts`,
 * aplicado ao ciclo completo de Caixa. Etapa 18.2 — Caixa Geral da Loja: sem
 * vínculo de vendedor, 4 tipos de movimento, saldo negativo permitido.
 */
describe("HTTP — Caixas (integração — servidor real)", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let connection: Connection;
  let accessToken: string;

  function authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${accessToken}`, "content-type": "application/json" };
  }

  async function fecharTudoQueEstiverAberto(): Promise<void> {
    await connection.collection("caixas").updateMany({ status: "aberto" }, { $set: { status: "fechado" } });
  }

  beforeAll(async () => {
    process.env["MONGODB_URI"] = MONGODB_URI_TESTE;
    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });

    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        exceptionFactory: validationExceptionFactory,
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.setGlobalPrefix("api/v1", { exclude: ["health", "docs"] });

    const swaggerConfig = new DocumentBuilder().setTitle("MARIELA API").addBearerAuth().build();
    SwaggerModule.setup("docs", app, SwaggerModule.createDocument(app, swaggerConfig));

    await app.init();
    await app.listen(0);
    const endereco = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${endereco.port}`;
    connection = app.get(getConnectionToken());

    const authService = app.get(AuthService);
    const email = `teste.http.caixas.${Date.now()}@mariela.dev`;
    await authService.criarAdminSeed({ nome: "HTTP Caixas", email, senha: "senha-forte-123" });
    const login = await authService.login({ usuario: email, senha: "senha-forte-123" }, { ip: null, userAgent: null });
    accessToken = login.accessToken;
  });

  afterAll(async () => {
    await connection.collection("caixas").deleteMany({});
    await connection.collection("movimentos_caixa").deleteMany({});
    await connection.collection("eventos_caixa").deleteMany({});
    await connection.collection("sequencias").deleteMany({ _id: { $in: ["caixa", "usuario"] } });
    await connection.collection("usuarios").deleteMany({});
    await connection.collection("refresh_tokens").deleteMany({});
    await connection.collection("eventos_auth").deleteMany({});
    await app.close();
  });

  it("GET /api/v1/caixas SEM token retorna 401", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/caixas`);
    expect(resposta.status).toBe(401);
  });

  it("POST /api/v1/caixas com payload inválido retorna 400 no envelope de erro", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/caixas`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ valorInicial: -10 }),
    });
    const corpo = (await resposta.json()) as { code: string; errors: { field: string }[] };
    expect(resposta.status).toBe(400);
    expect(corpo.code).toBe("VALIDATION_ERROR");
    expect(corpo.errors.some((erro) => erro.field === "valorInicial")).toBe(true);
  });

  it("POST /api/v1/caixas com campos proibidos (status/codigo/saldo) rejeitado por forbidNonWhitelisted", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/caixas`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ valorInicial: 100, status: "aberto", codigo: "CAIXA-9999", saldoEsperado: 99999 }),
    });
    expect(resposta.status).toBe(400);
  });

  it("GET /api/v1/caixas/atual retorna null quando não há caixa aberto", async () => {
    await fecharTudoQueEstiverAberto();
    const resposta = await fetch(`${baseUrl}/api/v1/caixas/atual`, { headers: authHeaders() });
    const corpo = (await resposta.json()) as { data: unknown };
    expect(resposta.status).toBe(200);
    expect(corpo.data).toBeNull();
  });

  it("fluxo completo: abrir → atual → injeção → sangria negativa → movimentações → fechamento negativo → 409 dupla abertura → nova operação após fechado falha", async () => {
    const abertura = await fetch(`${baseUrl}/api/v1/caixas`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ valorInicial: 200 }),
    });
    expect(abertura.status).toBe(201);
    const corpoAbertura = (await abertura.json()) as { data: { id: string; codigo: string; resumo: { saldoEsperado: number } } };
    const caixaId = corpoAbertura.data.id;
    expect(corpoAbertura.data.codigo).toMatch(/^CAIXA-\d{4}$/);
    expect(corpoAbertura.data.resumo.saldoEsperado).toBe(200);

    const duplaAbertura = await fetch(`${baseUrl}/api/v1/caixas`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ valorInicial: 50 }),
    });
    expect(duplaAbertura.status).toBe(409);

    const atual = await fetch(`${baseUrl}/api/v1/caixas/atual`, { headers: authHeaders() });
    const corpoAtual = (await atual.json()) as { data: { id: string } };
    expect(atual.status).toBe(200);
    expect(corpoAtual.data.id).toBe(caixaId);

    const entrada = await fetch(`${baseUrl}/api/v1/caixas/${caixaId}/entrada`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ descricao: "Suprimento", valor: 100, formaPagamento: "Dinheiro" }),
    });
    const corpoEntrada = (await entrada.json()) as { data: { resumo: { saldoEsperado: number }; movimentacoes: { tipo: string }[] } };
    expect(entrada.status).toBe(201);
    expect(corpoEntrada.data.resumo.saldoEsperado).toBe(300);
    expect(corpoEntrada.data.movimentacoes[0]?.tipo).toBe("injecao");

    // Etapa 18.2 — sangria maior que o saldo é PERMITIDA, saldo fica negativo.
    const sangriaNegativa = await fetch(`${baseUrl}/api/v1/caixas/${caixaId}/saida`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ descricao: "Retirada grande", valor: 1000, formaPagamento: "Dinheiro", motivo: "Teste" }),
    });
    const corpoSangriaNegativa = (await sangriaNegativa.json()) as { data: { resumo: { saldoEsperado: number } } };
    expect(sangriaNegativa.status).toBe(201);
    expect(corpoSangriaNegativa.data.resumo.saldoEsperado).toBe(-700);

    const saida = await fetch(`${baseUrl}/api/v1/caixas/${caixaId}/saida`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ descricao: "Compra", valor: 50, formaPagamento: "Dinheiro", motivo: "Material" }),
    });
    const corpoSaida = (await saida.json()) as { data: { resumo: { saldoEsperado: number }; movimentacoes: { tipo: string }[] } };
    expect(saida.status).toBe(201);
    expect(corpoSaida.data.resumo.saldoEsperado).toBe(-750);
    expect(corpoSaida.data.movimentacoes[0]?.tipo).toBe("sangria");

    const movimentacoes = await fetch(`${baseUrl}/api/v1/caixas/${caixaId}/movimentacoes?page=1&limit=20`, {
      headers: authHeaders(),
    });
    const corpoMovimentacoes = (await movimentacoes.json()) as { data: unknown[]; meta: { total: number } };
    expect(movimentacoes.status).toBe(200);
    expect(corpoMovimentacoes.meta.total).toBe(3);

    const fechamentoSemObservacao = await fetch(`${baseUrl}/api/v1/caixas/${caixaId}/fechamento`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ valorInformado: -700 }),
    });
    expect(fechamentoSemObservacao.status).toBe(400);

    const fechamento = await fetch(`${baseUrl}/api/v1/caixas/${caixaId}/fechamento`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ valorInformado: -750 }),
    });
    const corpoFechamento = (await fechamento.json()) as { data: { status: string; fechamento: { diferenca: number; valorEsperado: number } } };
    expect(fechamento.status).toBe(201);
    expect(corpoFechamento.data.status).toBe("fechado");
    expect(corpoFechamento.data.fechamento.diferenca).toBe(0);
    expect(corpoFechamento.data.fechamento.valorEsperado).toBe(-750); // fechamento negativo permitido

    const entradaAposFechado = await fetch(`${baseUrl}/api/v1/caixas/${caixaId}/entrada`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ descricao: "Tarde demais", valor: 10, formaPagamento: "Dinheiro" }),
    });
    expect(entradaAposFechado.status).toBe(400);

    const fechamentoDuplicado = await fetch(`${baseUrl}/api/v1/caixas/${caixaId}/fechamento`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ valorInformado: -750 }),
    });
    expect(fechamentoDuplicado.status).toBe(400);

    // Novo caixa NÃO herda o saldo negativo do anterior.
    const novaAbertura = await fetch(`${baseUrl}/api/v1/caixas`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ valorInicial: 50 }),
    });
    const corpoNovaAbertura = (await novaAbertura.json()) as { data: { resumo: { saldoEsperado: number } } };
    expect(novaAbertura.status).toBe(201);
    expect(corpoNovaAbertura.data.resumo.saldoEsperado).toBe(50);

    // Caixa anterior permanece consultável, com o saldo negativo preservado.
    const consultaAnterior = await fetch(`${baseUrl}/api/v1/caixas/${caixaId}`, { headers: authHeaders() });
    const corpoConsultaAnterior = (await consultaAnterior.json()) as { data: { status: string; fechamento: { valorEsperado: number } } };
    expect(consultaAnterior.status).toBe(200);
    expect(corpoConsultaAnterior.data.status).toBe("fechado");
    expect(corpoConsultaAnterior.data.fechamento.valorEsperado).toBe(-750);

    await fecharTudoQueEstiverAberto();
  });

  describe("GET /caixas/:id/movimentacoes: contrato duplo (Etapa 20.01A)", () => {
    it("SEM page/limit: devolve TODO o histórico, nunca truncado pelo limite padrão (50)", async () => {
      const abertura = await fetch(`${baseUrl}/api/v1/caixas`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ valorInicial: 100 }),
      });
      const { data: caixa } = (await abertura.json()) as { data: { id: string } };

      const quantidade = 55;
      for (let indice = 0; indice < quantidade; indice += 1) {
        await fetch(`${baseUrl}/api/v1/caixas/${caixa.id}/entrada`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ descricao: `Ajuste ${indice}`, valor: 1, formaPagamento: "Dinheiro" }),
        });
      }

      const resposta = await fetch(`${baseUrl}/api/v1/caixas/${caixa.id}/movimentacoes`, { headers: authHeaders() });
      expect(resposta.status).toBe(200);
      const corpo = (await resposta.json()) as {
        data: unknown[];
        meta: { total: number; page: number; limit: number; totalPages: number };
      };
      expect(corpo.data).toHaveLength(quantidade);
      expect(corpo.meta.total).toBe(quantidade);
      expect(corpo.meta.limit).toBe(quantidade);
      expect(corpo.meta.totalPages).toBe(1);

      await fecharTudoQueEstiverAberto();
    });

    it("COM page/limit explícitos: preserva o contrato paginado existente, truncando de verdade", async () => {
      const abertura = await fetch(`${baseUrl}/api/v1/caixas`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ valorInicial: 100 }),
      });
      const { data: caixa } = (await abertura.json()) as { data: { id: string } };

      for (let indice = 0; indice < 5; indice += 1) {
        await fetch(`${baseUrl}/api/v1/caixas/${caixa.id}/entrada`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ descricao: `Ajuste ${indice}`, valor: 1, formaPagamento: "Dinheiro" }),
        });
      }

      const resposta = await fetch(`${baseUrl}/api/v1/caixas/${caixa.id}/movimentacoes?page=1&limit=2`, {
        headers: authHeaders(),
      });
      expect(resposta.status).toBe(200);
      const corpo = (await resposta.json()) as {
        data: unknown[];
        meta: { total: number; page: number; limit: number; totalPages: number };
      };
      expect(corpo.data).toHaveLength(2);
      expect(corpo.meta.total).toBe(5);
      expect(corpo.meta.totalPages).toBe(3);

      await fecharTudoQueEstiverAberto();
    });
  });

  it("GET /api/v1/caixas com paginação e busca encontra o caixa pelo código", async () => {
    const caixas = await connection.collection("caixas").find().sort({ criadoEm: -1 }).limit(1).toArray();
    const codigo = caixas[0]?.["codigo"] as string;
    const listagem = await fetch(`${baseUrl}/api/v1/caixas?busca=${encodeURIComponent(codigo)}&page=1&limit=20`, {
      headers: authHeaders(),
    });
    const corpo = (await listagem.json()) as {
      data: unknown[];
      meta: { total: number; page: number; limit: number; totalPages: number };
      facets: Record<string, unknown>;
    };
    expect(listagem.status).toBe(200);
    expect(corpo.data).toHaveLength(1);
    expect(corpo.facets["status"]).toBeTruthy();
    expect(corpo.facets["responsavel"]).toBeUndefined(); // Etapa 18.2 — grupo removido
  });

  it("GET /api/v1/caixas/estatisticas retorna as contagens agregadas", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/caixas/estatisticas`, { headers: authHeaders() });
    const corpo = (await resposta.json()) as { data: { caixasFechados: number; recebimentosHoje: number } };
    expect(resposta.status).toBe(200);
    expect(corpo.data.caixasFechados).toBeGreaterThanOrEqual(1);
    expect(corpo.data.recebimentosHoje).toBe(0); // conceito retirado do domínio
  });

  it("GET /api/v1/caixas/:id inexistente retorna 404", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/caixas/65f1a2b3c4d5e6f7a8b9c0d1`, { headers: authHeaders() });
    expect(resposta.status).toBe(404);
  });

  describe("GET /caixas: contrato duplo retrocompatível (Etapa 18.2)", () => {
    it("SEM nenhum query param: devolve o array COMPLETO de caixas, sem meta/facets, sem truncar em 20", async () => {
      for (let indice = 0; indice < 21; indice += 1) {
        const criacao = await fetch(`${baseUrl}/api/v1/caixas`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ valorInicial: 10 }),
        });
        const { data } = (await criacao.json()) as { data: { id: string } };
        await fetch(`${baseUrl}/api/v1/caixas/${data.id}/fechamento`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ valorInformado: 10 }),
        });
      }

      const resposta = await fetch(`${baseUrl}/api/v1/caixas`, { headers: authHeaders() });
      expect(resposta.status).toBe(200);
      const corpo = (await resposta.json()) as { data: unknown[]; meta?: unknown; facets?: unknown };
      expect(Array.isArray(corpo.data)).toBe(true);
      expect(corpo.meta).toBeUndefined();
      expect(corpo.facets).toBeUndefined();
      expect(corpo.data.length).toBeGreaterThanOrEqual(21); // nunca truncado em 20 (LIMITE_PADRAO)
    });

    it("COM page/limit: preserva o contrato paginado/facetado já existente", async () => {
      const resposta = await fetch(`${baseUrl}/api/v1/caixas?page=1&limit=1`, { headers: authHeaders() });
      expect(resposta.status).toBe(200);
      const corpo = (await resposta.json()) as { data: unknown[]; meta: { total: number; page: number; limit: number }; facets: Record<string, unknown> };
      expect(corpo.data.length).toBeLessThanOrEqual(1);
      expect(corpo.meta).toBeTruthy();
      expect(corpo.meta.page).toBe(1);
      expect(corpo.meta.limit).toBe(1);
      expect(corpo.facets).toBeTruthy();
    });

    it("array completo mantém o formato aninhado abertura/fechamento esperado pelo caixasApi.listar() do Backoffice", async () => {
      const resposta = await fetch(`${baseUrl}/api/v1/caixas`, { headers: authHeaders() });
      const corpo = (await resposta.json()) as { data: Record<string, unknown>[] };
      const primeiro = corpo.data[0]!;
      expect(primeiro["abertura"]).toBeTruthy();
      expect((primeiro["abertura"] as Record<string, unknown>)["responsavelNome"]).toBe("Loja");
      expect((primeiro["abertura"] as Record<string, unknown>)["responsavelId"]).toBeNull();
    });
  });

  describe("concorrência real via HTTP: POST /:id/entrada × POST /:id/fechamento (Etapa 18.3)", () => {
    it("nunca deixa um movimento órfão em caixa fechado, em requisições HTTP genuinamente concorrentes", async () => {
      for (let rodada = 0; rodada < 10; rodada += 1) {
        const abertura = await fetch(`${baseUrl}/api/v1/caixas`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ valorInicial: 100 }),
        });
        const { data: caixa } = (await abertura.json()) as { data: { id: string } };

        const [respostaEntrada, respostaFechamento] = await Promise.all([
          fetch(`${baseUrl}/api/v1/caixas/${caixa.id}/entrada`, {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ descricao: `Injeção HTTP rodada ${rodada}`, valor: 10, formaPagamento: "Dinheiro" }),
          }),
          fetch(`${baseUrl}/api/v1/caixas/${caixa.id}/fechamento`, {
            method: "POST",
            headers: authHeaders(),
            // `observacao` sempre enviada: idem à razão documentada em `caixas.service.spec.ts` (Teste D).
            body: JSON.stringify({ valorInformado: 100, observacao: "Concorrência HTTP" }),
          }),
        ]);

        expect([200, 201]).toContain(respostaFechamento.status); // fechamento nunca perde a corrida
        expect([201, 400]).toContain(respostaEntrada.status); // ou venceu (201) ou perdeu com erro claro (400), nunca 500

        const movimentacoes = await fetch(`${baseUrl}/api/v1/caixas/${caixa.id}/movimentacoes`, { headers: authHeaders() });
        const corpoMovimentacoes = (await movimentacoes.json()) as { meta: { total: number } };

        if (respostaEntrada.status === 201) {
          expect(corpoMovimentacoes.meta.total).toBe(1);
        } else {
          expect(corpoMovimentacoes.meta.total).toBe(0);
        }
      }
    });
  });

  it("GET /docs-json documenta as rotas de Caixas com BearerAuth (rotas de vendas/recebimentos dedicadas foram removidas)", async () => {
    const resposta = await fetch(`${baseUrl}/docs-json`);
    const documento = (await resposta.json()) as { paths: Record<string, unknown> };
    expect(Object.keys(documento.paths)).toEqual(
      expect.arrayContaining([
        "/api/v1/caixas",
        "/api/v1/caixas/atual",
        "/api/v1/caixas/estatisticas",
        "/api/v1/caixas/{id}",
        "/api/v1/caixas/{id}/movimentacoes",
        "/api/v1/caixas/{id}/entrada",
        "/api/v1/caixas/{id}/saida",
        "/api/v1/caixas/{id}/fechamento",
      ]),
    );
    expect(Object.keys(documento.paths)).not.toContain("/api/v1/caixas/{id}/vendas");
    expect(Object.keys(documento.paths)).not.toContain("/api/v1/caixas/{id}/recebimentos");
  });

  /**
   * Etapa 18.5 — auditoria final do contrato: confirma, via chamadas HTTP
   * reais (não só leitura de DTO), que o payload de entrada/saída/fechamento
   * nunca aceita `tipo`/`sentido` arbitrários nem `valorEsperado` vindo do
   * cliente — essas 3 coisas são deliberadamente decididas só pelo backend
   * (rota determina `tipo`, `SENTIDO_POR_TIPO` determina `sentido`,
   * `calcularResumo` sobre `movimentos_caixa` determina `valorEsperado`).
   */
  describe("auditoria de contrato (Etapa 18.5): payloads proibidos nunca alteram o resultado", () => {
    it("POST /:id/entrada com tipo/sentido/vendedorId extras é rejeitado por forbidNonWhitelisted", async () => {
      const abertura = await fetch(`${baseUrl}/api/v1/caixas`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ valorInicial: 100 }) });
      const { data: caixa } = (await abertura.json()) as { data: { id: string } };

      const resposta = await fetch(`${baseUrl}/api/v1/caixas/${caixa.id}/entrada`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          descricao: "Tentativa de injeção de campo",
          valor: 50,
          formaPagamento: "Dinheiro",
          tipo: "sangria",
          sentido: "entrada",
          vendedorId: "65f1a2b3c4d5e6f7a8b9c0d1",
        }),
      });
      expect(resposta.status).toBe(400);

      const detalhe = await fetch(`${baseUrl}/api/v1/caixas/${caixa.id}`, { headers: authHeaders() });
      const corpoDetalhe = (await detalhe.json()) as { data: { resumo: { quantidadeMovimentacoes: number } } };
      expect(corpoDetalhe.data.resumo.quantidadeMovimentacoes).toBe(0); // payload rejeitado inteiro, nenhum efeito colateral parcial
      await fecharTudoQueEstiverAberto();
    });

    it("POST /:id/fechamento com valorEsperado/diferenca extras é rejeitado, nunca aceito do cliente", async () => {
      const abertura = await fetch(`${baseUrl}/api/v1/caixas`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ valorInicial: 100 }) });
      const { data: caixa } = (await abertura.json()) as { data: { id: string } };

      const resposta = await fetch(`${baseUrl}/api/v1/caixas/${caixa.id}/fechamento`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ valorInformado: 100, valorEsperado: 999999, diferenca: 0 }),
      });
      expect(resposta.status).toBe(400);

      const detalhe = await fetch(`${baseUrl}/api/v1/caixas/${caixa.id}`, { headers: authHeaders() });
      const corpoDetalhe = (await detalhe.json()) as { data: { status: string } };
      expect(corpoDetalhe.data.status).toBe("aberto"); // rejeitado inteiro: nem chegou a fechar
      await fecharTudoQueEstiverAberto();
    });

    it("Swagger não documenta tipos antigos nem vendedor como propriedade do Caixa: só os 4 DTOs de request existem, nenhum expõe tipo/sentido/vendedorId como campo do Caixa", async () => {
      const resposta = await fetch(`${baseUrl}/docs-json`);
      const documento = (await resposta.json()) as { components?: { schemas?: Record<string, { properties?: Record<string, unknown> }> } };
      const schemas = documento.components?.schemas ?? {};

      for (const nome of ["AbrirCaixaDto", "EntradaCaixaDto", "SaidaCaixaDto", "FechamentoCaixaDto", "AbrirCaixaPdvDto"]) {
        const propriedades = Object.keys(schemas[nome]?.properties ?? {});
        expect(propriedades).not.toContain("tipo");
        expect(propriedades).not.toContain("sentido");
        expect(propriedades).not.toContain("vendedorId");
        expect(propriedades).not.toContain("valorEsperado");
        expect(propriedades).not.toContain("saldoEsperado");
      }
      // Nenhum schema chamado "RecebimentoCaixa" (conceito abolido na 18.2).
      expect(Object.keys(schemas)).not.toContain("RecebimentoCaixa");
    });
  });
});
