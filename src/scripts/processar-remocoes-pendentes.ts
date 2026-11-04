import "reflect-metadata";
import { abrirContextoDaAplicacao, executarComando } from "./processar-remocoes-pendentes.comando.js";

/**
 * Fase 56.4.3 — consulta (padrão, somente leitura) ou processa (`--apply`)
 * as remoções de itens de configuração que ficaram pendentes
 * (`configuracoes.remocoesPendentes`). NÃO existe rota HTTP para isto de
 * propósito — só este script, executado localmente pelo operador (mesmo
 * racional de `seed-admin.ts`). A imagem Docker de produção não contém
 * `src/`: este comando nunca roda dentro do Render.
 *
 *   bun run src/scripts/processar-remocoes-pendentes.ts --banco mariela_test             (dry-run)
 *   bun run src/scripts/processar-remocoes-pendentes.ts --banco mariela_test --apply     (aplica)
 *
 * `--banco` é obrigatório e precisa ser EXATAMENTE o banco da MONGODB_URI do
 * ambiente; `mariela_dev_local` é recusado. Em banco protegido (produção ou
 * não reconhecido como teste local), `--apply` só vale junto com
 * `--confirmar-producao <nome-exato>`. Nunca imprime a URI nem credenciais.
 * Ver `processar-remocoes-pendentes.comando.ts`.
 */
async function bootstrap(): Promise<void> {
  process.exitCode = await executarComando({
    argv: process.argv.slice(2),
    uri: process.env["MONGODB_URI"],
    escrever: (linha) => console.log(linha),
    abrirContexto: abrirContextoDaAplicacao,
  });
}

void bootstrap();
