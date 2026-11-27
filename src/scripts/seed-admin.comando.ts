import type { INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { getConnectionToken } from "@nestjs/mongoose";
import type { Connection } from "mongoose";
import { FalhaAuditoriaCriacaoAdmin, ProvisionamentoAdminService, type AvaliacaoProvisionamento } from "../modules/auth/provisionamento-admin.service.js";
import { FORMATO_EMAIL_ADMIN, normalizarEmailAdmin, TAMANHO_MAXIMO_EMAIL } from "../modules/auth/usuario-admin.util.js";
import {
  interpretarArgumentosDeEscrita,
  ocultarSegredos,
  validarAmbienteDeEscrita,
  verificarExecucaoLocal,
  type AmbienteDeExecucao,
  type Resultado,
} from "./comando-local.util.js";
import { ComandoSeedAdminModule } from "./seed-admin.modulo.js";

/**
 * Fase 60.4.3.2.1 — lógica do comando `seed:admin` (ponto de entrada: `seed-admin.ts`). Mesmas guardas de
 * `admin:desativar` (`comando-local.util.ts`): execução só local a partir do código-fonte, `--banco` obrigatório e
 * igual ao banco da URI, dry-run por padrão, `--apply` + `--confirmar-producao` em banco protegido. Toda validação
 * acontece ANTES de qualquer conexão.
 *
 * Variáveis: `ADMIN_EMAIL` e `ADMIN_NAME` (sempre); com `--apply`, também `ADMIN_PASSWORD` e `ADMIN_SEED_CONFIRM`
 * (o MESMO e-mail, repetido). `ADMIN_SEED_EXECUTOR` é opcional (quem executou, gravado no evento `ADMIN_CREATED`).
 * Nunca imprime a senha, o hash, a URI ou credenciais.
 */

export const CODIGOS_DE_SAIDA = {
  /** Dry-run: o ADMIN seria criado. Apply: o ADMIN foi criado. */
  sucesso: 0,
  /** Já existe um usuário com este e-mail — nada foi (ou seria) alterado. */
  jaExiste: 1,
  /** Recusado ANTES de qualquer conexão (argumentos, variáveis ou ambiente inválidos). */
  recusado: 2,
  /** Falha durante a execução (conexão, banco divergente, persistência). */
  falha: 3,
} as const;

export const USO = [
  "Uso: bun run seed:admin --banco <nome-do-banco> [--apply [--confirmar-producao <nome-do-banco>]]",
  "     (equivale a: bun run src/scripts/seed-admin.ts ...)",
  "  ADMIN_EMAIL                  obrigatória: e-mail do novo ADMIN",
  "  ADMIN_NAME                   obrigatória: nome (até 120 caracteres)",
  "  ADMIN_PASSWORD               obrigatória com --apply: senha (8 a 200 caracteres; nunca exibida)",
  "  ADMIN_SEED_CONFIRM           obrigatória com --apply: repita EXATAMENTE o mesmo e-mail",
  "  ADMIN_SEED_EXECUTOR          opcional: identificação de quem executa (até 120 caracteres), gravada na auditoria",
  "  --banco <nome>               obrigatório; precisa ser EXATAMENTE o banco da MONGODB_URI configurada",
  "  --apply                      cria o ADMIN (sem ele: dry-run, somente leitura)",
  "  --confirmar-producao <nome>  obrigatório junto com --apply em banco protegido (produção ou desconhecido); repita o nome exato",
  `  Códigos de saída: ${CODIGOS_DE_SAIDA.sucesso} criado (ou seria criado) | ${CODIGOS_DE_SAIDA.jaExiste} já existe, nada alterado | ` +
    `${CODIGOS_DE_SAIDA.recusado} recusado antes de conectar | ${CODIGOS_DE_SAIDA.falha} falha na execução`,
].join("\n");

const ENTRADA_LOCAL_ESPERADA = "src/scripts/seed-admin.ts";

/** `senhaMaxima` = limite do `LoginDto` (uma senha maior nunca conseguiria fazer login). */
export const LIMITES = { emailMaximo: TAMANHO_MAXIMO_EMAIL, nomeMaximo: 120, senhaMinima: 8, senhaMaxima: 200, executorMaximo: 120 } as const;

export interface PedidoSeed {
  email: string;
  nome: string;
  /** Presente sempre no modo apply; no dry-run, só se informada (e então já validada). */
  senha: string | null;
  executor: string | null;
}

/**
 * Regras de cada campo, compartilhadas com o comando interativo `admin:criar` (`criar-admin.comando.ts`). `rotulo` só
 * muda o nome do campo na mensagem (variável aqui, pergunta lá); a regra é a mesma. Nenhuma mensagem ecoa a senha.
 */
export function validarEmailDoAdmin(valor: string, rotulo: string): Resultado<string> {
  const email = normalizarEmailAdmin(valor);
  if (!email || email.length > LIMITES.emailMaximo || !FORMATO_EMAIL_ADMIN.test(email)) return { ok: false, erro: `${rotulo} não tem formato de e-mail válido.` };
  return { ok: true, valor: email };
}

export function validarNomeDoAdmin(valor: string, rotulo: string): Resultado<string> {
  const nome = valor.trim();
  if (!nome) return { ok: false, erro: `${rotulo} não pode ficar vazio.` };
  if (nome.length > LIMITES.nomeMaximo) return { ok: false, erro: `${rotulo} excede ${LIMITES.nomeMaximo} caracteres.` };
  return { ok: true, valor: nome };
}

export function validarSenhaDoAdmin(senha: string, rotulo: string): Resultado<string> {
  if (senha.length < LIMITES.senhaMinima || senha.length > LIMITES.senhaMaxima) {
    return { ok: false, erro: `${rotulo} deve ter de ${LIMITES.senhaMinima} a ${LIMITES.senhaMaxima} caracteres (o valor não é exibido).` };
  }
  return { ok: true, valor: senha };
}

/** Valida as variáveis `ADMIN_*`. Nenhuma mensagem ecoa a senha. */
export function interpretarVariaveis(variaveis: Readonly<Record<string, string | undefined>>, aplicar: boolean): Resultado<PedidoSeed> {
  if (!normalizarEmailAdmin(variaveis["ADMIN_EMAIL"] ?? "")) return { ok: false, erro: "Defina ADMIN_EMAIL com o e-mail do novo ADMIN." };
  const emailValidado = validarEmailDoAdmin(variaveis["ADMIN_EMAIL"] ?? "", "ADMIN_EMAIL");
  if (!emailValidado.ok) return emailValidado;
  const email = emailValidado.valor;

  if (!(variaveis["ADMIN_NAME"] ?? "").trim()) return { ok: false, erro: "Defina ADMIN_NAME com o nome do novo ADMIN." };
  const nomeValidado = validarNomeDoAdmin(variaveis["ADMIN_NAME"] ?? "", "ADMIN_NAME");
  if (!nomeValidado.ok) return nomeValidado;
  const nome = nomeValidado.valor;

  const executorBruto = (variaveis["ADMIN_SEED_EXECUTOR"] ?? "").trim();
  if (executorBruto.length > LIMITES.executorMaximo) return { ok: false, erro: `ADMIN_SEED_EXECUTOR excede ${LIMITES.executorMaximo} caracteres.` };
  const executor = executorBruto || null;

  const senhaInformada = variaveis["ADMIN_PASSWORD"];
  const senha = senhaInformada === undefined || senhaInformada === "" ? null : senhaInformada;
  if (senha !== null) {
    const senhaValidada = validarSenhaDoAdmin(senha, "ADMIN_PASSWORD");
    if (!senhaValidada.ok) return senhaValidada;
  }
  if (!aplicar) return { ok: true, valor: { email, nome, senha, executor } };

  if (senha === null) return { ok: false, erro: "--apply exige ADMIN_PASSWORD." };
  const confirmacao = variaveis["ADMIN_SEED_CONFIRM"];
  if (confirmacao === undefined || confirmacao.trim() === "") {
    return { ok: false, erro: "--apply exige ADMIN_SEED_CONFIRM com o MESMO e-mail de ADMIN_EMAIL (confirmação explícita)." };
  }
  if (normalizarEmailAdmin(confirmacao) !== email) return { ok: false, erro: "ADMIN_SEED_CONFIRM não corresponde EXATAMENTE a ADMIN_EMAIL." };
  return { ok: true, valor: { email, nome, senha, executor } };
}

export interface ContextoSeed {
  service: Pick<ProvisionamentoAdminService, "avaliar" | "criar">;
  conexao: Connection;
  fechar(): Promise<void>;
}

export type AbrirContexto = (uri: string) => Promise<ContextoSeed>;

/**
 * Contexto real: `ComandoSeedAdminModule` conectado EXATAMENTE à URI validada, sem criar coleções nem índices.
 * `aoConectar` (antes de compilar os models) e `aoCriar` (com o contexto pronto) são pontos de instrumentação.
 */
export function criarAbridorDeContexto(
  opcoes: { aoConectar?: (conexao: Connection) => void; aoCriar?: (app: INestApplicationContext) => void } = {},
): AbrirContexto {
  return async (uri) => {
    const app = await NestFactory.createApplicationContext(ComandoSeedAdminModule.paraUri(uri, opcoes.aoConectar), { logger: false });
    opcoes.aoCriar?.(app);
    return { service: app.get(ProvisionamentoAdminService), conexao: app.get<Connection>(getConnectionToken()), fechar: () => app.close() };
  };
}

export const abrirContextoDoComando: AbrirContexto = criarAbridorDeContexto();

export interface DependenciasComando {
  argv: readonly string[];
  /** Variáveis do processo: `MONGODB_URI` e as `ADMIN_*`. */
  variaveis: Readonly<Record<string, string | undefined>>;
  escrever: (linha: string) => void;
  abrirContexto: AbrirContexto;
  execucao: AmbienteDeExecucao;
}

function relatarAvaliacao(escrever: (linha: string) => void, avaliacao: AvaliacaoProvisionamento, pedido: PedidoSeed): number {
  if (avaliacao.status === "existe") {
    const { usuario } = avaliacao;
    escrever(`[PREVISÃO] já existe um usuário com este e-mail (${usuario.codigo}, tipo ${usuario.tipo}, ativo=${usuario.ativo}) — o --apply não faria nada.`);
    return CODIGOS_DE_SAIDA.jaExiste;
  }
  escrever(
    `[PREVISÃO] o --apply criaria o ADMIN <${avaliacao.email}> (nome: ${pedido.nome}), ativo, código previsto ${avaliacao.proximoCodigo} ` +
      "(previsão — o número só é reservado na criação).",
  );
  escrever(pedido.senha === null ? "  ADMIN_PASSWORD: não informada (obrigatória no --apply)." : "  ADMIN_PASSWORD: informada e com tamanho válido (valor não exibido).");
  escrever("Dry-run: nada foi alterado.");
  return CODIGOS_DE_SAIDA.sucesso;
}

/** Executa o comando e devolve o código de saída. Nunca escreve a senha, o hash, a URI ou credenciais. */
export async function executarComando(dependencias: DependenciasComando): Promise<number> {
  const { escrever, variaveis } = dependencias;
  const local = verificarExecucaoLocal(dependencias.execucao, ENTRADA_LOCAL_ESPERADA);
  if (!local.ok) {
    escrever(`ERRO: ${local.erro}`);
    escrever("Nenhuma conexão foi aberta: nada foi lido nem alterado.");
    return CODIGOS_DE_SAIDA.recusado;
  }
  const argumentos = interpretarArgumentosDeEscrita(dependencias.argv);
  if (!argumentos.ok) {
    escrever(`ERRO: ${argumentos.erro}`);
    escrever(USO);
    return CODIGOS_DE_SAIDA.recusado;
  }
  const pedido = interpretarVariaveis(variaveis, argumentos.valor.aplicar);
  if (!pedido.ok) {
    escrever(`ERRO: ${pedido.erro}`);
    escrever("Nenhuma conexão foi aberta: nada foi lido nem alterado.");
    return CODIGOS_DE_SAIDA.recusado;
  }
  const autorizacao = validarAmbienteDeEscrita(argumentos.valor, variaveis["MONGODB_URI"]);
  if (!autorizacao.ok) {
    escrever(`ERRO: ${autorizacao.erro}`);
    escrever("Nenhuma conexão foi aberta: nada foi lido nem alterado.");
    return CODIGOS_DE_SAIDA.recusado;
  }
  const execucao = autorizacao.valor;
  escrever(`Banco selecionado: ${execucao.banco}`);
  escrever(`Ambiente: ${execucao.ambiente === "teste" ? "teste (banco de teste em host local)" : "PROTEGIDO (produção ou banco não reconhecido como teste)"}`);
  escrever(execucao.modo === "apply" ? "Modo: apply (o ADMIN SERÁ criado se o e-mail não existir)" : "Modo: dry-run (somente leitura — nada será alterado)");
  escrever(`E-mail alvo: ${pedido.valor.email}`);

  let contexto: ContextoSeed | null = null;
  try {
    contexto = await dependencias.abrirContexto(execucao.uri);
    if (contexto.conexao.name !== execucao.banco) {
      escrever(`ERRO: a conexão aberta não aponta para "${execucao.banco}" — operação abortada antes de qualquer consulta.`);
      return CODIGOS_DE_SAIDA.falha;
    }
    if (execucao.modo === "dry-run") return relatarAvaliacao(escrever, await contexto.service.avaliar(pedido.valor.email), pedido.valor);

    const { senha } = pedido.valor;
    // `interpretarVariaveis` garante a senha no modo apply; a checagem só protege contra uma regressão futura.
    if (senha === null) throw new Error("Senha ausente no modo apply.");
    const resultado = await contexto.service.criar({ nome: pedido.valor.nome, email: pedido.valor.email, senha, executor: pedido.valor.executor });
    if (!resultado.criado) {
      escrever(`Já existe um usuário com este e-mail (${resultado.usuario.codigo}) — nada foi feito.`);
      return CODIGOS_DE_SAIDA.jaExiste;
    }
    escrever(`Administrador criado: ${resultado.usuario.codigo} <${resultado.usuario.email}>`);
    escrever(`  Perfil: ${resultado.usuario.tipo}; ativo: ${resultado.usuario.ativo}`);
    escrever("  Auditoria: ADMIN_CREATED registrado em eventos_auth.");
    return CODIGOS_DE_SAIDA.sucesso;
  } catch (erro) {
    if (erro instanceof FalhaAuditoriaCriacaoAdmin) {
      const causa = erro.causa instanceof Error ? `${erro.causa.name}: ${erro.causa.message}` : String(erro.causa);
      escrever(`Administrador criado: ${erro.usuario.codigo} <${erro.usuario.email}> — o usuário EXISTE e já pode entrar.`);
      escrever(`ERRO na auditoria: o evento ADMIN_CREATED não foi gravado (${ocultarSegredos(causa, execucao.uri)}).`);
      escrever("Uma nova execução NÃO grava o evento (o e-mail já existe): registre a criação manualmente.");
      return CODIGOS_DE_SAIDA.falha;
    }
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
