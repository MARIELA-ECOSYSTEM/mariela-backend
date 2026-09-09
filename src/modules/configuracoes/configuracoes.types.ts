/** Espelha `EnderecoLoja` do contrato do Backoffice (Etapa 11.2) — todos os campos são string (nunca opcionais no payload; podem ser vazios). */
export interface EnderecoLoja {
  cep: string;
  logradouro: string;
  numero: string;
  complemento: string;
  bairro: string;
  cidade: string;
  estado: string;
}

/** Espelha `DadosLoja` do contrato do Backoffice (Etapa 11.2). */
export interface DadosLoja {
  nome: string;
  logo: string;
  telefone: string;
  whatsapp: string;
  email: string;
  endereco: EnderecoLoja;
}
