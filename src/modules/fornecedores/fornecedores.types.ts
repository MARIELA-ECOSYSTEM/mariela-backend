export interface EnderecoFornecedorDados {
  cep: string;
  logradouro: string;
  numero: string;
  complemento: string;
  bairro: string;
  cidade: string;
  estado: string;
}

/** Formato de entrada do repository — deliberadamente não reusa a classe `@Schema`. */
export interface DadosCriarFornecedor {
  codigo: string;
  nome: string;
  foto: string | null;
  contato: string;
  telefone: string;
  telefoneNormalizado: string;
  email: string;
  cnpj: string;
  instagram: string;
  observacao: string;
  endereco: EnderecoFornecedorDados | null;
  excluidoEm: null;
}

/** Agregados comerciais calculados a partir de Produtos — nunca persistidos em Fornecedor. */
export interface AgregadoFornecedor {
  produtosVinculados: number;
  valorEmCusto: number;
  ultimaEntrada: Date | null;
}
