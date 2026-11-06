import { Module, type DynamicModule } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import type { Connection } from "mongoose";
import { ProvisionamentoAdminService } from "../modules/auth/provisionamento-admin.service.js";
import { Usuario, UsuarioSchema } from "../modules/auth/schemas/usuario.schema.js";
import { UsuariosRepository } from "../modules/auth/usuarios.repository.js";
import { Sequencia, SequenciaSchema } from "../modules/sequencias/schemas/sequencia.schema.js";
import { SequenciasRepository } from "../modules/sequencias/sequencias.repository.js";
import { SequenciasService } from "../modules/sequencias/sequencias.service.js";

/**
 * Fase 60.4.3.2.1 — contexto Nest EXCLUSIVO do comando `seed:admin` (mesmo racional de `desativar-admin.modulo.ts`).
 * Antes o seed subia o `AppModule` inteiro, o que no banco de destino criava coleções e índices de TODOS os models
 * (`autoCreate`/`autoIndex`, padrão do Mongoose) e rodava os `syncIndexes()` de caixas e movimentos. Aqui só existem
 * os dois models que a criação usa (`usuarios` e `sequencias`), numa conexão própria com `autoIndex`/`autoCreate`
 * desligados; nenhum controller, JWT, configuração da aplicação ou hook de outro módulo.
 */
export const OPCOES_DE_CONEXAO_DO_COMANDO = {
  autoIndex: false,
  autoCreate: false,
  serverSelectionTimeoutMS: 5_000,
  /** Identifica as operações do comando nos logs/profiler do servidor. */
  appName: "mariela-seed-admin",
  /** Habilita os eventos de monitoramento de comandos do driver (sem ouvinte, não fazem nada). */
  monitorCommands: true,
} as const;

@Module({})
export class ComandoSeedAdminModule {
  /** `aoConectar` recebe a conexão logo depois de aberta e antes de qualquer model ser compilado (instrumentação). */
  static paraUri(uri: string, aoConectar?: (conexao: Connection) => void): DynamicModule {
    return {
      module: ComandoSeedAdminModule,
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
          { name: Sequencia.name, schema: SequenciaSchema },
        ]),
      ],
      providers: [ProvisionamentoAdminService, UsuariosRepository, SequenciasService, SequenciasRepository],
    };
  }
}
