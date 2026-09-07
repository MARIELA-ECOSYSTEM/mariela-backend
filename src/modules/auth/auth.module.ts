import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { SequenciasModule } from "../sequencias/sequencias.module.js";
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";
import { LoginThrottleService } from "./login-throttle.service.js";
import { RefreshTokensRepository } from "./refresh-tokens.repository.js";
import { EventoAuth, EventoAuthSchema } from "./schemas/evento-auth.schema.js";
import { RefreshToken, RefreshTokenSchema } from "./schemas/refresh-token.schema.js";
import { Usuario, UsuarioSchema } from "./schemas/usuario.schema.js";
import { UsuariosRepository } from "./usuarios.repository.js";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Usuario.name, schema: UsuarioSchema },
      { name: RefreshToken.name, schema: RefreshTokenSchema },
      { name: EventoAuth.name, schema: EventoAuthSchema },
    ]),
    SequenciasModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, UsuariosRepository, RefreshTokensRepository, LoginThrottleService],
  // O script de seed (`bun run seed:admin`) usa `AuthService` fora de um controller.
  exports: [AuthService],
})
export class AuthModule {}
