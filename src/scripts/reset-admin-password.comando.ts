import type { INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { getConnectionToken } from "@nestjs/mongoose";
import type { Connection } from "mongoose";
import {
  FalhaRedefinicaoSenhaAdmin,
  RedefinicaoSenhaAdminService,
  type AvaliacaoRedefinicao,
  type EtapaRedefinicao,
  type ResultadoRedefinicao,
} from "../modules/auth/redefinicao-senha-admin.service.js";
import { FORMATO_EMAIL_ADMIN, normalizarEmailAdmin, TAMANHO_MAXIMO_EMAIL } from "../modules/auth/usuario-admin.util.js";
import {
  interpretarArgumentosDeEscrita,
  ocultarSegredos,
  validarAmbienteDeEscrita,
  verificarExecucaoLocal,
  type AmbienteDeExecucao,
  type Resultado,
} from "./comando-local.util.js";
import { ComandoResetSenhaAdminModule } from "./reset-admin-password.modulo.js";

/**
 * Lógica do comando `admin:reset-password` (ponto de entrada: `reset-admin-password.ts`). Mesmas guardas de
 * `seed:admin` e `admin:desativar` (`comando-local.util.ts`): execução só local a partir do código-fonte, `--banco`
 * obrigatório e igual ao banco da URI, dry-run por padrão, `--apply` + `--confirmar-producao` em banco protegido.
 * Toda validação acontece ANTES de qualquer conexão.
 *
 * Variáveis: `ADMIN_EMAIL` (sempre); com `--apply`, também `ADMIN_PASSWORD` (8 a 200) e `ADMIN_RESET_CONFIRM` (o
 * MESMO e-mail, repetido); `ADMIN_RESET_EXECUTOR` é opcional (quem executou, gravado no evento). Nunca imprime a
 * senha, o hash, a URI, credenciais ou token.
 */

export const CODIGOS_DE_SAIDA = {
  /** Dry-run com alvo ADMIN, ou senha redefinida sem sessões remanescentes. */
  sucesso: 0,
  /** Alvo recusado (inexistente ou não ADMIN — nada alterado), ou sessões ainda válidas depois da revogação. */
  alvoRecusado: 1,
  /** Recusado ANTES de qualquer conexão (argumentos, variáveis ou ambiente inválidos). */
  recusado: 2,
  /** Falha durante a execução (conexão, banco divergente, persistência). A saída diz até onde chegou. */
  falha: 3,
} as const;

export const USO = [
  "Uso: bun run admin:reset-password --banco <nome-do-banco> [--apply [--confirmar-producao <nome-do-banco>]]",
  "     (equivale a: bun --no-env-file src/scripts/reset-admin-password.ts ...)",
  "  ADMIN_EMAIL                  obrigatória: e-mail do ADMIN",
  "  ADMIN_PASSWORD               obrigatória com --apply: nova senha (8 a 200 caracteres; nunca exibida)",
  "  ADMIN_RESET_CONFIRM          obrigatória com --apply: repita EXATAMENTE o mesmo e-mail",
  "  ADMIN_RESET_EXECUTOR         opcional: identificação de quem executa (até 120 caracteres), gravada na auditoria",
  "  --banco <nome>               obrigatório; precisa ser EXATAMENTE o banco da MONGODB_URI configurada",
  "  --apply                      redefine a senha (sem ele: dry-run, somente leitura)",
  "  --confirmar-producao <nome>  obrigatório junto com --apply em banco protegido (produção ou desconhecido); repita o nome exato",
  `  Códigos de saída: ${CODIGOS_DE_SAIDA.sucesso} sucesso | ${CODIGOS_DE_SAIDA.alvoRecusado} alvo recusado ou sessões remanescentes | ` +
    `${CODIGOS_DE_SAIDA.recusado} recusado antes de conectar | ${CODIGOS_DE_SAIDA.falha} falha na execução`,
].join("\n");

const ENTRADA_LOCAL_ESPERADA = "src/scripts/reset-admin-password.ts";

/** `senhaMaxima` = limite do `LoginDto` (uma senha maior nunca conseguiria fazer login). */
export const LIMITES = { emailMaximo: TAMANHO_MAXIMO_EMAIL, senhaMinima: 8, senhaMaxima: 200, executorMaximo: 120 } as const;

export interface PedidoRedefinicao {
  email: string;
  /** Presente sempre no modo apply; no dry-run, só se informada (e então já validada). */
  senha: string | null;
  executor: string | null;
}

/** Valida as variáveis `ADMIN_*`. Nenhuma mensagem ecoa a senha. */
export function interpretarVariaveis(variaveis: Readonly<Record<string, string | undefined>>, aplicar: boolean): Resultado<PedidoRedefinicao> {
  const email = normalizarEmailAdmin(variaveis["ADMIN_EMAIL"] ?? "");
  if (!email) return { ok: false, erro: "Defina ADMIN_EMAIL com o e-mail do ADMIN." };
  if (email.length > LIMITES.emailMaximo || !FORMATO_EMAIL_ADMIN.test(email)) return { ok: false, erro: "ADMIN_EMAIL não tem formato de e-mail válido." };

  const executorBruto = (variaveis["ADMIN_RESET_EXECUTOR"] ?? "").trim();
  if (executorBruto.length > LIMITES.executorMaximo) return { ok: false, erro: `ADMIN_RESET_EXECUTOR excede ${LIMITES.executorMaximo} caracteres.` };
  const executor = executorBruto || null;

  const senhaInformada = variaveis["ADMIN_PASSWORD"];
  const senha = senhaInformada === undefined || senhaInformada === "" ? null : senhaInformada;
  if (senha !== null && (senha.length < LIMITES.senhaMinima || senha.length > LIMITES.senhaMaxima)) {
    return { ok: false, erro: `ADMIN_PASSWORD deve ter de ${LIMITES.senhaMinima} a ${LIMITES.senhaMaxima} caracteres (o valor não é exibido).` };
  }
  if (!aplicar) return { ok: true, valor: { email, senha, executor } };

  if (senha === null) return { ok: false, erro: "--apply exige ADMIN_PASSWORD." };
  const confirmacao = variaveis["ADMIN_RESET_CONFIRM"];
  if (confirmacao === undefined || confirmacao.trim() === "") {
    return { ok: false, erro: "--apply exige ADMIN_RESET_CONFIRM com o MESMO e-mail de ADMIN_EMAIL (confirmação explícita)." };
  }
  if (normalizarEmailAdmin(confirmacao) !== email) return { ok: false, erro: "ADMIN_RESET_CONFIRM não corresponde EXATAMENTE a ADMIN_EMAIL." };
  return { ok: true, valor: { email, senha, executor } };
}

export interface ContextoRedefinicao {
  service: Pick<RedefinicaoSenhaAdminService, "avaliar" | "redefinir">;
  conexao: Connection;
  fechar(): Promise<void>;
}

export type AbrirContexto = (uri: string) => Promise<ContextoRedefinicao>;

/**
 * Contexto real: `ComandoResetSenhaAdminModule` conectado EXATAMENTE à URI validada, sem criar coleções nem índices.
 * `aoConectar` (antes de compilar os models) e `aoCriar` (com o contexto pronto) são pontos de instrumentação.
 */
export function criarAbridorDeContexto(
  opcoes: { aoConectar?: (conexao: Connection) => void; aoCriar?: (app: INestApplicationContext) => void } = {},
): AbrirContexto {
  return async (uri) => {
    const app = await NestFactory.createApplicationContext(ComandoResetSenhaAdminModule.paraUri(uri, opcoes.aoConectar), { logger: false });
    opcoes.aoCriar?.(app);
    return { service: app.get(RedefinicaoSenhaAdminService), conexao: app.get<Connection>(getConnectionToken()), fechar: () => app.close() };
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

function relatarAvaliacao(escrever: (linha: string) => void, avaliacao: AvaliacaoRedefinicao, pedido: PedidoRedefinicao): number {
  if (avaliacao.status === "nao_encontrado") {
    escrever(`[PREVISÃO] nenhum usuário com o e-mail ${pedido.email} — o --apply não faria nada.`);
    return CODIGOS_DE_SAIDA.alvoRecusado;
  }
  if (avaliacao.status === "nao_admin") {
    escrever(`[PREVISÃO] ${avaliacao.alvo.codigo} <${avaliacao.alvo.email}> não é ADMIN — este comando o recusaria.`);
    return CODIGOS_DE_SAIDA.alvoRecusado;
  }
  const { alvo, sessoesValidas } = avaliacao;
  escrever(`Alvo: ${alvo.codigo} <${alvo.email}> — ativo: ${alvo.ativo}; sessões válidas: ${sessoesValidas}`);
  escrever(`[PREVISÃO] o --apply gravaria a nova senha, revogaria ${sessoesValidas} sessão(ões) válida(s) e registraria ADMIN_PASSWORD_RESET.`);
  if (!alvo.ativo) escrever("  Aviso: o usuário está INATIVO — a senha nova não permite login enquanto ele estiver desativado.");
  escrever(pedido.senha === null ? "  ADMIN_PASSWORD: não informada (obrigatória no --apply)." : "  ADMIN_PASSWORD: informada e com tamanho válido (valor não exibido).");
  escrever("Dry-run: nada foi alterado.");
  return CODIGOS_DE_SAIDA.sucesso;
}

function relatarResultado(escrever: (linha: string) => void, resultado: ResultadoRedefinicao, email: string): number {
  if (resultado.status === "nao_encontrado") {
    escrever(`ERRO: nenhum usuário com o e-mail ${email} — nada foi alterado.`);
    return CODIGOS_DE_SAIDA.alvoRecusado;
  }
  if (resultado.status === "nao_admin") {
    escrever(`ERRO: ${resultado.alvo.codigo} <${resultado.alvo.email}> não é ADMIN — este comando só redefine a senha de administradores; nada foi alterado.`);
    return CODIGOS_DE_SAIDA.alvoRecusado;
  }
  const { alvo } = resultado;
  escrever(`[RESULTADO] senha de ${alvo.codigo} <${alvo.email}> redefinida.`);
  escrever(`  Sessões revogadas nesta execução: ${resultado.sessoesRevogadas}`);
  escrever(`  Sessões ainda válidas depois da revogação: ${resultado.sessoesRemanescentes}`);
  escrever("  Auditoria: ADMIN_PASSWORD_RESET registrado em eventos_auth.");
  escrever("  Access tokens já emitidos valem até expirar (JWT_ACCESS_EXPIRES_IN).");
  if (!alvo.ativo) escrever("  Aviso: o usuário está INATIVO — a senha nova não permite login enquanto ele estiver desativado.");
  if (resultado.sessoesRemanescentes > 0) {
    escrever("ATENÇÃO: ainda há sessões válidas depois de duas revogações — execute de novo e investigue.");
    return CODIGOS_DE_SAIDA.alvoRecusado;
  }
  return CODIGOS_DE_SAIDA.sucesso;
}

const ESTADO_APOS_FALHA: Record<EtapaRedefinicao, string> = {
  senha: "Nada foi alterado: a senha anterior continua valendo.",
  revogacao: "A senha nova JÁ está gravada, mas a revogação das sessões falhou. Execute de novo o mesmo comando.",
  auditoria: "A senha nova JÁ está gravada e as sessões foram revogadas, mas o evento ADMIN_PASSWORD_RESET não foi gravado. Execute de novo o mesmo comando.",
};

/** Executa o comando e devolve o código de saída. Nunca escreve a senha, o hash, a URI, credenciais ou token. */
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
  const { email, senha, executor } = pedido.valor;
  escrever(`Banco selecionado: ${execucao.banco}`);
  escrever(`Ambiente: ${execucao.ambiente === "teste" ? "teste (banco de teste em host local)" : "PROTEGIDO (produção ou banco não reconhecido como teste)"}`);
  escrever(execucao.modo === "apply" ? "Modo: apply (a senha SERÁ redefinida e as sessões revogadas)" : "Modo: dry-run (somente leitura — nada será alterado)");
  escrever(`E-mail alvo: ${email}`);

  let contexto: ContextoRedefinicao | null = null;
  try {
    contexto = await dependencias.abrirContexto(execucao.uri);
    if (contexto.conexao.name !== execucao.banco) {
      escrever(`ERRO: a conexão aberta não aponta para "${execucao.banco}" — operação abortada antes de qualquer consulta.`);
      return CODIGOS_DE_SAIDA.falha;
    }
    if (execucao.modo === "dry-run") return relatarAvaliacao(escrever, await contexto.service.avaliar(email), pedido.valor);
    // `interpretarVariaveis` garante a senha no modo apply; a checagem só protege contra uma regressão futura.
    if (senha === null) throw new Error("Senha ausente no modo apply.");
    return relatarResultado(escrever, await contexto.service.redefinir({ email, senha, executor }), email);
  } catch (erro) {
    if (erro instanceof FalhaRedefinicaoSenhaAdmin) {
      const causa = erro.causa instanceof Error ? `${erro.causa.name}: ${erro.causa.message}` : String(erro.causa);
      escrever(`ERRO na etapa "${erro.etapa}": ${ocultarSegredos(causa, execucao.uri)}`);
      escrever(ESTADO_APOS_FALHA[erro.etapa]);
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
