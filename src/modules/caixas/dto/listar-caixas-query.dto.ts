import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import {
  LIMITE_MAXIMO,
  LIMITE_PADRAO,
  PAGINA_PADRAO,
  type Ordem,
  type OrdenarCaixaPor,
} from "../caixas.constants.js";

const ORDENAR_POR_VALORES: OrdenarCaixaPor[] = ["data", "faturamento", "saldo", "diferenca", "vendas"];
const ORDEM_VALORES: Ordem[] = ["asc", "desc"];

/** CSV (`"aberto,fechado"`) → lista de valores; ausente/vazio → lista vazia. */
function paraLista({ value }: { value: unknown }): string[] {
  if (typeof value !== "string" || value.trim() === "") return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Espelha os grupos de filtro que a tela de Caixa já expõe
 * (`src/routes/_backoffice/caixa.index.tsx`): status, período, responsável
 * (valores dinâmicos), diferença de fechamento e faixa de saldo esperado.
 */
export class ListarCaixasQueryDto {
  @ApiPropertyOptional({ description: "Busca por código do caixa ou nome do responsável." })
  @IsOptional()
  @IsString()
  busca?: string;

  @ApiPropertyOptional({ enum: ORDENAR_POR_VALORES, default: "data" })
  @IsOptional()
  @IsIn(ORDENAR_POR_VALORES)
  ordenarPor: OrdenarCaixaPor = "data";

  @ApiPropertyOptional({ enum: ORDEM_VALORES, default: "desc" })
  @IsOptional()
  @IsIn(ORDEM_VALORES)
  ordem: Ordem = "desc";

  @ApiPropertyOptional({ description: "CSV: aberto, fechado." })
  @IsOptional()
  @Transform(paraLista)
  status: string[] = [];

  @ApiPropertyOptional({ description: "CSV: hoje, 7d, 30d, mes, mes-anterior." })
  @IsOptional()
  @Transform(paraLista)
  periodo: string[] = [];

  @ApiPropertyOptional({ description: "CSV com nomes de responsável (valores dinâmicos)." })
  @IsOptional()
  @Transform(paraLista)
  responsavel: string[] = [];

  @ApiPropertyOptional({ description: "CSV: conferido, sobra, falta." })
  @IsOptional()
  @Transform(paraLista)
  diferenca: string[] = [];

  @ApiPropertyOptional({ description: "CSV: ate-500, 500-1500, 1500-3000, acima-3000." })
  @IsOptional()
  @Transform(paraLista)
  saldo: string[] = [];

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
