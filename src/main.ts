import "reflect-metadata";
import { Logger, ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import type { Request, Response } from "express";
import helmet from "helmet";
import { AppModule } from "./app.module.js";
import type { Configuration } from "./config/configuration.js";
import { ERROR_CODES } from "./common/constants/error-codes.constant.js";
import { HttpExceptionFilter } from "./common/filters/http-exception.filter.js";
import { ResponseInterceptor } from "./common/interceptors/response.interceptor.js";
import { StructuredLoggerService } from "./common/logger/structured-logger.service.js";
import { validationExceptionFactory } from "./common/pipes/validation-exception-factory.js";
import type { ApiErrorResponse } from "./common/types/api-response.interface.js";

/**
 * Etapa 18.23 — fixa o timezone do processo do servidor ANTES de qualquer
 * outro código rodar, resolvendo a questão transversal já identificada em
 * etapas anteriores (Dashboard/Vendas/Caixa/Coleções/Campanhas sempre
 * dependeram do timezone do SO do processo, nunca fixado em lugar nenhum —
 * um deploy num host/container em UTC produziria "início do dia"/"início do
 * mês" incorretos para uma loja brasileira). "America/Sao_Paulo" é a única
 * loja física do ecossistema hoje; se `TZ` já vier definido pelo ambiente
 * (Docker/systemd/etc.), essa configuração explícita do host tem prioridade
 * — nunca sobrescrita aqui. Escopado deliberadamente a este processo de
 * servidor: os testes nunca importam `main.ts` e continuam rodando sob o
 * timezone ambiente da máquina/CI, exatamente como já validado nos 1156
 * testes existentes — nenhum comportamento de teste muda por causa disto.
 */
if (!process.env["TZ"]) {
  process.env["TZ"] = "America/Sao_Paulo";
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: new StructuredLoggerService(),
  });

  const configService = app.get(ConfigService<Configuration>);
  const { port, apiPrefix, swaggerEnabled } = configService.get("app", { infer: true })!;
  const { origins } = configService.get("cors", { infer: true })!;

  app.use(helmet());
  app.enableCors({ origin: origins.length > 0 ? origins : false, credentials: true });

  // `/health` e `/docs` ficam fora do prefixo versionado: são infraestrutura,
  // não endpoints de negócio.
  app.setGlobalPrefix(apiPrefix, { exclude: ["health", "docs"] });

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

  // Etapa 18.23 — fora de produção, sempre habilitado; em produção, só com
  // `SWAGGER_ENABLED=true` explícito (ver `configuration.ts#swaggerEnabled`).
  // Expor o schema completo da API publicamente por padrão em produção não é
  // necessário para o modo de operação atual (Backoffice/PDV internos) e é
  // evitável sem custo — quem precisar dele em produção liga por opção.
  if (swaggerEnabled) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle("MARIELA API")
      .setDescription("API REST central do ecossistema MARIELA (Backoffice, PDV, Vitrine Virtual, Integrações).")
      .setVersion("0.1.0")
      .addBearerAuth()
      .build();
    const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup("docs", app, swaggerDocument);
  }

  // As rotas dos controllers só são de fato montadas no adapter HTTP durante
  // `init()` (chamado implicitamente por `listen()`). Chamando-o explicitamente
  // aqui garantimos que o catch-all abaixo — adicionado via `app.use()` — fique
  // depois delas na pilha do Express; senão ele intercepta TODAS as rotas,
  // inclusive `/health`.
  await app.init();

  // Fallback de 404 no mesmo envelope de erro da API.
  // Necessário porque uma rota que não casa com NENHUM controller nunca chega
  // a entrar na "exception zone" do Nest — o Express responde antes, com o
  // HTML padrão dele.
  app.use((req: Request, res: Response) => {
    const corpo: ApiErrorResponse = {
      statusCode: 404,
      code: ERROR_CODES.NOT_FOUND,
      message: `Recurso não encontrado: ${req.method} ${req.originalUrl}`,
    };
    res.status(404).json(corpo);
  });

  // Permite que o Nest chame `onModuleDestroy`/`onApplicationShutdown` (ex.:
  // fechar a conexão do Mongoose) quando o processo recebe SIGINT/SIGTERM.
  app.enableShutdownHooks();

  await app.listen(port);

  const logger = new Logger("Bootstrap");
  logger.log(`API disponível em http://localhost:${port}/${apiPrefix}`);
  logger.log(`Health check em http://localhost:${port}/health`);
  logger.log(
    swaggerEnabled
      ? `Documentação Swagger em http://localhost:${port}/docs`
      : "Documentação Swagger desabilitada (produção sem SWAGGER_ENABLED=true).",
  );
}

void bootstrap();
