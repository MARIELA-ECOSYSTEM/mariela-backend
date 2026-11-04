import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import { normalizarCategoria, normalizarCor, normalizarFormaPagamento, normalizarTamanho } from "../produtos/utils/normalizacao.util.js";
import { ID_CONFIGURACAO_GLOBAL, type CampoLista } from "./configuracoes.constants.js";
import type { DadosLoja } from "./configuracoes.types.js";
import { Configuracao, type ConfiguracaoDocument } from "./schemas/configuracao.schema.js";

/**
 * As quatro listas com regra de unicidade case-insensitive (Fase 54.0 —
 * `cores`/`tamanhos`; Fase 55.1 — `categorias`; Fase 55.2 —
 * `formasPagamento`) — cada uma mapeia para seu campo-espelho normalizado
 * (ver `configuracao.schema.ts`) e a função de normalização já estabelecida
 * para o mesmo conceito em Produtos/Vendas (`Variante.corNormalizada`/
 * `Tamanho.tamanho`/`Produto.categoria`/`PagamentoVenda.forma`), nunca uma
 * regra nova e divergente.
 */
const CAMPOS_COM_NORMALIZACAO = {
  cores: { campoNormalizado: "coresNormalizadas", normalizar: normalizarCor },
  tamanhos: { campoNormalizado: "tamanhosNormalizados", normalizar: normalizarTamanho },
  categorias: { campoNormalizado: "categoriasNormalizadas", normalizar: normalizarCategoria },
  formasPagamento: { campoNormalizado: "formasPagamentoNormalizadas", normalizar: normalizarFormaPagamento },
} as const satisfies Partial<Record<CampoLista, { campoNormalizado: string; normalizar: (valor: string) => string }>>;

export type CampoComNormalizacao = keyof typeof CAMPOS_COM_NORMALIZACAO;

function temNormalizacao(campo: CampoLista): campo is CampoComNormalizacao {
  return campo in CAMPOS_COM_NORMALIZACAO;
}

/** Fase 56.4.1 — valor normalizado com a MESMA função do espelho da lista (usado em logs e conferências). */
export function normalizarItemLista(campo: CampoComNormalizacao, valor: string): string {
  return CAMPOS_COM_NORMALIZACAO[campo].normalizar(valor);
}

/**
 * Fase 56.4.1 — lista e espelho exatamente como estão no documento CRU (sem
 * os defaults do Mongoose): `null` = campo ausente no documento (singleton
 * legado, anterior ao espelho).
 */
export interface EstadoListaPersistido {
  lista: string[] | null;
  espelho: string[] | null;
  /** Fase 56.4.2 — `opId` das remoções pendentes (de qualquer lista) presentes no documento. */
  opIdsPendentes: string[];
}

/**
 * Resultado de UMA tentativa de `restaurarItemLista`:
 * - `restaurado`: o item voltou à lista (e ao espelho, se faltava);
 * - `espelho_reparado`: a lista já tinha um equivalente normalizado, só o espelho foi completado;
 * - `ja_presente`: lista e espelho já representavam o item — nada a restaurar (a pendência, se informada, foi encerrada);
 * - `pendencia_encerrada`: a pendência informada já não existe (outra execução concluiu a operação) — nada foi gravado;
 * - `conflito`: o documento mudou entre a leitura e a escrita — nada foi gravado, reler e tentar de novo.
 */
export type ResultadoRestauracao = "restaurado" | "espelho_reparado" | "ja_presente" | "pendencia_encerrada" | "conflito";

/** Fase 56.4.2 — dados da intenção gravados junto com o `$pull` (a lista, o valor e o normalizado vêm da própria remoção). */
export interface DadosRemocaoPendente {
  opId: string;
  posicao: number | null;
  em: Date;
}

/** Fase 56.4.2 — pendência lida do documento CRU e validada. */
export interface RemocaoPendenteValida {
  opId: string;
  lista: CampoComNormalizacao;
  valor: string;
  normalizado: string;
  posicao: number | null;
  em: Date;
}

/** Fase 56.4.2 — pendência que não pode ser processada com segurança; fica no documento, nunca é apagada. */
export interface RemocaoPendenteMalformada {
  indice: number;
  opId: string | null;
  motivo: string;
}

function ehTexto(valor: unknown): valor is string {
  return typeof valor === "string";
}

function ehCampoComNormalizacao(valor: unknown): valor is CampoComNormalizacao {
  return typeof valor === "string" && Object.hasOwn(CAMPOS_COM_NORMALIZACAO, valor);
}

/** `opId` de cada pendência do documento cru (entradas sem `opId` textual são ignoradas aqui — ver `lerRemocoesPendentes`). */
function opIdsDasPendencias(valor: unknown): string[] {
  if (valor === undefined) return [];
  if (!Array.isArray(valor)) throw new Error('Formato inesperado do campo "remocoesPendentes" no documento de configuração.');
  const itens: unknown[] = valor;
  const opIds: string[] = [];
  for (const item of itens) {
    if (typeof item === "object" && item !== null && "opId" in item && typeof item.opId === "string") opIds.push(item.opId);
  }
  return opIds;
}

/** Valida uma pendência crua; devolve o motivo quando ela não pode ser processada com segurança. */
function validarPendencia(bruto: unknown): RemocaoPendenteValida | string {
  if (typeof bruto !== "object" || bruto === null) return "a entrada não é um objeto";
  if (!("opId" in bruto) || typeof bruto.opId !== "string" || bruto.opId.length === 0) return "opId ausente ou inválido";
  if (!("lista" in bruto) || !ehCampoComNormalizacao(bruto.lista)) return "lista ausente ou desconhecida";
  if (!("valor" in bruto) || typeof bruto.valor !== "string" || bruto.valor.length === 0) return "valor ausente ou inválido";
  if (!("normalizado" in bruto) || typeof bruto.normalizado !== "string") return "normalizado ausente ou inválido";
  const posicao = "posicao" in bruto ? bruto.posicao : null;
  if (posicao !== null && posicao !== undefined && !(typeof posicao === "number" && Number.isInteger(posicao) && posicao >= 0)) {
    return "posicao inválida";
  }
  if (!("em" in bruto) || !(bruto.em instanceof Date) || Number.isNaN(bruto.em.getTime())) return "em ausente ou inválido";
  return {
    opId: bruto.opId,
    lista: bruto.lista,
    valor: bruto.valor,
    normalizado: bruto.normalizado,
    posicao: typeof posicao === "number" ? posicao : null,
    em: bruto.em,
  };
}

function comoListaPersistida(valor: unknown, campo: string): string[] | null {
  if (valor === undefined) return null;
  if (Array.isArray(valor)) {
    const itens: unknown[] = valor;
    if (itens.every(ehTexto)) return itens;
  }
  throw new Error(`Formato inesperado do campo "${campo}" no documento de configuração.`);
}

/** Filtro de igualdade EXATA (mesmos elementos, mesma ordem) — ou ausência do campo. */
function igualdadeExata(valor: string[] | null): string[] | { $exists: false } {
  return valor === null ? { $exists: false } : valor;
}

@Injectable()
export class ConfiguracoesRepository {
  constructor(@InjectModel(Configuracao.name) private readonly configuracaoModel: Model<ConfiguracaoDocument>) {}

  /**
   * Devolve o documento singleton, criando-o com os defaults do schema na
   * PRIMEIRA chamada de todo o sistema — `findOneAndUpdate` com `upsert` e um
   * `_id` fixo é uma única operação atômica no MongoDB (nunca duas leituras +
   * uma escrita): mesmo sob concorrência real (duas requisições simultâneas
   * batendo em `GET /configuracoes` antes de o documento existir), o próprio
   * MongoDB serializa as duas tentativas de upsert no mesmo `_id` — só uma
   * cria, a outra apenas lê o que a primeira criou. Nunca lança erro de chave
   * duplicada (ao contrário de um `create()` ingênuo).
   */
  async obter(): Promise<ConfiguracaoDocument> {
    const documento = await this.configuracaoModel
      .findOneAndUpdate(
        { _id: ID_CONFIGURACAO_GLOBAL },
        { $setOnInsert: { _id: ID_CONFIGURACAO_GLOBAL } },
        { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
      )
      .exec();
    return documento!;
  }

  /**
   * Substitui `loja` por inteiro (contrato: `PUT /configuracoes/loja` recebe
   * `DadosLoja` completo, nunca um patch parcial). `upsert: true` aqui é
   * seguro (ao contrário de `adicionarItemLista`/`removerItemLista` abaixo)
   * porque o filtro é só `{_id}`, sem nenhuma condição extra que possa falhar
   * contra um documento já existente — nunca há risco de tentar inserir um
   * segundo documento com o mesmo `_id`.
   */
  async atualizarLoja(loja: DadosLoja): Promise<ConfiguracaoDocument> {
    const documento = await this.configuracaoModel
      .findOneAndUpdate(
        { _id: ID_CONFIGURACAO_GLOBAL },
        { $set: { loja } },
        { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
      )
      .exec();
    return documento!;
  }

  /**
   * Adiciona `valor` à lista `campo` de forma ATÔMICA — nunca lê o array
   * inteiro em memória para depois salvar de volta (isso teria uma janela de
   * "lost update" sob duas adições concorrentes). O filtro
   * `{ [campo]: { $ne: valor } }` combinado com `$push` é uma única operação
   * Mongo: só encontra e modifica o documento se `valor` AINDA não estiver na
   * lista — duas chamadas concorrentes adicionando o MESMO valor nunca
   * resultam em duas entradas (o MongoDB serializa escritas no mesmo
   * documento). Devolve `null` quando `valor` já existia (o service traduz
   * isso em conflito).
   *
   * Deliberadamente SEM `upsert` aqui: a chamada a `obter()` acima já assegura que
   * o singleton existe ANTES desta chamada. Combinar `upsert: true` com um
   * filtro que inclui a condição `$ne` seria perigoso — se o documento já
   * existe mas `valor` JÁ está na lista, o filtro não bate no documento
   * existente, e `upsert` tentaria inserir um SEGUNDO documento com o mesmo
   * `_id`, causando um erro de chave duplicada em vez do "já existe" que o
   * chamador espera.
   */
  async adicionarItemLista(campo: CampoLista, valor: string): Promise<ConfiguracaoDocument | null> {
    const documento = await this.obter();

    if (temNormalizacao(campo)) {
      const { campoNormalizado, normalizar } = CAMPOS_COM_NORMALIZACAO[campo];
      const valorNormalizado = normalizar(valor);
      // Self-heal (idempotente, só ADITIVO via $addToSet — nunca sobrescreve
      // nem remove): cobre o documento singleton já existente em produção,
      // criado antes desta fase, cujo campo-espelho ainda não existe/está
      // incompleto para os itens já cadastrados.
      await this.sincronizarEspelhoNormalizado(documento, campo, campoNormalizado, normalizar);
      return this.configuracaoModel
        .findOneAndUpdate(
          { _id: ID_CONFIGURACAO_GLOBAL, [campoNormalizado]: { $ne: valorNormalizado } },
          { $push: { [campo]: valor, [campoNormalizado]: valorNormalizado } },
          { returnDocument: "after" },
        )
        .exec();
    }

    return this.configuracaoModel
      .findOneAndUpdate({ _id: ID_CONFIGURACAO_GLOBAL, [campo]: { $ne: valor } }, { $push: { [campo]: valor } }, { returnDocument: "after" })
      .exec();
  }

  /**
   * Garante que todo valor já presente em `campo` tem o correspondente
   * normalizado em `campoNormalizado` — sem isso, um documento singleton
   * criado antes da Fase 54.0 permitiria duplicata case-insensitive contra
   * itens antigos (o filtro `$ne` só enxerga o que já está no espelho).
   * `$addToSet`+`$each` é seguro sob concorrência: nunca remove, nunca
   * sobrescreve, e rodar duas vezes com os mesmos valores não cria duplicata
   * no próprio espelho.
   */
  private async sincronizarEspelhoNormalizado(
    documento: ConfiguracaoDocument,
    campo: CampoComNormalizacao,
    campoNormalizado: string,
    normalizar: (valor: string) => string,
  ): Promise<void> {
    const valores = documento[campo as keyof ConfiguracaoDocument] as unknown as string[];
    const jaPresentes = new Set(
      (documento[campoNormalizado as keyof ConfiguracaoDocument] as unknown as string[] | undefined) ?? [],
    );
    const faltantes = [...new Set(valores.map(normalizar))].filter((item) => !jaPresentes.has(item));
    if (faltantes.length === 0) return;
    await this.configuracaoModel
      .updateOne({ _id: ID_CONFIGURACAO_GLOBAL }, { $addToSet: { [campoNormalizado]: { $each: faltantes } } })
      .exec();
  }

  /**
   * Remove `valor` da lista `campo` de forma atômica — mesma técnica de
   * `adicionarItemLista`, espelhada: o filtro exige que `valor` ESTEJA na
   * lista para que `$pull` rode; devolve `null` quando não estava (o service
   * traduz isso em "não encontrado"). Mesmo motivo para não usar `upsert`.
   */
  async removerItemLista(campo: CampoLista, valor: string): Promise<ConfiguracaoDocument | null> {
    await this.obter();
    const pull: Record<string, unknown> = { [campo]: valor };
    if (temNormalizacao(campo)) {
      const { campoNormalizado, normalizar } = CAMPOS_COM_NORMALIZACAO[campo];
      // Puxa do espelho também; se ainda não estava sincronizado para este
      // valor específico, o `$pull` desse campo simplesmente não casa nada
      // (no-op seguro) — nunca lança erro.
      pull[campoNormalizado] = normalizar(valor);
    }
    return this.configuracaoModel
      .findOneAndUpdate({ _id: ID_CONFIGURACAO_GLOBAL, [campo]: valor }, { $pull: pull }, { returnDocument: "after" })
      .exec();
  }

  /**
   * Fase 56.4.2 — remove `valor` da lista e do espelho E grava a intenção
   * (`remocoesPendentes`) num ÚNICO `findOneAndUpdate` sobre o singleton: ou
   * as três mudanças acontecem juntas, ou nenhuma. O filtro exige:
   * - `valor` EXATO na lista (nunca remove um item diferente do esperado);
   * - quando `posicao` é informada, `valor` exatamente nesse índice — a
   *   posição gravada na pendência é a real no instante da remoção;
   * - nenhuma pendência com o mesmo `opId` (repetir a operação nunca duplica a pendência).
   * `null` = o filtro não casou (item ausente ou fora da posição informada).
   * Sem `upsert`, pelo mesmo motivo de `removerItemLista`.
   */
  async removerItemComPendencia(campo: CampoComNormalizacao, valor: string, dados: DadosRemocaoPendente): Promise<ConfiguracaoDocument | null> {
    const { campoNormalizado, normalizar } = CAMPOS_COM_NORMALIZACAO[campo];
    const normalizado = normalizar(valor);
    const filtro: Record<string, unknown> = { _id: ID_CONFIGURACAO_GLOBAL, [campo]: valor, "remocoesPendentes.opId": { $ne: dados.opId } };
    if (dados.posicao !== null) filtro[`${campo}.${dados.posicao}`] = valor;
    const pendencia: RemocaoPendenteValida = { opId: dados.opId, lista: campo, valor, normalizado, posicao: dados.posicao, em: dados.em };
    return this.configuracaoModel
      .findOneAndUpdate(filtro, { $pull: { [campo]: valor, [campoNormalizado]: normalizado }, $push: { remocoesPendentes: pendencia } }, { returnDocument: "after" })
      .exec();
  }

  /** Fase 56.4.2 — a pendência `opId` está no documento (identifica se uma remoção de resultado desconhecido foi aplicada). */
  async pendenciaExiste(opId: string): Promise<boolean> {
    return (await this.configuracaoModel.exists({ _id: ID_CONFIGURACAO_GLOBAL, "remocoesPendentes.opId": opId }).exec()) !== null;
  }

  /**
   * Fase 56.4.2 — encerra a pendência `opId` mantendo o item removido (sem
   * vínculo): um único `$pull` condicionado à pendência existir. `false` = ela
   * já não existia (outra execução concluiu) — nada foi gravado.
   */
  async finalizarRemocaoPendente(opId: string): Promise<boolean> {
    const { matchedCount } = await this.configuracaoModel
      .updateOne({ _id: ID_CONFIGURACAO_GLOBAL, "remocoesPendentes.opId": opId }, { $pull: { remocoesPendentes: { opId } } })
      .exec();
    return matchedCount > 0;
  }

  /**
   * Fase 56.4.2 — pendências do documento CRU, validadas. As que não podem
   * ser processadas com segurança voltam em `malformadas` (com o motivo) e
   * continuam intactas no documento — nunca apagadas nem ignoradas em silêncio.
   */
  async lerRemocoesPendentes(): Promise<{ validas: RemocaoPendenteValida[]; malformadas: RemocaoPendenteMalformada[] }> {
    const documento = await this.configuracaoModel.findById(ID_CONFIGURACAO_GLOBAL, { remocoesPendentes: 1 }).lean<Record<string, unknown>>().exec();
    const brutas = documento?.["remocoesPendentes"];
    if (brutas === undefined) return { validas: [], malformadas: [] };
    if (!Array.isArray(brutas)) return { validas: [], malformadas: [{ indice: -1, opId: null, motivo: "remocoesPendentes não é uma lista" }] };
    const itens: unknown[] = brutas;
    const validas: RemocaoPendenteValida[] = [];
    const malformadas: RemocaoPendenteMalformada[] = [];
    itens.forEach((bruto, indice) => {
      const resultado = validarPendencia(bruto);
      if (typeof resultado !== "string") {
        validas.push(resultado);
        return;
      }
      const opId = typeof bruto === "object" && bruto !== null && "opId" in bruto && typeof bruto.opId === "string" ? bruto.opId : null;
      malformadas.push({ indice, opId, motivo: resultado });
    });
    return { validas, malformadas };
  }

  /** Fase 56.4.1 — leitura CRUA (`lean`) só da lista, do seu espelho e dos `opId` pendentes; `null` se o singleton não existe. */
  async lerEstadoLista(campo: CampoComNormalizacao): Promise<EstadoListaPersistido | null> {
    const { campoNormalizado } = CAMPOS_COM_NORMALIZACAO[campo];
    const documento = await this.configuracaoModel
      .findById(ID_CONFIGURACAO_GLOBAL, { [campo]: 1, [campoNormalizado]: 1, "remocoesPendentes.opId": 1 })
      .lean<Record<string, unknown>>()
      .exec();
    if (!documento) return null;
    return {
      lista: comoListaPersistida(documento[campo], campo),
      espelho: comoListaPersistida(documento[campoNormalizado], campoNormalizado),
      opIdsPendentes: opIdsDasPendencias(documento["remocoesPendentes"]),
    };
  }

  /** Índice de `valor` (comparação EXATA, a mesma do filtro de `removerItemLista`) ou `null` se não está na lista. */
  async posicaoDoItem(campo: CampoComNormalizacao, valor: string): Promise<number | null> {
    const indice = (await this.lerEstadoLista(campo))?.lista?.indexOf(valor) ?? -1;
    return indice >= 0 ? indice : null;
  }

  /** O item está corretamente representado: um equivalente NORMALIZADO na lista E o normalizado no espelho. */
  async itemRepresentado(campo: CampoComNormalizacao, valor: string): Promise<boolean> {
    const { normalizar } = CAMPOS_COM_NORMALIZACAO[campo];
    const normalizado = normalizar(valor);
    const estado = await this.lerEstadoLista(campo);
    return Boolean(estado?.lista?.some((item) => normalizar(item) === normalizado) && estado.espelho?.includes(normalizado));
  }

  /**
   * Fase 56.4.2 — confirmação da restauração numa leitura nova: o item está
   * representado (lista + espelho) e, quando há `opId`, a pendência já não existe.
   */
  async restauracaoConfirmada(campo: CampoComNormalizacao, valor: string, opId: string | null): Promise<boolean> {
    const { normalizar } = CAMPOS_COM_NORMALIZACAO[campo];
    const normalizado = normalizar(valor);
    const estado = await this.lerEstadoLista(campo);
    if (!estado) return false;
    const representado = Boolean(estado.lista?.some((item) => normalizar(item) === normalizado) && estado.espelho?.includes(normalizado));
    return representado && (opId === null || !estado.opIdsPendentes.includes(opId));
  }

  /**
   * Fase 56.4.1 — restaura `valor` removido por `removerItemLista` (compensação),
   * em UMA tentativa atômica e idempotente.
   *
   * Por que não um único `$push` com `[espelho]: { $ne: normalizado }`: a
   * unicidade da lista é por valor NORMALIZADO (acentos, caixa, espaços), e
   * nenhum operador do MongoDB reproduz `normalizar*` dentro de um filtro — o
   * `$ne` sobre o espelho não distingue "espelho com o valor mas lista sem
   * equivalente" de "lista com equivalente mas espelho sem o valor".
   *
   * Estratégia (compare-and-set num único documento, sem transação):
   * 1. lê lista e espelho CRUS;
   * 2. decide em memória, com o normalizador real da lista: se já existe um
   *    equivalente normalizado na lista, não insere (nunca duplica por
   *    grafia); senão insere `valor` em `posicao` (limitada a `[0, tamanho]`;
   *    `null` = fim). O espelho ganha o normalizado só se faltar;
   * 3. grava lista e espelho num ÚNICO `updateOne` cujo filtro exige que os
   *    dois arrays estejam EXATAMENTE como foram lidos (igualdade de array é
   *    nativa do MongoDB). Se qualquer escrita concorrente mudou um deles
   *    (ex.: uma inclusão do mesmo item com outra grafia), nada é gravado e o
   *    resultado é `conflito` — quem chama relê e tenta de novo.
   *
   * Idempotente: cada tentativa parte do estado persistido, então repetir
   * depois de uma escrita aplicada (inclusive com confirmação perdida) devolve
   * `ja_presente`, nunca duplica.
   *
   * Fase 56.4.2 — com `opId`, a pendência é encerrada NA MESMA escrita que
   * restaura (o filtro também exige que ela ainda exista). Se o item já está
   * representado, a escrita só encerra a pendência — ainda condicionada aos
   * arrays lidos. Se a pendência já não existe, nada é gravado
   * (`pendencia_encerrada`): outra execução concluiu, e a decisão dela não é sobrescrita.
   */
  async restaurarItemLista(campo: CampoComNormalizacao, valor: string, posicao: number | null, opId: string | null): Promise<ResultadoRestauracao> {
    const { campoNormalizado, normalizar } = CAMPOS_COM_NORMALIZACAO[campo];
    const normalizado = normalizar(valor);
    const lido = await this.lerEstadoLista(campo);
    if (!lido) return "conflito";
    if (opId !== null && !lido.opIdsPendentes.includes(opId)) return "pendencia_encerrada";

    const listaAtual = lido.lista ?? [];
    const espelhoAtual = lido.espelho ?? [];
    const listaTemEquivalente = listaAtual.some((item) => normalizar(item) === normalizado);
    const espelhoTemNormalizado = espelhoAtual.includes(normalizado);
    if (listaTemEquivalente && espelhoTemNormalizado && opId === null) return "ja_presente";

    const indice = posicao === null ? listaAtual.length : Math.min(Math.max(posicao, 0), listaAtual.length);
    const novaLista = listaTemEquivalente ? listaAtual : [...listaAtual.slice(0, indice), valor, ...listaAtual.slice(indice)];
    const novoEspelho = espelhoTemNormalizado ? espelhoAtual : [...espelhoAtual, normalizado];

    const filtro: Record<string, unknown> = {
      _id: ID_CONFIGURACAO_GLOBAL,
      [campo]: igualdadeExata(lido.lista),
      [campoNormalizado]: igualdadeExata(lido.espelho),
    };
    const atualizacao: Record<string, unknown> = { $set: { [campo]: novaLista, [campoNormalizado]: novoEspelho } };
    if (opId !== null) {
      filtro["remocoesPendentes.opId"] = opId;
      atualizacao["$pull"] = { remocoesPendentes: { opId } };
    }
    const { matchedCount } = await this.configuracaoModel.updateOne(filtro, atualizacao).exec();
    if (matchedCount === 0) return "conflito";
    if (listaTemEquivalente && espelhoTemNormalizado) return "ja_presente";
    return listaTemEquivalente ? "espelho_reparado" : "restaurado";
  }
}
