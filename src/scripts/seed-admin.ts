import "reflect-metadata";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { abrirContextoDoComando, executarComando } from "./seed-admin.comando.js";

/**
 * Cria um administrador do Backoffice. NÃO existe rota HTTP pública para isto de propósito (§19) — só este script,
 * executado localmente pelo operador (a imagem de produção não contém `src/`).
 *
 *   ADMIN_EMAIL=admin@mariela.com ADMIN_NAME="Administradora" bun run seed:admin --banco mariela_test          (dry-run)
 *   ADMIN_EMAIL=admin@mariela.com ADMIN_NAME="Administradora" ADMIN_PASSWORD="..." ADMIN_SEED_CONFIRM=admin@mariela.com \
 *     bun run seed:admin --banco mariela_test --apply                                                          (cria)
 *
 * Idempotente: com o e-mail já existente não altera nada (código de saída 1). Fase 60.4.3.2.1 — roda num contexto
 * mínimo (`seed-admin.modulo.ts`, sem `AppModule`, sem criar coleções nem índices) e com as guardas dos comandos
 * administrativos (`--banco`, dry-run por padrão, `--confirmar-producao` em banco protegido). Nunca imprime a senha.
 * Ver `seed-admin.comando.ts`.
 */
async function bootstrap(): Promise<void> {
  process.exitCode = await executarComando({
    argv: process.argv.slice(2),
    variaveis: process.env,
    escrever: (linha) => console.log(linha),
    abrirContexto: abrirContextoDoComando,
    execucao: { arquivoDeEntrada: fileURLToPath(import.meta.url), variaveis: process.env, existeArquivo: existsSync },
  });
}

void bootstrap();
