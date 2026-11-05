import { NestFactory } from "@nestjs/core";
import { getConnectionToken } from "@nestjs/mongoose";
import type { Connection } from "mongoose";
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
import { ComandoMigracaoMidiasModule, MigradorMidiasLegadas } from "./migrar-midias-legadas.modulo.js";
import { interpretarUrl, planejarProduto, type MidiaLegadaNova, type Ocorrencia, type PlanoProduto, type ProdutoLegado } from "./migrar-midias-legadas.plano.js";

/**
 * Fase 60.2 — lógica do comando `migrar-midias-legadas` (ponto de entrada: `migrar-midias-legadas.ts`). Mesma
 * estrutura do comando da Fase 56.4.3: ordem garantida execução local → argumentos → banco da URI → autorização →
 * só então a conexão; qualquer recusa acontece antes de conectar. As REGRAS da migração ficam em
 * `migrar-midias-legadas.plano.ts` (puras); aqui só se lê, executa e relata.
 *
 * Nesta fase o `--apply` é permitido SOMENTE em banco de teste em host local (`mariela_test`): banco protegido
 * (produção, Atlas/Render ou desconhecido) é recusado para escrita, sem confirmação que contorne. O dry-run é
 * somente leitura (apenas `find`) e funciona em qualquer banco autorizado pela URI.
 */

const ENTRADA_LOCAL_ESPERADA = "src/scripts/migrar-midias-legadas.ts";
/** Releituras por produto quando o documento muda entre a leitura e a escrita (mesmo limite de `salvarComRetentativa`). */
const TENTATIVAS_POR_PRODUTO = 3;

export const CODIGOS_DE_SAIDA = {
  /** Execução concluída sem pendências. */
  sucesso: 0,
  /** Execução concluída, mas há produtos pendentes ou dados legados não migráveis (ver o relatório). */
  intervencaoNecessaria: 1,
  /** Recusado ANTES de qualquer conexão (argumentos ou ambiente inválidos). */
  recusado: 2,
  /** Falha durante a execução (conexão, banco divergente, erro inesperado). */
  falha: 3,
} as const;

export const USO = [
  "Uso: bun run midias:migrar-legado --banco <nome-do-banco> [--apply]",
  "     (equivale a: bun run src/scripts/migrar-midias-legadas.ts --banco <nome-do-banco> [--apply])",
  "  --banco <nome>  obrigatório; precisa ser EXATAMENTE o banco da MONGODB_URI configurada",
  "  --apply         grava a migração (sem ele: dry-run, somente leitura). Nesta fase, só em banco de teste local.",
  `  Códigos de saída: ${CODIGOS_DE_SAIDA.sucesso} sucesso | ${CODIGOS_DE_SAIDA.intervencaoNecessaria} há pendências | ` +
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

export interface ExecucaoAutorizada {
  banco: string;
  uri: string;
  ambiente: Ambiente;
  modo: "dry-run" | "apply";
}

/** Valida o ambiente ANTES de qualquer conexão. Escrita só em banco de teste em host local (Fase 60.2). */
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
  if (opcoes.aplicar && ambiente !== "teste") {
    return {
      ok: false,
      erro:
        `Escrita recusada em "${opcoes.banco}": nesta fase o --apply só é permitido em banco de teste em host local ` +
        `(${analise.local ? "banco não reconhecido como teste" : "conexão externa (Atlas/Render ou host remoto)"}). Use o dry-run para analisar.`,
    };
  }
  return { ok: true, valor: { banco: opcoes.banco, uri, ambiente, modo: opcoes.aplicar ? "apply" : "dry-run" } };
}

/** Base pública do R2 normalizada como em `configuration.ts` (sem barra final); `null` quando ausente ou não é URL http(s). */
export function normalizarBaseUrlPublica(valor: string | undefined): string | null {
  const texto = (valor ?? "").trim().replace(/\/+$/, "");
  return texto !== "" && interpretarUrl(texto) ? texto : null;
}

export interface ContextoMigracao {
  migrador: Pick<MigradorMidiasLegadas, "listarProdutos" | "lerProduto" | "acrescentarMidias">;
  conexao: Connection;
  fechar(): Promise<void>;
}

export type AbrirContexto = (uri: string) => Promise<ContextoMigracao>;

/** Contexto real: `ComandoMigracaoMidiasModule`, conectado EXATAMENTE à URI validada, sem índices automáticos. */
export function criarAbridorDeContexto(opcoes: { aoConectar?: (conexao: Connection) => void } = {}): AbrirContexto {
  return async (uri) => {
    const app = await NestFactory.createApplicationContext(ComandoMigracaoMidiasModule.paraUri(uri, opcoes.aoConectar), { logger: false });
    return { migrador: app.get(MigradorMidiasLegadas), conexao: app.get<Connection>(getConnectionToken()), fechar: () => app.close() };
  };
}

export const abrirContextoDoComando: AbrirContexto = criarAbridorDeContexto();

export interface DependenciasComando {
  argv: readonly string[];
  uri: string | undefined;
  /** Valor cru de `R2_PUBLIC_BASE_URL` (só usado para reconhecer chaves; nunca para acessar o R2). */
  baseUrlPublica: string | undefined;
  escrever: (linha: string) => void;
  abrirContexto: AbrirContexto;
  execucao: AmbienteDeExecucao;
  agora?: () => Date;
}

type Situacao = "sem_midia" | "ja_migrado" | "migrado" | "pendente";

interface ResultadoProduto {
  plano: PlanoProduto;
  situacao: Situacao;
  /** Itens efetivamente gravados (apply) ou que seriam gravados (dry-run). */
  novas: MidiaLegadaNova[];
  principalDefinida: boolean;
  motivo: string | null;
  detalhes: string[];
}

function resultadoDoPlano(plano: PlanoProduto): ResultadoProduto {
  const { desfecho } = plano;
  if (desfecho.status === "migrar") {
    return { plano, situacao: "migrado", novas: desfecho.novas, principalDefinida: desfecho.definirPrincipal !== null, motivo: null, detalhes: [] };
  }
  if (desfecho.status === "pendente") {
    return { plano, situacao: "pendente", novas: [], principalDefinida: false, motivo: desfecho.motivo, detalhes: desfecho.detalhes };
  }
  return { plano, situacao: desfecho.status, novas: [], principalDefinida: false, motivo: null, detalhes: [] };
}

/** `--apply` de um produto: escrita condicional; se o documento mudou, relê e replaneja (até 3 vezes). */
async function aplicarProduto(contexto: ContextoMigracao, lido: ProdutoLegado, baseUrl: string | null, agora: Date, uri: string): Promise<ResultadoProduto> {
  let atual = lido;
  for (let tentativa = 1; tentativa <= TENTATIVAS_POR_PRODUTO; tentativa += 1) {
    const plano = planejarProduto(atual, baseUrl, agora);
    if (plano.desfecho.status !== "migrar") return resultadoDoPlano(plano);
    try {
      if (await contexto.migrador.acrescentarMidias(atual, plano.desfecho.novas, plano.desfecho.definirPrincipal)) return resultadoDoPlano(plano);
    } catch (erro) {
      const descricao = erro instanceof Error ? `${erro.name}: ${erro.message}` : String(erro);
      return { plano, situacao: "pendente", novas: [], principalDefinida: false, motivo: "falha_escrita", detalhes: [ocultarSegredos(descricao, uri)] };
    }
    const relido = await contexto.migrador.lerProduto(atual._id);
    if (!relido) return { plano, situacao: "pendente", novas: [], principalDefinida: false, motivo: "produto_removido", detalhes: ["o produto deixou de existir durante a migração"] };
    atual = relido;
  }
  const plano = planejarProduto(atual, baseUrl, agora);
  return {
    plano,
    situacao: "pendente",
    novas: [],
    principalDefinida: false,
    motivo: "concorrencia",
    detalhes: [`o documento mudou a cada tentativa (${TENTATIVAS_POR_PRODUTO}); nada foi gravado`],
  };
}

function descreverOcorrencia(ocorrencia: Ocorrencia): string {
  switch (ocorrencia.tipo) {
    case "url_invalida":
      return `URL inválida em variante ${ocorrencia.varianteId}.${ocorrencia.campo}: ${JSON.stringify(ocorrencia.valor)} (não migrada; campo legado preservado)`;
    case "principal_sem_imagem":
      return `fotoPrincipalVarianteId ${ocorrencia.varianteId} não tem imagem migrável: nenhuma principal foi inventada`;
    case "chave_r2_nao_reconhecida":
      return `variante ${ocorrencia.varianteId}.${ocorrencia.campo} está no domínio de mídia, mas o caminho não é uma chave reconhecível deste produto: migrada com chave null`;
  }
}

const OCORRENCIAS_PENDENTES = new Set<Ocorrencia["tipo"]>(["url_invalida", "principal_sem_imagem"]);

function relatar(escrever: (linha: string) => void, execucao: ExecucaoAutorizada, baseUrl: string | null, resultados: ResultadoProduto[]): number {
  const aplicar = execucao.modo === "apply";
  for (const resultado of resultados) {
    const { plano } = resultado;
    const rotulo = `produto ${plano.produtoId} (${plano.codProduto})`;
    if (resultado.situacao === "migrado") {
      const imagens = resultado.novas.filter((midia) => midia.tipo === "image").length;
      escrever(
        `[${aplicar ? "MIGRADO" : "MIGRARIA"}] ${rotulo}: ${imagens} imagem(ns), ${resultado.novas.length - imagens} vídeo(s)` +
          (resultado.principalDefinida ? ", principal definida" : ""),
      );
    }
    if (resultado.situacao === "pendente") escrever(`[PENDENTE] ${rotulo}: ${resultado.motivo} — ${resultado.detalhes.join("; ")} (produto não modificado)`);
    for (const ocorrencia of plano.ocorrencias) escrever(`[${OCORRENCIAS_PENDENTES.has(ocorrencia.tipo) ? "PENDÊNCIA" : "AVISO"}] ${rotulo}: ${descreverOcorrencia(ocorrencia)}`);
  }

  const contar = (situacao: Situacao) => resultados.filter((resultado) => resultado.situacao === situacao).length;
  const novas = resultados.flatMap((resultado) => resultado.novas);
  const ocorrencias = resultados.flatMap((resultado) => resultado.plano.ocorrencias);
  const pendentes = resultados.filter(
    (resultado) => resultado.situacao === "pendente" || resultado.plano.ocorrencias.some((ocorrencia) => OCORRENCIAS_PENDENTES.has(ocorrencia.tipo)),
  );
  const porMotivo = (motivo: string) => resultados.filter((resultado) => resultado.motivo === motivo).length;

  escrever(aplicar ? "Resumo — resultados EFETIVOS da aplicação:" : "Resumo — PREVISÃO do dry-run (NENHUM dado foi alterado):");
  escrever(`  Banco selecionado: ${execucao.banco}`);
  escrever(`  Modo: ${execucao.modo}`);
  escrever(`  Domínio de mídia para reconhecer chaves R2: ${baseUrl ? "configurado" : "não configurado (nenhuma chave extraída; URLs preservadas com chave null)"}`);
  escrever(`  Produtos analisados: ${resultados.length}`);
  escrever(`  Produtos com mídias legadas: ${resultados.filter((resultado) => resultado.plano.temMidiaLegada).length}`);
  escrever(`  Produtos ${aplicar ? "migrados" : "que seriam migrados"}: ${contar("migrado")}`);
  escrever(`  Produtos já migrados: ${contar("ja_migrado")}`);
  escrever(`  Produtos sem mídia: ${contar("sem_midia")}`);
  escrever(`  Imagens ${aplicar ? "migradas" : "a migrar"}: ${novas.filter((midia) => midia.tipo === "image").length}`);
  escrever(`  Vídeos ${aplicar ? "migrados" : "a migrar"}: ${novas.filter((midia) => midia.tipo === "video").length}`);
  escrever(`  URLs externas preservadas (chave null): ${novas.filter((midia) => midia.chave === null).length}`);
  escrever(`  Chaves R2 identificadas: ${novas.filter((midia) => midia.chave !== null).length}`);
  escrever(`  Principais definidas: ${resultados.filter((resultado) => resultado.principalDefinida).length}`);
  escrever(`  Produtos pendentes: ${pendentes.length}`);
  escrever(`  URLs inválidas: ${ocorrencias.filter((ocorrencia) => ocorrencia.tipo === "url_invalida").length}`);
  escrever(`  Principais sem imagem correspondente: ${ocorrencias.filter((ocorrencia) => ocorrencia.tipo === "principal_sem_imagem").length}`);
  escrever(`  URLs do domínio de mídia sem chave reconhecível: ${ocorrencias.filter((ocorrencia) => ocorrencia.tipo === "chave_r2_nao_reconhecida").length}`);
  escrever(`  Produtos acima dos limites: ${porMotivo("limite")}`);
  escrever(`  Conflitos com galerias existentes: ${porMotivo("conflito")}`);
  escrever(`  Divergências em produtos já migrados: ${porMotivo("divergencia_pos_migracao")}`);
  escrever(`  Falhas de escrita / concorrência: ${porMotivo("falha_escrita") + porMotivo("concorrencia") + porMotivo("produto_removido")}`);
  escrever(aplicar ? "  Campos legados, uploads_midia e storage: não alterados." : "  Dry-run: nenhum dado foi alterado (somente leitura).");
  return pendentes.length > 0 ? CODIGOS_DE_SAIDA.intervencaoNecessaria : CODIGOS_DE_SAIDA.sucesso;
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
  const autorizacao = validarAmbiente(argumentos.valor, dependencias.uri);
  if (!autorizacao.ok) {
    escrever(`ERRO: ${autorizacao.erro}`);
    escrever("Nenhuma conexão foi aberta: nada foi lido nem alterado.");
    return CODIGOS_DE_SAIDA.recusado;
  }
  const execucao = autorizacao.valor;
  const baseUrl = normalizarBaseUrlPublica(dependencias.baseUrlPublica);
  const agora = (dependencias.agora ?? (() => new Date()))();
  escrever(`Banco selecionado: ${execucao.banco}`);
  escrever(`Ambiente: ${execucao.ambiente === "teste" ? "teste (banco de teste em host local)" : "PROTEGIDO (produção ou banco não reconhecido como teste)"}`);
  escrever(execucao.modo === "apply" ? "Modo: apply (a migração SERÁ gravada)" : "Modo: dry-run (somente leitura — nada será alterado)");

  let contexto: ContextoMigracao | null = null;
  try {
    contexto = await dependencias.abrirContexto(execucao.uri);
    // Revalida o banco na conexão efetivamente aberta, antes de qualquer consulta.
    if (contexto.conexao.name !== execucao.banco) {
      escrever(`ERRO: a conexão aberta não aponta para "${execucao.banco}" — operação abortada antes de qualquer consulta.`);
      return CODIGOS_DE_SAIDA.falha;
    }
    const produtos = await contexto.migrador.listarProdutos();
    const resultados: ResultadoProduto[] = [];
    for (const produto of produtos) {
      resultados.push(
        execucao.modo === "apply" ? await aplicarProduto(contexto, produto, baseUrl, agora, execucao.uri) : resultadoDoPlano(planejarProduto(produto, baseUrl, agora)),
      );
    }
    return relatar(escrever, execucao, baseUrl, resultados);
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
