/**
 * Fase 60.2 — proteções de ambiente compartilhadas pelos comandos administrativos locais (extraídas, sem mudança
 * de comportamento, de `processar-remocoes-pendentes.comando.ts` — Fases 56.4.3/56.4.3.1). Funções puras: nenhuma
 * abre conexão, e nenhuma devolve host, usuário ou senha da URI.
 */

/** Banco de desenvolvimento local do operador — sempre recusado pelos comandos. */
export const BANCO_RECUSADO = "mariela_dev_local";

/**
 * Únicos bancos tratados como TESTE, e só quando a URI aponta para um host local. Qualquer outro banco — produção
 * (`marielaDB`) ou desconhecido — é tratado como PROTEGIDO: falha segura.
 */
const BANCOS_DE_TESTE = new Set(["mariela_test"]);
const HOSTS_LOCAIS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Caracteres aceitos pelo MongoDB num nome de banco, sem `/\. "$*<>:|?` (limite de 63 para caber nos 64 bytes). */
export const NOME_DE_BANCO_VALIDO = /^[A-Za-z0-9_-]{1,63}$/;

export type Resultado<T> = { ok: true; valor: T } | { ok: false; erro: string };

/** Onde e como o comando está sendo executado (o ponto de entrada informa os valores reais; os testes informam cenários). */
export interface AmbienteDeExecucao {
  /** Caminho absoluto do arquivo de entrada efetivamente executado. */
  arquivoDeEntrada: string;
  variaveis: Readonly<Record<string, string | undefined>>;
  existeArquivo: (caminho: string) => boolean;
}

/**
 * Recusa execução fora da máquina do operador, ANTES de qualquer conexão. Garantia principal (estrutural): o
 * comando só roda a partir do código-fonte (`entradaEsperada`, ex.: `src/scripts/x.ts`); a imagem de produção
 * contém apenas `dist/`, então dentro dela só existe o `.js` compilado — recusado. Sinais adicionais de ambiente
 * implantado, cada um suficiente para recusar (nenhum deles AUTORIZA nada): `NODE_ENV=production`, variáveis da
 * plataforma Render (`RENDER`, `RENDER_*`) e `/.dockerenv`.
 */
export function verificarExecucaoLocal(ambiente: AmbienteDeExecucao, entradaEsperada: string): Resultado<null> {
  const caminho = ambiente.arquivoDeEntrada.replaceAll("\\", "/");
  if (!caminho.endsWith(`/${entradaEsperada}`)) {
    return {
      ok: false,
      erro:
        `Este comando só pode ser executado a partir do código-fonte (${entradaEsperada}) na máquina do operador; ` +
        "a execução do artefato compilado (dist/) é recusada.",
    };
  }
  const sinais: string[] = [];
  if (ambiente.variaveis["NODE_ENV"] === "production") sinais.push("NODE_ENV=production");
  const variaveisRender = Object.keys(ambiente.variaveis).filter((nome) => nome === "RENDER" || nome.startsWith("RENDER_"));
  if (variaveisRender.length > 0) sinais.push(`variáveis da plataforma Render (${variaveisRender.sort().join(", ")})`);
  if (ambiente.existeArquivo("/.dockerenv")) sinais.push("/.dockerenv (container Docker)");
  if (sinais.length > 0) {
    return { ok: false, erro: `Execução em ambiente implantado recusada — sinais detectados: ${sinais.join("; ")}. Execute na máquina do operador.` };
  }
  return { ok: true, valor: null };
}

/** Nunca ecoa valores livres (um operador pode colar a URI por engano): só nomes de parâmetro com formato de parâmetro. */
export function descreverArgumento(argumento: string): string {
  return /^--[a-z][a-z-]*$/.test(argumento) ? `"${argumento}"` : "(valor não exibido)";
}

export interface AnaliseUri {
  banco: string;
  /** Todos os hosts são locais e o esquema é `mongodb://` (nunca `+srv`, que é sempre remoto). */
  local: boolean;
}

/** Extrai o banco do path da URI e se ela é local — sem nunca devolver host, usuário ou senha. */
export function analisarUri(uri: string): AnaliseUri | null {
  const correspondencia = /^(mongodb(?:\+srv)?):\/\/([^/]+)\/([^/?]+)/.exec(uri.trim());
  const [, esquema, autoridade, bancoCodificado] = correspondencia ?? [];
  if (!esquema || !autoridade || !bancoCodificado) return null;
  let banco: string;
  try {
    banco = decodeURIComponent(bancoCodificado);
  } catch {
    return null;
  }
  const hosts = autoridade
    .slice(autoridade.lastIndexOf("@") + 1)
    .split(",")
    .map((host) => (host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : (host.split(":")[0] ?? "")).toLowerCase());
  const local = esquema === "mongodb" && hosts.length > 0 && hosts.every((host) => HOSTS_LOCAIS.has(host));
  return { banco, local };
}

export type Ambiente = "teste" | "protegido";

export function classificarAmbiente(analise: AnaliseUri): Ambiente {
  return BANCOS_DE_TESTE.has(analise.banco) && analise.local ? "teste" : "protegido";
}

/**
 * Fase 60.4.3.2.1 — argumentos e autorização dos comandos administrativos de ESCRITA (`admin:desativar`,
 * `seed:admin`), extraídos sem mudança de `desativar-admin.comando.ts` (mesma regra de
 * `processar-remocoes-pendentes`): `--banco <nome>` obrigatório e igual ao banco da URI; sem `--apply`, dry-run;
 * em banco protegido, `--apply` só com `--confirmar-producao <nome-exato>`.
 */
export interface OpcoesDeEscrita {
  banco: string;
  aplicar: boolean;
  confirmacaoProducao: string | null;
}

const PARAMETROS_DE_ESCRITA = new Set(["--banco", "--apply", "--confirmar-producao"]);

export function interpretarArgumentosDeEscrita(argv: readonly string[]): Resultado<OpcoesDeEscrita> {
  let banco: string | null = null;
  let aplicar = false;
  let confirmacaoProducao: string | null = null;
  const vistos = new Set<string>();
  for (let indice = 0; indice < argv.length; indice += 1) {
    const argumento = argv[indice] ?? "";
    if (!PARAMETROS_DE_ESCRITA.has(argumento)) return { ok: false, erro: `Parâmetro desconhecido ${descreverArgumento(argumento)}.` };
    if (vistos.has(argumento)) return { ok: false, erro: `Parâmetro repetido "${argumento}".` };
    vistos.add(argumento);
    if (argumento === "--apply") {
      aplicar = true;
      continue;
    }
    const valor = argv[indice + 1];
    if (valor === undefined || valor.startsWith("--") || valor.trim() === "") return { ok: false, erro: `O parâmetro "${argumento}" exige um valor.` };
    indice += 1;
    if (argumento === "--banco") banco = valor;
    else confirmacaoProducao = valor;
  }
  if (banco === null) return { ok: false, erro: 'O parâmetro "--banco <nome-do-banco>" é obrigatório.' };
  if (!NOME_DE_BANCO_VALIDO.test(banco)) return { ok: false, erro: "Nome de banco inválido em --banco (use só letras, números, _ ou -)." };
  if (confirmacaoProducao !== null && !aplicar) return { ok: false, erro: '"--confirmar-producao" só pode ser usado junto com "--apply".' };
  return { ok: true, valor: { banco, aplicar, confirmacaoProducao } };
}

export interface ExecucaoAutorizada {
  banco: string;
  uri: string;
  ambiente: Ambiente;
  modo: "dry-run" | "apply";
}

/** Valida banco e autorização ANTES de qualquer conexão. Nunca devolve nem ecoa a URI. */
export function validarAmbienteDeEscrita(opcoes: OpcoesDeEscrita, uri: string | undefined): Resultado<ExecucaoAutorizada> {
  if (opcoes.banco === BANCO_RECUSADO) return { ok: false, erro: `O banco "${BANCO_RECUSADO}" é recusado por este comando.` };
  if (!uri || uri.trim() === "") return { ok: false, erro: "MONGODB_URI não está definida no ambiente." };
  const analise = analisarUri(uri);
  if (!analise) return { ok: false, erro: "MONGODB_URI não tem um nome de banco reconhecível no path (a URI não é exibida)." };
  if (analise.banco === BANCO_RECUSADO) return { ok: false, erro: `A MONGODB_URI configurada aponta para "${BANCO_RECUSADO}", recusado por este comando.` };
  if (analise.banco !== opcoes.banco) {
    return { ok: false, erro: `O banco informado em --banco ("${opcoes.banco}") é diferente do banco da MONGODB_URI configurada ("${analise.banco}").` };
  }
  const ambiente = classificarAmbiente(analise);
  if (opcoes.confirmacaoProducao !== null) {
    if (ambiente === "teste") return { ok: false, erro: '"--confirmar-producao" não se aplica a um banco de teste local.' };
    if (opcoes.confirmacaoProducao !== opcoes.banco) return { ok: false, erro: '"--confirmar-producao" não corresponde EXATAMENTE ao banco selecionado.' };
  }
  if (opcoes.aplicar && ambiente === "protegido" && opcoes.confirmacaoProducao !== opcoes.banco) {
    return {
      ok: false,
      erro: `Escrita em banco protegido ("${opcoes.banco}") exige "--apply" E "--confirmar-producao ${opcoes.banco}". "--apply" sozinho não autoriza.`,
    };
  }
  return { ok: true, valor: { banco: opcoes.banco, uri, ambiente, modo: opcoes.aplicar ? "apply" : "dry-run" } };
}

/** Remove a URI (e usuário/senha embutidos) de qualquer texto antes de exibi-lo. */
export function ocultarSegredos(texto: string, uri: string): string {
  let resultado = texto;
  const credenciais = /^mongodb(?:\+srv)?:\/\/([^@/]+)@/.exec(uri.trim())?.[1];
  if (uri.trim()) resultado = resultado.split(uri.trim()).join("<uri oculta>");
  if (credenciais) {
    resultado = resultado.split(credenciais).join("<credenciais ocultas>");
    for (const parte of credenciais.split(":")) if (parte.length >= 3) resultado = resultado.split(parte).join("<oculto>");
  }
  return resultado.replace(/mongodb(?:\+srv)?:\/\/\S+/g, "<uri oculta>");
}
