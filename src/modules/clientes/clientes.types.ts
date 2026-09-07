/** Formato de entrada do repository — deliberadamente não reusa a classe `@Schema`. */
export interface DadosCriarCliente {
  codigo: string;
  nome: string;
  foto: string | null;
  telefone: string;
  telefoneNormalizado: string;
  dataNascimento: Date | null;
  observacao: string;
  compras: number;
  totalComprado: number;
  ultimaCompra: Date | null;
  excluidoEm: null;
}
