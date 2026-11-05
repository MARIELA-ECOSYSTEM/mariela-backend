import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { executarComando } from "./verificar-config-r2.comando.js";

/**
 * Fase 60.4.1 — confere, sem rede, se as variáveis do R2 deste processo estão presentes e com formato válido.
 *
 *   bun run midias:verificar-r2
 *
 * Somente leitura: não conecta ao R2, ao MongoDB nem a lugar nenhum, e nunca imprime valores das variáveis `R2_*`.
 * Recusa rodar fora da máquina do operador (artefato compilado, `NODE_ENV=production`, Render, Docker).
 * Ver `verificar-config-r2.comando.ts`.
 */
process.exitCode = executarComando({
  argv: process.argv.slice(2),
  variaveis: process.env,
  escrever: (linha) => console.log(linha),
  execucao: { arquivoDeEntrada: fileURLToPath(import.meta.url), variaveis: process.env, existeArquivo: existsSync },
});
