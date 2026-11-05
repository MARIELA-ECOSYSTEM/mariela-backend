import { randomUUID } from "node:crypto";
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
 * Seleção: registros `pendente` cujo `limpezaApos` venceu há pelo menos `MARGEM_DE_SEGURANCA_MS`, e reservas de
 * limpeza (`limpando`) interrompidas há pelo menos `PRAZO_RECUPERACAO_LIMPEZA_MS`.
 *
 * Fase 60.3.1 — coordenação com a confirmação por RESERVA atômica no próprio registro (MongoDB standalone, sem
 * transação multi-documento). [apply] `pendente` → `limpando` + token (condicional) → produto e referências →
 * `HeadObject` → posse da reserva e referências de novo → `DeleteObject` (se existir) → `limpando` → `descartado`
 * (condicional ao token). Sem a reserva, nada é excluído; qualquer dúvida devolve o registro a `pendente`.
 *
 * Por que é seguro: a confirmação só grava o produto depois de reservar o registro (`pendente` no prazo →
 * `confirmando`, escrita condicional no mesmo documento). As duas reservas se excluem; e um registro que a limpeza
 * já assumiu nunca mais volta a ser reservável pela confirmação — a reserva da limpeza grava a marca permanente
 * `limpezaIniciadaEm`, e a da confirmação exige que ela esteja ausente (independe de relógio). Logo, depois da
 * reserva da limpeza nenhuma confirmação grava referência nova; as gravadas antes estão visíveis na consulta feita
 * depois da reserva. A margem de 15 minutos continua como proteção complementar, não como garantia.
 *
 * Recuperação: uma reserva `limpando` interrompida (processo caiu) é retomada por outra execução depois do prazo,
 * trocando o token por escrita condicional. A execução antiga, se ainda estiver viva, perde a posse: suas
 * transições exigem o token antigo e ela confere a posse imediatamente antes de excluir. No pior caso ela ainda
 * exclui um objeto que, pelo argumento acima, nenhuma confirmação pode ter referenciado desde a primeira reserva.
 * Limite (fora do protocolo): uma URL colada à mão em `variante.foto`/`video` não passa pela reserva; a limpeza a
 * procura antes de excluir, mas não há como bloqueá-la atomicamente.
 */

const ENTRADA_LOCAL_ESPERADA = "src/scripts/limpar-uploads-abandonados.ts";

/**
 * Tempo extra, depois de `limpezaApos`, antes de um registro ser elegível — proteção operacional complementar à
 * reserva atômica (Fase 60.3.1), que é a garantia.
 */
export const MARGEM_DE_SEGURANCA_MS = 15 * 60 * 1000;

/**
 * Fase 60.3.1 — idade mínima de uma reserva `limpando` para outra execução retomá-la (processo interrompido).
 * Bem maior que o tempo de processar um registro; retomar uma reserva ainda viva é seguro (ver o cabeçalho).
 */
export const PRAZO_RECUPERACAO_LIMPEZA_MS = 30 * 60 * 1000;

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
  leitor: Pick<
    LeitorLimpezaUploads,
    "listarRegistros" | "lerRegistro" | "produtoExiste" | "buscarReferencia" | "assumirLimpeza" | "recuperarLimpeza" | "possuiReserva" | "liberarLimpeza" | "marcarDescartado"
  >;
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
  | "em_confirmacao"
  | "confirmacao_interrompida"
  | "limpeza_em_andamento"
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
  /** Registro era uma reserva `limpando` interrompida, retomada (ou que seria retomada) por esta execução. */
  recuperado: boolean;
  detalhe: string;
}

/** Desfechos de registros que esta execução não processa (só contados). */
const NAO_PROCESSADOS = new Set<Desfecho>(["fora_de_escopo", "nao_expirado", "dentro_da_margem", "em_confirmacao", "confirmacao_interrompida", "limpeza_em_andamento"]);

function elegivel(registro: RegistroUpload, agora: Date): boolean {
  return registro.estado === "pendente" && registro.limpezaApos instanceof Date && registro.limpezaApos.getTime() + MARGEM_DE_SEGURANCA_MS <= agora.getTime();
}

/** Reserva de limpeza interrompida: `limpando` reservada há pelo menos o prazo de recuperação. */
function recuperavel(registro: RegistroUpload, agora: Date): boolean {
  return registro.estado === "limpando" && registro.reservadoEm instanceof Date && registro.reservadoEm.getTime() + PRAZO_RECUPERACAO_LIMPEZA_MS <= agora.getTime();
}

function descreverErro(erro: unknown, uri: string): string {
  return ocultarSegredos(erro instanceof Error ? `${erro.name}: ${erro.message}` : String(erro), uri);
}

/** Processa UM registro elegível ou recuperável. Nunca exclui diante de dúvida; nunca lança (todo erro vira desfecho). */
async function processarRegistro(contexto: ContextoLimpeza, registro: RegistroUpload, execucao: ExecucaoAutorizada, agora: Date): Promise<ResultadoRegistro> {
  const recuperacao = registro.estado === "limpando";
  const resultado = (desfecho: Desfecho, detalhe: string, objetoExistia: boolean | null = null, excluido = false): ResultadoRegistro => ({
    registro,
    desfecho,
    objetoExistia,
    excluido,
    recuperado: recuperacao,
    detalhe: recuperacao ? `[reserva interrompida ${execucao.modo === "apply" ? "retomada" : "— seria retomada"}] ${detalhe}` : detalhe,
  });
  const { leitor } = contexto;
  const uploadId = registro._id;

  /** Produto e referências (lidos depois da reserva no apply, e de novo imediatamente antes da exclusão). */
  async function verificarReferencias(): Promise<{ impedimento: ResultadoRegistro | null; nota: string }> {
    let produtoExiste: boolean;
    try {
      produtoExiste = await leitor.produtoExiste(registro.produtoId);
    } catch (erro) {
      return { impedimento: resultado("falha_consulta", `falha ao ler o produto ${String(registro.produtoId)} (${descreverErro(erro, execucao.uri)})`), nota: "" };
    }
    try {
      const referencia = await leitor.buscarReferencia(uploadId, registro.chave);
      if (referencia) return { impedimento: resultado("preservado_referencia", `arquivo referenciado por ${referencia}: objeto preservado (inconsistência a analisar)`), nota: "" };
    } catch (erro) {
      return { impedimento: resultado("falha_consulta", `falha ao procurar referências (${descreverErro(erro, execucao.uri)})`), nota: "" };
    }
    return { impedimento: null, nota: produtoExiste ? "" : " (produto inexistente — consulta bem-sucedida sem documento)" };
  }

  if (execucao.modo === "dry-run") {
    // Somente leitura: nenhuma reserva é adquirida.
    const { impedimento, nota } = await verificarReferencias();
    if (impedimento) return impedimento;
    if (!contexto.storage) return resultado("nao_verificado", `storage não configurado: objeto não verificado${nota}`);
    try {
      return (await contexto.storage.inspecionarObjeto(registro.chave)).existe
        ? resultado("seria_excluido", `objeto existe e não é referenciado: seria excluído e o registro descartado${nota}`, true)
        : resultado("seria_descartado_ausente", `objeto já ausente: o registro seria marcado como descartado${nota}`, false);
    } catch (erro) {
      return resultado("falha_leitura_storage", `falha ao consultar o objeto no storage (${descreverErro(erro, execucao.uri)})`);
    }
  }

  // 1. Reserva atômica (ou retomada de uma reserva interrompida, trocando o token).
  const token = randomUUID();
  try {
    const assumiu = recuperacao
      ? await leitor.recuperarLimpeza(uploadId, registro.tokenReserva ?? null, new Date(agora.getTime() - PRAZO_RECUPERACAO_LIMPEZA_MS), token, agora)
      : await leitor.assumirLimpeza(uploadId, new Date(agora.getTime() - MARGEM_DE_SEGURANCA_MS), token, agora);
    if (!assumiu) return resultado("conflito", "outra execução ou operação assumiu ou alterou o registro antes da reserva: nada foi feito");
  } catch (erro) {
    return resultado("falha_consulta", `falha ao reservar o registro (${descreverErro(erro, execucao.uri)})`);
  }

  /** Devolve a reserva (`limpando` → `pendente`) quando nada foi excluído. Se a devolução falhar, ela fica recuperável após o prazo. */
  async function liberar(item: ResultadoRegistro): Promise<ResultadoRegistro> {
    try {
      await leitor.liberarLimpeza(uploadId, token);
      return item;
    } catch (erro) {
      return { ...item, detalhe: `${item.detalhe} (falha ao liberar a reserva — o registro fica em limpeza e será recuperável após o prazo: ${descreverErro(erro, execucao.uri)})` };
    }
  }

  if (!contexto.storage) return liberar(resultado("nao_verificado", "storage não configurado: objeto não verificado"));

  // 2. Objeto.
  let existe: boolean;
  try {
    existe = (await contexto.storage.inspecionarObjeto(registro.chave)).existe;
  } catch (erro) {
    return liberar(resultado("falha_leitura_storage", `falha ao consultar o objeto no storage (${descreverErro(erro, execucao.uri)})`));
  }

  // 3. Imediatamente antes de excluir (e DEPOIS da reserva): a reserva continua desta execução e nada referencia o
  // arquivo — qualquer confirmação concluída antes da reserva já está visível aqui.
  try {
    if (!(await leitor.possuiReserva(uploadId, token))) {
      return resultado("conflito", "a reserva foi retomada por outra execução antes da exclusão: nada foi excluído por esta execução", existe);
    }
  } catch (erro) {
    return liberar(resultado("falha_consulta", `falha ao conferir a posse da reserva (${descreverErro(erro, execucao.uri)})`, existe));
  }
  const final = await verificarReferencias();
  if (final.impedimento) return liberar({ ...final.impedimento, objetoExistia: existe });

  // 4. Exclusão física (só se existir) e 5. marcação condicional ao token.
  if (existe) {
    try {
      await contexto.storage.excluirObjeto(registro.chave);
    } catch (erro) {
      return liberar(resultado("falha_exclusao", `falha ao excluir o objeto — registro devolvido a pendente (${descreverErro(erro, execucao.uri)})`, true));
    }
  }
  try {
    if (!(await leitor.marcarDescartado(uploadId, token))) {
      return resultado("conflito", `${existe ? "objeto excluído, mas " : ""}a reserva foi retomada por outra execução antes da marcação (ela conclui o registro)`, existe, existe);
    }
  } catch (erro) {
    return resultado(
      "falha_atualizacao",
      `${existe ? "objeto excluído, mas " : ""}falha ao marcar como descartado — o registro fica em limpeza e será concluído após o prazo de recuperação (${descreverErro(erro, execucao.uri)})`,
      existe,
      existe,
    );
  }
  return existe
    ? resultado("excluido_e_descartado", `objeto excluído e registro descartado${final.nota}`, true, true)
    : resultado("descartado_ausente", `objeto já ausente; registro descartado${final.nota}`, false);
}

const DESFECHOS_PARA_ANALISE = new Set<Desfecho>([
  "preservado_referencia",
  "falha_consulta",
  "falha_leitura_storage",
  "falha_exclusao",
  "falha_atualizacao",
  "conflito",
  "confirmacao_interrompida",
]);

function relatar(escrever: (linha: string) => void, execucao: ExecucaoAutorizada, resultados: ResultadoRegistro[], analisados: number): number {
  const aplicar = execucao.modo === "apply";
  for (const item of resultados) {
    if (NAO_PROCESSADOS.has(item.desfecho) && item.desfecho !== "confirmacao_interrompida") continue;
    escrever(`[${item.desfecho.toUpperCase()}] upload ${item.registro._id} chave=${item.registro.chave}: ${item.detalhe}`);
  }
  const contar = (...desfechos: Desfecho[]) => resultados.filter((item) => desfechos.includes(item.desfecho)).length;
  const processados = resultados.filter((item) => !NAO_PROCESSADOS.has(item.desfecho));

  escrever(aplicar ? "Resumo — resultados EFETIVOS da limpeza:" : "Resumo — PREVISÃO do dry-run (NENHUMA escrita no MongoDB nem no storage):");
  escrever(`  Banco selecionado: ${execucao.banco}`);
  escrever(`  Modo: ${execucao.modo}`);
  escrever(`  Registros analisados: ${analisados}`);
  escrever(`  Fora do escopo (confirmado, removido ou descartado — nunca tocados): ${contar("fora_de_escopo")}`);
  escrever(`  Em confirmação (reserva da confirmação — nunca tocados): ${contar("em_confirmacao")}`);
  escrever(`  Confirmações interrompidas (em confirmação após o prazo — análise manual, nunca excluídas): ${contar("confirmacao_interrompida")}`);
  escrever(`  Limpezas em andamento em outra execução (reserva com menos de ${PRAZO_RECUPERACAO_LIMPEZA_MS / 60_000} min — não tocadas): ${contar("limpeza_em_andamento")}`);
  escrever(`  Pendentes não expirados: ${contar("nao_expirado")}`);
  escrever(`  Pendentes vencidos ainda dentro da margem de segurança (${MARGEM_DE_SEGURANCA_MS / 60_000} min): ${contar("dentro_da_margem")}`);
  escrever(`  Registros elegíveis: ${processados.length}`);
  escrever(`  Reservas de limpeza interrompidas ${aplicar ? "retomadas" : "que seriam retomadas"}: ${processados.filter((item) => item.recuperado).length}`);
  escrever(`  Objetos existentes: ${processados.filter((item) => item.objetoExistia === true).length}`);
  escrever(`  Objetos já ausentes: ${processados.filter((item) => item.objetoExistia === false).length}`);
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
      const base = { registro, objetoExistia: null, excluido: false, recuperado: false, detalhe: "" };
      const vencido = registro.limpezaApos instanceof Date && registro.limpezaApos.getTime() + MARGEM_DE_SEGURANCA_MS <= agora.getTime();
      if (registro.estado === "pendente") {
        if (!(registro.limpezaApos instanceof Date) || registro.limpezaApos.getTime() > agora.getTime()) resultados.push({ ...base, desfecho: "nao_expirado" });
        else if (!elegivel(registro, agora)) resultados.push({ ...base, desfecho: "dentro_da_margem" });
        else resultados.push(await processarRegistro(contexto, registro, execucao, agora));
      } else if (registro.estado === "limpando") {
        if (recuperavel(registro, agora)) resultados.push(await processarRegistro(contexto, registro, execucao, agora));
        else resultados.push({ ...base, desfecho: "limpeza_em_andamento" });
      } else if (registro.estado === "confirmando") {
        // Nunca tocado: a confirmação pode ter gravado o produto sem concluir o registro. Vencido = análise manual.
        resultados.push(
          vencido
            ? { ...base, desfecho: "confirmacao_interrompida", detalhe: "em confirmação após o prazo: objeto nunca excluído; reconciliar com uma nova confirmação ou analisar" }
            : { ...base, desfecho: "em_confirmacao" },
        );
      } else resultados.push({ ...base, desfecho: "fora_de_escopo" });
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
