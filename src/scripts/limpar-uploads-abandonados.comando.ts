import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { getConnectionToken } from "@nestjs/mongoose";
import type { Connection } from "mongoose";
import type { Configuration, StorageConfig } from "../config/configuration.js";
import type { MediaStorage } from "../modules/media/media.types.js";
import { R2PresignerProvider } from "../modules/media/providers/r2-presigner.provider.js";
import {
  analisarUri,
  BANCO_RECUSADO,
  classificarAmbiente,
  descreverArgumento,
  NOME_DE_BANCO_VALIDO,
  ocultarSegredos,
  verificarExecucaoLocal,
  type Ambiente,
  type AmbienteDeExecucao,
  type Resultado,
} from "./comando-local.util.js";
import { ComandoLimpezaUploadsModule, LeitorLimpezaUploads, type RegistroUpload } from "./limpar-uploads-abandonados.modulo.js";

/**
 * Fase 60.3 — lógica do comando `limpar-uploads-abandonados` (ponto de entrada: `limpar-uploads-abandonados.ts`).
 * Mesma estrutura dos comandos 56.4.3/60.2: execução local → argumentos → banco da URI → autorização → conexão.
 *
 * Seleção: registros de `uploads_midia` em `pendente` cujo `limpezaApos` venceu há pelo menos
 * `MARGEM_DE_SEGURANCA_MS`. Para cada um: revalida o registro → confirma a existência do produto → procura
 * referências (produtos e vendas) → `HeadObject` → [apply] revalida registro e referências de novo → exclui o
 * objeto (se existir) → `pendente` → `descartado` condicional. Qualquer dúvida (falha de leitura, referência,
 * estado mudado) = nada é excluído e o registro fica como está.
 *
 * Limites honestos de coordenação MongoDB × R2 (sem transação entre os dois): entre a última revalidação e a
 * exclusão existe uma janela mínima. Ela é fechada na prática por duas regras já existentes — a confirmação
 * recusa upload com `limpezaApos` vencido, e a margem de segurança deixa de fora confirmações que começaram antes
 * do vencimento e ainda estejam em andamento. Se o objeto for excluído e a marcação falhar, o registro continua
 * `pendente` e a próxima execução o conclui (objeto já ausente → `descartado`).
 */

const ENTRADA_LOCAL_ESPERADA = "src/scripts/limpar-uploads-abandonados.ts";

/**
 * Tempo extra, depois de `limpezaApos`, antes de um registro ser elegível. Cobre uma confirmação que passou pela
 * checagem de prazo pouco antes do vencimento e ainda está gravando o produto (decisão desta fase, a revisar).
 */
export const MARGEM_DE_SEGURANCA_MS = 15 * 60 * 1000;

export const CODIGOS_DE_SAIDA = {
  /** Concluído sem falhas, conflitos nem registros preservados por referência. */
  sucesso: 0,
  /** Concluído, mas há falhas, conflitos ou registros preservados que exigem análise (ver relatório). */
  intervencaoNecessaria: 1,
  /** Recusado ANTES de qualquer conexão. */
  recusado: 2,
  /** Falha durante a execução (conexão, banco divergente, erro inesperado). */
  falha: 3,
} as const;

export const USO = [
  "Uso: bun run midias:limpar-abandonadas --banco <nome-do-banco> [--apply]",
  "     (equivale a: bun run src/scripts/limpar-uploads-abandonados.ts --banco <nome-do-banco> [--apply])",
  "  --banco <nome>  obrigatório; precisa ser EXATAMENTE o banco da MONGODB_URI configurada",
  "  --apply         exclui os objetos abandonados e marca os registros como descartados (sem ele: dry-run).",
  "                  Nesta fase, só em banco de teste local e com as variáveis R2_* configuradas.",
  `  Códigos de saída: ${CODIGOS_DE_SAIDA.sucesso} sucesso | ${CODIGOS_DE_SAIDA.intervencaoNecessaria} há itens para análise | ` +
    `${CODIGOS_DE_SAIDA.recusado} recusado antes de conectar | ${CODIGOS_DE_SAIDA.falha} falha na execução`,
].join("\n");

export interface OpcoesComando {
  banco: string;
  aplicar: boolean;
}

const PARAMETROS_CONHECIDOS = new Set(["--banco", "--apply"]);

export function interpretarArgumentos(argv: readonly string[]): Resultado<OpcoesComando> {
  let banco: string | null = null;
  let aplicar = false;
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
    banco = valor;
  }
  if (banco === null) return { ok: false, erro: 'O parâmetro "--banco <nome-do-banco>" é obrigatório.' };
  if (!NOME_DE_BANCO_VALIDO.test(banco)) return { ok: false, erro: "Nome de banco inválido em --banco (use só letras, números, _ ou -)." };
  return { ok: true, valor: { banco, aplicar } };
}

export type ConfigR2 = StorageConfig["r2"];

/** As 5 variáveis do R2, ou `null` se alguma faltar (mesma exigência de `exigirBaseUrlPublica`). Nunca exibidas. */
export function lerConfigR2(variaveis: Readonly<Record<string, string | undefined>>): ConfigR2 | null {
  const valor = (nome: string) => (variaveis[nome] ?? "").trim();
  const config: ConfigR2 = {
    accountId: valor("R2_ACCOUNT_ID"),
    accessKeyId: valor("R2_ACCESS_KEY_ID"),
    secretAccessKey: valor("R2_SECRET_ACCESS_KEY"),
    bucketName: valor("R2_BUCKET_NAME"),
    publicBaseUrl: valor("R2_PUBLIC_BASE_URL").replace(/\/+$/, ""),
  };
  return Object.values(config).every((campo) => campo !== "") ? config : null;
}

export interface ExecucaoAutorizada {
  banco: string;
  uri: string;
  ambiente: Ambiente;
  modo: "dry-run" | "apply";
}

/** Valida o ambiente ANTES de qualquer conexão. Exclusão só em banco de teste local e com o storage configurado. */
export function validarAmbiente(opcoes: OpcoesComando, uri: string | undefined, r2: ConfigR2 | null): Resultado<ExecucaoAutorizada> {
  if (opcoes.banco === BANCO_RECUSADO) return { ok: false, erro: `O banco "${BANCO_RECUSADO}" é recusado por este comando.` };
  if (!uri || uri.trim() === "") return { ok: false, erro: "MONGODB_URI não está definida no ambiente." };
  const analise = analisarUri(uri);
  if (!analise) return { ok: false, erro: "MONGODB_URI não tem um nome de banco reconhecível no path (a URI não é exibida)." };
  if (analise.banco === BANCO_RECUSADO) return { ok: false, erro: `A MONGODB_URI configurada aponta para "${BANCO_RECUSADO}", recusado por este comando.` };
  if (analise.banco !== opcoes.banco) {
    return { ok: false, erro: `O banco informado em --banco ("${opcoes.banco}") é diferente do banco da MONGODB_URI configurada ("${analise.banco}").` };
  }
  const ambiente = classificarAmbiente(analise);
  if (opcoes.aplicar && ambiente !== "teste") {
    return {
      ok: false,
      erro:
        `Limpeza recusada em "${opcoes.banco}": nesta fase o --apply só é permitido em banco de teste em host local ` +
        `(${analise.local ? "banco não reconhecido como teste" : "conexão externa (Atlas/Render ou host remoto)"}). Use o dry-run para analisar.`,
    };
  }
  if (opcoes.aplicar && r2 === null) {
    return { ok: false, erro: "O --apply exige o storage configurado (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_PUBLIC_BASE_URL)." };
  }
  return { ok: true, valor: { banco: opcoes.banco, uri, ambiente, modo: opcoes.aplicar ? "apply" : "dry-run" } };
}

export interface ContextoLimpeza {
  leitor: Pick<LeitorLimpezaUploads, "listarRegistros" | "lerRegistro" | "produtoExiste" | "buscarReferencia" | "marcarDescartado">;
  /** `null` = storage não configurado (só possível no dry-run): objetos ficam "não verificados". */
  storage: Pick<MediaStorage, "inspecionarObjeto" | "excluirObjeto"> | null;
  conexao: Connection;
  fechar(): Promise<void>;
}

export type AbrirContexto = (uri: string, r2: ConfigR2 | null) => Promise<ContextoLimpeza>;

/** Storage R2 real a partir da configuração validada (as credenciais nunca passam pelo relatório). */
export function criarStorageR2(r2: ConfigR2): MediaStorage {
  return new R2PresignerProvider(new ConfigService<Configuration>({ storage: { r2 } }));
}

export function criarAbridorDeContexto(opcoes: { aoConectar?: (conexao: Connection) => void } = {}): AbrirContexto {
  return async (uri, r2) => {
    const app = await NestFactory.createApplicationContext(ComandoLimpezaUploadsModule.paraUri(uri, opcoes.aoConectar), { logger: false });
    return {
      leitor: app.get(LeitorLimpezaUploads),
      storage: r2 ? criarStorageR2(r2) : null,
      conexao: app.get<Connection>(getConnectionToken()),
      fechar: () => app.close(),
    };
  };
}

export const abrirContextoDoComando: AbrirContexto = criarAbridorDeContexto();

export interface DependenciasComando {
  argv: readonly string[];
  uri: string | undefined;
  r2: ConfigR2 | null;
  escrever: (linha: string) => void;
  abrirContexto: AbrirContexto;
  execucao: AmbienteDeExecucao;
  agora?: () => Date;
}

/** Desfecho de um registro. Os prefixos `seria_` só aparecem no dry-run. */
export type Desfecho =
  | "fora_de_escopo"
  | "nao_expirado"
  | "dentro_da_margem"
  | "preservado_referencia"
  | "falha_consulta"
  | "falha_leitura_storage"
  | "nao_verificado"
  | "seria_excluido"
  | "seria_descartado_ausente"
  | "excluido_e_descartado"
  | "descartado_ausente"
  | "falha_exclusao"
  | "falha_atualizacao"
  | "conflito";

interface ResultadoRegistro {
  registro: RegistroUpload;
  desfecho: Desfecho;
  /** O objeto existia no storage (quando verificado). */
  objetoExistia: boolean | null;
  /** O objeto foi efetivamente excluído nesta execução. */
  excluido: boolean;
  detalhe: string;
}

function elegivel(registro: RegistroUpload, agora: Date): boolean {
  return registro.estado === "pendente" && registro.limpezaApos instanceof Date && registro.limpezaApos.getTime() + MARGEM_DE_SEGURANCA_MS <= agora.getTime();
}

function descreverErro(erro: unknown, uri: string): string {
  return ocultarSegredos(erro instanceof Error ? `${erro.name}: ${erro.message}` : String(erro), uri);
}

/** Processa UM registro elegível. Nunca exclui diante de dúvida; nunca lança (todo erro vira desfecho). */
async function processarRegistro(contexto: ContextoLimpeza, registro: RegistroUpload, execucao: ExecucaoAutorizada, agora: Date): Promise<ResultadoRegistro> {
  const resultado = (desfecho: Desfecho, detalhe: string, objetoExistia: boolean | null = null, excluido = false): ResultadoRegistro => ({
    registro,
    desfecho,
    objetoExistia,
    excluido,
    detalhe,
  });
  const { leitor } = contexto;
  const uploadId = registro._id;

  /** Estado e referências — usado antes da verificação do objeto e de novo imediatamente antes da exclusão. */
  async function revalidar(): Promise<ResultadoRegistro | null> {
    let atual: RegistroUpload | null;
    try {
      atual = await leitor.lerRegistro(uploadId);
    } catch (erro) {
      return resultado("falha_consulta", `falha ao reler o registro (${descreverErro(erro, execucao.uri)})`);
    }
    if (!atual || !elegivel(atual, agora) || atual.chave !== registro.chave) {
      return resultado("conflito", `o registro mudou durante a limpeza (estado atual: ${atual?.estado ?? "inexistente"})`);
    }
    try {
      const referencia = await leitor.buscarReferencia(uploadId, registro.chave);
      if (referencia) return resultado("preservado_referencia", `arquivo referenciado por ${referencia}: objeto preservado (inconsistência a analisar)`);
    } catch (erro) {
      return resultado("falha_consulta", `falha ao procurar referências (${descreverErro(erro, execucao.uri)})`);
    }
    return null;
  }

  let produtoExiste: boolean;
  try {
    produtoExiste = await leitor.produtoExiste(registro.produtoId);
  } catch (erro) {
    return resultado("falha_consulta", `falha ao ler o produto ${String(registro.produtoId)} (${descreverErro(erro, execucao.uri)})`);
  }
  const notaProduto = produtoExiste ? "" : " (produto inexistente — consulta bem-sucedida sem documento)";

  const impedimento = await revalidar();
  if (impedimento) return impedimento;
  if (!contexto.storage) return resultado("nao_verificado", `storage não configurado: objeto não verificado${notaProduto}`);

  let existe: boolean;
  try {
    existe = (await contexto.storage.inspecionarObjeto(registro.chave)).existe;
  } catch (erro) {
    return resultado("falha_leitura_storage", `falha ao consultar o objeto no storage (${descreverErro(erro, execucao.uri)})`);
  }

  if (execucao.modo === "dry-run") {
    return existe
      ? resultado("seria_excluido", `objeto existe e não é referenciado: seria excluído e o registro descartado${notaProduto}`, true)
      : resultado("seria_descartado_ausente", `objeto já ausente: o registro seria marcado como descartado${notaProduto}`, false);
  }

  // Última revalidação, imediatamente antes de qualquer exclusão.
  const impedimentoFinal = await revalidar();
  if (impedimentoFinal) return { ...impedimentoFinal, objetoExistia: existe };

  if (existe) {
    try {
      await contexto.storage.excluirObjeto(registro.chave);
    } catch (erro) {
      return resultado("falha_exclusao", `falha ao excluir o objeto — registro mantido pendente (${descreverErro(erro, execucao.uri)})`, true);
    }
  }
  try {
    if (!(await leitor.marcarDescartado(uploadId))) {
      return resultado(
        "conflito",
        existe ? "o objeto foi excluído, mas o registro deixou de estar pendente antes da marcação (outra execução ou operação)" : "o registro deixou de estar pendente antes da marcação",
        existe,
        existe,
      );
    }
  } catch (erro) {
    return resultado(
      "falha_atualizacao",
      `${existe ? "objeto excluído, mas " : ""}falha ao marcar como descartado — a próxima execução conclui (${descreverErro(erro, execucao.uri)})`,
      existe,
      existe,
    );
  }
  return existe
    ? resultado("excluido_e_descartado", `objeto excluído e registro descartado${notaProduto}`, true, true)
    : resultado("descartado_ausente", `objeto já ausente; registro descartado${notaProduto}`, false);
}

const DESFECHOS_PARA_ANALISE = new Set<Desfecho>(["preservado_referencia", "falha_consulta", "falha_leitura_storage", "falha_exclusao", "falha_atualizacao", "conflito"]);

function relatar(escrever: (linha: string) => void, execucao: ExecucaoAutorizada, resultados: ResultadoRegistro[], analisados: number): number {
  const aplicar = execucao.modo === "apply";
  for (const item of resultados) {
    if (item.desfecho === "fora_de_escopo" || item.desfecho === "nao_expirado" || item.desfecho === "dentro_da_margem") continue;
    escrever(`[${item.desfecho.toUpperCase()}] upload ${item.registro._id} chave=${item.registro.chave}: ${item.detalhe}`);
  }
  const contar = (...desfechos: Desfecho[]) => resultados.filter((item) => desfechos.includes(item.desfecho)).length;
  const elegiveis = resultados.filter((item) => !["fora_de_escopo", "nao_expirado", "dentro_da_margem"].includes(item.desfecho));

  escrever(aplicar ? "Resumo — resultados EFETIVOS da limpeza:" : "Resumo — PREVISÃO do dry-run (NENHUMA escrita no MongoDB nem no storage):");
  escrever(`  Banco selecionado: ${execucao.banco}`);
  escrever(`  Modo: ${execucao.modo}`);
  escrever(`  Registros analisados: ${analisados}`);
  escrever(`  Fora do escopo (confirmado, removido ou descartado — nunca tocados): ${contar("fora_de_escopo")}`);
  escrever(`  Pendentes não expirados: ${contar("nao_expirado")}`);
  escrever(`  Pendentes vencidos ainda dentro da margem de segurança (${MARGEM_DE_SEGURANCA_MS / 60_000} min): ${contar("dentro_da_margem")}`);
  escrever(`  Registros elegíveis: ${elegiveis.length}`);
  escrever(`  Objetos existentes: ${elegiveis.filter((item) => item.objetoExistia === true).length}`);
  escrever(`  Objetos já ausentes: ${elegiveis.filter((item) => item.objetoExistia === false).length}`);
  escrever(`  Objetos não verificados (storage não configurado): ${contar("nao_verificado")}`);
  escrever(`  Objetos que seriam excluídos: ${aplicar ? "não se aplica ao apply" : contar("seria_excluido")}`);
  escrever(`  Objetos efetivamente excluídos: ${resultados.filter((item) => item.excluido).length}`);
  escrever(`  Registros marcados como descartados: ${contar("excluido_e_descartado", "descartado_ausente")}${aplicar ? "" : ` (dry-run; seriam ${contar("seria_excluido", "seria_descartado_ausente")})`}`);
  escrever(`  Registros preservados por referência: ${contar("preservado_referencia")}`);
  escrever(`  Falhas de consulta (MongoDB): ${contar("falha_consulta")}`);
  escrever(`  Falhas de leitura do storage: ${contar("falha_leitura_storage")}`);
  escrever(`  Falhas de exclusão: ${contar("falha_exclusao")}`);
  escrever(`  Falhas ao marcar o registro: ${contar("falha_atualizacao")}`);
  escrever(`  Conflitos concorrentes: ${contar("conflito")}`);
  escrever(aplicar ? "  Registros de uploads_midia nunca são apagados." : "  Dry-run: nenhuma escrita ocorreu no MongoDB nem no storage.");
  return resultados.some((item) => DESFECHOS_PARA_ANALISE.has(item.desfecho)) ? CODIGOS_DE_SAIDA.intervencaoNecessaria : CODIGOS_DE_SAIDA.sucesso;
}

/** Executa o comando e devolve o código de saída. Nunca escreve a URI nem credenciais. */
export async function executarComando(dependencias: DependenciasComando): Promise<number> {
  const { escrever } = dependencias;
  const local = verificarExecucaoLocal(dependencias.execucao, ENTRADA_LOCAL_ESPERADA);
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
  const autorizacao = validarAmbiente(argumentos.valor, dependencias.uri, dependencias.r2);
  if (!autorizacao.ok) {
    escrever(`ERRO: ${autorizacao.erro}`);
    escrever("Nenhuma conexão foi aberta: nada foi lido nem alterado.");
    return CODIGOS_DE_SAIDA.recusado;
  }
  const execucao = autorizacao.valor;
  const agora = (dependencias.agora ?? (() => new Date()))();
  escrever(`Banco selecionado: ${execucao.banco}`);
  escrever(`Ambiente: ${execucao.ambiente === "teste" ? "teste (banco de teste em host local)" : "PROTEGIDO (produção ou banco não reconhecido como teste)"}`);
  escrever(execucao.modo === "apply" ? "Modo: apply (objetos abandonados SERÃO excluídos)" : "Modo: dry-run (somente leitura — nada será alterado no MongoDB nem no storage)");
  escrever(`Storage: ${dependencias.r2 ? "configurado" : "não configurado (objetos não serão verificados)"}`);

  let contexto: ContextoLimpeza | null = null;
  try {
    contexto = await dependencias.abrirContexto(execucao.uri, dependencias.r2);
    if (contexto.conexao.name !== execucao.banco) {
      escrever(`ERRO: a conexão aberta não aponta para "${execucao.banco}" — operação abortada antes de qualquer consulta.`);
      return CODIGOS_DE_SAIDA.falha;
    }
    const registros = await contexto.leitor.listarRegistros();
    const resultados: ResultadoRegistro[] = [];
    for (const registro of registros) {
      const base = { registro, objetoExistia: null, excluido: false, detalhe: "" };
      if (registro.estado !== "pendente") resultados.push({ ...base, desfecho: "fora_de_escopo" });
      else if (!(registro.limpezaApos instanceof Date) || registro.limpezaApos.getTime() > agora.getTime()) resultados.push({ ...base, desfecho: "nao_expirado" });
      else if (!elegivel(registro, agora)) resultados.push({ ...base, desfecho: "dentro_da_margem" });
      else resultados.push(await processarRegistro(contexto, registro, execucao, agora));
    }
    return relatar(escrever, execucao, resultados, registros.length);
  } catch (erro) {
    escrever(`ERRO durante a execução: ${descreverErro(erro, execucao.uri)}`);
    return CODIGOS_DE_SAIDA.falha;
  } finally {
    if (contexto) {
      try {
        await contexto.fechar();
      } catch (erro) {
        escrever(`AVISO: falha ao encerrar a conexão: ${descreverErro(erro, execucao.uri)}`);
      }
    }
  }
}
