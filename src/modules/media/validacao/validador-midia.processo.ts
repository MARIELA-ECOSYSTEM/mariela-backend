/**
 * Fase 60.4.3.4.1 — ponto de entrada do SUBPROCESSO de validação de mídia. NUNCA importe este arquivo: ele lê o
 * stdin e encerra o processo. Quem o executa é `ValidadorMidiaService` (`bun --no-env-file <este arquivo> <mime>`).
 *
 * Protocolo: argv[2] = MIME declarado; stdin = bytes do arquivo; stdout = UMA linha JSON com o `ResultadoValidacao`;
 * código de saída 0. Qualquer falha inesperada termina com código ≠ 0 e sem resultado — o pai responde 503.
 * O processo recebe só um ambiente mínimo (sem segredos) e não acessa rede, banco nem disco.
 */
import { BYTES_MAXIMOS_VALIDACAO } from "./validacao-midia.constants.js";
import { validarConteudoDeMidia } from "./validar-midia.js";

const contentType = process.argv[2] ?? "";
const entrada = new Uint8Array(await Bun.stdin.arrayBuffer());
if (entrada.length > BYTES_MAXIMOS_VALIDACAO) {
  process.stderr.write("entrada acima do teto de validação\n");
  process.exit(2);
}
const resultado = await validarConteudoDeMidia(contentType, entrada);
process.stdout.write(`${JSON.stringify(resultado)}\n`);
process.exit(0);
