import { ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import type { Ordem, OrdenarProdutoPor } from "../../produtos/produtos.constants.js";
import { LIMITE_MAXIMO_PDV, LIMITE_PADRAO_PDV, PAGINA_PADRAO_PDV } from "../pdv-produtos.constants.js";

const ORDENAR_POR_VALORES: OrdenarProdutoPor[] = ["nome", "codProduto", "precoVenda", "quantidadeTotal", "criadoEm"];
const ORDEM_VALORES: Ordem[] = ["asc", "desc"];

/**
 * Contrato ENXUTO — só `busca`, ordenação e paginação. Deliberadamente NÃO
 * expõe o esquema de facetas administrativo (categorias/coleções/campanhas/
 * fornecedores/promoção/novidade/estoque) de `ListarProdutosQueryDto`: são
 * filtros organizacionais do Backoffice, sem utilidade comprovada para o
 * vendedor nesta etapa (nenhum frontend do PDV existe ainda para justificá-los)
 * — evita copiar cegamente o contrato administrativo (ver relatório, seção
 * "Decisões").
 */
export class ListarProdutosPdvQueryDto {
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

  @ApiPropertyOptional({ default: PAGINA_PADRAO_PDV, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = PAGINA_PADRAO_PDV;

  @ApiPropertyOptional({ default: LIMITE_PADRAO_PDV, minimum: 1, maximum: LIMITE_MAXIMO_PDV })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(LIMITE_MAXIMO_PDV)
  limit: number = LIMITE_PADRAO_PDV;
}
