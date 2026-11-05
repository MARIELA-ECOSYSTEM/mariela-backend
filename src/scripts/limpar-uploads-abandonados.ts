import "reflect-metadata";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { abrirContextoDoComando, executarComando, lerConfigR2 } from "./limpar-uploads-abandonados.comando.js";

/**
 * Fase 60.3 — limpa uploads abandonados: registros `pendente` de `uploads_midia` com `limpezaApos` vencido, cujo
 * arquivo não é referenciado por nenhum produto nem venda. Dry-run por padrão; `--apply` exclui o objeto no R2 e
 * marca o registro como `descartado` (registros nunca são apagados). NÃO existe rota HTTP nem agendamento — só este
 * script, executado localmente pelo operador; a imagem Docker de produção não contém `src/`.
 *
 *   bun run midias:limpar-abandonadas --banco mariela_test             (dry-run)
 *   bun run midias:limpar-abandonadas --banco mariela_test --apply     (nesta fase, só em banco de teste local)
 *
 * Ver `limpar-uploads-abandonados.comando.ts`. Nunca imprime a URI nem credenciais.
 */
async function bootstrap(): Promise<void> {
  process.exitCode = await executarComando({
    argv: process.argv.slice(2),
    uri: process.env["MONGODB_URI"],
    r2: lerConfigR2(process.env),
    escrever: (linha) => console.log(linha),
    abrirContexto: abrirContextoDoComando,
    execucao: { arquivoDeEntrada: fileURLToPath(import.meta.url), variaveis: process.env, existeArquivo: existsSync },
  });
}

void bootstrap();
