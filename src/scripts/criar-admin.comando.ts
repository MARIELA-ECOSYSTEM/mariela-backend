import { FalhaAuditoriaCriacaoAdmin } from "../modules/auth/provisionamento-admin.service.js";
import {
  analisarUri,
  BANCO_RECUSADO,
  classificarAmbiente,
  ocultarSegredos,
  validarAmbienteDeEscrita,
  verificarExecucaoLocal,
  type AmbienteDeExecucao,
  type Resultado,
} from "./comando-local.util.js";
import type { TerminalInterativo } from "./criar-admin.terminal.js";
import {
  interpretarVariaveis,
  validarEmailDoAdmin,
  validarNomeDoAdmin,
  validarSenhaDoAdmin,
  type AbrirContexto,
  type ContextoSeed,
} from "./seed-admin.comando.js";

/**
 * Comando interativo `admin:criar` (ponto de entrada: `criar-admin.ts`) — o MESMO provisionamento do `seed:admin`
 * (`ProvisionamentoAdminService` no contexto mínimo `ComandoSeedAdminModule`: hash Argon2id, idempotência por e-mail,
 * evento `ADMIN_CREATED`), mas com as respostas digitadas em vez de variáveis `ADMIN_*`.
 *
 * Mesmas guardas, reaproveitadas de `comando-local.util.ts` e `seed-admin.comando.ts`: execução só local a partir do
 * código-fonte; `mariela_dev_local` recusado; o nome do banco DIGITADO precisa ser exatamente o da URI (equivale a
 * `--banco`); em banco protegido, o nome é digitado uma segunda vez (equivale a `--confirmar-producao`); antes de
 * escrever, um dry-run (leitura) e uma confirmação final explícita. Cancelar em qualquer etapa não escreve nada.
 *
 * Configuração: a `MONGODB_URI` vem do ambiente do processo e, só na falta dela, da chave `MONGODB_URI` do `.env` do
 * backend — NENHUMA outra chave do arquivo é lida (o `bun` roda com `--no-env-file`). Variáveis `ADMIN_*` são
 * ignoradas. Nunca imprime a senha, o hash, a URI ou credenciais.
 */

export const CODIGOS_DE_SAIDA = {
  sucesso: 0,
  /** Já existe um usuário com este e-mail — nada foi alterado. */
  jaExiste: 1,
  /** Recusado pelas guardas (ambiente, terminal, configuração, banco ou dados inválidos) — nada foi alterado. */
  recusado: 2,
  /** Falha durante a execução (conexão, persistência ou auditoria). A saída diz o estado. */
  falha: 3,
  /** O operador cancelou — nada foi alterado. */
  cancelado: 4,
} as const;

const ENTRADA_LOCAL_ESPERADA = "src/scripts/criar-admin.ts";
/** Tentativas por campo antes de desistir (digitação errada não deve exigir recomeçar tudo). */
export const TENTATIVAS_POR_CAMPO = 3;
export const PALAVRA_DE_CONFIRMACAO = "CRIAR";

export type OrigemUri = "ambiente" | "arquivo-env";

/**
 * Extrai SÓ o valor de `MONGODB_URI` do conteúdo de um `.env` (última ocorrência vale, como no carregador do Bun).
 * Aceita `export `, aspas simples/duplas e comentário após valor sem aspas. Recusa interpolação `${...}` (o valor real
 * dependeria de outras chaves, que este comando não lê). Nunca devolve outras chaves.
 */
export function extrairMongodbUriDoEnv(conteudo: string): Resultado<string> | null {
  let encontrado: string | null = null;
  for (const linhaBruta of conteudo.split(/\r?\n/)) {
    const linha = linhaBruta.trim().replace(/^export\s+/, "");
    const correspondencia = /^MONGODB_URI\s*=(.*)$/.exec(linha);
    if (!correspondencia) continue;
    let valor = (correspondencia[1] ?? "").trim();
    const aspas = valor[0];
    if ((aspas === '"' || aspas === "'") && valor.indexOf(aspas, 1) > 0) {
      valor = valor.slice(1, valor.indexOf(aspas, 1));
    } else {
      valor = valor.replace(/\s+#.*$/, "").trim();
    }
    encontrado = valor;
  }
  if (encontrado === null || encontrado === "") return null;
  if (encontrado.includes("${")) return { ok: false, erro: "A MONGODB_URI do .env usa interpolação (${...}); defina MONGODB_URI no ambiente do terminal." };
  return { ok: true, valor: encontrado };
}

/** Ambiente do processo primeiro; `.env` (só a chave `MONGODB_URI`) como alternativa. Nunca devolve a URI na mensagem. */
export function resolverUri(
  variaveis: Readonly<Record<string, string | undefined>>,
  lerArquivoEnv: () => string | null,
): Resultado<{ uri: string; origem: OrigemUri }> {
  const doAmbiente = variaveis["MONGODB_URI"]?.trim();
  if (doAmbiente) return { ok: true, valor: { uri: doAmbiente, origem: "ambiente" } };
  const conteudo = lerArquivoEnv();
  const doArquivo = conteudo === null ? null : extrairMongodbUriDoEnv(conteudo);
  if (doArquivo === null) return { ok: false, erro: "MONGODB_URI não está definida no ambiente do terminal nem no arquivo .env do backend." };
  if (!doArquivo.ok) return doArquivo;
  return { ok: true, valor: { uri: doArquivo.valor, origem: "arquivo-env" } };
}

export interface DependenciasComando {
  terminal: TerminalInterativo;
  escrever: (linha: string) => void;
  /** Variáveis do processo: só `MONGODB_URI` é lida (e os sinais de ambiente implantado, via `execucao`). */
  variaveis: Readonly<Record<string, string | undefined>>;
  /** Conteúdo do `.env` do backend, ou `null` se não existir. Só é chamado na falta de `MONGODB_URI` no ambiente. */
  lerArquivoEnv: () => string | null;
  /** O MESMO abridor do `seed:admin` (contexto mínimo `ComandoSeedAdminModule`). */
  abrirContexto: AbrirContexto;
  execucao: AmbienteDeExecucao;
}

class Cancelado extends Error {}
class Recusado extends Error {}

/** Pergunta até obter um valor válido (ou esgotar as tentativas). Erros de validação nunca contêm o valor digitado. */
async function perguntarValidado(
  deps: DependenciasComando,
  pergunta: string,
  validar: (valor: string) => Resultado<string>,
  oculto = false,
): Promise<string> {
  for (let tentativa = 1; tentativa <= TENTATIVAS_POR_CAMPO; tentativa++) {
    const resposta = oculto ? await deps.terminal.perguntarOculto(pergunta) : await deps.terminal.perguntar(pergunta);
    if (resposta === null) throw new Cancelado();
    const resultado = validar(resposta);
    if (resultado.ok) return resultado.valor;
    deps.escrever(`  ${resultado.erro}`);
  }
  throw new Recusado(`Dados inválidos após ${TENTATIVAS_POR_CAMPO} tentativas.`);
}

async function perguntarSenhaConfirmada(deps: DependenciasComando): Promise<string> {
  for (let tentativa = 1; tentativa <= TENTATIVAS_POR_CAMPO; tentativa++) {
    const senha = await perguntarValidado(deps, "Senha (8 a 200 caracteres; não aparece na tela): ", (valor) => validarSenhaDoAdmin(valor, "A senha"), true);
    const confirmacao = await deps.terminal.perguntarOculto("Repita a senha: ");
    if (confirmacao === null) throw new Cancelado();
    if (confirmacao === senha) return senha;
    deps.escrever("  As senhas não conferem. Digite as duas de novo.");
  }
  throw new Recusado(`As senhas não conferiram em ${TENTATIVAS_POR_CAMPO} tentativas.`);
}

async function confirmarNomeDoBanco(deps: DependenciasComando, pergunta: string, banco: string): Promise<string> {
  const digitado = await deps.terminal.perguntar(pergunta);
  if (digitado === null) throw new Cancelado();
  if (digitado.trim() !== banco) throw new Recusado(`O nome digitado não é exatamente "${banco}".`);
  return digitado.trim();
}

/** Executa o fluxo e devolve o código de saída. Nunca escreve a senha, o hash, a URI ou credenciais. */
export async function executarComando(deps: DependenciasComando): Promise<number> {
  const { escrever } = deps;
  const nadaAlterado = "Nada foi alterado.";

  // 1) Guardas que não dependem de resposta nenhuma — antes de qualquer pergunta ou conexão.
  const local = verificarExecucaoLocal(deps.execucao, ENTRADA_LOCAL_ESPERADA);
  if (!local.ok) {
    escrever(`ERRO: ${local.erro}`);
    escrever(`Nenhuma conexão foi aberta. ${nadaAlterado}`);
    return CODIGOS_DE_SAIDA.recusado;
  }
  if (!deps.terminal.interativo) {
    escrever("ERRO: este comando precisa de um terminal interativo (a senha é digitada sem eco). Entrada por arquivo ou pipe é recusada.");
    escrever(`Nenhuma conexão foi aberta. ${nadaAlterado}`);
    return CODIGOS_DE_SAIDA.recusado;
  }
  const configuracao = resolverUri(deps.variaveis, deps.lerArquivoEnv);
  if (!configuracao.ok) {
    escrever(`ERRO: ${configuracao.erro}`);
    escrever(`Nenhuma conexão foi aberta. ${nadaAlterado}`);
    return CODIGOS_DE_SAIDA.recusado;
  }
  const { uri, origem } = configuracao.valor;
  const analise = analisarUri(uri);
  // `validarAmbienteDeEscrita` em modo leitura recusa URI sem banco e `mariela_dev_local` (a escrita é validada de novo adiante).
  const previa = validarAmbienteDeEscrita({ banco: analise?.banco ?? BANCO_RECUSADO, aplicar: false, confirmacaoProducao: null }, uri);
  if (!analise || !previa.ok) {
    escrever(`ERRO: ${previa.ok ? "MONGODB_URI não tem um nome de banco reconhecível (a URI não é exibida)." : previa.erro}`);
    escrever(`Nenhuma conexão foi aberta. ${nadaAlterado}`);
    return CODIGOS_DE_SAIDA.recusado;
  }
  const banco = analise.banco;
  const protegido = classificarAmbiente(analise) === "protegido";

  escrever("Criação de ADMIN do MARIELA Backoffice — operação exclusiva do desenvolvedor.");
  escrever("Ctrl+C cancela em qualquer pergunta; nada é gravado antes da confirmação final.");

  let contexto: ContextoSeed | null = null;
  // Guardada fora do `try` só para ser apagada de qualquer mensagem de erro (defesa extra além da URI).
  let senhaDigitada: string | null = null;
  const ocultar = (texto: string) => {
    const semUri = ocultarSegredos(texto, uri);
    return senhaDigitada ? semUri.split(senhaDigitada).join("<oculto>") : semUri;
  };
  try {
    // 2) Dados do novo ADMIN (mesmas regras do `seed:admin`).
    const email = await perguntarValidado(deps, "E-mail do novo ADMIN: ", (valor) => validarEmailDoAdmin(valor, "O e-mail"));
    const nome = await perguntarValidado(deps, "Nome: ", (valor) => validarNomeDoAdmin(valor, "O nome"));
    const senha = await perguntarSenhaConfirmada(deps);
    senhaDigitada = senha;

    // 3) Banco de destino: nome visível, URI nunca.
    escrever("");
    escrever(`Banco de destino: ${banco}`);
    escrever(`Ambiente: ${protegido ? "PROTEGIDO (produção ou banco não reconhecido como teste local)" : "teste (banco de teste em host local)"}`);
    escrever(`Configuração lida de: ${origem === "ambiente" ? "variável MONGODB_URI do terminal" : "chave MONGODB_URI do arquivo .env do backend"} (a URI não é exibida)`);
    const bancoConfirmado = await confirmarNomeDoBanco(deps, "Digite o nome do banco de destino para confirmar: ", banco);
    let confirmacaoProducao: string | null = null;
    if (protegido) {
      escrever(`ATENÇÃO: "${banco}" é um banco PROTEGIDO. A escrita só é autorizada com o nome digitado de novo.`);
      confirmacaoProducao = await confirmarNomeDoBanco(deps, "Digite novamente o nome exato do banco para autorizar a escrita: ", banco);
    }

    // 4) As MESMAS guardas do `seed:admin --apply` (banco = URI, dev_local, confirmação de produção) e do pedido.
    const autorizacao = validarAmbienteDeEscrita({ banco: bancoConfirmado, aplicar: true, confirmacaoProducao }, uri);
    if (!autorizacao.ok) throw new Recusado(autorizacao.erro);
    const pedido = interpretarVariaveis({ ADMIN_EMAIL: email, ADMIN_NAME: nome, ADMIN_PASSWORD: senha, ADMIN_SEED_CONFIRM: email }, true);
    if (!pedido.ok) throw new Recusado(pedido.erro);

    // 5) Dry-run (somente leitura) no banco confirmado.
    contexto = await deps.abrirContexto(autorizacao.valor.uri);
    if (contexto.conexao.name !== banco) {
      escrever(`ERRO: a conexão aberta não aponta para "${banco}" — operação abortada antes de qualquer consulta. ${nadaAlterado}`);
      return CODIGOS_DE_SAIDA.falha;
    }
    const avaliacao = await contexto.service.avaliar(email);
    if (avaliacao.status === "existe") {
      const { usuario } = avaliacao;
      escrever(`Já existe um usuário com este e-mail (${usuario.codigo}, tipo ${usuario.tipo}, ativo=${usuario.ativo}). ${nadaAlterado}`);
      return CODIGOS_DE_SAIDA.jaExiste;
    }

    // 6) Resumo (só dados não sensíveis) e confirmação final explícita.
    escrever("");
    escrever("Resumo:");
    escrever(`  E-mail: ${avaliacao.email}`);
    escrever(`  Nome: ${pedido.valor.nome}`);
    escrever("  Perfil: ADMIN; ativo: true");
    escrever(`  Código previsto: ${avaliacao.proximoCodigo} (o número só é reservado na criação)`);
    escrever("  Senha: definida (não exibida)");
    escrever(`  Banco: ${banco}${protegido ? " (PROTEGIDO)" : ""}`);
    const final = await deps.terminal.perguntar(`Digite ${PALAVRA_DE_CONFIRMACAO} para criar o ADMIN (qualquer outra resposta cancela): `);
    if (final === null || final.trim() !== PALAVRA_DE_CONFIRMACAO) throw new Cancelado();

    // 7) Criação — a regra é a do `ProvisionamentoAdminService` (idempotente; grava ADMIN_CREATED).
    const resultado = await contexto.service.criar({ nome: pedido.valor.nome, email, senha, executor: null });
    if (!resultado.criado) {
      escrever(`Já existe um usuário com este e-mail (${resultado.usuario.codigo}) — criado por outra execução neste intervalo. ${nadaAlterado}`);
      return CODIGOS_DE_SAIDA.jaExiste;
    }
    escrever(`Administrador criado: ${resultado.usuario.codigo} <${resultado.usuario.email}>`);
    escrever(`  Perfil: ${resultado.usuario.tipo}; ativo: ${resultado.usuario.ativo}`);
    escrever("  Auditoria: ADMIN_CREATED registrado em eventos_auth.");
    return CODIGOS_DE_SAIDA.sucesso;
  } catch (erro) {
    if (erro instanceof Cancelado) {
      escrever(`Cancelado pelo operador. ${nadaAlterado}`);
      return CODIGOS_DE_SAIDA.cancelado;
    }
    if (erro instanceof Recusado) {
      escrever(`ERRO: ${erro.message} ${nadaAlterado}`);
      return CODIGOS_DE_SAIDA.recusado;
    }
    if (erro instanceof FalhaAuditoriaCriacaoAdmin) {
      const causa = erro.causa instanceof Error ? `${erro.causa.name}: ${erro.causa.message}` : String(erro.causa);
      escrever(`Administrador criado: ${erro.usuario.codigo} <${erro.usuario.email}> — o usuário EXISTE e já pode entrar.`);
      escrever(`ERRO na auditoria: o evento ADMIN_CREATED não foi gravado (${ocultar(causa)}).`);
      escrever("Uma nova execução NÃO grava o evento (o e-mail já existe): registre a criação manualmente.");
      return CODIGOS_DE_SAIDA.falha;
    }
    const descricao = erro instanceof Error ? `${erro.name}: ${erro.message}` : String(erro);
    escrever(`ERRO durante a execução: ${ocultar(descricao)}`);
    return CODIGOS_DE_SAIDA.falha;
  } finally {
    senhaDigitada = null;
    if (contexto) {
      try {
        await contexto.fechar();
      } catch (erro) {
        escrever(`AVISO: falha ao encerrar a conexão: ${ocultarSegredos(erro instanceof Error ? erro.message : String(erro), uri)}`);
      }
    }
  }
}
