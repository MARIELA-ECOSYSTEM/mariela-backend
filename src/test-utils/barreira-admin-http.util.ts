import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { getConnectionToken } from "@nestjs/mongoose";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Types, type Connection } from "mongoose";
import { AppModule } from "../app.module.js";
import { ERROR_CODES } from "../common/constants/error-codes.constant.js";
import { HttpExceptionFilter } from "../common/filters/http-exception.filter.js";
import { ResponseInterceptor } from "../common/interceptors/response.interceptor.js";
import { validationExceptionFactory } from "../common/pipes/validation-exception-factory.js";
import type { Configuration } from "../config/configuration.js";
import { AuthService } from "../modules/auth/auth.service.js";
import { MONGODB_URI_TESTE } from "./mongo-teste.util.js";

/**
 * Fase 22.8.1 — matriz HTTP de autenticação/autorização de uma rota ADMIN, contra o servidor REAL (mesmo bootstrap
 * dos demais `*.http.e2e.spec.ts`) e o banco de teste isolado (`MONGODB_URI_TESTE`, nunca o de desenvolvimento).
 *
 * Cobre: sem token, esquema errado, token malformado, segredo errado, token expirado, token do PDV (outro segredo e
 * outro formato) e papel desconhecido — todos 401 — e o ADMIN válido chegando ao processamento normal (200).
 *
 * 403: com `ROLES = ["ADMIN"]` (decisão de produto mantida), todo token aceito pelo `JwtAuthGuard` já tem o papel
 * exigido e um papel diferente é recusado ANTES, pelo próprio `JwtAuthGuard` (401). O 403 do `RolesGuard` não é
 * alcançável por HTTP hoje; ele segue coberto pelo teste unitário `roles.guard.spec.ts`. O caso "papel desconhecido"
 * abaixo documenta essa fronteira — se um dia existir um segundo papel, ele passará a falhar e pedirá o caso 403.
 *
 * Só cria o usuário ADMIN de teste (removido no fim, com suas sessões e eventos). Nenhuma operação comercial.
 */
/** Remove usuários de TESTE (e-mail casando com `padrao`) e as sessões/eventos deles, no banco de teste. */
async function removerUsuariosDeTeste(connection: Connection, padrao: RegExp): Promise<void> {
  if (!padrao.source.startsWith("^teste\\.http\\.barreira\\.")) {
    throw new Error("removerUsuariosDeTeste só remove usuários criados por este utilitário.");
  }
  const usuarios = await connection.collection("usuarios").find({ email: padrao }, { projection: { _id: 1 } }).toArray();
  const ids = usuarios.map((usuario) => usuario._id);
  if (ids.length === 0) return;
  await connection.collection("refresh_tokens").deleteMany({ usuarioId: { $in: ids } });
  await connection.collection("eventos_auth").deleteMany({ usuarioId: { $in: ids } });
  await connection.collection("usuarios").deleteMany({ _id: { $in: ids } });
}

export function descreverBarreiraAdmin(opcoes: {
  modulo: string;
  metodo: "GET";
  /** Caminho sob `/api/v1`, ex.: `/relatorios/resumo`. */
  rota: string;
  /** Verifica o corpo da resposta 200 do ADMIN (processamento normal do endpoint). */
  validarSucesso: (corpo: { data: unknown }) => void;
}): void {
  const { modulo, metodo, rota, validarSucesso } = opcoes;

  describe(`HTTP — ${modulo}: barreira de autenticação/autorização (Fase 22.8.1)`, () => {
    let app: NestExpressApplication;
    let baseUrl: string;
    let connection: Connection;
    let usuarioId: string;
    let email: string;
    const tokens: Record<string, string> = {};

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
      await app.init();
      await app.listen(0);
      baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/v1`;
      connection = app.get(getConnectionToken());
      // Restos de uma execução INTERROMPIDA deste mesmo spec (ex.: timeout no meio do beforeAll) — só os deste módulo.
      await removerUsuariosDeTeste(connection, new RegExp(`^teste\\.http\\.barreira\\.${modulo}\\.`));

      const authService = app.get(AuthService);
      email = `teste.http.barreira.${modulo}.${Date.now()}@mariela.dev`;
      const senha = "senha-forte-barreira-123";
      const seed = await authService.criarAdminSeed({ nome: `HTTP Barreira ${modulo}`, email, senha });
      usuarioId = seed.usuario.id;
      const login = await authService.login({ usuario: email, senha }, { ip: null, userAgent: null });
      tokens["admin"] = login.accessToken;

      // Tokens forjados com os segredos DESTE ambiente de teste (lidos do ConfigService — nunca de produção).
      const config = app.get(ConfigService<Configuration>);
      const segredoAdmin = config.get("jwt.accessSecret", { infer: true })!;
      const segredoPdv = config.get("pdvJwt.accessSecret", { infer: true })!;
      const jwt = new JwtService({}); // sem `signOptions` padrão: cada token define a própria expiração
      const formatoAdmin = { sub: usuarioId, codigo: seed.usuario.codigo, role: "ADMIN" };
      tokens["segredoErrado"] = await jwt.signAsync(formatoAdmin, {
        secret: randomBytes(48).toString("hex"),
        expiresIn: "5m",
      });
      tokens["expirado"] = await jwt.signAsync(
        { ...formatoAdmin, exp: Math.floor(Date.now() / 1000) - 120 },
        { secret: segredoAdmin },
      );
      tokens["pdv"] = await jwt.signAsync(
        { sub: new Types.ObjectId().toString(), vendedorId: "vendedor-teste", codigo: "VEN-TESTE", tipo: "PDV" },
        { secret: segredoPdv, expiresIn: "5m" },
      );
      tokens["papelDesconhecido"] = await jwt.signAsync(
        { ...formatoAdmin, role: "GERENTE" },
        { secret: segredoAdmin, expiresIn: "5m" },
      );
    }, 60_000); // subir o AppModule a frio (compilação + conexão + argon2id) passa do padrão de 5 s do Bun

    afterAll(async () => {
      if (connection && email) await removerUsuariosDeTeste(connection, new RegExp(`^${email.replace(/\./g, "\\.")}$`));
      await app?.close();
    }, 60_000);

    async function requisitar(authorization?: string): Promise<{ status: number; corpo: Record<string, unknown> }> {
      const resposta = await fetch(`${baseUrl}${rota}`, {
        method: metodo,
        headers: authorization === undefined ? {} : { authorization },
      });
      return { status: resposta.status, corpo: (await resposta.json()) as Record<string, unknown> };
    }

    function esperar401(resultado: { status: number; corpo: Record<string, unknown> }): void {
      expect(resultado.status).toBe(401);
      expect(resultado.corpo["code"]).toBe(ERROR_CODES.UNAUTHORIZED);
      expect(resultado.corpo["data"]).toBeUndefined(); // nada do recurso vaza
    }

    it(`${metodo} ${rota} SEM token → 401`, async () => {
      esperar401(await requisitar());
    });

    it(`${metodo} ${rota} com esquema que não é Bearer → 401`, async () => {
      esperar401(await requisitar(`Token ${tokens["admin"]}`));
    });

    it(`${metodo} ${rota} com token malformado → 401`, async () => {
      esperar401(await requisitar("Bearer isto-nao-e-um-jwt"));
    });

    it(`${metodo} ${rota} com token assinado por OUTRO segredo → 401`, async () => {
      esperar401(await requisitar(`Bearer ${tokens["segredoErrado"]}`));
    });

    it(`${metodo} ${rota} com token EXPIRADO → 401`, async () => {
      esperar401(await requisitar(`Bearer ${tokens["expirado"]}`));
    });

    it(`${metodo} ${rota} com token do PDV (vendedor) → 401 — PDV não acessa rota ADMIN`, async () => {
      esperar401(await requisitar(`Bearer ${tokens["pdv"]}`));
    });

    it(`${metodo} ${rota} com papel desconhecido (assinatura válida) → 401 no JwtAuthGuard (403 não alcançável com papel único)`, async () => {
      esperar401(await requisitar(`Bearer ${tokens["papelDesconhecido"]}`));
    });

    it(`${metodo} ${rota} com token ADMIN válido → 200, processamento normal do endpoint`, async () => {
      const { status, corpo } = await requisitar(`Bearer ${tokens["admin"]}`);
      expect(status).toBe(200);
      validarSucesso(corpo as { data: unknown });
    });
  });
}
