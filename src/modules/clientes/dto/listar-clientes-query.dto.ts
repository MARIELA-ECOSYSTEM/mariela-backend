import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import {
  LIMITE_MAXIMO,
  LIMITE_PADRAO,
  PAGINA_PADRAO,
  type Ordem,
  type OrdenarClientePor,
} from "../clientes.constants.js";

const ORDENAR_POR_VALORES: OrdenarClientePor[] = ["nome", "compras", "totalComprado", "ultimaCompra", "criadoEm"];
const ORDEM_VALORES: Ordem[] = ["asc", "desc"];

/** CSV (`"1m,3m"`) → lista de valores; ausente/vazio → lista vazia. */
function paraLista({ value }: { value: unknown }): string[] {
  if (typeof value !== "string" || value.trim() === "") return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Espelha exatamente os grupos de filtro que a tela de Clientes já expõe
 * (`src/routes/_backoffice/clientes.tsx`): recência de compra, histórico,
 * aniversário e presença de observação — todos no mesmo esquema de facetas
 * (CSV, seleção múltipla) já usado por Produtos.
 */
export class ListarClientesQueryDto {
  @ApiPropertyOptional({ description: "Busca por nome ou telefone." })
  @IsOptional()
  @IsString()
  busca?: string;

  @ApiPropertyOptional({ enum: ORDENAR_POR_VALORES, default: "nome" })
  @IsOptional()
  @IsIn(ORDENAR_POR_VALORES)
  ordenarPor: OrdenarClientePor = "nome";

  @ApiPropertyOptional({ enum: ORDEM_VALORES, default: "asc" })
  @IsOptional()
  @IsIn(ORDEM_VALORES)
  ordem: Ordem = "asc";

  @ApiPropertyOptional({ description: "CSV: 1m, 3m, 6m (sem compra há mais de N meses)." })
  @IsOptional()
  @Transform(paraLista)
  recencia: string[] = [];

  @ApiPropertyOptional({ description: "CSV: com, sem, recorrente (2+ compras)." })
  @IsOptional()
  @Transform(paraLista)
  historico: string[] = [];

  @ApiPropertyOptional({ description: "CSV: mes, semana, com, sem (data de nascimento cadastrada)." })
  @IsOptional()
  @Transform(paraLista)
  aniversario: string[] = [];

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
