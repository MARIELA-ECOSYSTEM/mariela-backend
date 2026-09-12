import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ValidationPipe } from "@nestjs/common";
import { getConnectionToken } from "@nestjs/mongoose";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { Test } from "@nestjs/testing";
import type { AddressInfo } from "node:net";
import type { Connection } from "mongoose";
import { AppModule } from "../../app.module.js";
import { HttpExceptionFilter } from "../../common/filters/http-exception.filter.js";
import { ResponseInterceptor } from "../../common/interceptors/response.interceptor.js";
import { validationExceptionFactory } from "../../common/pipes/validation-exception-factory.js";
import { MONGODB_URI_TESTE } from "../../test-utils/mongo-teste.util.js";
import { AuthService } from "../auth/auth.service.js";
import { ClientesService } from "../clientes/clientes.service.js";
import type { WhatsappProvider } from "./providers/whatsapp-provider.interface.js";
import { WHATSAPP_PROVIDER } from "./whatsapp.constants.js";
import type { StatusWhatsapp } from "./whatsapp.types.js";

/**
 * Sobe a aplicação HTTP DE VERDADE (mesmos guards, mesmo pipeline de
 * exceções, mesmo prefixo global) — mesmo padrão de
 * `adquirentes.http.e2e.spec.ts`. O provider da Evolution API é substituído
 * (`overrideProvider`) por um dublê: esta suíte NUNCA chama a Evolution API
 * real nem envia uma mensagem de WhatsApp de verdade (Etapa Pré-22, §16).
 */
class WhatsappProviderDeTeste implements WhatsappProvider {
  chamadasEnviarTexto: { telefone: string; mensagem: string }[] = [];

  async obterStatus(): Promise<StatusWhatsapp> {
    return { provider: "evolution-api", transporte: "baileys", instance: "teste-e2e", status: "CONNECTED", numero: "+5583986567915", qrCode: null };
  }
  async conectar(): Promise<StatusWhatsapp> {
    return { ...(await this.obterStatus()), status: "QRCODE", qrCode: "data:image/png;base64,FAKE" };
  }
  async desconectar(): Promise<StatusWhatsapp> {
    return { ...(await this.obterStatus()), status: "DISCONNECTED" };
  }
  async enviarTexto(input: { telefone: string; mensagem: string }) {
    this.chamadasEnviarTexto.push(input);
    return { idExterno: "msg-e2e-1" };
  }
}

describe("HTTP — Integrações/WhatsApp (integração — servidor real, provider dublê)", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let connection: Connection;
  let adminAccessToken: string;
  let providerDeTeste: WhatsappProviderDeTeste;
  let contadorTelefone = 0;

  function telefoneUnico(): string {
    contadorTelefone += 1;
    return `1195${String(contadorTelefone).padStart(6, "0")}`;
  }

  function jsonHeaders(token?: string): Record<string, string> {
    return { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
  }

  beforeAll(async () => {
    process.env["MONGODB_URI"] = MONGODB_URI_TESTE;
    providerDeTeste = new WhatsappProviderDeTeste();

    // Sobe o `AppModule` real (mesmos guards/filtros/módulos de toda a API),
    // mas substitui SOMENTE o provider da Evolution API por um dublê — esta
    // suíte nunca deve depender de uma Evolution API real rodando, nem enviar
    // uma mensagem de verdade (Etapa Pré-22, §16/§39).
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(WHATSAPP_PROVIDER)
      .useValue(providerDeTeste)
      .compile();

    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });

    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, exceptionFactory: validationExceptionFactory }),
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
    const email = `teste.http.whatsapp.${Date.now()}@mariela.dev`;
    await authService.criarAdminSeed({ nome: "HTTP WhatsApp", email, senha: "senha-forte-123" });
    const login = await authService.login({ usuario: email, senha: "senha-forte-123" }, { ip: null, userAgent: null });
    adminAccessToken = login.accessToken;
  });

  afterAll(async () => {
    await connection.collection("clientes").deleteMany({});
    await connection.collection("eventos_cliente").deleteMany({});
    await connection.collection("sequencias").deleteMany({ _id: { $in: ["cliente", "usuario"] } });
    await connection.collection("usuarios").deleteMany({});
    await connection.collection("refresh_tokens").deleteMany({});
    await connection.collection("eventos_auth").deleteMany({});
    await app.close();
  });

  it("GET /api/v1/integracoes/whatsapp/status SEM token retorna 401", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/integracoes/whatsapp/status`);
    expect(resposta.status).toBe(401);
  });

  it("POST /api/v1/integracoes/whatsapp/mensagens com payload inválido (tipo ausente) retorna 400", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/integracoes/whatsapp/mensagens`, {
      method: "POST",
      headers: jsonHeaders(adminAccessToken),
      body: JSON.stringify({ id: "65f1a2b3c4d5e6f7a8b9c0d1" }),
    });
    const corpo = (await resposta.json()) as { statusCode: number; code: string };
    expect(resposta.status).toBe(400);
    expect(corpo.code).toBe("VALIDATION_ERROR");
  });

  it("POST /api/v1/integracoes/whatsapp/mensagens com campo `telefone` extra é REJEITADO (contrato não aceita telefone do cliente)", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/integracoes/whatsapp/mensagens`, {
      method: "POST",
      headers: jsonHeaders(adminAccessToken),
      body: JSON.stringify({ tipo: "CLIENTE", id: "65f1a2b3c4d5e6f7a8b9c0d1", telefone: "83999999999" }),
    });
    expect(resposta.status).toBe(400);
  });

  it("POST /api/v1/integracoes/whatsapp/mensagens com cliente inexistente retorna 404, sem chamar o provider", async () => {
    const antes = providerDeTeste.chamadasEnviarTexto.length;
    const resposta = await fetch(`${baseUrl}/api/v1/integracoes/whatsapp/mensagens`, {
      method: "POST",
      headers: jsonHeaders(adminAccessToken),
      body: JSON.stringify({ tipo: "CLIENTE", id: "65f1a2b3c4d5e6f7a8b9c0d1" }),
    });
    expect(resposta.status).toBe(404);
    expect(providerDeTeste.chamadasEnviarTexto.length).toBe(antes);
  });

  it("fluxo completo: cria cliente → envia mensagem → provider recebe o telefone REAL do cadastro (nunca um telefone informado pelo chamador)", async () => {
    const clientesService = app.get(ClientesService);
    const cliente = await clientesService.criar({ nome: "Cliente HTTP WhatsApp", telefone: telefoneUnico() }, null);

    const resposta = await fetch(`${baseUrl}/api/v1/integracoes/whatsapp/mensagens`, {
      method: "POST",
      headers: jsonHeaders(adminAccessToken),
      body: JSON.stringify({ tipo: "CLIENTE", id: cliente.id, mensagem: "Mensagem de teste E2E" }),
    });
    const corpo = (await resposta.json()) as { data: { status: string; tipo: string; destinatario: string } };

    expect(resposta.status).toBe(200);
    expect(corpo.data.status).toBe("enviada");
    expect(corpo.data.tipo).toBe("CLIENTE");
    expect(corpo.data.destinatario).toBe(`+55${cliente.telefone}`);

    const ultimaChamada = providerDeTeste.chamadasEnviarTexto.at(-1);
    expect(ultimaChamada?.telefone).toBe(`+55${cliente.telefone}`);
    expect(ultimaChamada?.mensagem).toBe("Mensagem de teste E2E");
  });

  it("GET /api/v1/integracoes/whatsapp/status com token ADMIN retorna o status do provider", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/integracoes/whatsapp/status`, { headers: jsonHeaders(adminAccessToken) });
    const corpo = (await resposta.json()) as { data: StatusWhatsapp };
    expect(resposta.status).toBe(200);
    expect(corpo.data.provider).toBe("evolution-api");
    expect(corpo.data.status).toBe("CONNECTED");
  });

  it("POST /api/v1/integracoes/whatsapp/conectar devolve QR Code quando o provider o fornece", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/integracoes/whatsapp/conectar`, {
      method: "POST",
      headers: jsonHeaders(adminAccessToken),
    });
    const corpo = (await resposta.json()) as { data: StatusWhatsapp };
    expect(resposta.status).toBe(200);
    expect(corpo.data.status).toBe("QRCODE");
    expect(corpo.data.qrCode).toContain("data:image/png;base64,");
  });

  it("POST /api/v1/integracoes/whatsapp/desconectar devolve DISCONNECTED", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/integracoes/whatsapp/desconectar`, {
      method: "POST",
      headers: jsonHeaders(adminAccessToken),
    });
    const corpo = (await resposta.json()) as { data: StatusWhatsapp };
    expect(resposta.status).toBe(200);
    expect(corpo.data.status).toBe("DISCONNECTED");
  });

  it("GET /docs-json documenta as rotas de Integrações/WhatsApp com BearerAuth", async () => {
    const resposta = await fetch(`${baseUrl}/docs-json`);
    const documento = (await resposta.json()) as { paths: Record<string, unknown> };
    expect(Object.keys(documento.paths)).toEqual(
      expect.arrayContaining([
        "/api/v1/integracoes/whatsapp/status",
        "/api/v1/integracoes/whatsapp/conectar",
        "/api/v1/integracoes/whatsapp/desconectar",
        "/api/v1/integracoes/whatsapp/mensagens",
      ]),
    );
  });
});
