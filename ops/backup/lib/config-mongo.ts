import { readFileSync } from "node:fs";

/**
 * Fase 60.4.3.4.21.2 — lê o arquivo de configuração do `mongodump --config` (YAML com a chave `uri:`), o MESMO arquivo
 * que o `mongodump` usa — uma única fonte do segredo. A URI nunca é impressa, logada nem devolvida em mensagens de erro.
 */

export class ConfigMongoErro extends Error {
  constructor(
    readonly codigo: "CONFIG_ILEGIVEL" | "URI_AUSENTE" | "URI_INVALIDA" | "BANCO_AUSENTE" | "BANCO_DIVERGENTE",
    mensagem: string,
  ) {
    super(mensagem);
    this.name = "ConfigMongoErro";
  }
}

/** Extrai a URI de um YAML simples do mongodump (`uri: valor`, com ou sem aspas). Não aceita outras chaves com segredo. */
export function extrairUriDoYaml(conteudo: string): string {
  for (const linha of conteudo.split(/\r?\n/)) {
    const m = /^\s*uri\s*:\s*(.+?)\s*$/.exec(linha);
    if (!m) continue;
    let valor = m[1]!;
    if ((valor.startsWith('"') && valor.endsWith('"')) || (valor.startsWith("'") && valor.endsWith("'"))) valor = valor.slice(1, -1);
    if (!valor) break;
    return valor;
  }
  throw new ConfigMongoErro("URI_AUSENTE", "o arquivo de configuração não tem a chave 'uri'");
}

/** Banco definido no caminho da URI (`mongodb[+srv]://hosts/<banco>?...`). */
export function bancoDaUri(uri: string): string {
  const m = /^mongodb(?:\+srv)?:\/\/[^/]+\/([^/?]*)/.exec(uri);
  if (!/^mongodb(?:\+srv)?:\/\//.test(uri)) throw new ConfigMongoErro("URI_INVALIDA", "a URI não é mongodb:// nem mongodb+srv://");
  const banco = m ? decodeURIComponent(m[1] ?? "") : "";
  if (!banco) throw new ConfigMongoErro("BANCO_AUSENTE", "a URI não define o banco no caminho");
  return banco;
}

/** Lê o config, exige que o banco da URI seja EXATAMENTE `esperado` e devolve a URI (só para uso interno do driver). */
export function lerConfigMongo(caminho: string, esperado: string): { uri: string; banco: string } {
  let conteudo: string;
  try {
    conteudo = readFileSync(caminho, "utf8");
  } catch {
    throw new ConfigMongoErro("CONFIG_ILEGIVEL", "não foi possível ler o arquivo de configuração");
  }
  const uri = extrairUriDoYaml(conteudo);
  const banco = bancoDaUri(uri);
  if (banco !== esperado) throw new ConfigMongoErro("BANCO_DIVERGENTE", `o banco da configuração não é '${esperado}'`);
  return { uri, banco };
}

/** Remove qualquer URI/host de uma mensagem de erro antes de ela ir para log ou saída. */
export function sanitizarMensagem(texto: string): string {
  return texto
    .replace(/mongodb(\+srv)?:\/\/\S+/gi, "[uri-removida]")
    .replace(/\b[a-z0-9-]+(\.[a-z0-9-]+)+\.(mongodb\.net|com|net|org|br|io)(:\d+)?\b/gi, "[host-removido]")
    .replace(/\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g, "[ip-removido]")
    .slice(0, 200);
}
