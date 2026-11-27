import { Module, type DynamicModule } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import type { Connection } from "mongoose";
import { RedefinicaoSenhaAdminService } from "../modules/auth/redefinicao-senha-admin.service.js";
import { RefreshTokensRepository } from "../modules/auth/refresh-tokens.repository.js";
import { EventoAuth, EventoAuthSchema } from "../modules/auth/schemas/evento-auth.schema.js";
import { RefreshToken, RefreshTokenSchema } from "../modules/auth/schemas/refresh-token.schema.js";
import { Usuario, UsuarioSchema } from "../modules/auth/schemas/usuario.schema.js";
import { UsuariosRepository } from "../modules/auth/usuarios.repository.js";

/**
 * Contexto Nest EXCLUSIVO do comando `admin:reset-password` (mesmo racional de `desativar-admin.modulo.ts`). Antes o
 * comando subia o `AppModule` inteiro — workers (reconciliação de estoque), criação de coleções e índices e o `.env`
 * do diretório. Aqui só existem os models de autenticação que a redefinição usa, numa conexão própria com
 * `autoIndex`/`autoCreate` desligados; nenhum controller, JWT, worker ou outro módulo.
 */
export const OPCOES_DE_CONEXAO_DO_COMANDO = {
  autoIndex: false,
  autoCreate: false,
  serverSelectionTimeoutMS: 5_000,
  /** Identifica as operações do comando nos logs/profiler do servidor. */
  appName: "mariela-reset-admin-password",
  /** Habilita os eventos de monitoramento de comandos do driver (sem ouvinte, não fazem nada). */
  monitorCommands: true,
} as const;

@Module({})
export class ComandoResetSenhaAdminModule {
  /** `aoConectar` recebe a conexão logo depois de aberta e antes de qualquer model ser compilado (instrumentação). */
  static paraUri(uri: string, aoConectar?: (conexao: Connection) => void): DynamicModule {
    return {
      module: ComandoResetSenhaAdminModule,
      imports: [
        MongooseModule.forRoot(uri, {
          ...OPCOES_DE_CONEXAO_DO_COMANDO,
          connectionFactory: (conexao: Connection) => {
            aoConectar?.(conexao);
            return conexao;
          },
        }),
        MongooseModule.forFeature([
          { name: Usuario.name, schema: UsuarioSchema },
          { name: RefreshToken.name, schema: RefreshTokenSchema },
          { name: EventoAuth.name, schema: EventoAuthSchema },
        ]),
      ],
      providers: [RedefinicaoSenhaAdminService, UsuariosRepository, RefreshTokensRepository],
    };
  }
}
