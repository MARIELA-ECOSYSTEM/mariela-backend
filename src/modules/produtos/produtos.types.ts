/**
 * Formatos de ENTRADA para criação de documentos/subdocumentos — deliberadamente
 * simples (não reutilizam as classes decoradas `@Schema`, que descrevem o
 * formato PERSISTIDO/lido, com `Types.DocumentArray` etc.). Evita casts
 * artificiais no service só para satisfazer o tipo de subdocumento do Mongoose.
 */

export interface DadosCriarProduto {
  codProduto: string;
  nome: string;
  descricao: string;
  categoria: string;
  colecaoId: string | null;
  campanhaId: string | null;
  fornecedorId: string | null;
  precoCusto: number;
  precoVenda: number;
  margemLucro: number;
  ehNovidade: boolean;
  ehPromocao: false;
  precoPromocional: null;
  quantidadeTotal: 0;
  fotoPrincipalVarianteId: null;
  estoqueZeradoEm: null;
  excluidoEm: null;
  variantes: [];
}

export interface DadosNovaVariante {
  cor: string;
  corNormalizada: string;
  codVariante: string;
  quantidadeVariante: 0;
  foto: string | null;
  video: string | null;
  tamanhos: [];
}
