import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import {
  LIMITE_MAXIMO,
  LIMITE_PADRAO,
  PAGINA_PADRAO,
  type Ordem,
  type OrdenarVendedorPor,
} from "../vendedores.constants.js";

const ORDENAR_POR_VALORES: OrdenarVendedorPor[] = [
  "nome",
  "vendas",
  "totalVendido",
  "ultimaVenda",
  "dataNascimento",
  "criadoEm",
];
const ORDEM_VALORES: Ordem[] = ["asc", "desc"];

/** CSV (`"ativos,inativos"`) → lista de valores; ausente/vazio → lista vazia. */
function paraLista({ value }: { value: unknown }): string[] {
  if (typeof value !== "string" || value.trim() === "") return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Espelha exatamente os grupos de filtro que a tela de Vendedores já expõe
 * (`src/routes/_backoffice/vendedores.tsx`): status, faixa de vendas, faixa de
 * valor vendido, última venda, aniversário e presença de observação.
 */
export class ListarVendedoresQueryDto {
  @ApiPropertyOptional({ description: "Busca por nome, código ou telefone." })
  @IsOptional()
  @IsString()
  busca?: string;

  @ApiPropertyOptional({ enum: ORDENAR_POR_VALORES, default: "nome" })
  @IsOptional()
  @IsIn(ORDENAR_POR_VALORES)
  ordenarPor: OrdenarVendedorPor = "nome";

  @ApiPropertyOptional({ enum: ORDEM_VALORES, default: "asc" })
  @IsOptional()
  @IsIn(ORDEM_VALORES)
  ordem: Ordem = "asc";

  @ApiPropertyOptional({ description: "CSV: ativos, inativos." })
  @IsOptional()
  @Transform(paraLista)
  status: string[] = [];

  @ApiPropertyOptional({ description: "CSV: sem, 1-5, 6-20, 21+ (faixa de vendas)." })
  @IsOptional()
  @Transform(paraLista)
  vendas: string[] = [];

  @ApiPropertyOptional({ description: "CSV: ate-500, 500-2000, 2000-10000, 10000+ (faixa de valor vendido)." })
  @IsOptional()
  @Transform(paraLista)
  valor: string[] = [];

  @ApiPropertyOptional({ description: "CSV: 7, 30, 90, nunca (dias desde a última venda)." })
  @IsOptional()
  @Transform(paraLista)
  ultimaVenda: string[] = [];

  @ApiPropertyOptional({ description: "CSV: mes, com, sem (data de nascimento cadastrada)." })
  @IsOptional()
  @Transform(paraLista)
  nascimento: string[] = [];

  @ApiPropertyOptional({ description: "CSV: com, sem (observação cadastrada)." })
  @IsOptional()
  @Transform(paraLista)
  observacao: string[] = [];

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
