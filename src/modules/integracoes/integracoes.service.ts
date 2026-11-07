import { Injectable } from "@nestjs/common";
import type { Integracao } from "./integracoes.types.js";

/**
 * Catálogo ESTÁTICO das integrações do ecossistema MARIELA — nenhuma delas
 * (fora o WhatsApp, já implementado em `WhatsappModule`) executa qualquer
 * chamada real; é só a vitrine consumida por `GET /integracoes`, mesmo
 * conteúdo hoje mantido em `src/services/mock/integracoes.mock.ts` do
 * Backoffice (a especificação de fato do contrato).
 */
/**
 * Fase 60.4.3.4.12 (F11) — o catálogo é exibido no Backoffice como estado das integrações; ele precisa refletir o que
 * existe de fato no backend, nunca uma proteção ou integração inexistente. Estado verificado no código nesta fase:
 *   - PDV: as rotas `/pdv/*` existem e são a API consumida pelo MARIELA PDV → "disponivel";
 *   - WhatsApp: módulo implementado, ativo só com a Evolution API configurada → "disponivel" (inalterado);
 *   - Loja online e Instagram Shopping: nenhum módulo, rota ou integração no backend → "planejada";
 *   - NF-e: nenhuma implementação → "planejada" (inalterado);
 *   - Backup: existe só como script operacional manual (`ops/backup`), sem agendamento automático e sem restauração
 *     comprovada com dados reais (`docs/backup-mongodb.md`) → "planejada". "conectada" afirmava uma proteção inexistente.
 * Só os VALORES mudaram; o formato da resposta (`Integracao`) e os ids são os mesmos.
 */
const CATALOGO: Integracao[] = [
  {
    id: "int_pdv",
    nome: "MARIELA PDV",
    categoria: "Vendas",
    descricao: "Sincronização de vendas e caixa com o PDV da loja física.",
    status: "disponivel",
    observacao: "Sistema separado que consome as rotas /pdv desta API (autenticação própria de vendedor).",
  },
  {
    id: "int_whatsapp",
    nome: "WhatsApp Business",
    categoria: "Atendimento",
    descricao: "Envio de novidades e confirmação de reservas para clientes.",
    status: "disponivel",
    observacao: "Depende de número verificado e template aprovado.",
  },
  {
    id: "int_ecommerce",
    nome: "Loja online",
    categoria: "Catálogo",
    descricao: "Publicação do catálogo, preços e estoque na vitrine digital.",
    status: "planejada",
    observacao: "Vitrine Virtual ainda não implementada; publicará apenas produtos com estoque disponível.",
  },
  {
    id: "int_nfe",
    nome: "Emissor de NF-e",
    categoria: "Fiscal",
    descricao: "Emissão de notas fiscais a partir das vendas registradas.",
    status: "planejada",
    observacao: "Aguarda definição do certificado digital da loja.",
  },
  {
    id: "int_instagram",
    nome: "Instagram Shopping",
    categoria: "Marketing",
    descricao: "Marcação de produtos do catálogo nas publicações da loja.",
    status: "planejada",
    observacao: "Ainda não implementada; exigirá conta comercial vinculada ao catálogo.",
  },
  {
    id: "int_backup",
    nome: "Backup automático",
    categoria: "Sistema",
    descricao: "Rotina de backup dos dados oficiais mantidos na API.",
    status: "planejada",
    observacao: "Hoje só existe backup manual por script operacional; agendamento automático e restauração comprovada ainda pendentes.",
  },
];

@Injectable()
export class IntegracoesService {
  listar(): Integracao[] {
    return CATALOGO.map((integracao) => ({ ...integracao }));
  }
}
