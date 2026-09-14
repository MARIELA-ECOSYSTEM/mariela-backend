import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ValidationPipe } from "@nestjs/common";
import { getConnectionToken } from "@nestjs/mongoose";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import type { Connection } from "mongoose";
import type { AddressInfo } from "node:net";
import { AppModule } from "../../app.module.js";
import { HttpExceptionFilter } from "../../common/filters/http-exception.filter.js";
import { ResponseInterceptor } from "../../common/interceptors/response.interceptor.js";
import { validationExceptionFactory } from "../../common/pipes/validation-exception-factory.js";
import { MONGODB_URI_TESTE } from "../../test-utils/mongo-teste.util.js";
import { AuthService } from "../auth/auth.service.js";
import { ClientesService } from "../clientes/clientes.service.js";
import type { WhatsappProvider } from "./providers/whatsapp-provider.interface.js";
import { WHATSAPP_PROVIDER, WHATSAPP_SEND_THROTTLE_LIMITE } from "./whatsapp.constants.js";
import type { StatusWhatsapp } from "./whatsapp.types.js";

/**
 * Etapa 24 — rate limiting de `POST /integracoes/whatsapp/mensagens`. Mesmo
 * padrão de `whatsapp.http.e2e.spec.ts` (provider dublê via
 * `overrideProvider`, nunca chama a Evolution API real), app próprio isolado
 * (mesmo racional de `auth-rate-limit.http.e2e.spec.ts`).
 *
 * O dublê REGISTRA cada chamada (`chamadasEnviarTexto`) — é isso que prova
 * de forma direta, não apenas inferida por status HTTP, que o provider NUNCA
 * é chamado quando a requisição é bloqueada pelo guard (que roda ANTES do
 * handler/service, por garantia do próprio Nest).
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
    return { idExterno: `msg-${this.chamadasEnviarTexto.length}` };
  }
}

describe("HTTP — WhatsApp: rate limiting de POST /integracoes/whatsapp/mensagens (Etapa 24)", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let connection: Connection;
  let adminAccessToken: string;
  let providerDeTeste: WhatsappProviderDeTeste;
  let clienteId: string;
  let contadorTelefone = 0;

  function telefoneUnico(): string {
    contadorTelefone += 1;
    return `1196${String(contadorTelefone).padStart(6, "0")}`;
  }

  function jsonHeaders(token?: string): Record<string, string> {
    return { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
  }

  beforeAll(async () => {
    process.env["MONGODB_URI"] = MONGODB_URI_TESTE;
    providerDeTeste = new WhatsappProviderDeTeste();

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

    await app.init();
    await app.listen(0);
    const endereco = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${endereco.port}`;
    connection = app.get(getConnectionToken());

    const authService = app.get(AuthService);
    const email = `teste.http.whatsapp-rate-limit.${Date.now()}@mariela.dev`;
    await authService.criarAdminSeed({ nome: "Rate Limit WhatsApp", email, senha: "senha-forte-123" });
    const login = await authService.login({ usuario: email, senha: "senha-forte-123" }, { ip: null, userAgent: null });
    adminAccessToken = login.accessToken;

    const clientesService = app.get(ClientesService);
    const cliente = await clientesService.criar({ nome: "Cliente Rate Limit", telefone: telefoneUnico() }, null);
    clienteId = cliente.id;
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

  async function enviarMensagem(): Promise<Response> {
    return fetch(`${baseUrl}/api/v1/integracoes/whatsapp/mensagens`, {
      method: "POST",
      headers: jsonHeaders(adminAccessToken),
      body: JSON.stringify({ tipo: "CLIENTE", id: clienteId }),
    });
  }

  it("requisição normal funciona: chega ao provider, que registra a chamada", async () => {
    const chamadasAntes = providerDeTeste.chamadasEnviarTexto.length;
    const resposta = await enviarMensagem();
    expect(resposta.status).toBe(200);
    expect(providerDeTeste.chamadasEnviarTexto.length).toBe(chamadasAntes + 1);
  });

  it(`o limite (${WHATSAPP_SEND_THROTTLE_LIMITE} por janela) é respeitado: excesso retorna 429`, async () => {
    // 1 chamada já feita acima. Completa até o limite (todas devem
    // funcionar), depois a próxima deve ser bloqueada.
    const faltamParaOLimite = WHATSAPP_SEND_THROTTLE_LIMITE - 1;
    for (let indice = 0; indice < faltamParaOLimite; indice += 1) {
      const resposta = await enviarMensagem();
      expect(resposta.status).toBe(200);
    }

    const bloqueada = await enviarMensagem();
    expect(bloqueada.status).toBe(429);
    const corpo = (await bloqueada.json()) as { statusCode: number; code: string };
    expect(corpo.statusCode).toBe(429);
    expect(corpo.code).toBe("TOO_MANY_REQUESTS");
  });

  it("o provider NÃO é chamado quando a requisição é bloqueada pelo rate limit", async () => {
    const chamadasAntesDoBloqueio = providerDeTeste.chamadasEnviarTexto.length;

    // Neste ponto o balde já está no limite (teste anterior) — qualquer nova
    // chamada deve ser bloqueada SEM incrementar o contador do dublê.
    const bloqueada = await enviarMensagem();
    expect(bloqueada.status).toBe(429);
    expect(providerDeTeste.chamadasEnviarTexto.length).toBe(chamadasAntesDoBloqueio);

    // Confirma de novo, para eliminar qualquer dúvida de que uma única
    // observação foi coincidência.
    const bloqueadaDeNovo = await enviarMensagem();
    expect(bloqueadaDeNovo.status).toBe(429);
    expect(providerDeTeste.chamadasEnviarTexto.length).toBe(chamadasAntesDoBloqueio);
  });

  it("regressão: com o balde de envio esgotado, outra rota do módulo (status) continua funcionando normalmente", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/integracoes/whatsapp/status`, {
      headers: jsonHeaders(adminAccessToken),
    });
    expect(resposta.status).toBe(200);
    const corpo = (await resposta.json()) as { data: { status: string } };
    expect(corpo.data.status).toBe("CONNECTED");
  });
});
