import { ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import { LIMITE_MAXIMO, LIMITE_PADRAO, PAGINA_PADRAO } from "../../clientes/clientes.constants.js";

/**
 * Contrato ENXUTO — só `busca` e paginação. Deliberadamente NÃO expõe o
 * esquema de facetas administrativo (recência/histórico/aniversário/
 * observação) de `ListarClientesQueryDto`: são filtros de gestão do
 * Backoffice, sem utilidade para o vendedor localizar um cliente durante uma
 * venda. Ordenação também não é exposta — sempre `nome`/`asc` (ver o service),
 * a mesma ordem já usada como padrão pelo Backoffice.
 *
 * Paginação REAPROVEITA as constantes administrativas (`PAGINA_PADRAO`/
 * `LIMITE_PADRAO`/`LIMITE_MAXIMO` de `clientes.constants.ts`) — ao contrário
 * do catálogo de Produtos do PDV, não há aqui nenhuma justificativa de UX
 * (grade touch-first) para uma paginação diferente da administrativa.
 */
export class ListarClientesPdvQueryDto {
  @ApiPropertyOptional({ description: "Busca por nome ou telefone." })
  @IsOptional()
  @IsString()
  busca?: string;

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
