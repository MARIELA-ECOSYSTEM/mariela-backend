import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { ValidationPipe } from "@nestjs/common";
import { getConnectionToken } from "@nestjs/mongoose";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { ThrottlerStorage } from "@nestjs/throttler";
import type { AddressInfo } from "node:net";
import type { Connection } from "mongoose";
import { AppModule } from "../../../app.module.js";
import { HttpExceptionFilter } from "../../../common/filters/http-exception.filter.js";
import { ResponseInterceptor } from "../../../common/interceptors/response.interceptor.js";
import { validationExceptionFactory } from "../../../common/pipes/validation-exception-factory.js";
import { MONGODB_URI_TESTE } from "../../../test-utils/mongo-teste.util.js";
import { AuthService } from "../../auth/auth.service.js";
import { ClientesService } from "../../clientes/clientes.service.js";
import type { Sequencia } from "../../sequencias/schemas/sequencia.schema.js";
import {
  PROVEDOR_ENVIO_WHATSAPP,
  type EnviarTemplateWhatsappInput,
  type InfoTemplateProvedorWhatsapp,
  type ProvedorEnvioWhatsapp,
  type ResultadoEnvioProvedorWhatsapp,
} from "../providers/provedor-envio-whatsapp.interface.js";

/**
 * Fase 22.8.9.10.3 — HTTP real (mesmos guards, pipes, filtro de erros e prefixo da API) das rotas de envio por
 * template e de bloqueio. O provedor de envio é um dublê: nenhuma chamada à Meta/Evolution, nenhuma credencial.
 */
class ProvedorEnvioFalso implements ProvedorEnvioWhatsapp {
  readonly nome = "falso";
  chamadas: EnviarTemplateWhatsappInput[] = [];
  configurado(): boolean {
    return true;
  }
  async enviarTemplate(input: EnviarTemplateWhatsappInput): Promise<ResultadoEnvioProvedorWhatsapp> {
    this.chamadas.push(input);
    return { resultado: "aceita", wamid: `wamid.${input.referenciaInterna}`, waId: null };
  }
  async consultarTemplate(nomeMeta: string, idioma: string): Promise<InfoTemplateProvedorWhatsapp | null> {
    return { nomeMeta, idioma, status: "APPROVED", categoria: "MARKETING", quantidadeParametros: 1 };
  }
}

describe("HTTP — WhatsApp por template e bloqueios (servidor real, provedor dublê)", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let connection: Connection;
  let token: string;
  let provedor: ProvedorEnvioFalso;
  let clientes: ClientesService;
  let contador = 0;

  const h = (comToken = true) => ({ "content-type": "application/json", ...(comToken ? { authorization: `Bearer ${token}` } : {}) });
  const url = (caminho: string) => `${baseUrl}/api/v1/integracoes/whatsapp${caminho}`;
  const novoCliente = (nome = "Cliente HTTP WhatsApp") => clientes.criar({ nome, telefone: `849${String(++contador).padStart(8, "0")}` }, null);
  const corpoEnvio = (clienteId: string, extra: Record<string, unknown> = {}) => ({
    idempotencyKey: randomUUID(),
    destinatario: { tipo: "CLIENTE", id: clienteId },
    template: "aniversario_v2",
    ...extra,
  });
  const post = (caminho: string, corpo: unknown) => fetch(url(caminho), { method: "POST", headers: h(), body: JSON.stringify(corpo) });

  beforeAll(async () => {
    process.env["MONGODB_URI"] = MONGODB_URI_TESTE;
    provedor = new ProvedorEnvioFalso();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(PROVEDOR_ENVIO_WHATSAPP).useValue(provedor).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, exceptionFactory: validationExceptionFactory }));
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.setGlobalPrefix("api/v1", { exclude: ["health", "docs"] });
    await app.init();
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    connection = app.get(getConnectionToken());
    await connection.model("MensagemWhatsapp").init();
    await connection.model("BloqueioWhatsapp").init();
    clientes = app.get(ClientesService);

    const auth = app.get(AuthService);
    const email = `teste.http.whatsapp.envios.${Date.now()}@mariela.dev`;
    await auth.criarAdminSeed({ nome: "HTTP WhatsApp Envios", email, senha: "senha-forte-123" });
    token = (await auth.login({ usuario: email, senha: "senha-forte-123" }, { ip: null, userAgent: null })).accessToken;
    // Sobe o `AppModule` inteiro (todos os módulos e índices): numa 1ª execução fria passa dos 5 s padrão do bun.
  }, 30_000);

  beforeEach(async () => {
    await connection.collection("mensagens_whatsapp").deleteMany({});
    await connection.collection("whatsapp_bloqueios").deleteMany({});
    provedor.chamadas = [];
    // O limite de envio (10/10 s) continua ATIVO; só o balde é zerado entre testes independentes
    // (o próprio limite é coberto por `whatsapp-rate-limit.http.e2e.spec.ts`).
    app.get<{ storage: Map<string, unknown> }>(ThrottlerStorage).storage.clear();
  });

  afterAll(async () => {
    await connection.collection("mensagens_whatsapp").deleteMany({});
    await connection.collection("whatsapp_bloqueios").deleteMany({});
    await connection.collection("clientes").deleteMany({});
    await connection.collection("eventos_cliente").deleteMany({});
    await connection.collection<Sequencia>("sequencias").deleteMany({ _id: { $in: ["cliente", "usuario"] } });
    await connection.collection("usuarios").deleteMany({});
    await connection.collection("refresh_tokens").deleteMany({});
    await connection.collection("eventos_auth").deleteMany({});
    await app.close();
  });

  it("sem token: 401 em envio, histórico, templates e bloqueios", async () => {
    for (const [metodo, caminho] of [
      ["POST", "/envios"],
      ["GET", "/mensagens"],
      ["GET", "/templates"],
      ["GET", "/bloqueios"],
    ] as const) {
      const r = await fetch(url(caminho), { method: metodo, headers: h(false), body: metodo === "POST" ? "{}" : undefined });
      expect(r.status).toBe(401);
    }
  });

  it("POST /envios: telefone ou texto no corpo (mesmo aninhado) → 400; nada é enviado", async () => {
    const c = await novoCliente();
    expect((await post("/envios", corpoEnvio(c.id, { telefone: "84999990000" }))).status).toBe(400);
    expect((await post("/envios", corpoEnvio(c.id, { mensagem: "texto livre" }))).status).toBe(400);
    expect((await post("/envios", { ...corpoEnvio(c.id), destinatario: { tipo: "CLIENTE", id: c.id, telefone: "84999990000" } })).status).toBe(400);
    expect(provedor.chamadas).toHaveLength(0);
  });

  it("POST /envios: 201 na criação, 200 na repetição da mesma chave (sem reenviar), 409 com conteúdo diferente", async () => {
    const c = await novoCliente();
    const corpo = corpoEnvio(c.id);
    const r1 = await post("/envios", corpo);
    expect(r1.status).toBe(201);
    const b1 = (await r1.json()) as { data: { id: string; estado: string; destinatario: { telefoneMascarado: string } } };
    expect(b1.data.estado).toBe("aceita");
    expect(JSON.stringify(b1)).not.toContain(c.telefone);

    const r2 = await post("/envios", corpo);
    expect(r2.status).toBe(200);
    expect(((await r2.json()) as { data: { id: string } }).data.id).toBe(b1.data.id);

    const outro = await novoCliente();
    const r3 = await post("/envios", { ...corpo, destinatario: { tipo: "CLIENTE", id: outro.id } });
    expect(r3.status).toBe(409);
    expect(((await r3.json()) as { code: string }).code).toBe("WHATSAPP_IDEMPOTENCIA_CONFLITO");
    expect(provedor.chamadas).toHaveLength(1);
  });

  it("campanha repetida para o mesmo cliente no ano → 409 WHATSAPP_JA_ENVIADA_CAMPANHA", async () => {
    const c = await novoCliente();
    expect((await post("/envios", corpoEnvio(c.id, { campanha: { tipo: "ANIVERSARIO" } }))).status).toBe(201);
    const r = await post("/envios", corpoEnvio(c.id, { campanha: { tipo: "ANIVERSARIO" } }));
    expect(r.status).toBe(409);
    expect(((await r.json()) as { code: string }).code).toBe("WHATSAPP_JA_ENVIADA_CAMPANHA");
  });

  it("GET /mensagens (paginado, filtro por cliente) e GET /mensagens/:id (404 para id inválido)", async () => {
    const c = await novoCliente();
    await post("/envios", corpoEnvio(c.id));
    await post("/envios", corpoEnvio(c.id));
    const lista = (await (await fetch(url(`/mensagens?clienteId=${c.id}&limit=1`), { headers: h() })).json()) as {
      data: { id: string }[];
      meta: { total: number; limit: number; totalPages: number };
    };
    expect(lista.data).toHaveLength(1);
    expect(lista.meta).toMatchObject({ total: 2, limit: 1, totalPages: 2 });
    expect((await fetch(url(`/mensagens/${lista.data[0]!.id}`), { headers: h() })).status).toBe(200);
    expect((await fetch(url("/mensagens/nao-e-um-id"), { headers: h() })).status).toBe(404);
    expect((await fetch(url("/mensagens?limit=500"), { headers: h() })).status).toBe(400);
  });

  it("bloqueio: POST 201 e depois 200 (idempotente); envio → 422; DELETE exige motivo; depois envia", async () => {
    const c = await novoCliente();
    expect((await post(`/clientes/${c.id}/bloqueio`, { motivo: "Pediu" })).status).toBe(201);
    expect((await post(`/clientes/${c.id}/bloqueio`, {})).status).toBe(200);
    const status = (await (await fetch(url(`/clientes/${c.id}/bloqueio`), { headers: h() })).json()) as { data: { bloqueado: boolean; telefoneMascarado: string } };
    expect(status.data.bloqueado).toBe(true);
    expect(status.data.telefoneMascarado).not.toContain(c.telefone);

    const envio = await post("/envios", corpoEnvio(c.id));
    expect(envio.status).toBe(422);
    expect(((await envio.json()) as { code: string }).code).toBe("WHATSAPP_CONTATO_BLOQUEADO");

    const semMotivo = await fetch(url(`/clientes/${c.id}/bloqueio`), { method: "DELETE", headers: h(), body: "{}" });
    expect(semMotivo.status).toBe(400);
    const comMotivo = await fetch(url(`/clientes/${c.id}/bloqueio`), { method: "DELETE", headers: h(), body: JSON.stringify({ motivo: "Autorizou de novo" }) });
    expect(comMotivo.status).toBe(200);
    expect((await post("/envios", corpoEnvio(c.id))).status).toBe(201);
  });

  it("GET /templates e POST /templates/:chave/previa (primeiro nome do cadastro)", async () => {
    const templates = (await (await fetch(url("/templates"), { headers: h() })).json()) as { data: { chave: string; estadoAprovacao: string }[] };
    expect(templates.data).toContainEqual(expect.objectContaining({ chave: "aniversario_v2", estadoAprovacao: "APROVADO" }));
    const c = await novoCliente("Fernanda Lima");
    const previa = await post("/templates/aniversario_v2/previa", { clienteId: c.id });
    expect(previa.status).toBe(200);
    expect(((await previa.json()) as { data: { texto: string } }).data.texto).toStartWith("Olá, Fernanda!");
    expect((await post("/templates/nao_existe/previa", { clienteId: c.id })).status).toBe(422);
  });

  it("POST /mensagens/:id/liberar-reenvio: aceita não pode (409); motivo curto → 400", async () => {
    const c = await novoCliente();
    const id = ((await (await post("/envios", corpoEnvio(c.id))).json()) as { data: { id: string } }).data.id;
    expect((await post(`/mensagens/${id}/liberar-reenvio`, { motivo: "curto" })).status).toBe(400);
    const r = await post(`/mensagens/${id}/liberar-reenvio`, { motivo: "Motivo suficientemente longo" });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { code: string }).code).toBe("WHATSAPP_LIBERACAO_NAO_PERMITIDA");
  });
});
