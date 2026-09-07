import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsOptional, IsString } from "class-validator";

/** Espelha os filtros que `estoqueApi.listar` já envia (`src/services/api/estoque.api.ts`). */
export class ListarEstoqueQueryDto {
  @ApiPropertyOptional({ description: "Busca por nome ou código do produto." })
  @IsOptional()
  @IsString()
  busca?: string;

  @ApiPropertyOptional({ enum: ["disponivel", "sem-estoque"] })
  @IsOptional()
  @IsIn(["disponivel", "sem-estoque"])
  disponibilidade?: "disponivel" | "sem-estoque";
}
