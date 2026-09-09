/**
 * Configuração é um SINGLETON global — um único documento na coleção,
 * identificado por um `_id` fixo (não um ObjectId), mesmo padrão já usado por
 * `Sequencia` (`_id` = a chave da entidade, nunca gerado). `findOneAndUpdate`
 * com este `_id` fixo + `upsert: true` é uma operação atômica única no
 * MongoDB — cria o documento na primeira chamada, reaproveita nas seguintes,
 * sem nenhuma janela de corrida para criar um segundo documento.
 */
export const ID_CONFIGURACAO_GLOBAL = "global";

/**
 * As quatro listas do contrato (Etapa 11.2) — exatamente estas quatro, sem
 * nenhuma outra. `CampoLista` é o tipo usado pelo repository/service para
 * indexar a lista certa dentro do documento sem duplicar lógica por lista.
 */
export const CAMPOS_LISTA = ["categorias", "tamanhos", "cores", "formasPagamento"] as const;
export type CampoLista = (typeof CAMPOS_LISTA)[number];
