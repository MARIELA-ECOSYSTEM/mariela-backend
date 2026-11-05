import "reflect-metadata";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { abrirContextoDoComando, executarComando } from "./migrar-midias-legadas.comando.js";

/**
 * Fase 60.2 — migra os campos legados (`variante.foto`, `variante.video`, `fotoPrincipalVarianteId`) para a galeria
 * (`midias[]`, `midiaPrincipalId`). Dry-run por padrão; `--apply` grava. NÃO existe rota HTTP para isto — só este
 * script, executado localmente pelo operador; a imagem Docker de produção não contém `src/`.
 *
 *   bun run midias:migrar-legado --banco mariela_test             (dry-run)
 *   bun run midias:migrar-legado --banco mariela_test --apply     (aplica — nesta fase, só em banco de teste local)
 *
 * `--banco` é obrigatório e precisa ser EXATAMENTE o banco da MONGODB_URI. `R2_PUBLIC_BASE_URL` (opcional) só serve
 * para reconhecer chaves de URLs do domínio de mídia — o R2 nunca é acessado. Nunca imprime a URI nem credenciais.
 * Ver `migrar-midias-legadas.comando.ts` e `migrar-midias-legadas.plano.ts`.
 */
async function bootstrap(): Promise<void> {
  process.exitCode = await executarComando({
    argv: process.argv.slice(2),
    uri: process.env["MONGODB_URI"],
    baseUrlPublica: process.env["R2_PUBLIC_BASE_URL"],
    escrever: (linha) => console.log(linha),
    abrirContexto: abrirContextoDoComando,
    execucao: { arquivoDeEntrada: fileURLToPath(import.meta.url), variaveis: process.env, existeArquivo: existsSync },
  });
}

void bootstrap();
