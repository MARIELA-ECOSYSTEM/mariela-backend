import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, Max, Min } from "class-validator";
import {
  LIMITE_MAXIMO_MOVIMENTOS,
  LIMITE_PADRAO_MOVIMENTOS,
  PAGINA_PADRAO_MOVIMENTOS,
  TIPOS_MOVIMENTACAO,
} from "../caixas.constants.js";

function paraLista({ value }: { value: unknown }): string[] {
  if (typeof value !== "string" || value.trim() === "") return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Histórico paginado de movimentações de UM caixa (`GET /caixas/:id/movimentacoes`). */
export class ListarMovimentosQueryDto {
  @ApiPropertyOptional({ description: `CSV: ${TIPOS_MOVIMENTACAO.join(", ")}.` })
  @IsOptional()
  @Transform(paraLista)
  tipo: string[] = [];

  @ApiPropertyOptional({ enum: ["asc", "desc"], default: "desc" })
  @IsOptional()
  @IsIn(["asc", "desc"])
  ordem: "asc" | "desc" = "desc";

  @ApiPropertyOptional({ default: PAGINA_PADRAO_MOVIMENTOS, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = PAGINA_PADRAO_MOVIMENTOS;

  @ApiPropertyOptional({ default: LIMITE_PADRAO_MOVIMENTOS, minimum: 1, maximum: LIMITE_MAXIMO_MOVIMENTOS })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(LIMITE_MAXIMO_MOVIMENTOS)
  limit: number = LIMITE_PADRAO_MOVIMENTOS;
}
