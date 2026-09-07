import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { MongooseModule } from "@nestjs/mongoose";
import type { Configuration } from "../../config/configuration.js";
import { VendedoresModule } from "../vendedores/vendedores.module.js";
import { PdvJwtAuthGuard } from "./guards/pdv-jwt-auth.guard.js";
import { PdvAuthController } from "./pdv-auth.controller.js";
import { PdvAuthRepository } from "./pdv-auth.repository.js";
import { PdvAuthService } from "./pdv-auth.service.js";
import { PdvAuthLoginThrottleService } from "./pdv-auth-login-throttle.service.js";
import { EventoPdvAuth, EventoPdvAuthSchema } from "./schemas/evento-pdv-auth.schema.js";
import { VendedorRefreshToken, VendedorRefreshTokenSchema } from "./schemas/vendedor-refresh-token.schema.js";

/**
 * `JwtModule` PRÓPRIO do PDV (segredo `PDV_JWT_ACCESS_SECRET`, SEM
 * `global: true`) — capturado numa constante para poder ser reexportado (ver
 * `exports` abaixo). IMPORTANTE: um guard usado via `@UseGuards(Classe)` tem
 * suas dependências resolvidas no escopo do módulo que POSSUI O CONTROLLER
 * que o usa, não no módulo onde o guard foi originalmente declarado — então
 * só exportar `PdvJwtAuthGuard` NÃO bastava: um módulo consumidor (ex.:
 * `PdvCaixaModule`) que apenas importasse `PdvAuthModule` acabava resolvendo
 * `JwtService` para o `JwtModule` GLOBAL do ADMIN (o único visível no escopo
 * dele), verificando tokens do PDV com o segredo ERRADO e rejeitando toda
 * sessão válida com 401. Reexportar este `JwtModule` (import + export do
 * mesmo módulo dinâmico) garante que qualquer módulo que importe
 * `PdvAuthModule` ganhe, no seu PRÓPRIO escopo, a mesma instância de
 * `JwtService` configurada com o segredo do PDV — resolvendo a ambiguidade a
 * favor do import local explícito, não do módulo global.
 */
const PdvJwtModule = JwtModule.registerAsync({
  inject: [ConfigService],
  useFactory: (configService: ConfigService<Configuration>) => ({
    secret: configService.get("pdvJwt.accessSecret", { infer: true }),
    signOptions: { expiresIn: configService.get("pdvJwt.accessExpiresIn", { infer: true }) },
  }),
});

/**
 * Autenticação do MARIELA PDV — módulo COMPLETAMENTE separado de `AuthModule`
 * (ADMIN). Reaproveita `VendedoresModule` (já existente) só para verificar
 * código+senha (`VendedoresService.verificarSenha`) e recarregar o vendedor
 * por id (`VendedoresRepository.encontrarPorId`, usado pelo guard) — nunca
 * duplica cadastro/CRUD de vendedor, que continua exclusivo do Backoffice.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: VendedorRefreshToken.name, schema: VendedorRefreshTokenSchema },
      { name: EventoPdvAuth.name, schema: EventoPdvAuthSchema },
    ]),
    VendedoresModule,
    PdvJwtModule,
  ],
  controllers: [PdvAuthController],
  providers: [PdvAuthService, PdvAuthRepository, PdvAuthLoginThrottleService, PdvJwtAuthGuard],
  // `PdvJwtModule` e `PdvJwtAuthGuard` são exportados juntos para uso por
  // futuros módulos do PDV (catálogo, caixa, vendas) — eles só precisam
  // importar `PdvAuthModule` para usar `@UseGuards(PdvJwtAuthGuard)` com o
  // `JwtService` correto disponível no PRÓPRIO escopo deles.
  exports: [PdvJwtModule, PdvJwtAuthGuard],
})
export class PdvAuthModule {}
