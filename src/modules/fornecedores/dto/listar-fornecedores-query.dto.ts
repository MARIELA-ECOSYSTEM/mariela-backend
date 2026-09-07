import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import {
  LIMITE_MAXIMO,
  LIMITE_PADRAO,
  PAGINA_PADRAO,
  type Ordem,
  type OrdenarFornecedorPor,
} from "../fornecedores.constants.js";

const ORDENAR_POR_VALORES: OrdenarFornecedorPor[] = [
  "nome",
  "produtosVinculados",
  "valorEmCusto",
  "ultimaEntrada",
  "criadoEm",
];
const ORDEM_VALORES: Ordem[] = ["asc", "desc"];

/** CSV (`"1-5,6-15"`) → lista de valores; ausente/vazio → lista vazia. */
function paraLista({ value }: { value: unknown }): string[] {
  if (typeof value !== "string" || value.trim() === "") return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Espelha exatamente os grupos de filtro que a tela de Fornecedores já expõe
 * (`src/routes/_backoffice/fornecedores.tsx`): faixa de produtos vinculados,
 * presença de endereço, recência de entrada e presença de CNPJ.
 */
export class ListarFornecedoresQueryDto {
  @ApiPropertyOptional({ description: "Busca por nome, código, contato, telefone ou CNPJ." })
  @IsOptional()
  @IsString()
  busca?: string;

  @ApiPropertyOptional({ enum: ORDENAR_POR_VALORES, default: "nome" })
  @IsOptional()
  @IsIn(ORDENAR_POR_VALORES)
  ordenarPor: OrdenarFornecedorPor = "nome";

  @ApiPropertyOptional({ enum: ORDEM_VALORES, default: "asc" })
  @IsOptional()
  @IsIn(ORDEM_VALORES)
  ordem: Ordem = "asc";

  @ApiPropertyOptional({ description: "CSV: sem, 1-5, 6-15, 16+ (faixa de produtos vinculados)." })
  @IsOptional()
  @Transform(paraLista)
  produtos: string[] = [];

  @ApiPropertyOptional({ description: "CSV: com, sem (endereço cadastrado)." })
  @IsOptional()
  @Transform(paraLista)
  endereco: string[] = [];

  @ApiPropertyOptional({ description: "CSV: 30, 90, nunca (última entrada de produto)." })
  @IsOptional()
  @Transform(paraLista)
  entrada: string[] = [];

  @ApiPropertyOptional({ description: "CSV: com, sem (CNPJ cadastrado)." })
  @IsOptional()
  @Transform(paraLista)
  documento: string[] = [];

  @ApiPropertyOptional({ default: PAGINA_PADRAO, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = PAGINA_PADRAO;

  @ApiPropertyOptional({ default: LIMITE_PADRAO, minimum: 1, maximum: LIMITE_MAXIMO })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(LIMITE_MAXIMO)
  limit: number = LIMITE_PADRAO;
}
