import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import { LIMITE_MAXIMO, LIMITE_PADRAO, PAGINA_PADRAO, type Ordem, type OrdenarVendaPor } from "../vendas.constants.js";

const ORDENAR_POR_VALORES: OrdenarVendaPor[] = ["data", "valor", "pendente"];
const ORDEM_VALORES: Ordem[] = ["asc", "desc"];

function paraLista({ value }: { value: unknown }): string[] {
  if (typeof value !== "string" || value.trim() === "") return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Espelha exatamente os grupos de filtro que a tela de Vendas já expõe
 * (`src/routes/_backoffice/vendas.index.tsx`): status, período, vendedor,
 * cliente, forma de pagamento, caixa, faixa de valor, promoção/desconto e
 * situação financeira.
 */
export class ListarVendasQueryDto {
  @ApiPropertyOptional({ description: "Busca por código, número, cliente, vendedor ou forma de pagamento." })
  @IsOptional()
  @IsString()
  busca?: string;

  @ApiPropertyOptional({ enum: ORDENAR_POR_VALORES, default: "data" })
  @IsOptional()
  @IsIn(ORDENAR_POR_VALORES)
  ordenarPor: OrdenarVendaPor = "data";

  @ApiPropertyOptional({ enum: ORDEM_VALORES, default: "desc" })
  @IsOptional()
  @IsIn(ORDEM_VALORES)
  ordem: Ordem = "desc";

  @ApiPropertyOptional({ description: "CSV: em_pagamento, concluida, cancelada." })
  @IsOptional()
  @Transform(paraLista)
  status: string[] = [];

  @ApiPropertyOptional({ description: "CSV: hoje, 7d, 30d, mes, mes-anterior." })
  @IsOptional()
  @Transform(paraLista)
  periodo: string[] = [];

  @ApiPropertyOptional({ description: "CSV de ids de vendedor." })
  @IsOptional()
  @Transform(paraLista)
  vendedor: string[] = [];

  @ApiPropertyOptional({ description: "CSV de ids de cliente (ou 'consumidor-final')." })
  @IsOptional()
  @Transform(paraLista)
  cliente: string[] = [];

  @ApiPropertyOptional({ description: "CSV de formas de pagamento." })
  @IsOptional()
  @Transform(paraLista)
  pagamento: string[] = [];

  @ApiPropertyOptional({ description: "CSV de códigos de caixa." })
  @IsOptional()
  @Transform(paraLista)
  caixa: string[] = [];

  @ApiPropertyOptional({ description: "CSV: ate-200, 200-500, 500-1000, acima-1000." })
  @IsOptional()
  @Transform(paraLista)
  valor: string[] = [];

  @ApiPropertyOptional({ description: "CSV: promocao, desconto, cheio." })
  @IsOptional()
  @Transform(paraLista)
  condicoes: string[] = [];

  @ApiPropertyOptional({ description: "CSV: quitada, pendente, parcelada, devolucao." })
  @IsOptional()
  @Transform(paraLista)
  financeiro: string[] = [];

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
