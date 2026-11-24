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

/**
 * Fase 22.8.9.10.7.3 — mensagens padrão de WhatsApp (textos pré-prontos que o operador escolhe e edita antes de
 * enviar). São só TEXTO de apoio: não são templates da Meta, não têm aprovação e não são enviadas por si.
 */
export const LIMITES_MENSAGEM_WHATSAPP = { titulo: 60, conteudo: 1000, quantidade: 30 } as const;

/** Conjunto inicial, gravado na primeira leitura de um documento que ainda não tem o campo (nunca sobrescreve). */
export const MENSAGENS_WHATSAPP_INICIAIS: readonly { titulo: string; conteudo: string }[] = [
  { titulo: "Saudação", conteudo: "Olá! Aqui é da MARIELA. Como podemos ajudar você hoje?" },
  {
    titulo: "Agradecimento pela compra",
    conteudo: "Olá! Muito obrigada pela sua compra na MARIELA. Foi um prazer atender você. Qualquer dúvida, estamos à disposição.",
  },
  { titulo: "Pedido pronto para retirada", conteudo: "Olá! Seu pedido já está pronto para retirada na MARIELA. Estamos esperando por você." },
  {
    titulo: "Aviso de pagamento",
    conteudo: "Olá! Passando para lembrar do pagamento pendente na MARIELA. Se você já fez o pagamento, por favor desconsidere esta mensagem.",
  },
  { titulo: "Aviso de pedido", conteudo: "Olá! Temos uma atualização sobre o seu pedido na MARIELA. Fale com a gente para saber os detalhes." },
  { titulo: "Atendimento personalizado", conteudo: "Olá! Aqui é da equipe MARIELA." },
];
