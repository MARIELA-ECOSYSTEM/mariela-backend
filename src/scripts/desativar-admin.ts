import "reflect-metadata";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { abrirContextoDoComando, executarComando } from "./desativar-admin.comando.js";

/**
 * Fase 60.4.3.1.5 — desativação administrativa de um ADMIN: `ativo=false`, revogação de todas as sessões e evento de
 * auditoria `ADMIN_DEACTIVATED`. NÃO existe rota HTTP para isto de propósito (mesmo racional de `seed-admin.ts`) —
 * só este script, executado localmente pelo operador; a imagem de produção não contém `src/`.
 *
 *   ADMIN_EMAIL=x@y bun run admin:desativar --banco mariela_test                                   (dry-run)
 *   ADMIN_EMAIL=x@y ADMIN_DEACTIVATE_CONFIRM=x@y ADMIN_DEACTIVATE_REASON="..." \
 *     bun run admin:desativar --banco mariela_test --apply                                          (aplica)
 *
 * Em banco protegido (produção ou não reconhecido como teste local), `--apply` só vale com
 * `--confirmar-producao <nome-exato>`. Nunca imprime a URI, credenciais, senha ou token.
 * Ver `desativar-admin.comando.ts`.
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
