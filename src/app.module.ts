import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import configuration, { type Configuration } from "./config/configuration.js";
import { validateEnv } from "./config/env.validation.js";
import { DatabaseModule } from "./database/database.module.js";
import { AuthModule } from "./modules/auth/auth.module.js";
import { CaixasModule } from "./modules/caixas/caixas.module.js";
import { CampanhasModule } from "./modules/campanhas/campanhas.module.js";
import { ClientesModule } from "./modules/clientes/clientes.module.js";
import { ColecoesModule } from "./modules/colecoes/colecoes.module.js";
import { DashboardModule } from "./modules/dashboard/dashboard.module.js";
import { EstoqueModule } from "./modules/estoque/estoque.module.js";
import { FornecedoresModule } from "./modules/fornecedores/fornecedores.module.js";
import { PdvAuthModule } from "./modules/pdv-auth/pdv-auth.module.js";
import { PdvCaixaModule } from "./modules/pdv-caixa/pdv-caixa.module.js";
import { PdvProdutosModule } from "./modules/pdv-produtos/pdv-produtos.module.js";
import { PdvVendasModule } from "./modules/pdv-vendas/pdv-vendas.module.js";
import { ProdutosModule } from "./modules/produtos/produtos.module.js";
import { SaudeModule } from "./modules/saude/saude.module.js";
import { VendasModule } from "./modules/vendas/vendas.module.js";
import { VendedoresModule } from "./modules/vendedores/vendedores.module.js";

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
    SaudeModule,
    AuthModule,
    ProdutosModule,
    EstoqueModule,
    ClientesModule,
    FornecedoresModule,
    ColecoesModule,
    CampanhasModule,
    VendedoresModule,
    CaixasModule,
    VendasModule,
    DashboardModule,
    PdvAuthModule,
    PdvCaixaModule,
    PdvProdutosModule,
    PdvVendasModule,
  ],
})
export class AppModule {}
