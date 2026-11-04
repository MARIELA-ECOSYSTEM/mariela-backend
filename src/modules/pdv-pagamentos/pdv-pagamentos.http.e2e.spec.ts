import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { getConnectionToken } from "@nestjs/mongoose";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { Types, type Connection } from "mongoose";
import { AppModule } from "../../app.module.js";
import { HttpExceptionFilter } from "../../common/filters/http-exception.filter.js";
import { ResponseInterceptor } from "../../common/interceptors/response.interceptor.js";
import { validationExceptionFactory } from "../../common/pipes/validation-exception-factory.js";
import { MONGODB_URI_TESTE } from "../../test-utils/mongo-teste.util.js";
import { garantirItemConfiguracao } from "../../test-utils/configuracoes-teste.util.js";
import { AuthService } from "../auth/auth.service.js";
import { CaixasService } from "../caixas/caixas.service.js";
import { ConfiguracoesService } from "../configuracoes/configuracoes.service.js";
import type { Configuracao } from "../configuracoes/schemas/configuracao.schema.js";
import { PdvAuthService } from "../pdv-auth/pdv-auth.service.js";
import { normalizarFormaPagamento } from "../produtos/utils/normalizacao.util.js";
import { ProdutosService } from "../produtos/produtos.service.js";
import { VendedoresService } from "../vendedores/vendedores.service.js";
import type { AdquirentePdv } from "./pdv-pagamentos.types.js";

/**
 * Fase 59 — `GET /pdv/pagamentos/formas` e `GET /pdv/pagamentos/adquirentes`,
 * contra a aplicação HTTP DE VERDADE (mesmos guards, filtro de exceções e
 * interceptor) e o banco de teste isolado `mariela_test`.
 */
describe("HTTP — PDV Pagamentos (integração — servidor real)", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let connection: Connection;
  let adminAccessToken: string;
  let contador = 0;
  const vendedoresCriados: string[] = [];
  const adquirentesCriadas: string[] = [];
  const produtosCriados: string[] = [];
  const vendasCriadas: string[] = [];
  const caixasCriados: string[] = [];
  const FORMAS = ["Dinheiro", "PIX", "Débito", "Crédito"];

  function jsonHeaders(token?: string): Record<string, string> {
    return { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
  }

  function sufixo(): string {
    contador += 1;
    return `${Date.now()}-${contador}`;
  }

  beforeAll(async () => {
    process.env["MONGODB_URI"] = MONGODB_URI_TESTE;
    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, exceptionFactory: validationExceptionFactory }));
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.setGlobalPrefix("api/v1", { exclude: ["health", "docs"] });
    await app.init();
    await app.listen(0);
    const endereco = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${endereco.port}`;
    connection = app.get(getConnectionToken());
    expect(connection.name).toBe("mariela_test");

    const authService = app.get(AuthService);
    const email = `teste.http.pdv-pagamentos.${Date.now()}@mariela.dev`;
    await authService.criarAdminSeed({ nome: "HTTP PDV Pagamentos", email, senha: "senha-forte-123" });
    adminAccessToken = (await authService.login({ usuario: email, senha: "senha-forte-123" }, { ip: null, userAgent: null })).accessToken;

    const configuracoesService = app.get(ConfiguracoesService);
    await garantirItemConfiguracao(configuracoesService, "cores", "Azul");
    await garantirItemConfiguracao(configuracoesService, "tamanhos", "M");
    await garantirItemConfiguracao(configuracoesService, "categorias", "Vestidos");
    for (const forma of FORMAS) await garantirItemConfiguracao(configuracoesService, "formasPagamento", forma);
  });

  afterAll(async () => {
    const ids = (lista: string[]) => lista.map((id) => new Types.ObjectId(id));
    await connection.collection("vendas").deleteMany({ _id: { $in: ids(vendasCriadas) } });
    await connection.collection("eventos_venda").deleteMany({ vendaId: { $in: [...ids(vendasCriadas), ...vendasCriadas] } });
    await connection.collection("movimentos_caixa").deleteMany({ caixaId: { $in: ids(caixasCriados) } });
    await connection.collection("eventos_caixa").deleteMany({ caixaId: { $in: [...ids(caixasCriados), ...caixasCriados] } });
    await connection.collection("caixas").deleteMany({ _id: { $in: ids(caixasCriados) } });
    await connection.collection("produtos").deleteMany({ _id: { $in: ids(produtosCriados) } });
    await connection.collection("eventos_produto").deleteMany({ produtoId: { $in: [...ids(produtosCriados), ...produtosCriados] } });
    await connection.collection("adquirentes").deleteMany({ _id: { $in: ids(adquirentesCriadas) } });
    await connection.collection("eventos_adquirente").deleteMany({ adquirenteId: { $in: [...ids(adquirentesCriadas), ...adquirentesCriadas] } });
    await connection.collection("vendedores").deleteMany({ _id: { $in: ids(vendedoresCriados) } });
    await connection.collection("eventos_vendedor").deleteMany({ vendedorId: { $in: [...ids(vendedoresCriados), ...vendedoresCriados] } });
    await connection.collection("vendedor_refresh_tokens").deleteMany({ vendedorId: { $in: ids(vendedoresCriados) } });
    await connection.collection("usuarios").deleteMany({ email: /^teste\.http\.pdv-pagamentos\./ });
    await app.close();
  });

  /** Login via `PdvAuthService` (mesmo racional de `pdv-vendas.http.e2e.spec.ts`: não consumir o rate limit do login HTTP). */
  async function criarELogarVendedor(ativo = true): Promise<string> {
    const vendedoresService = app.get(VendedoresService);
    const vendedor = await vendedoresService.criar(
      { nome: `Vendedora HTTP PDV Pagamentos ${sufixo()}`, telefone: `1189${String(contador).padStart(6, "0")}`, ativo: true, senha: "senha123" },
      null,
    );
    vendedoresCriados.push(vendedor.id);
    const login = await app.get(PdvAuthService).login({ codigo: vendedor.codigo, senha: "senha123" }, { ip: null, userAgent: null });
    if (!ativo) await vendedoresService.alterarStatus(vendedor.id, { ativo: false }, null);
    return login.accessToken;
  }

  async function criarAdquirente(
    nome: string,
    tabelaTarifas: { modalidade: "debito" | "credito"; parcelas: number; percentual: number }[],
    extra: { ativo?: boolean; observacao?: string } = {},
  ): Promise<string> {
    const resposta = await fetch(`${baseUrl}/api/v1/adquirentes`, {
      method: "POST",
      headers: jsonHeaders(adminAccessToken),
      body: JSON.stringify({ nome, tabelaTarifas, ...extra }),
    });
    expect(resposta.status).toBe(201);
    const id = ((await resposta.json()) as { data: { id: string } }).data.id;
    adquirentesCriadas.push(id);
    return id;
  }

  async function get(caminho: string, token?: string) {
    const resposta = await fetch(`${baseUrl}/api/v1${caminho}`, { headers: jsonHeaders(token) });
    const texto = await resposta.text();
    return { status: resposta.status, texto, corpo: JSON.parse(texto) as Record<string, unknown> };
  }

  async function adquirentesDoPdv(token: string): Promise<AdquirentePdv[]> {
    const { status, corpo } = await get("/pdv/pagamentos/adquirentes", token);
    expect(status).toBe(200);
    return corpo["data"] as AdquirentePdv[];
  }

  describe("autenticação e autorização", () => {
    for (const caminho of ["/pdv/pagamentos/formas", "/pdv/pagamentos/adquirentes"]) {
      it(`${caminho} sem token: 401 no envelope de erro padronizado`, async () => {
        const { status, corpo } = await get(caminho);
        expect(status).toBe(401);
        expect(corpo).toMatchObject({ statusCode: 401, code: "UNAUTHORIZED", message: "Token de acesso não informado." });
        expect(corpo["data"]).toBeUndefined();
      });

      it(`${caminho} com token do ADMIN, de vendedor inativo ou inválido: 401 (o namespace /pdv só aceita vendedor ativo)`, async () => {
        const inativo = await criarELogarVendedor(false);
        for (const token of [adminAccessToken, inativo, "token.invalido.qualquer"]) {
          const { status, corpo } = await get(caminho, token);
          expect(status).toBe(401);
          expect(corpo).toMatchObject({ statusCode: 401, code: "UNAUTHORIZED" });
        }
      });
    }

    it("os endpoints administrativos continuam só do ADMIN: o vendedor recebe 401 em leitura E escrita; o ADMIN mantém o acesso", async () => {
      const vendedor = await criarELogarVendedor();
      for (const caminho of ["/configuracoes", "/adquirentes"]) {
        expect((await get(caminho, vendedor)).status).toBe(401);
        expect((await get(caminho, adminAccessToken)).status).toBe(200);
      }
      const escritaConfig = await fetch(`${baseUrl}/api/v1/configuracoes/formasPagamento`, {
        method: "POST",
        headers: jsonHeaders(vendedor),
        body: JSON.stringify({ valor: `Forma Indevida ${sufixo()}` }),
      });
      expect(escritaConfig.status).toBe(401);
      const escritaAdquirente = await fetch(`${baseUrl}/api/v1/adquirentes`, {
        method: "POST",
        headers: jsonHeaders(vendedor),
        body: JSON.stringify({ nome: `Adquirente Indevida ${sufixo()}` }),
      });
      expect(escritaAdquirente.status).toBe(401);
    });
  });

  describe("GET /pdv/pagamentos/formas", () => {
    it("200 { data: string[] }: exatamente as formas cadastradas, na ordem do cadastro, todas presentes no espelho normalizado", async () => {
      const vendedor = await criarELogarVendedor();
      const { status, corpo } = await get("/pdv/pagamentos/formas", vendedor);
      expect(status).toBe(200);
      expect(Object.keys(corpo)).toEqual(["data"]);
      const formas = corpo["data"] as string[];
      const configuracao = await connection.collection<Configuracao>("configuracoes").findOne({ _id: "global" });
      expect(formas).toEqual(configuracao?.formasPagamento ?? []);
      for (const forma of FORMAS) expect(formas).toContain(forma);
      for (const forma of formas) expect(configuracao?.formasPagamentoNormalizadas).toContain(normalizarFormaPagamento(forma));
    });
  });

  describe("GET /pdv/pagamentos/adquirentes", () => {
    it("só adquirentes ativas, não excluídas e com tarifa; formato do PDV; ordem por nome; sem campos administrativos", async () => {
      const base = `Adq PDV ${sufixo()}`;
      const completa = await criarAdquirente(
        `${base} B Completa`,
        [
          { modalidade: "credito", parcelas: 6, percentual: 4.5 },
          { modalidade: "debito", parcelas: 1, percentual: 1.2 },
          { modalidade: "credito", parcelas: 1, percentual: 2.9 },
        ],
        { observacao: "Anotação interna do Backoffice — não deve aparecer no PDV" },
      );
      const soCredito = await criarAdquirente(`${base} A SoCredito`, [{ modalidade: "credito", parcelas: 3, percentual: 3.3 }]);
      const inativa = await criarAdquirente(`${base} C Inativa`, [{ modalidade: "debito", parcelas: 1, percentual: 1 }], { ativo: false });
      const semTarifa = await criarAdquirente(`${base} D SemTarifa`, []);
      const excluida = await criarAdquirente(`${base} E Excluida`, [{ modalidade: "debito", parcelas: 1, percentual: 1 }]);
      expect((await fetch(`${baseUrl}/api/v1/adquirentes/${excluida}`, { method: "DELETE", headers: jsonHeaders(adminAccessToken) })).status).toBe(200);

      const vendedor = await criarELogarVendedor();
      const { texto, corpo } = await get("/pdv/pagamentos/adquirentes", vendedor);
      expect(Object.keys(corpo)).toEqual(["data"]);
      const doTeste = (corpo["data"] as AdquirentePdv[]).filter((adquirente) => adquirente.nome.startsWith(base));

      expect(doTeste.map((adquirente) => adquirente.id)).toEqual([soCredito, completa]); // ordem por nome; inativa, sem tarifa e excluída fora
      expect(doTeste).toEqual([
        { id: soCredito, nome: `${base} A SoCredito`, modalidades: { debito: null, credito: { opcoes: [{ parcelas: 3, tarifaPercentual: 3.3 }] } } },
        {
          id: completa,
          nome: `${base} B Completa`,
          modalidades: {
            debito: { tarifaPercentual: 1.2 },
            credito: {
              opcoes: [
                { parcelas: 1, tarifaPercentual: 2.9 },
                { parcelas: 6, tarifaPercentual: 4.5 },
              ],
            },
          },
        },
      ]);
      for (const ausente of ["observacao", "Anotação interna", "nomeNormalizado", "excluidoEm", "criadoEm", "atualizadoEm", "tabelaTarifas", "\"ativo\"", inativa, semTarifa, excluida]) {
        expect(texto).not.toContain(ausente);
      }
    });
  });

  it("as consultas não modificam nenhum documento (configuração e adquirentes idênticos, inclusive atualizadoEm) e não aceitam escrita", async () => {
    const adquirente = await criarAdquirente(`Adq Leitura ${sufixo()}`, [{ modalidade: "debito", parcelas: 1, percentual: 1.1 }]);
    const vendedor = await criarELogarVendedor();
    const configuracaoAntes = await connection.collection<Configuracao>("configuracoes").findOne({ _id: "global" });
    const adquirenteAntes = await connection.collection("adquirentes").findOne({ _id: new Types.ObjectId(adquirente) });

    for (let vez = 0; vez < 2; vez += 1) {
      expect((await get("/pdv/pagamentos/formas", vendedor)).status).toBe(200);
      expect((await get("/pdv/pagamentos/adquirentes", vendedor)).status).toBe(200);
    }

    expect(await connection.collection<Configuracao>("configuracoes").findOne({ _id: "global" })).toEqual(configuracaoAntes);
    expect(await connection.collection("adquirentes").findOne({ _id: new Types.ObjectId(adquirente) })).toEqual(adquirenteAntes);

    for (const metodo of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const caminho of ["/pdv/pagamentos/formas", "/pdv/pagamentos/adquirentes"]) {
        const resposta = await fetch(`${baseUrl}/api/v1${caminho}`, { method: metodo, headers: jsonHeaders(vendedor), body: "{}" });
        expect(resposta.status).toBe(404);
      }
    }
  });

  it("integridade: uma venda montada SÓ com o que as consultas devolvem (forma + adquirente + parcelas) é aceita, com a tarifa listada", async () => {
    const caixasService = app.get(CaixasService);
    const atual = await caixasService.obterAtual();
    if (atual) await caixasService.fechar(atual.id, { valorInformado: atual.resumo.saldoEsperado }, null);

    const nome = `Adq Venda ${sufixo()}`;
    await criarAdquirente(nome, [{ modalidade: "credito", parcelas: 3, percentual: 3.7 }]);
    const vendedor = await criarELogarVendedor();
    const formas = (await get("/pdv/pagamentos/formas", vendedor)).corpo["data"] as string[];
    const adquirente = (await adquirentesDoPdv(vendedor)).find((item) => item.nome === nome);
    const opcao = adquirente?.modalidades.credito?.opcoes[0];
    expect(opcao).toEqual({ parcelas: 3, tarifaPercentual: 3.7 });
    const forma = formas.find((item) => item === "Crédito");
    expect(forma).toBe("Crédito");

    const abertura = await fetch(`${baseUrl}/api/v1/pdv/caixa/abertura`, { method: "POST", headers: jsonHeaders(vendedor), body: JSON.stringify({ valorInicial: 0 }) });
    const caixaId = ((await abertura.json()) as { data: { id: string } }).data.id;
    caixasCriados.push(caixaId);
    const produtosService = app.get(ProdutosService);
    const produto = await produtosService.criar({ nome: `Produto HTTP PDV Pagamentos ${sufixo()}`, categoria: "Vestidos", precoCusto: 50, precoVenda: 300, ehNovidade: false }, null);
    produtosCriados.push(produto.id);
    const variante = await produtosService.adicionarVariante(produto.id, { cor: "Azul" }, null);
    const { tamanhoId } = await produtosService.ajustarQuantidadeTamanho(produto.id, String(variante._id), { tamanho: "M", delta: 2, exigirExistente: false });

    const venda = await fetch(`${baseUrl}/api/v1/pdv/vendas`, {
      method: "POST",
      headers: jsonHeaders(vendedor),
      body: JSON.stringify({
        idempotencyKey: randomUUID(),
        itens: [{ produtoId: produto.id, varianteId: String(variante._id), tamanhoId, quantidade: 1 }],
        pagamentos: [{ forma, modalidade: "credito", adquirenteId: adquirente?.id, parcelas: opcao?.parcelas, valor: 300 }],
      }),
    });
    expect(venda.status).toBe(201);
    const corpo = (await venda.json()) as { data: { id: string; pagamentos: { forma: string; tarifaAplicada: { percentual: number } | null }[] } };
    vendasCriadas.push(corpo.data.id);
    expect(corpo.data.pagamentos[0]?.forma).toBe("Crédito");
    expect(corpo.data.pagamentos[0]?.tarifaAplicada?.percentual).toBe(opcao?.tarifaPercentual ?? -1);

    await caixasService.fechar(caixaId, { valorInformado: 300 }, null);
  });
});
