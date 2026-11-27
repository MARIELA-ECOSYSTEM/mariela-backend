import "reflect-metadata";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { executarComando } from "./criar-admin.comando.js";
import { criarTerminalDoProcesso } from "./criar-admin.terminal.js";
import { abrirContextoDoComando } from "./seed-admin.comando.js";

/**
 * Cria um ADMIN do Backoffice de forma interativa: `bun run admin:criar`. Operação exclusiva do desenvolvedor, só na
 * máquina local (a imagem de produção não contém `src/`); não existe rota HTTP nem tela para isto. Pergunta e-mail,
 * nome e senha (sem eco), mostra o banco de destino (nunca a URI) e só grava depois da confirmação final. Ver
 * `criar-admin.comando.ts`.
 */
const ARQUIVO_ENV_DO_BACKEND = fileURLToPath(new URL("../../.env", import.meta.url));

async function bootstrap(): Promise<void> {
  // Ctrl+C fora de uma pergunta (ex.: durante a consulta ao banco): nas perguntas o terminal está em modo raw e o
  // Ctrl+C chega como tecla (cancela). Aqui ele não interrompe uma escrita em andamento — o comando termina sozinho.
  process.on("SIGINT", () => {
    process.stdout.write("\nAguarde: a operação em andamento termina e o comando informa o resultado.\n");
  });
  const codigo = await executarComando({
    terminal: criarTerminalDoProcesso(),
    escrever: (linha) => console.log(linha),
    variaveis: process.env,
    lerArquivoEnv: () => (existsSync(ARQUIVO_ENV_DO_BACKEND) ? readFileSync(ARQUIVO_ENV_DO_BACKEND, "utf8") : null),
    abrirContexto: abrirContextoDoComando,
    execucao: { arquivoDeEntrada: fileURLToPath(import.meta.url), variaveis: process.env, existeArquivo: existsSync },
  });
  process.exit(codigo);
}

void bootstrap();
