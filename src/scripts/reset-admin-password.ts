import "reflect-metadata";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { abrirContextoDoComando, executarComando } from "./reset-admin-password.comando.js";

/**
 * Redefine a senha de um ADMIN existente. NÃO existe rota HTTP para isto de propósito (§19) — só este script,
 * executado localmente pelo operador (a imagem de produção não contém `src/`).
 *
 *   ADMIN_EMAIL=admin@mariela.com bun run admin:reset-password --banco mariela_test                         (dry-run)
 *   ADMIN_EMAIL=admin@mariela.com ADMIN_PASSWORD="..." ADMIN_RESET_CONFIRM=admin@mariela.com \
 *     bun run admin:reset-password --banco mariela_test --apply                                            (redefine)
 *
 * Não lê o `.env` (`bun --no-env-file`), roda num contexto mínimo (`reset-admin-password.modulo.ts`, sem `AppModule`)
 * e com as guardas dos comandos administrativos (`--banco`, dry-run por padrão, `--confirmar-producao` em banco
 * protegido). Altera só `senhaHash`, revoga todas as sessões e grava `ADMIN_PASSWORD_RESET`. Nunca imprime a senha.
 * Ver `reset-admin-password.comando.ts`.
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
