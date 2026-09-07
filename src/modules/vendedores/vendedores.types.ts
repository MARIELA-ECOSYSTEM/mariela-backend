/** Formato de entrada do repository — deliberadamente não reusa a classe `@Schema`. */
export interface DadosCriarVendedor {
  codigo: string;
  nome: string;
  foto: string | null;
  telefone: string;
  telefoneNormalizado: string;
  dataNascimento: Date | null;
  observacao: string;
  senhaHash: string;
  ativo: boolean;
  vendas: number;
  totalVendido: number;
  ultimaVenda: null;
  excluidoEm: null;
}
