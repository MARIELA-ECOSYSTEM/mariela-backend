/** Formato de entrada do repository — deliberadamente não reusa a classe `@Schema`. */
export interface DadosCriarColecao {
  codigo: string;
  nome: string;
  descricao: string;
  inicio: Date;
  fim: Date;
  ativo: boolean;
  destaque: boolean;
  banner: boolean;
  fotoDestaque: string | null;
  fotoBanner: string | null;
  excluidoEm: null;
}
