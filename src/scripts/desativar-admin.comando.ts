import type { INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { getConnectionToken } from "@nestjs/mongoose";
import type { Connection } from "mongoose";
import {
  DesativacaoAdminService,
  FalhaDesativacaoAdmin,
  type AvaliacaoDesativacao,
  type EtapaDesativacao,
  type ResultadoDesativacao,
} from "../modules/auth/desativacao-admin.service.js";
import { FORMATO_EMAIL_ADMIN, normalizarEmailAdmin, TAMANHO_MAXIMO_EMAIL } from "../modules/auth/usuario-admin.util.js";
import {
  interpretarArgumentosDeEscrita,
  ocultarSegredos,
  validarAmbienteDeEscrita,
  verificarExecucaoLocal,
  type AmbienteDeExecucao,
  type ExecucaoAutorizada,
  type OpcoesDeEscrita,
  type Resultado,
} from "./comando-local.util.js";
import { ComandoDesativarAdminModule } from "./desativar-admin.modulo.js";

/**
 * Fase 60.4.3.1.5 — lógica do comando `admin:desativar` (ponto de entrada: `desativar-admin.ts`). Mesmo modelo de
 * `processar-remocoes-pendentes.comando.ts`: toda validação de argumentos, variáveis e ambiente é pura e acontece
 * ANTES de qualquer conexão; sem `--apply`, só leitura.
 *
 * Variáveis: `ADMIN_EMAIL` (alvo, sempre); com `--apply`, também `ADMIN_DEACTIVATE_CONFIRM` (o MESMO e-mail,
 * repetido) e `ADMIN_DEACTIVATE_REASON` (motivo, auditado); `ADMIN_DEACTIVATE_EXECUTOR` é opcional (quem executou).
 * Nunca imprime a URI, credenciais, senha ou token.
 */

export const CODIGOS_DE_SAIDA = {
  /** Dry-run concluído com alvo ADMIN, ou desativação concluída sem sessões remanescentes. */
  sucesso: 0,
  /** Alvo recusado (inexistente ou não ADMIN), ou sessões ainda válidas depois da revogação. Nada foi alterado no 1º caso. */
  alvoRecusado: 1,
  /** Recusado ANTES de qualquer conexão (argumentos, variáveis ou ambiente inválidos). */
  recusado: 2,
  /** Falha durante a execução (conexão, banco divergente, persistência). A saída diz até onde chegou. */
  falha: 3,
} as const;

export const USO = [
  "Uso: bun run admin:desativar --banco <nome-do-banco> [--apply [--confirmar-producao <nome-do-banco>]]",
  "     (equivale a: bun run src/scripts/desativar-admin.ts ...)",
  "  ADMIN_EMAIL                  obrigatória: e-mail do ADMIN a desativar",
  "  ADMIN_DEACTIVATE_CONFIRM     obrigatória com --apply: repita EXATAMENTE o mesmo e-mail",
  "  ADMIN_DEACTIVATE_REASON      obrigatória com --apply: motivo (5 a 500 caracteres), gravado na auditoria",
  "  ADMIN_DEACTIVATE_EXECUTOR    opcional: identificação de quem executa (até 120 caracteres), gravada na auditoria",
  "  --banco <nome>               obrigatório; precisa ser EXATAMENTE o banco da MONGODB_URI configurada",
  "  --apply                      desativa (sem ele: dry-run, somente leitura)",
  "  --confirmar-producao <nome>  obrigatório junto com --apply em banco protegido (produção ou desconhecido); repita o nome exato",
  `  Códigos de saída: ${CODIGOS_DE_SAIDA.sucesso} sucesso | ${CODIGOS_DE_SAIDA.alvoRecusado} alvo recusado ou sessões remanescentes | ` +
    `${CODIGOS_DE_SAIDA.recusado} recusado antes de conectar | ${CODIGOS_DE_SAIDA.falha} falha na execução`,
].join("\n");

const ENTRADA_LOCAL_ESPERADA = "src/scripts/desativar-admin.ts";

export const LIMITES = { emailMaximo: TAMANHO_MAXIMO_EMAIL, motivoMinimo: 5, motivoMaximo: 500, executorMaximo: 120 } as const;

/** Fase 60.4.3.2.1 — argumentos e autorização compartilhados com `seed:admin` (`comando-local.util.ts`), sem mudança de regra. */
export { interpretarArgumentosDeEscrita as interpretarArgumentos, validarAmbienteDeEscrita as validarAmbiente };
export type { ExecucaoAutorizada, OpcoesDeEscrita as OpcoesComando };

export interface PedidoDesativacao {
  email: string;
  motivo: string | null;
  executor: string | null;
}

/** Valida as variáveis `ADMIN_*`. O e-mail do alvo pode aparecer na saída (não é segredo); motivo e executor não são ecoados em erros. */
export function interpretarVariaveis(variaveis: Readonly<Record<string, string | undefined>>, aplicar: boolean): Resultado<PedidoDesativacao> {
  const email = normalizarEmailAdmin(variaveis["ADMIN_EMAIL"] ?? "");
  if (!email) return { ok: false, erro: "Defina ADMIN_EMAIL com o e-mail do ADMIN a desativar." };
  if (email.length > LIMITES.emailMaximo || !FORMATO_EMAIL_ADMIN.test(email)) return { ok: false, erro: "ADMIN_EMAIL não tem formato de e-mail válido." };

  const executorBruto = (variaveis["ADMIN_DEACTIVATE_EXECUTOR"] ?? "").trim();
  if (executorBruto.length > LIMITES.executorMaximo) return { ok: false, erro: `ADMIN_DEACTIVATE_EXECUTOR excede ${LIMITES.executorMaximo} caracteres.` };
  const executor = executorBruto || null;

  if (!aplicar) return { ok: true, valor: { email, motivo: null, executor } };

  const confirmacao = variaveis["ADMIN_DEACTIVATE_CONFIRM"];
  if (confirmacao === undefined || confirmacao.trim() === "") {
    return { ok: false, erro: "--apply exige ADMIN_DEACTIVATE_CONFIRM com o MESMO e-mail de ADMIN_EMAIL (confirmação explícita)." };
  }
  if (normalizarEmailAdmin(confirmacao) !== email) return { ok: false, erro: "ADMIN_DEACTIVATE_CONFIRM não corresponde EXATAMENTE a ADMIN_EMAIL." };

  const motivo = (variaveis["ADMIN_DEACTIVATE_REASON"] ?? "").trim();
  if (motivo.length < LIMITES.motivoMinimo || motivo.length > LIMITES.motivoMaximo) {
    return { ok: false, erro: `--apply exige ADMIN_DEACTIVATE_REASON com ${LIMITES.motivoMinimo} a ${LIMITES.motivoMaximo} caracteres (motivo da desativação).` };
  }
  return { ok: true, valor: { email, motivo, executor } };
}

export interface ContextoDesativacao {
  service: Pick<DesativacaoAdminService, "avaliar" | "desativar">;
  conexao: Connection;
  fechar(): Promise<void>;
}

export type AbrirContexto = (uri: string) => Promise<ContextoDesativacao>;

/**
 * Contexto real: `ComandoDesativarAdminModule` conectado EXATAMENTE à URI validada, sem criar/sincronizar índices.
 * `aoConectar` (antes de compilar os models) e `aoCriar` (com o contexto pronto) são pontos de instrumentação.
 */
export function criarAbridorDeContexto(
  opcoes: { aoConectar?: (conexao: Connection) => void; aoCriar?: (app: INestApplicationContext) => void } = {},
): AbrirContexto {
  return async (uri) => {
    const app = await NestFactory.createApplicationContext(ComandoDesativarAdminModule.paraUri(uri, opcoes.aoConectar), { logger: false });
    opcoes.aoCriar?.(app);
    return { service: app.get(DesativacaoAdminService), conexao: app.get<Connection>(getConnectionToken()), fechar: () => app.close() };
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

function relatarAvaliacao(escrever: (linha: string) => void, avaliacao: AvaliacaoDesativacao, email: string): number {
  if (avaliacao.status === "nao_encontrado") {
    escrever(`[PREVISÃO] nenhum usuário com o e-mail ${email} — o --apply não faria nada.`);
    return CODIGOS_DE_SAIDA.alvoRecusado;
  }
  if (avaliacao.status === "nao_admin") {
    escrever(`[PREVISÃO] ${avaliacao.alvo.codigo} <${avaliacao.alvo.email}> não é ADMIN — este comando o recusaria.`);
    return CODIGOS_DE_SAIDA.alvoRecusado;
  }
  const { alvo, sessoesValidas, auditoriaRegistrada } = avaliacao;
  escrever(`Alvo: ${alvo.codigo} <${alvo.email}> — estado atual: ${avaliacao.status}; sessões válidas: ${sessoesValidas}; evento ADMIN_DEACTIVATED: ${auditoriaRegistrada ? "já registrado" : "não registrado"}`);
  if (avaliacao.status === "ativo") {
    escrever(`[PREVISÃO] o --apply gravaria ativo=false, revogaria ${sessoesValidas} sessão(ões) válida(s) e registraria ADMIN_DEACTIVATED.`);
  } else {
    escrever(
      `[PREVISÃO] já inativo: o --apply revogaria ${sessoesValidas} sessão(ões) remanescente(s)` +
        (auditoriaRegistrada ? (sessoesValidas > 0 ? " e registraria ADMIN_SESSIONS_REVOKED." : "; nenhum evento novo.") : " e registraria ADMIN_DEACTIVATED (reconciliado)."),
    );
  }
  escrever("Dry-run: nada foi alterado.");
  return CODIGOS_DE_SAIDA.sucesso;
}

function relatarResultado(escrever: (linha: string) => void, resultado: ResultadoDesativacao, email: string): number {
  if (resultado.status === "nao_encontrado") {
    escrever(`ERRO: nenhum usuário com o e-mail ${email} — nada foi alterado.`);
    return CODIGOS_DE_SAIDA.alvoRecusado;
  }
  if (resultado.status === "nao_admin") {
    escrever(`ERRO: ${resultado.alvo.codigo} <${resultado.alvo.email}> não é ADMIN — este comando só desativa administradores; nada foi alterado.`);
    return CODIGOS_DE_SAIDA.alvoRecusado;
  }
  const { alvo } = resultado;
  escrever(
    resultado.status === "desativado"
      ? `[RESULTADO] ${alvo.codigo} <${alvo.email}> desativado (ativo=false).`
      : `[RESULTADO] ${alvo.codigo} <${alvo.email}> já estava inativo — nenhuma transição.`,
  );
  escrever(`  Sessões revogadas nesta execução: ${resultado.sessoesRevogadas}`);
  escrever(`  Sessões ainda válidas depois da revogação: ${resultado.sessoesRemanescentes}`);
  const auditoria: Record<typeof resultado.auditoria, string> = {
    registrada: "ADMIN_DEACTIVATED registrado",
    reconciliada: "ADMIN_DEACTIVATED registrado agora (reconciliado: a desativação aconteceu antes)",
    ja_registrada: "ADMIN_DEACTIVATED já existia — não duplicado",
  };
  escrever(`  Auditoria: ${auditoria[resultado.auditoria]}${resultado.eventoDeSessoes ? "; ADMIN_SESSIONS_REVOKED registrado" : ""}`);
  escrever("  Login e renovação de sessão deste usuário passam a ser recusados. Access tokens já emitidos valem até expirar (JWT_ACCESS_EXPIRES_IN).");
  if (resultado.sessoesRemanescentes > 0) {
    escrever("ATENÇÃO: ainda há sessões válidas depois de duas revogações — execute de novo e investigue.");
    return CODIGOS_DE_SAIDA.alvoRecusado;
  }
  return CODIGOS_DE_SAIDA.sucesso;
}

const ESTADO_APOS_FALHA: Record<EtapaDesativacao, string> = {
  transicao: "Nada foi alterado: o usuário continua no estado anterior.",
  revogacao: "O usuário JÁ está inativo (login e renovação recusados), mas a revogação das sessões falhou. Execute de novo o mesmo comando.",
  verificacao: "O usuário está inativo e a revogação foi executada, mas a conferência das sessões falhou. Execute de novo o mesmo comando.",
  auditoria: "O usuário está inativo e as sessões foram revogadas, mas o evento de auditoria não foi gravado. Execute de novo o mesmo comando.",
};

/** Executa o comando e devolve o código de saída. Nunca escreve a URI, credenciais, senha ou token. */
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
  const uri = variaveis["MONGODB_URI"];
  const autorizacao = validarAmbienteDeEscrita(argumentos.valor, uri);
  if (!autorizacao.ok) {
    escrever(`ERRO: ${autorizacao.erro}`);
    escrever("Nenhuma conexão foi aberta: nada foi lido nem alterado.");
    return CODIGOS_DE_SAIDA.recusado;
  }
  const execucao = autorizacao.valor;
  const { email, motivo, executor } = pedido.valor;
  escrever(`Banco selecionado: ${execucao.banco}`);
  escrever(`Ambiente: ${execucao.ambiente === "teste" ? "teste (banco de teste em host local)" : "PROTEGIDO (produção ou banco não reconhecido como teste)"}`);
  escrever(execucao.modo === "apply" ? "Modo: apply (o usuário SERÁ desativado)" : "Modo: dry-run (somente leitura — nada será alterado)");
  escrever(`E-mail alvo: ${email}`);

  let contexto: ContextoDesativacao | null = null;
  try {
    contexto = await dependencias.abrirContexto(execucao.uri);
    if (contexto.conexao.name !== execucao.banco) {
      escrever(`ERRO: a conexão aberta não aponta para "${execucao.banco}" — operação abortada antes de qualquer consulta.`);
      return CODIGOS_DE_SAIDA.falha;
    }
    if (execucao.modo === "dry-run") return relatarAvaliacao(escrever, await contexto.service.avaliar(email), email);
    // `interpretarVariaveis` garante o motivo no modo apply; a checagem só protege contra uma regressão futura.
    if (motivo === null) throw new Error("Motivo ausente no modo apply.");
    return relatarResultado(escrever, await contexto.service.desativar({ email, motivo, executor }), email);
  } catch (erro) {
    if (erro instanceof FalhaDesativacaoAdmin) {
      const causa = erro.causa instanceof Error ? `${erro.causa.name}: ${erro.causa.message}` : String(erro.causa);
      escrever(`ERRO na etapa "${erro.etapa}": ${ocultarSegredos(causa, execucao.uri)}`);
      escrever(ESTADO_APOS_FALHA[erro.etapa]);
      if (erro.reivindicacaoPresa) {
        escrever("ATENÇÃO: a marca desativacaoAuditadaEm ficou gravada sem o evento — uma nova execução NÃO regrava o evento; exige intervenção manual.");
      }
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
