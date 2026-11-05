import { LIMITES_TRANSPORTE_R2, TRANSPORTE_R2_PADRAO } from "../modules/media/media.constants.js";
import { descreverArgumento, verificarExecucaoLocal, type AmbienteDeExecucao } from "./comando-local.util.js";

/**
 * Fase 60.4.1 — verificação LOCAL e OFFLINE da configuração do R2 (ponto de entrada: `verificar-config-r2.ts`).
 * Só lê as variáveis de ambiente do próprio processo: nenhuma conexão de rede, nenhum MongoDB, nenhum acesso ao
 * bucket — não existe modo de escrita. Nunca imprime valores das variáveis `R2_*` (só presença e o resultado da
 * conferência de formato), exceto os números de transporte, que não são sensíveis.
 *
 * O que ela NÃO consegue verificar (exige a validação real, em bucket de teste, numa fase autorizada): se as
 * credenciais funcionam, se o bucket existe, a leitura pública do domínio e o CORS do bucket.
 */

const ENTRADA_LOCAL_ESPERADA = "src/scripts/verificar-config-r2.ts";

export const CODIGOS_DE_SAIDA = {
  /** Todas as variáveis presentes e com formato válido (avisos não mudam o código). */
  sucesso: 0,
  /** Há variável ausente ou com formato inválido. */
  configuracaoInvalida: 1,
  /** Recusado antes de qualquer verificação (argumentos ou ambiente de execução). */
  recusado: 2,
} as const;

export const USO = [
  "Uso: bun run midias:verificar-r2",
  "     (equivale a: bun run src/scripts/verificar-config-r2.ts) — sem parâmetros; somente leitura e sem rede.",
  `  Códigos de saída: ${CODIGOS_DE_SAIDA.sucesso} configuração válida | ${CODIGOS_DE_SAIDA.configuracaoInvalida} ausente ou inválida | ${CODIGOS_DE_SAIDA.recusado} recusado`,
].join("\n");

type Nivel = "ok" | "aviso" | "erro";
interface Verificacao {
  nivel: Nivel;
  mensagem: string;
}

const NOMES_R2 = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_PUBLIC_BASE_URL"] as const;

/** Regra de nomes de bucket compatível com S3/R2: 3–63 caracteres, minúsculas, dígitos e hífen, começando e terminando em letra/dígito. */
const NOME_DE_BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const HEXADECIMAL = (tamanho: number) => new RegExp(`^[0-9a-f]{${tamanho}}$`);

function verificarR2(variaveis: Readonly<Record<string, string | undefined>>): Verificacao[] {
  const valor = (nome: string) => (variaveis[nome] ?? "").trim();
  const resultado: Verificacao[] = [];
  for (const nome of NOMES_R2) {
    if (!valor(nome)) resultado.push({ nivel: "erro", mensagem: `${nome}: ausente` });
  }

  const conta = valor("R2_ACCOUNT_ID");
  if (conta) {
    resultado.push(
      HEXADECIMAL(32).test(conta)
        ? { nivel: "ok", mensagem: "R2_ACCOUNT_ID: presente (32 caracteres hexadecimais)" }
        : { nivel: "aviso", mensagem: "R2_ACCOUNT_ID: presente, mas fora do formato usual de ID de conta (32 caracteres hexadecimais) — confira" },
    );
  }
  const chave = valor("R2_ACCESS_KEY_ID");
  if (chave) {
    resultado.push(
      HEXADECIMAL(32).test(chave)
        ? { nivel: "ok", mensagem: "R2_ACCESS_KEY_ID: presente (32 caracteres hexadecimais)" }
        : { nivel: "aviso", mensagem: "R2_ACCESS_KEY_ID: presente, mas fora do formato usual (32 caracteres hexadecimais) — confira" },
    );
  }
  const segredo = valor("R2_SECRET_ACCESS_KEY");
  if (segredo) {
    resultado.push(
      HEXADECIMAL(64).test(segredo)
        ? { nivel: "ok", mensagem: "R2_SECRET_ACCESS_KEY: presente (64 caracteres hexadecimais)" }
        : { nivel: "aviso", mensagem: "R2_SECRET_ACCESS_KEY: presente, mas fora do formato usual (64 caracteres hexadecimais) — confira" },
    );
  }
  const bucket = valor("R2_BUCKET_NAME");
  if (bucket) {
    resultado.push(
      NOME_DE_BUCKET.test(bucket)
        ? { nivel: "ok", mensagem: "R2_BUCKET_NAME: presente, nome válido" }
        : { nivel: "erro", mensagem: "R2_BUCKET_NAME: nome inválido (3–63 caracteres: letras minúsculas, dígitos e hífen; começa e termina em letra ou dígito)" },
    );
  }

  const base = valor("R2_PUBLIC_BASE_URL").replace(/\/+$/, "");
  if (base) {
    // Mesma regra do boot (`env.validation.ts`).
    if (!/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/.test(base)) {
      resultado.push({ nivel: "erro", mensagem: "R2_PUBLIC_BASE_URL: formato inválido (use http(s)://domínio, sem query string) — a API não sobe assim" });
    } else {
      resultado.push({ nivel: "ok", mensagem: "R2_PUBLIC_BASE_URL: presente, formato válido" });
      const url = new URL(base);
      if (url.protocol !== "https:") resultado.push({ nivel: "aviso", mensagem: "R2_PUBLIC_BASE_URL: usa http — em produção, use https" });
      if (url.pathname !== "/" && url.pathname !== "") {
        resultado.push({
          nivel: "aviso",
          mensagem: "R2_PUBLIC_BASE_URL: tem caminho — as URLs são base + \"/\" + chave; só funciona se o domínio mapear esse caminho para a raiz do bucket",
        });
      }
    }
  }
  return resultado;
}

function verificarTransporte(variaveis: Readonly<Record<string, string | undefined>>): { verificacoes: Verificacao[]; efetivo: Record<string, number> } {
  const verificacoes: Verificacao[] = [];
  const padroes: Record<keyof typeof LIMITES_TRANSPORTE_R2, number> = {
    R2_CONNECTION_TIMEOUT_MS: TRANSPORTE_R2_PADRAO.timeoutConexaoMs,
    R2_REQUEST_TIMEOUT_MS: TRANSPORTE_R2_PADRAO.timeoutRequisicaoMs,
    R2_MAX_ATTEMPTS: TRANSPORTE_R2_PADRAO.maxTentativas,
  };
  const efetivo: Record<string, number> = {};
  for (const nome of Object.keys(LIMITES_TRANSPORTE_R2) as (keyof typeof LIMITES_TRANSPORTE_R2)[]) {
    const bruto = (variaveis[nome] ?? "").trim();
    const { minimo, maximo } = LIMITES_TRANSPORTE_R2[nome];
    if (bruto === "") {
      efetivo[nome] = padroes[nome];
      verificacoes.push({ nivel: "ok", mensagem: `${nome}: não definida — padrão do projeto ${padroes[nome]}` });
      continue;
    }
    const numero = Number(bruto);
    if (!Number.isInteger(numero) || numero < minimo || numero > maximo) {
      efetivo[nome] = padroes[nome];
      verificacoes.push({ nivel: "erro", mensagem: `${nome}: inválida (inteiro entre ${minimo} e ${maximo}) — a API não sobe assim` });
      continue;
    }
    efetivo[nome] = numero;
    verificacoes.push({ nivel: "ok", mensagem: `${nome}: ${numero}` });
  }
  return { verificacoes, efetivo };
}

export interface DependenciasComando {
  argv: readonly string[];
  variaveis: Readonly<Record<string, string | undefined>>;
  escrever: (linha: string) => void;
  execucao: AmbienteDeExecucao;
}

const ROTULO: Record<Nivel, string> = { ok: "OK", aviso: "AVISO", erro: "ERRO" };

/** Executa a verificação e devolve o código de saída. Sem rede, sem banco, sem escrita. */
export function executarComando(dependencias: DependenciasComando): number {
  const { escrever } = dependencias;
  const local = verificarExecucaoLocal(dependencias.execucao, ENTRADA_LOCAL_ESPERADA);
  if (!local.ok) {
    escrever(`ERRO: ${local.erro}`);
    return CODIGOS_DE_SAIDA.recusado;
  }
  const [primeiro] = dependencias.argv;
  if (primeiro !== undefined) {
    escrever(`ERRO: Parâmetro desconhecido ${descreverArgumento(primeiro)}.`);
    escrever(USO);
    return CODIGOS_DE_SAIDA.recusado;
  }

  escrever("Verificação da configuração do R2 — somente leitura das variáveis deste processo (sem rede, sem banco, sem bucket).");
  const r2 = verificarR2(dependencias.variaveis);
  const transporte = verificarTransporte(dependencias.variaveis);
  for (const item of [...r2, ...transporte.verificacoes]) escrever(`[${ROTULO[item.nivel]}] ${item.mensagem}`);

  const conexao = transporte.efetivo["R2_CONNECTION_TIMEOUT_MS"] ?? TRANSPORTE_R2_PADRAO.timeoutConexaoMs;
  const resposta = transporte.efetivo["R2_REQUEST_TIMEOUT_MS"] ?? TRANSPORTE_R2_PADRAO.timeoutRequisicaoMs;
  const tentativas = transporte.efetivo["R2_MAX_ATTEMPTS"] ?? TRANSPORTE_R2_PADRAO.maxTentativas;
  escrever(`Prazo por tentativa: ${conexao + resposta} ms; tentativas: ${tentativas} (só falhas transitórias são repetidas).`);
  escrever("Endpoint S3 derivado: https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com (região \"auto\"; valor da conta não exibido).");
  escrever("NÃO verificado por este comando: credenciais válidas, existência do bucket, leitura pública do domínio e CORS do bucket");
  escrever("  (origens do Backoffice/Tauri, método PUT, cabeçalhos content-type e cache-control) — exigem a validação real em bucket de teste.");

  const erros = [...r2, ...transporte.verificacoes].filter((item) => item.nivel === "erro").length;
  escrever(erros > 0 ? `Resultado: ${erros} problema(s) de configuração — o upload de mídia não funcionaria assim.` : "Resultado: configuração local completa e com formato válido.");
  return erros > 0 ? CODIGOS_DE_SAIDA.configuracaoInvalida : CODIGOS_DE_SAIDA.sucesso;
}
