/**
 * Projeção de LEITURA do PDV sobre `Cliente` — nunca uma segunda entidade
 * persistida (não existe collection própria; ver `pdv-clientes.service.ts`).
 * Omite deliberadamente tudo que é administrativo/de gestão e irrelevante
 * para localizar um cliente durante a venda: `compras`/`totalComprado`/
 * `ultimaCompra` (agregados de gestão do Backoffice), `dataNascimento` e
 * `observacao` (dados pessoais/administrativos sem uso na venda).
 */
export interface ClientePdv {
  id: string;
  codigo: string;
  nome: string;
  foto: string | null;
  telefone: string;
}
