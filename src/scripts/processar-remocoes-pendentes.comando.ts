import { NestFactory } from "@nestjs/core";
import { getConnectionToken } from "@nestjs/mongoose";
import type { Connection } from "mongoose";
import { ComandoRemocoesPendentesModule } from "./processar-remocoes-pendentes.modulo.js";
import {
  ConfiguracoesService,
  type AvaliacaoRemocaoPendente,
  type DesfechoRemocaoPendente,
  type ResultadoProcessamentoRemocoes,
} from "../modules/configuracoes/configuracoes.service.js";

/**
 * Fase 56.4.3 — lógica do comando operacional `processar-remocoes-pendentes`
 * (o ponto de entrada é `processar-remocoes-pendentes.ts`). Separada do
 * ponto de entrada para que TODA a validação de argumentos e de ambiente
 * seja testável sem abrir conexão nenhuma.
 *
 * Ordem garantida: argumentos → banco da URI → ambiente/autorização → só
 * então a conexão. Qualquer recusa acontece antes de conectar; nada é lido
 * nem escrito. A regra de recuperação NÃO é reimplementada aqui: o dry-run
 * usa `ConfiguracoesService.avaliarRemocoesPendentes` (somente leitura) e o
 * `--apply` usa `ConfiguracoesService.processarRemocoesPendentes`.
 */

/** Banco de desenvolvimento local do operador — sempre recusado por este comando. */
export const BANCO_RECUSADO = "mariela_dev_local";

/**
 * Únicos bancos tratados como TESTE (escrita sem confirmação extra), e só
 * quando a URI aponta para um host local. Qualquer outro banco — produção
 * (`marielaDB`) ou desconhecido — é tratado como PROTEGIDO: falha segura.
 */
const BANCOS_DE_TESTE = new Set(["mariela_test"]);
const HOSTS_LOCAIS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Caracteres aceitos pelo MongoDB num nome de banco, sem `/\. "$*<>:|?` (limite de 63 para caber nos 64 bytes). */
const NOME_DE_BANCO_VALIDO = /^[A-Za-z0-9_-]{1,63}$/;

export const CODIGOS_DE_SAIDA = {
  /** Execução concluída; nenhuma pendência exige intervenção. */
  sucesso: 0,
  /** Execução concluída, mas há pendências indeterminadas, mantidas ou malformadas (ver a lista de `opId`). */
  intervencaoNecessaria: 1,
  /** Recusado ANTES de qualquer conexão (argumentos ou ambiente inválidos). */
  recusado: 2,
  /** Falha durante a execução (conexão, banco divergente, erro inesperado). */
  falha: 3,
} as const;

export const USO = [
  "Uso: bun run src/scripts/processar-remocoes-pendentes.ts --banco <nome-do-banco> [--apply [--confirmar-producao <nome-do-banco>]]",
  "  --banco <nome>               obrigatório; precisa ser EXATAMENTE o banco da MONGODB_URI configurada",
  "  --apply                      processa as pendências (sem ele: dry-run, somente leitura)",
  "  --confirmar-producao <nome>  obrigatório junto com --apply em banco protegido (produção ou desconhecido); repita o nome exato",
  `  Códigos de saída: ${CODIGOS_DE_SAIDA.sucesso} sucesso | ${CODIGOS_DE_SAIDA.intervencaoNecessaria} há pendências que exigem intervenção | ` +
    `${CODIGOS_DE_SAIDA.recusado} recusado antes de conectar | ${CODIGOS_DE_SAIDA.falha} falha na execução`,
].join("\n");

export interface OpcoesComando {
  banco: string;
  aplicar: boolean;
  confirmacaoProducao: string | null;
}

type Resultado<T> = { ok: true; valor: T } | { ok: false; erro: string };

/**
 * Fase 56.4.3.1 — onde e como o comando está sendo executado (o ponto de
 * entrada informa os valores reais; os testes informam cenários).
 */
export interface AmbienteDeExecucao {
  /** Caminho absoluto do arquivo de entrada efetivamente executado. */
  arquivoDeEntrada: string;
  variaveis: Readonly<Record<string, string | undefined>>;
  existeArquivo: (caminho: string) => boolean;
}

/** Sufixo do ÚNICO ponto de entrada aceito: o código-fonte TypeScript, nunca o artefato compilado. */
const ENTRADA_LOCAL_ESPERADA = "/src/scripts/processar-remocoes-pendentes.ts";

/**
 * Fase 56.4.3.1 — recusa execução fora da máquina do operador, ANTES de
 * qualquer conexão. Garantia principal (estrutural): o comando só roda a
 * partir do código-fonte (`src/scripts/*.ts`); a imagem de produção contém
 * apenas `dist/` (Dockerfile: `COPY --from=build /app/dist ./dist`), então
 * dentro dela só existe o `.js` compilado — recusado. Sinais adicionais de
 * ambiente implantado, cada um suficiente para recusar (nenhum deles
 * AUTORIZA nada): `NODE_ENV=production` (definido pelo próprio Dockerfile),
 * variáveis da plataforma Render (`RENDER`, `RENDER_*`) e `/.dockerenv`.
 * `--apply`/`--confirmar-producao` nunca contornam esta verificação.
 */
export function verificarExecucaoLocal(ambiente: AmbienteDeExecucao): Resultado<null> {
  const caminho = ambiente.arquivoDeEntrada.replaceAll("\\", "/");
  if (!caminho.endsWith(ENTRADA_LOCAL_ESPERADA)) {
    return {
      ok: false,
      erro:
        "Este comando só pode ser executado a partir do código-fonte (src/scripts/processar-remocoes-pendentes.ts) na máquina do operador; " +
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

const PARAMETROS_CONHECIDOS = new Set(["--banco", "--apply", "--confirmar-producao"]);

/** Nunca ecoa valores livres (um operador pode colar a URI por engano): só nomes de parâmetro com formato de parâmetro. */
function descreverArgumento(argumento: string): string {
  return /^--[a-z][a-z-]*$/.test(argumento) ? `"${argumento}"` : "(valor não exibido)";
}

export function interpretarArgumentos(argv: readonly string[]): Resultado<OpcoesComando> {
  let banco: string | null = null;
  let aplicar = false;
  let confirmacaoProducao: string | null = null;
  const vistos = new Set<string>();

  for (let indice = 0; indice < argv.length; indice += 1) {
    const argumento = argv[indice] ?? "";
    if (!PARAMETROS_CONHECIDOS.has(argumento)) return { ok: false, erro: `Parâmetro desconhecido ${descreverArgumento(argumento)}.` };
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

export interface ExecucaoAutorizada {
  banco: string;
  uri: string;
  ambiente: Ambiente;
  modo: "dry-run" | "apply";
}

/**
 * Valida o ambiente ANTES de qualquer conexão. Separa a possibilidade técnica
 * de conectar (a URI) da autorização para escrever: em banco protegido,
 * `--apply` só vale com `--confirmar-producao` igual ao nome exato do banco.
 */
export function validarAmbiente(opcoes: OpcoesComando, uri: string | undefined): Resultado<ExecucaoAutorizada> {
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

export interface ContextoRecuperacao {
  service: Pick<ConfiguracoesService, "avaliarRemocoesPendentes" | "processarRemocoesPendentes">;
  conexao: Connection;
  fechar(): Promise<void>;
}

export type AbrirContexto = (uri: string) => Promise<ContextoRecuperacao>;

/**
 * Contexto real do comando (Fase 56.4.3.1): `ComandoRemocoesPendentesModule`,
 * conectado EXATAMENTE à URI já validada (sem passar pelo ambiente), sem
 * criação/sincronização automática de índices. `aoConectar` é o ponto de
 * instrumentação, chamado antes de qualquer model ser compilado.
 */
export function criarAbridorDeContexto(opcoes: { aoConectar?: (conexao: Connection) => void } = {}): AbrirContexto {
  return async (uri) => {
    const app = await NestFactory.createApplicationContext(ComandoRemocoesPendentesModule.paraUri(uri, opcoes.aoConectar), { logger: false });
    return { service: app.get(ConfiguracoesService), conexao: app.get<Connection>(getConnectionToken()), fechar: () => app.close() };
  };
}

export const abrirContextoDoComando: AbrirContexto = criarAbridorDeContexto();

export interface DependenciasComando {
  argv: readonly string[];
  uri: string | undefined;
  escrever: (linha: string) => void;
  abrirContexto: AbrirContexto;
  execucao: AmbienteDeExecucao;
}

const EXPLICACAO_PREVISAO: Record<"restauravel" | "finalizavel" | "indeterminada", string> = {
  restauravel: "há vínculo: o --apply restauraria o item e encerraria a pendência",
  finalizavel: "sem vínculo: o --apply encerraria a pendência mantendo o item removido",
  indeterminada: "não foi possível consultar os vínculos: NENHUMA decisão (nunca tratada como sem vínculo)",
};

const DESFECHOS_QUE_EXIGEM_INTERVENCAO = new Set<DesfechoRemocaoPendente>(["mantida_falha_consulta", "mantida_falha_restauracao", "mantida_falha_finalizacao"]);

function identificar(opId: string | null, indice: number): string {
  return opId ?? `(sem opId, índice ${indice})`;
}

function relatarPrevisoes(escrever: (linha: string) => void, execucao: ExecucaoAutorizada, avaliacoes: AvaliacaoRemocaoPendente[]): number {
  escrever(`Pendências encontradas: ${avaliacoes.length}`);
  const intervencao: string[] = [];
  const contagem = { restauravel: 0, finalizavel: 0, indeterminada: 0, malformada: 0 };
  for (const avaliacao of avaliacoes) {
    contagem[avaliacao.previsao] += 1;
    if (avaliacao.previsao === "malformada") {
      intervencao.push(identificar(avaliacao.opId, avaliacao.indice));
      escrever(
        `[PREVISÃO] malformada opId=${avaliacao.opId ?? "(ausente)"} índice=${avaliacao.indice} motivo=${avaliacao.motivo} ` +
          "→ não seria processada nem alterada; exige intervenção",
      );
      continue;
    }
    const { pendencia } = avaliacao;
    if (avaliacao.previsao === "indeterminada") intervencao.push(pendencia.opId);
    escrever(
      `[PREVISÃO] ${avaliacao.previsao} opId=${pendencia.opId} lista=${pendencia.lista} valor=${JSON.stringify(pendencia.valor)} ` +
        `posição=${pendencia.posicao ?? "desconhecida"} em=${pendencia.em.toISOString()} → ${EXPLICACAO_PREVISAO[avaliacao.previsao]}` +
        (avaliacao.previsao === "indeterminada" ? ` (erro: ${ocultarSegredos(avaliacao.erro, execucao.uri)})` : ""),
    );
  }
  escrever("Resumo — PREVISÕES do dry-run (nenhuma operação foi executada, nada foi alterado):");
  escrever(`  Banco selecionado: ${execucao.banco}`);
  escrever("  Modo: dry-run");
  escrever(`  Total de pendências encontradas: ${avaliacoes.length}`);
  escrever(`  Previsto para restauração: ${contagem.restauravel}`);
  escrever(`  Previsto para finalização: ${contagem.finalizavel}`);
  escrever(`  Indeterminadas: ${contagem.indeterminada}`);
  escrever(`  Malformadas: ${contagem.malformada}`);
  escrever("  Efetivamente processado: 0 (dry-run) — restaurado 0, finalizado 0, já concluído 0, mantido 0");
  escrever(`  Exigem intervenção: ${intervencao.length > 0 ? intervencao.join(", ") : "nenhuma"}`);
  return intervencao.length > 0 ? CODIGOS_DE_SAIDA.intervencaoNecessaria : CODIGOS_DE_SAIDA.sucesso;
}

function relatarAplicacao(escrever: (linha: string) => void, execucao: ExecucaoAutorizada, resultado: ResultadoProcessamentoRemocoes): number {
  const total = resultado.processadas.length + resultado.malformadas.length;
  escrever(`Pendências encontradas: ${total}`);
  const intervencao: string[] = [];
  const contagem: Record<DesfechoRemocaoPendente, number> = {
    restaurada: 0,
    finalizada: 0,
    ja_concluida: 0,
    mantida_falha_consulta: 0,
    mantida_falha_restauracao: 0,
    mantida_falha_finalizacao: 0,
  };
  for (const item of resultado.processadas) {
    contagem[item.desfecho] += 1;
    if (DESFECHOS_QUE_EXIGEM_INTERVENCAO.has(item.desfecho)) intervencao.push(item.opId);
    escrever(`[RESULTADO] opId=${item.opId} lista=${item.lista} valor=${JSON.stringify(item.valor)} → ${item.desfecho}`);
  }
  for (const malformada of resultado.malformadas) {
    intervencao.push(identificar(malformada.opId, malformada.indice));
    escrever(`[RESULTADO] malformada opId=${malformada.opId ?? "(ausente)"} índice=${malformada.indice} motivo=${malformada.motivo} → mantida intacta, não processada`);
  }
  escrever("Resumo — resultados EFETIVOS retornados pelo processamento:");
  escrever(`  Banco selecionado: ${execucao.banco}`);
  escrever("  Modo: apply");
  escrever(`  Total de pendências encontradas: ${total}`);
  escrever("  Previsões: não se aplicam ao modo apply");
  escrever(`  Malformadas (mantidas intactas): ${resultado.malformadas.length}`);
  escrever(`  Efetivamente processado: ${resultado.processadas.length}`);
  escrever(`  Restaurado: ${contagem.restaurada}`);
  escrever(`  Finalizado: ${contagem.finalizada}`);
  escrever(`  Já concluído por outra execução: ${contagem.ja_concluida}`);
  escrever(`  Mantido por falha de consulta: ${contagem.mantida_falha_consulta}`);
  escrever(`  Mantido por falha de restauração: ${contagem.mantida_falha_restauracao}`);
  escrever(`  Mantido por falha de finalização: ${contagem.mantida_falha_finalizacao}`);
  escrever(`  Exigem intervenção: ${intervencao.length > 0 ? intervencao.join(", ") : "nenhuma"}`);
  return intervencao.length > 0 ? CODIGOS_DE_SAIDA.intervencaoNecessaria : CODIGOS_DE_SAIDA.sucesso;
}

/** Executa o comando e devolve o código de saída. Nunca escreve a URI nem credenciais. */
export async function executarComando(dependencias: DependenciasComando): Promise<number> {
  const { escrever } = dependencias;
  const local = verificarExecucaoLocal(dependencias.execucao);
  if (!local.ok) {
    escrever(`ERRO: ${local.erro}`);
    escrever("Nenhuma conexão foi aberta: nada foi lido nem alterado.");
    return CODIGOS_DE_SAIDA.recusado;
  }
  const argumentos = interpretarArgumentos(dependencias.argv);
  if (!argumentos.ok) {
    escrever(`ERRO: ${argumentos.erro}`);
    escrever(USO);
    return CODIGOS_DE_SAIDA.recusado;
  }
  const autorizacao = validarAmbiente(argumentos.valor, dependencias.uri);
  if (!autorizacao.ok) {
    escrever(`ERRO: ${autorizacao.erro}`);
    escrever("Nenhuma conexão foi aberta: nada foi lido nem alterado.");
    return CODIGOS_DE_SAIDA.recusado;
  }
  const execucao = autorizacao.valor;
  escrever(`Banco selecionado: ${execucao.banco}`);
  escrever(
    `Ambiente: ${execucao.ambiente === "teste" ? "teste (banco de teste em host local)" : "PROTEGIDO (produção ou banco não reconhecido como teste)"}`,
  );
  escrever(execucao.modo === "apply" ? "Modo: apply (as pendências SERÃO processadas)" : "Modo: dry-run (somente leitura — nada será alterado)");

  let contexto: ContextoRecuperacao | null = null;
  try {
    contexto = await dependencias.abrirContexto(execucao.uri);
    if (contexto.conexao.name !== execucao.banco) {
      escrever(`ERRO: a conexão aberta não aponta para "${execucao.banco}" — operação abortada antes de qualquer consulta.`);
      return CODIGOS_DE_SAIDA.falha;
    }
    if (execucao.modo === "dry-run") return relatarPrevisoes(escrever, execucao, await contexto.service.avaliarRemocoesPendentes());
    return relatarAplicacao(escrever, execucao, await contexto.service.processarRemocoesPendentes());
  } catch (erro) {
    const descricao = erro instanceof Error ? `${erro.name}: ${erro.message}` : String(erro);
    escrever(`ERRO durante a execução: ${ocultarSegredos(descricao, execucao.uri)}`);
    return CODIGOS_DE_SAIDA.falha;
  } finally {
    if (contexto) {
      try {
        await contexto.fechar();
      } catch (erro) {
        escrever(`AVISO: falha ao encerrar a conexão: ${ocultarSegredos(erro instanceof Error ? erro.message : String(erro), execucao.uri)}`);
      }
    }
  }
}
