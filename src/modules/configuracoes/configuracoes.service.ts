import { randomUUID } from "node:crypto";
import { forwardRef, Inject, Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { mongo, type Model } from "mongoose";
import { ApiException } from "../../common/exceptions/api.exception.js";
import { MovimentosCaixaRepository } from "../caixas/movimentos-caixa.repository.js";
import { ProdutosRepository } from "../produtos/produtos.repository.js";
import { normalizarCategoria, normalizarCor, normalizarFormaPagamento, normalizarTamanho } from "../produtos/utils/normalizacao.util.js";
import { VendasRepository } from "../vendas/vendas.repository.js";
import { CAMPOS_LISTA, type CampoLista } from "./configuracoes.constants.js";
import {
  ConfiguracoesRepository,
  normalizarItemLista,
  type RemocaoPendenteMalformada,
  type RemocaoPendenteValida,
} from "./configuracoes.repository.js";
import type { DadosLoja } from "./configuracoes.types.js";
import type { AtualizarLojaDto } from "./dto/atualizar-loja.dto.js";
import type { ConfiguracaoDocument } from "./schemas/configuracao.schema.js";
import { EventoConfiguracao, type EventoConfiguracaoDocument } from "./schemas/evento-configuracao.schema.js";

type ListaProtegidaContraExclusao = "cores" | "tamanhos" | "categorias" | "formasPagamento";

/** As listas sujeitas à proteção contra exclusão com vínculo (Fase 54.0 — cores/tamanhos; Fase 55.1 — categorias; Fase 55.2 — formas de pagamento). Ver `garantirSemVinculo`. */
const MENSAGEM_VINCULO: Record<ListaProtegidaContraExclusao, string> = {
  cores:
    "Não foi possível excluir esta cor porque existem produtos vinculados a ela no sistema. Remova ou altere os vínculos antes de tentar novamente.",
  tamanhos:
    "Não foi possível excluir este tamanho porque existem produtos vinculados a ele no sistema. Remova ou altere os vínculos antes de tentar novamente.",
  categorias:
    "Não foi possível excluir esta categoria porque existem produtos vinculados a ela no sistema. Remova ou altere os vínculos antes de tentar novamente.",
  formasPagamento:
    "Não foi possível excluir esta forma de pagamento porque existem vendas ou movimentações financeiras vinculadas a ela. Verifique os vínculos antes de tentar novamente.",
};

function ehListaProtegidaContraExclusao(campo: CampoLista): campo is ListaProtegidaContraExclusao {
  return campo === "cores" || campo === "tamanhos" || campo === "categorias" || campo === "formasPagamento";
}

/** Fase 56.4.1 — limite de tentativas da remoção, da rechecagem de vínculos e da restauração (compensação). */
const MAXIMO_TENTATIVAS = 3;

/**
 * Fase 56.4.1 — códigos que o próprio driver (`mongodb` 7.5.0,
 * `lib/error.js`: `RETRYABLE_READ_ERROR_CODES`, idêntico a
 * `RETRYABLE_WRITE_ERROR_CODES`) considera repetíveis: HostUnreachable(6),
 * HostNotFound(7), NetworkTimeout(89), ShutdownInProgress(91),
 * PrimarySteppedDown(189), ExceededTimeLimit(262), SocketException(9001),
 * NotWritablePrimary(10107), InterruptedAtShutdown(11600),
 * InterruptedDueToReplStateChange(11602), NotPrimaryNoSecondaryOk(13435),
 * NotPrimaryOrSecondary(13436), ReadConcernMajorityNotAvailableYet(134).
 * Replicados aqui porque `isRetryableReadError`/`isRetryableWriteError` são
 * internos do driver (não fazem parte da API pública).
 */
const CODIGOS_MONGO_TRANSITORIOS = new Set([6, 7, 89, 91, 189, 262, 9001, 10107, 11600, 11602, 13435, 13436, 134]);

/**
 * Erro transitório do MongoDB — o único tipo que é repetido. Mesma regra do
 * driver: falha de rede (`MongoNetworkError`, inclui timeout de socket), sem
 * servidor disponível (`MongoServerSelectionError`), rótulos de escrita
 * repetível (`RetryableWriteError`/`PoolRequestedRetry`) ou um dos códigos
 * acima. Nunca: `ApiException` (negócio), erros de validação do Mongoose,
 * chave duplicada ou qualquer outro código do servidor.
 */
function ehErroTransitorioMongo(erro: unknown): boolean {
  if (erro instanceof mongo.MongoNetworkError || erro instanceof mongo.MongoServerSelectionError) return true;
  if (!(erro instanceof mongo.MongoError)) return false;
  if (erro.hasErrorLabel("RetryableWriteError") || erro.hasErrorLabel("PoolRequestedRetry")) return true;
  return typeof erro.code === "number" && CODIGOS_MONGO_TRANSITORIOS.has(erro.code);
}

function descreverErro(erro: unknown): string {
  return erro instanceof Error ? `${erro.name}: ${erro.message}` : String(erro);
}

type VerificacaoVinculo = { situacao: "com_vinculo" } | { situacao: "sem_vinculo" } | { situacao: "indeterminado"; erro: unknown };

type Restauracao = { ok: true; tentativas: number; pendenciaEncerradaPorOutraExecucao: boolean } | { ok: false; tentativas: number; erro: unknown };

/** Fase 56.4.2 — remoção gravada junto com a pendência: documento depois do `$pull` e posição registrada. */
type RemocaoRegistrada = { documento: ConfiguracaoDocument; posicao: number | null };

/**
 * Fase 56.4.2 — desfecho de cada pendência em `processarRemocoesPendentes`:
 * - `restaurada`: havia vínculo — item restaurado e pendência encerrada na mesma escrita;
 * - `finalizada`: sem vínculo — item continua removido, pendência encerrada;
 * - `ja_concluida`: outra execução concluiu a pendência antes (nada gravado);
 * - `mantida_falha_consulta` / `mantida_falha_restauracao` / `mantida_falha_finalizacao`: pendência intacta, com log.
 */
export type DesfechoRemocaoPendente =
  | "restaurada"
  | "finalizada"
  | "ja_concluida"
  | "mantida_falha_consulta"
  | "mantida_falha_restauracao"
  | "mantida_falha_finalizacao";

export interface ResultadoProcessamentoRemocoes {
  processadas: { opId: string; lista: CampoLista; valor: string; desfecho: DesfechoRemocaoPendente }[];
  malformadas: RemocaoPendenteMalformada[];
}

const NOMES_LISTA: Record<CampoLista, string> = {
  categorias: "categorias",
  tamanhos: "tamanhos",
  cores: "cores",
  formasPagamento: "formas de pagamento",
};

/** Nomes (nunca valores) dos campos de `DadosLoja` cujo conteúdo difere entre dois estados — endereço aninhado como `endereco.<campo>`. */
function camposLojaAlterados(anterior: DadosLoja, novo: DadosLoja): string[] {
  const alterados: string[] = [];
  for (const campo of ["nome", "logo", "telefone", "whatsapp", "email"] as const) {
    if (anterior[campo] !== novo[campo]) alterados.push(campo);
  }
  for (const campo of Object.keys(novo.endereco) as (keyof DadosLoja["endereco"])[]) {
    if (anterior.endereco[campo] !== novo.endereco[campo]) alterados.push(`endereco.${campo}`);
  }
  return alterados;
}

/**
 * Configuração administrativa global e única da loja (Etapa 11.2) — contrato
 * fechado, extraído do Backoffice já implementado. Autoridade das regras:
 * valida `:lista`, normaliza e valida `valor` (nunca confia no frontend,
 * mesmo que o DTO já rejeite o caso óbvio de string totalmente vazia — aqui
 * também trata espaços-em-branco como vazio) e traduz o resultado do
 * repository (que já garante atomicidade/duplicidade via MongoDB, nunca
 * lendo-modificando-salvando o array inteiro) nos erros de domínio
 * apropriados.
 */
@Injectable()
export class ConfiguracoesService {
  private readonly logger = new Logger(ConfiguracoesService.name);

  constructor(
    private readonly configuracoesRepository: ConfiguracoesRepository,
    private readonly produtosRepository: ProdutosRepository,
    // Fase 55.2 — checagem de vínculo antes de excluir forma de pagamento.
    // Reusa as instâncias singleton JÁ exportadas por `VendasModule`/
    // `CaixasModule` (ver `ConfiguracoesModule`) — nunca uma segunda
    // implementação de consulta, nunca uma segunda instância do repository.
    // `forwardRef` aqui (não em `VendasService`/`CaixasService` ao injetar
    // `ConfiguracoesRepository`) — mesma assimetria já estabelecida entre
    // `ConfiguracoesService`/`ProdutosService` desde a Fase 54.2.
    @Inject(forwardRef(() => VendasRepository)) private readonly vendasRepository: VendasRepository,
    @Inject(forwardRef(() => MovimentosCaixaRepository)) private readonly movimentosCaixaRepository: MovimentosCaixaRepository,
    @InjectModel(EventoConfiguracao.name) private readonly eventoModel: Model<EventoConfiguracaoDocument>,
  ) {}

  async obter(): Promise<ConfiguracaoDocument> {
    return this.configuracoesRepository.obter();
  }

  async atualizarLoja(dto: AtualizarLojaDto, usuarioId: string | null): Promise<ConfiguracaoDocument> {
    const novaLoja: DadosLoja = {
      nome: dto.nome.trim(),
      logo: dto.logo.trim(),
      telefone: dto.telefone.trim(),
      whatsapp: dto.whatsapp.trim(),
      email: dto.email.trim(),
      endereco: {
        cep: dto.endereco.cep.trim(),
        logradouro: dto.endereco.logradouro.trim(),
        numero: dto.endereco.numero.trim(),
        complemento: dto.endereco.complemento.trim(),
        bairro: dto.endereco.bairro.trim(),
        cidade: dto.endereco.cidade.trim(),
        estado: dto.endereco.estado.trim(),
      },
    };

    // Leitura só para a trilha de auditoria (quais campos mudaram) — a escrita continua sendo a mesma operação atômica de sempre.
    const anterior = await this.configuracoesRepository.obter();
    const resultado = await this.configuracoesRepository.atualizarLoja(novaLoja);

    const lojaAnterior = anterior.loja as unknown as DadosLoja;
    await this.registrarEvento("configuracao.loja_atualizada", usuarioId, {
      camposAlterados: camposLojaAlterados(lojaAnterior, novaLoja),
    });
    return resultado;
  }

  async adicionarItem(lista: string, valorBruto: string, usuarioId: string | null): Promise<ConfiguracaoDocument> {
    const campo = this.validarCampoLista(lista);
    const valor = valorBruto.trim();
    if (!valor) {
      throw ApiException.validation("Dados inválidos.", [{ field: "valor", message: "O valor não pode ser vazio." }]);
    }

    const resultado = await this.configuracoesRepository.adicionarItemLista(campo, valor);
    if (!resultado) {
      throw ApiException.conflict(`"${valor}" já existe na lista de ${NOMES_LISTA[campo]}.`);
    }
    await this.registrarEvento("configuracao.item_adicionado", usuarioId, { lista: campo, valor });
    return resultado;
  }

  /**
   * Cores e tamanhos vinculados a produtos ATIVOS (mesma semântica de
   * "ativo" já usada pela proteção equivalente em Fornecedores/Coleções/
   * Campanhas — `excluidoEm: null`) não podem ser excluídos. A verificação
   * nunca confia no frontend: é refeita aqui, contra o Mongo, mesmo que o
   * Backoffice só ofereça excluir itens aparentemente sem uso.
   *
   * Concorrência: não há transação multi-documento disponível neste MongoDB
   * (nenhum módulo do projeto usa — standalone, sem replica set), então a
   * garantia vem de checar → agir → RECONFERIR logo depois. Se uma variante
   * passou a usar o valor exatamente na janela entre a checagem e o `$pull`
   * (ex.: duas requisições quase simultâneas — uma criando a variante, outra
   * excluindo a cor), a reconferência pega isso e a remoção é desfeita por
   * compensação (readiciona o valor) antes de responder com o mesmo erro de
   * negócio — nunca deixa a configuração inconsistente com os produtos reais.
   *
   * Fase 56.4.1 — compensação robusta (ver `removerItemProtegido`).
   * Fase 56.4.2 — intenção durável (`remocoesPendentes`) gravada junto com o `$pull`.
   */
  async removerItem(lista: string, valorBruto: string, usuarioId: string | null): Promise<ConfiguracaoDocument> {
    const campo = this.validarCampoLista(lista);
    const valor = valorBruto.trim();

    const resultado = ehListaProtegidaContraExclusao(campo)
      ? await this.removerItemProtegido(campo, valor)
      : await this.configuracoesRepository.removerItemLista(campo, valor);
    if (!resultado) {
      throw ApiException.notFound(`"${valor}" não existe na lista de ${NOMES_LISTA[campo]}.`);
    }

    await this.registrarEvento("configuracao.item_removido", usuarioId, { lista: campo, valor });
    return resultado;
  }

  /**
   * Fase 56.4.1 — checar → remover → RECHECAR → compensar, tolerante a falhas:
   *
   * - a posição do item é lida ANTES do `$pull`, para a restauração devolvê-lo
   *   ao mesmo lugar (melhor esforço: limitada ao tamanho atual da lista);
   * - `$pull` com resultado desconhecido (erro transitório) é reconciliado
   *   lendo o documento antes de repetir (`removerComReconciliacao`);
   * - a rechecagem repete erros transitórios; se mesmo assim não der para
   *   saber se há vínculo, NUNCA conclui "sem vínculo": restaura o item e
   *   propaga o erro original (HTTP 500);
   * - com vínculo, restaura (`restaurarComRetentativa`) e mantém o erro de
   *   negócio de sempre (HTTP 400). Se a restauração não puder ser
   *   concluída, registra o contexto em log e responde HTTP 500.
   *
   * Fase 56.4.2 — o `$pull` grava, na MESMA operação, a pendência `opId`
   * (`removerComPendencia`). Toda conclusão a encerra atomicamente: a
   * restauração no mesmo `updateOne` que devolve o item; o caso sem vínculo
   * com um `$pull` da própria pendência. Se o processo cair, ou a restauração
   * falhar, a pendência fica no documento para `processarRemocoesPendentes`.
   *
   * `null` = o item não estava na lista (o chamador traduz em 404).
   */
  private async removerItemProtegido(campo: ListaProtegidaContraExclusao, valor: string): Promise<ConfiguracaoDocument | null> {
    await this.garantirSemVinculo(campo, valor);
    const operacaoId = randomUUID();

    const remocao = await this.removerComPendencia(campo, valor, operacaoId);
    if (!remocao) return null;

    const verificacao = await this.verificarVinculoAposRemocao(campo, valor);
    if (verificacao.situacao === "sem_vinculo") {
      await this.encerrarPendenciaSemVinculo(campo, valor, operacaoId);
      return remocao.documento;
    }

    const motivo = verificacao.situacao === "com_vinculo" ? "vínculo encontrado na rechecagem" : `rechecagem indeterminada (${descreverErro(verificacao.erro)})`;
    const restauracao = await this.restaurarComRetentativa(campo, valor, remocao.posicao, operacaoId);
    // Pendência encerrada por outra execução sem o item de volta (ela concluiu que não havia vínculo): a restauração não aconteceu.
    const restaurado = restauracao.ok && (!restauracao.pendenciaEncerradaPorOutraExecucao || (await this.itemRepresentadoComSeguranca(campo, valor)));
    if (!restaurado) {
      const tentativas = restauracao.tentativas;
      const erroCompensacao = restauracao.ok ? new Error("A pendência foi encerrada por outra execução sem restaurar o item.") : restauracao.erro;
      this.logger.error(
        `Compensação da remoção falhou definitivamente — o item pode estar ausente da configuração com vínculo existente; ` +
          `a pendência fica no documento para processamento posterior. ` +
          `operacao=${operacaoId} lista=${campo} valor=${JSON.stringify(valor)} normalizado=${JSON.stringify(normalizarItemLista(campo, valor))} ` +
          `tentativas=${tentativas} motivo=${motivo} erroCompensacao=${descreverErro(erroCompensacao)}`,
        erroCompensacao instanceof Error ? erroCompensacao.stack : undefined,
      );
      throw new Error(`Falha ao restaurar "${valor}" na lista de ${NOMES_LISTA[campo]} após a remoção.`, { cause: erroCompensacao });
    }

    if (verificacao.situacao === "com_vinculo") {
      throw ApiException.validation(MENSAGEM_VINCULO[campo], [{ field: "valor", message: MENSAGEM_VINCULO[campo] }]);
    }
    // Item restaurado: a remoção não foi concluída porque não deu para verificar os vínculos.
    this.logger.warn(
      `Remoção desfeita: não foi possível verificar vínculos após o $pull. operacao=${operacaoId} lista=${campo} valor=${JSON.stringify(valor)} ` +
        `erroOriginal=${descreverErro(verificacao.erro)}`,
    );
    throw verificacao.erro;
  }

  /**
   * Fase 56.4.2 — `$pull` + pendência (uma operação atômica), com até 3
   * tentativas. Cada tentativa lê a posição atual do item e a exige no filtro
   * (a pendência registra a posição real); se o item mudou de lugar entre a
   * leitura e a escrita, relê. Na última tentativa a posição deixa de ser
   * exigida (continua registrada como lida) para uma lista sob alterações
   * contínuas não impedir a remoção.
   *
   * Erro transitório na escrita = resultado desconhecido (a confirmação pode
   * ter se perdido depois de o MongoDB aplicar a escrita). Antes de repetir,
   * a pendência `opId` é procurada: presente → a remoção DESTA operação foi
   * aplicada, segue para a rechecagem; ausente → nada desta operação foi
   * gravado, repete. Se nem essa consulta for possível, registra em log e propaga.
   */
  private async removerComPendencia(campo: ListaProtegidaContraExclusao, valor: string, operacaoId: string): Promise<RemocaoRegistrada | null> {
    const em = new Date();
    let ultimoErro: unknown = null;
    for (let tentativa = 1; tentativa <= MAXIMO_TENTATIVAS; tentativa += 1) {
      const posicao = await this.comRetentativaTransitoria(() => this.configuracoesRepository.posicaoDoItem(campo, valor));
      if (posicao === null) return null;
      const exigirPosicao = tentativa < MAXIMO_TENTATIVAS;
      try {
        const documento = await this.configuracoesRepository.removerItemComPendencia(campo, valor, {
          opId: operacaoId,
          posicao: exigirPosicao ? posicao : null,
          em,
        });
        if (documento) return { documento, posicao };
        if (!exigirPosicao) return null; // sem exigência de posição, `null` só pode significar item fora da lista
        // O item saiu da posição lida (ou da lista): relê na próxima tentativa.
      } catch (erro) {
        if (!ehErroTransitorioMongo(erro)) throw erro;
        ultimoErro = erro;
        let aplicada: boolean;
        try {
          aplicada = await this.comRetentativaTransitoria(() => this.configuracoesRepository.pendenciaExiste(operacaoId));
        } catch (erroConsulta) {
          this.logger.error(
            `Resultado da remoção desconhecido: falha ao consultar a pendência depois de um erro transitório no $pull. ` +
              `operacao=${operacaoId} lista=${campo} valor=${JSON.stringify(valor)} erroRemocao=${descreverErro(erro)} erroConsulta=${descreverErro(erroConsulta)}`,
          );
          throw erro;
        }
        if (aplicada) {
          return { documento: await this.comRetentativaTransitoria(() => this.configuracoesRepository.obter()), posicao: exigirPosicao ? posicao : null };
        }
      }
    }
    // Só se chega aqui com erro transitório na última tentativa e a pendência ausente: nada desta operação foi gravado.
    throw ultimoErro;
  }

  /**
   * Fase 56.4.2 — sem vínculo na rechecagem: o item continua removido e a
   * pendência é encerrada (`$pull` da própria pendência, repetido em erro
   * transitório — encerrar duas vezes é inofensivo). Se não der para encerrar,
   * a remoção continua correta (verificada sem vínculo): a pendência fica
   * para `processarRemocoesPendentes`, com aviso em log.
   */
  private async encerrarPendenciaSemVinculo(campo: ListaProtegidaContraExclusao, valor: string, operacaoId: string): Promise<void> {
    try {
      await this.comRetentativaTransitoria(() => this.configuracoesRepository.finalizarRemocaoPendente(operacaoId));
    } catch (erro) {
      this.logger.warn(
        `Remoção concluída, mas a pendência não pôde ser encerrada — fica para processamento posterior. ` +
          `operacao=${operacaoId} lista=${campo} valor=${JSON.stringify(valor)} erro=${descreverErro(erro)}`,
      );
    }
  }

  /** Leitura de confirmação que nunca lança (uma falha conta como "não confirmado"). */
  private async itemRepresentadoComSeguranca(campo: ListaProtegidaContraExclusao, valor: string): Promise<boolean> {
    try {
      return await this.configuracoesRepository.itemRepresentado(campo, valor);
    } catch {
      return false;
    }
  }

  /**
   * Fase 56.4.2 — processa as remoções que ficaram pendentes (processo
   * interrompido, restauração que falhou, encerramento que falhou). Uso
   * INTERNO: não é chamado no bootstrap nem exposto na API nesta fase.
   *
   * Para cada pendência válida: rechecagem de vínculos com as regras de
   * sempre (`existeVinculo`) →
   * - com vínculo: restaura e encerra a pendência na MESMA escrita atômica;
   * - sem vínculo: encerra a pendência (o item continua removido);
   * - consulta falhou: pendência intacta (nunca "sem vínculo"), log de erro;
   * - restauração/encerramento falhou: pendência intacta, log de erro.
   * Idempotente: uma pendência já concluída (por outra execução) resulta em
   * `ja_concluida`, sem nenhuma escrita. Pendências malformadas são
   * reportadas e registradas em log — nunca apagadas nem ignoradas em silêncio.
   */
  async processarRemocoesPendentes(): Promise<ResultadoProcessamentoRemocoes> {
    const { validas, malformadas } = await this.comRetentativaTransitoria(() => this.configuracoesRepository.lerRemocoesPendentes());
    for (const malformada of malformadas) {
      this.logger.error(
        `Pendência de remoção malformada mantida no documento (não processada). indice=${malformada.indice} ` +
          `opId=${malformada.opId ?? "(ausente)"} motivo=${malformada.motivo}`,
      );
    }
    const processadas: ResultadoProcessamentoRemocoes["processadas"] = [];
    for (const pendencia of validas) {
      processadas.push({ opId: pendencia.opId, lista: pendencia.lista, valor: pendencia.valor, desfecho: await this.processarRemocaoPendente(pendencia) });
    }
    return { processadas, malformadas };
  }

  private async processarRemocaoPendente(pendencia: RemocaoPendenteValida): Promise<DesfechoRemocaoPendente> {
    const { opId, lista, valor } = pendencia;
    const contexto = `operacao=${opId} lista=${lista} valor=${JSON.stringify(valor)} normalizado=${JSON.stringify(normalizarItemLista(lista, valor))}`;

    let existe: boolean;
    try {
      existe = await this.comRetentativaTransitoria(() => this.existeVinculo(lista, valor));
    } catch (erro) {
      this.logger.error(`Pendência de remoção mantida: falha ao verificar vínculos. ${contexto} erro=${descreverErro(erro)}`);
      return "mantida_falha_consulta";
    }

    if (!existe) {
      try {
        const encerrada = await this.comRetentativaTransitoria(() => this.configuracoesRepository.finalizarRemocaoPendente(opId));
        return encerrada ? "finalizada" : "ja_concluida";
      } catch (erro) {
        this.logger.error(`Pendência de remoção mantida: falha ao encerrar (sem vínculo). ${contexto} erro=${descreverErro(erro)}`);
        return "mantida_falha_finalizacao";
      }
    }

    const restauracao = await this.restaurarComRetentativa(lista, valor, pendencia.posicao, opId);
    if (!restauracao.ok) {
      this.logger.error(
        `Pendência de remoção mantida: falha ao restaurar o item vinculado. ${contexto} tentativas=${restauracao.tentativas} ` +
          `erro=${descreverErro(restauracao.erro)}`,
      );
      return "mantida_falha_restauracao";
    }
    return restauracao.pendenciaEncerradaPorOutraExecucao ? "ja_concluida" : "restaurada";
  }

  /** Fase 56.4.1 — rechecagem com repetição de erros transitórios; falha não-transitória ou esgotada = indeterminado (nunca "sem vínculo"). */
  private async verificarVinculoAposRemocao(campo: ListaProtegidaContraExclusao, valor: string): Promise<VerificacaoVinculo> {
    try {
      const existe = await this.comRetentativaTransitoria(() => this.existeVinculo(campo, valor));
      return existe ? { situacao: "com_vinculo" } : { situacao: "sem_vinculo" };
    } catch (erro) {
      return { situacao: "indeterminado", erro };
    }
  }

  /**
   * Fase 56.4.1 — até 3 tentativas de `restaurarItemLista` (atômica e
   * idempotente; cada tentativa RELÊ o documento, então uma escrita anterior
   * de resultado desconhecido é reconciliada antes de qualquer nova escrita).
   * Sucesso só depois de CONFIRMAR, numa leitura nova, que o item está na
   * lista (equivalente normalizado) e no espelho. `conflito` (o documento
   * mudou entre leitura e escrita) consome uma tentativa; erro não-transitório encerra na hora.
   *
   * Fase 56.4.2 — com `opId`, a restauração encerra a pendência na mesma
   * escrita, e a confirmação também exige a pendência encerrada.
   * `pendencia_encerrada` (outra execução concluiu antes) termina sem
   * escrever nada — quem chama decide o que isso significa.
   */
  private async restaurarComRetentativa(
    campo: ListaProtegidaContraExclusao,
    valor: string,
    posicao: number | null,
    opId: string,
  ): Promise<Restauracao> {
    let ultimoErro: unknown = null;
    for (let tentativa = 1; tentativa <= MAXIMO_TENTATIVAS; tentativa += 1) {
      try {
        const resultado = await this.configuracoesRepository.restaurarItemLista(campo, valor, posicao, opId);
        if (resultado === "pendencia_encerrada") return { ok: true, tentativas: tentativa, pendenciaEncerradaPorOutraExecucao: true };
        if (resultado !== "conflito" && (await this.configuracoesRepository.restauracaoConfirmada(campo, valor, opId))) {
          return { ok: true, tentativas: tentativa, pendenciaEncerradaPorOutraExecucao: false };
        }
        ultimoErro = new Error(
          resultado === "conflito"
            ? "O documento de configuração foi alterado entre a leitura e a escrita da restauração."
            : "A restauração não foi confirmada na leitura do documento.",
        );
      } catch (erro) {
        ultimoErro = erro;
        if (!ehErroTransitorioMongo(erro)) return { ok: false, tentativas: tentativa, erro };
      }
    }
    return { ok: false, tentativas: MAXIMO_TENTATIVAS, erro: ultimoErro };
  }

  /** Fase 56.4.1 — repete `operacao` (só LEITURAS idempotentes) em erro transitório do MongoDB, até 3 tentativas, sem espera artificial. */
  private async comRetentativaTransitoria<T>(operacao: () => Promise<T>): Promise<T> {
    for (let tentativa = 1; ; tentativa += 1) {
      try {
        return await operacao();
      } catch (erro) {
        if (!ehErroTransitorioMongo(erro) || tentativa >= MAXIMO_TENTATIVAS) throw erro;
      }
    }
  }

  private async garantirSemVinculo(campo: ListaProtegidaContraExclusao, valor: string): Promise<void> {
    if (await this.existeVinculo(campo, valor)) {
      throw ApiException.validation(MENSAGEM_VINCULO[campo], [{ field: "valor", message: MENSAGEM_VINCULO[campo] }]);
    }
  }

  /**
   * Busca produtos/vendas/movimentos usando `valor` (comparação sempre
   * normalizada, nunca a string crua). Três estratégias diferentes, cada
   * uma proporcional ao modelo de dados real do campo vinculado:
   *
   * - Cores/tamanhos: filtro direto no Mongo contra o campo-espelho
   *   normalizado já persistido em `Variante` (`corNormalizada`/
   *   `tamanhos.tamanho`).
   * - Categoria: campo raiz simples em `Produto`, sem espelho — comparação
   *   normalizada em memória sobre os produtos ativos (Fase 55.1; ver
   *   `docs/configuracoes-cores-tamanhos.md`).
   * - Forma de pagamento (Fase 55.2; estratégia de comparação corrigida na
   *   Fase 55.2.1): delega a duas consultas dedicadas, uma por collection
   *   (`VendasRepository.existeVinculoFormaPagamento`/
   *   `MovimentosCaixaRepository.existeVinculoFormaPagamento`). Cada uma
   *   projeta SÓ os campos de forma de pagamento relevantes (nunca
   *   itens/pagamentos inteiros, histórico, variantes) e compara em memória
   *   com `normalizarFormaPagamento` nos dois lados — a mesma normalização
   *   exata do cadastro (collation do MongoDB, usada numa primeira versão,
   *   resolve caixa/acento mas não colapsa espaços periféricos/internos,
   *   violando essa exigência). Nenhum campo-espelho nos documentos
   *   financeiros; nenhuma alteração de formato histórico. Ver a
   *   documentação para o custo (full scan proporcional ao volume atual) e o
   *   risco residual de concorrência entre coleções.
   */
  private async existeVinculo(campo: ListaProtegidaContraExclusao, valor: string): Promise<boolean> {
    if (campo === "categorias") {
      const valorNormalizado = normalizarCategoria(valor);
      const ativos = await this.produtosRepository.listarTodosAtivos();
      return ativos.some((produto) => normalizarCategoria(produto.categoria) === valorNormalizado);
    }
    if (campo === "formasPagamento") {
      const [naVendas, nosMovimentos] = await Promise.all([
        this.vendasRepository.existeVinculoFormaPagamento(valor),
        this.movimentosCaixaRepository.existeVinculoFormaPagamento(valor),
      ]);
      return naVendas || nosMovimentos;
    }
    const filtro =
      campo === "cores"
        ? { "variantes.corNormalizada": normalizarCor(valor) }
        : { "variantes.tamanhos.tamanho": normalizarTamanho(valor) };
    const vinculados = await this.produtosRepository.listarTodosAtivos(filtro);
    return vinculados.length > 0;
  }

  private async registrarEvento(tipo: string, usuarioId: string | null, detalhes: Record<string, unknown>): Promise<void> {
    await this.eventoModel.create({ tipo, usuarioId, detalhes });
  }

  private validarCampoLista(lista: string): CampoLista {
    if (!(CAMPOS_LISTA as readonly string[]).includes(lista)) {
      throw ApiException.validation("Dados inválidos.", [
        { field: "lista", message: `Lista inválida. Use uma de: ${CAMPOS_LISTA.join(", ")}.` },
      ]);
    }
    return lista as CampoLista;
  }
}
