import { Module, type DynamicModule } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import type { Connection } from "mongoose";
import { DesativacaoAdminService } from "../modules/auth/desativacao-admin.service.js";
import { RefreshTokensRepository } from "../modules/auth/refresh-tokens.repository.js";
import { EventoAuth, EventoAuthSchema } from "../modules/auth/schemas/evento-auth.schema.js";
import { RefreshToken, RefreshTokenSchema } from "../modules/auth/schemas/refresh-token.schema.js";
import { Usuario, UsuarioSchema } from "../modules/auth/schemas/usuario.schema.js";
import { UsuariosRepository } from "../modules/auth/usuarios.repository.js";

/**
 * Fase 60.4.3.1.5 — contexto Nest EXCLUSIVO do comando `admin:desativar` (mesmo racional de
 * `processar-remocoes-pendentes.modulo.ts`): não usa o `AppModule`, cuja inicialização cria e sincroniza índices
 * (`autoIndex`/`autoCreate` e os `syncIndexes()` de caixas) antes de qualquer decisão do operador. Monta só os
 * models e repositórios de autenticação, numa conexão própria com `autoIndex`/`autoCreate` desligados. Nenhum
 * controller, nenhum JWT, nenhum outro módulo.
 */
export const OPCOES_DE_CONEXAO_DO_COMANDO = {
  autoIndex: false,
  autoCreate: false,
  serverSelectionTimeoutMS: 5_000,
  /** Identifica as operações do comando nos logs/profiler do servidor. */
  appName: "mariela-desativar-admin",
  /** Habilita os eventos de monitoramento de comandos do driver (sem ouvinte, não fazem nada). */
  monitorCommands: true,
} as const;

@Module({})
export class ComandoDesativarAdminModule {
  /** `aoConectar` recebe a conexão logo depois de aberta e antes de qualquer model ser compilado (instrumentação). */
  static paraUri(uri: string, aoConectar?: (conexao: Connection) => void): DynamicModule {
    return {
      module: ComandoDesativarAdminModule,
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
      providers: [DesativacaoAdminService, UsuariosRepository, RefreshTokensRepository],
    };
  }
}
