import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import {
  LIMITE_MAXIMO,
  LIMITE_PADRAO,
  PAGINA_PADRAO,
  type Ordem,
  type OrdenarProdutoPor,
} from "../produtos.constants.js";

const ORDENAR_POR_VALORES: OrdenarProdutoPor[] = [
  "nome",
  "codProduto",
  "precoVenda",
  "quantidadeTotal",
  "criadoEm",
];
const ORDEM_VALORES: Ordem[] = ["asc", "desc"];

/** CSV (`"Vestidos,Blusas"`) → lista de valores; ausente/vazio → lista vazia. */
function paraLista({ value }: { value: unknown }): string[] {
  if (typeof value !== "string" || value.trim() === "") return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Espelha exatamente os parâmetros que `produtosApi.listar` já envia
 * (`src/services/api/produtos.api.ts`): `busca`, `ordenarPor`, `ordem` e a
 * seleção de facetas em CSV. Os filtros "simples" antigos (categoria única,
 * `promocao=sim|nao`…) foram aposentados — só o esquema de facetas continua.
 */
export class ListarProdutosQueryDto {
  @ApiPropertyOptional({ description: "Busca por nome, código (PROD-0001) ou categoria." })
  @IsOptional()
  @IsString()
  busca?: string;

  @ApiPropertyOptional({ enum: ORDENAR_POR_VALORES, default: "nome" })
  @IsOptional()
  @IsIn(ORDENAR_POR_VALORES)
  ordenarPor: OrdenarProdutoPor = "nome";

  @ApiPropertyOptional({ enum: ORDEM_VALORES, default: "asc" })
  @IsOptional()
  @IsIn(ORDEM_VALORES)
  ordem: Ordem = "asc";

  @ApiPropertyOptional({ description: "CSV de categorias selecionadas.", example: "Vestidos,Blusas" })
  @IsOptional()
  @Transform(paraLista)
  categorias: string[] = [];

  @ApiPropertyOptional({ description: "CSV de ids de coleção selecionados." })
  @IsOptional()
  @Transform(paraLista)
  colecoes: string[] = [];

  @ApiPropertyOptional({ description: "CSV de ids de campanha selecionados." })
  @IsOptional()
  @Transform(paraLista)
  campanhas: string[] = [];

  @ApiPropertyOptional({ description: "CSV de ids de fornecedor selecionados." })
  @IsOptional()
  @Transform(paraLista)
  fornecedores: string[] = [];

  @ApiPropertyOptional({ description: "CSV: com_estoque, sem_estoque." })
  @IsOptional()
  @Transform(paraLista)
  estoque: string[] = [];

  @ApiPropertyOptional({ description: "CSV: promocao, sem_promocao." })
  @IsOptional()
  @Transform(paraLista)
  promocao: string[] = [];

  @ApiPropertyOptional({ description: "CSV: novidade, sem_novidade." })
  @IsOptional()
  @Transform(paraLista)
  novidade: string[] = [];

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
