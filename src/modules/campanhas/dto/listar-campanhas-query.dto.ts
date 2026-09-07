import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import {
  LIMITE_MAXIMO,
  LIMITE_PADRAO,
  PAGINA_PADRAO,
  type Ordem,
  type OrdenarCampanhaPor,
} from "../campanhas.constants.js";

const ORDENAR_POR_VALORES: OrdenarCampanhaPor[] = ["nome", "criadoEm", "inicio", "fim"];
const ORDEM_VALORES: Ordem[] = ["asc", "desc"];

/** CSV (`"ativa,agendada"`) → lista de valores; ausente/vazio → lista vazia. */
function paraLista({ value }: { value: unknown }): string[] {
  if (typeof value !== "string" || value.trim() === "") return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Espelha exatamente os grupos de filtro que a tela de Campanhas já expõe
 * (`src/routes/_backoffice/campanhas/index.tsx`): situação (derivada de
 * período+ativo), destaque, banner e presença de produtos vinculados.
 */
export class ListarCampanhasQueryDto {
  @ApiPropertyOptional({ description: "Busca por nome, descrição ou código." })
  @IsOptional()
  @IsString()
  busca?: string;

  @ApiPropertyOptional({ enum: ORDENAR_POR_VALORES, default: "nome" })
  @IsOptional()
  @IsIn(ORDENAR_POR_VALORES)
  ordenarPor: OrdenarCampanhaPor = "nome";

  @ApiPropertyOptional({ enum: ORDEM_VALORES, default: "asc" })
  @IsOptional()
  @IsIn(ORDEM_VALORES)
  ordem: Ordem = "asc";

  @ApiPropertyOptional({ description: "CSV: ativa, agendada, encerrada, inativa." })
  @IsOptional()
  @Transform(paraLista)
  situacao: string[] = [];

  @ApiPropertyOptional({ description: "CSV: sim, nao (em destaque na vitrine)." })
  @IsOptional()
  @Transform(paraLista)
  destaque: string[] = [];

  @ApiPropertyOptional({ description: "CSV: sim, nao (no banner da vitrine)." })
  @IsOptional()
  @Transform(paraLista)
  banner: string[] = [];

  @ApiPropertyOptional({ description: "CSV: com, sem (produtos vinculados)." })
  @IsOptional()
  @Transform(paraLista)
  produtos: string[] = [];

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
