import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { JwtModule } from "@nestjs/jwt";
import { ThrottlerModule } from "@nestjs/throttler";
import configuration, { type Configuration } from "./config/configuration.js";
import { validateEnv } from "./config/env.validation.js";
import { AppThrottlerGuard } from "./common/guards/app-throttler.guard.js";
import { DatabaseModule } from "./database/database.module.js";
import { AdquirentesModule } from "./modules/adquirentes/adquirentes.module.js";
import { AuthModule } from "./modules/auth/auth.module.js";
import { CaixasModule } from "./modules/caixas/caixas.module.js";
import { CampanhasModule } from "./modules/campanhas/campanhas.module.js";
import { ClientesModule } from "./modules/clientes/clientes.module.js";
import { ColecoesModule } from "./modules/colecoes/colecoes.module.js";
import { ConfiguracoesModule } from "./modules/configuracoes/configuracoes.module.js";
import { DashboardModule } from "./modules/dashboard/dashboard.module.js";
import { EstoqueModule } from "./modules/estoque/estoque.module.js";
import { FornecedoresModule } from "./modules/fornecedores/fornecedores.module.js";
import { IntegracoesModule } from "./modules/integracoes/integracoes.module.js";
import { MediaModule } from "./modules/media/media.module.js";
import { PdvAuthModule } from "./modules/pdv-auth/pdv-auth.module.js";
import { PdvCaixaModule } from "./modules/pdv-caixa/pdv-caixa.module.js";
import { PdvClientesModule } from "./modules/pdv-clientes/pdv-clientes.module.js";
import { PdvProdutosModule } from "./modules/pdv-produtos/pdv-produtos.module.js";
import { PdvVendasModule } from "./modules/pdv-vendas/pdv-vendas.module.js";
import { ProdutosModule } from "./modules/produtos/produtos.module.js";
import { RelatoriosModule } from "./modules/relatorios/relatorios.module.js";
import { SaudeModule } from "./modules/saude/saude.module.js";
import { VendasModule } from "./modules/vendas/vendas.module.js";
import { VendedoresModule } from "./modules/vendedores/vendedores.module.js";
import { WhatsappModule } from "./modules/whatsapp/whatsapp.module.js";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate: validateEnv,
    }),
    DatabaseModule,
    // Global: disponibiliza `JwtService` para qualquer guard/service (ex.:
    // `JwtAuthGuard`) sem cada módulo precisar reimportar o JwtModule.
    // Configurado com o access secret; tokens de refresh são assinados
    // explicitamente com `JWT_REFRESH_SECRET` quando o login for implementado.
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (configService: ConfigService<Configuration>) => ({
        secret: configService.get("jwt.accessSecret", { infer: true }),
        signOptions: { expiresIn: configService.get("jwt.accessExpiresIn", { infer: true }) },
      }),
    }),
    /**
     * Etapa 24 — piso GLOBAL/moderado de rate limiting, aplicado a TODA rota
     * via `AppThrottlerGuard` como `APP_GUARD` abaixo (inclusive `/health`,
     * por isso `SaudeController` usa `@SkipThrottle()` — o HEALTHCHECK do
     * Docker nunca pode ser derrubado por isto). Limite generoso de propósito
     * (300 req/60s por IP = 5 req/s sustentado): existe só como barreira
     * contra abuso/DoS grosseiro, nunca deve ser percebido em uso normal de
     * dashboard/CRUDs/sincronização do PDV. Endpoints críticos (`/auth/login`,
     * `/pdv/auth/login`, `/integracoes/whatsapp/mensagens`) sobrescrevem este
     * mesmo throttler "default" com limites bem mais restritos via `@Throttle`
     * no próprio controller — não precisam de um throttler nomeado à parte.
     */
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService<Configuration>) => ({
        throttlers: [
          {
            name: "default",
            limit: configService.get("rateLimit.globalLimit", { infer: true })!,
            ttl: configService.get("rateLimit.globalTtlMs", { infer: true })!,
          },
        ],
      }),
    }),
    SaudeModule,
    AuthModule,
    AdquirentesModule,
    ProdutosModule,
    EstoqueModule,
    ClientesModule,
    FornecedoresModule,
    ColecoesModule,
    ConfiguracoesModule,
    CampanhasModule,
    VendedoresModule,
    CaixasModule,
    VendasModule,
    DashboardModule,
    RelatoriosModule,
    IntegracoesModule,
    PdvAuthModule,
    PdvCaixaModule,
    PdvClientesModule,
    PdvProdutosModule,
    PdvVendasModule,
    WhatsappModule,
    MediaModule,
  ],
  providers: [
    // Etapa 24 — aplica `AppThrottlerGuard` a toda rota da aplicação (ver
    // comentário do `ThrottlerModule.forRootAsync` acima).
    { provide: APP_GUARD, useClass: AppThrottlerGuard },
  ],
})
export class AppModule {}
