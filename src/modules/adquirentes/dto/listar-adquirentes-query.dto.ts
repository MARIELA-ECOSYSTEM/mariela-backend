import { ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import { LIMITE_MAXIMO, LIMITE_PADRAO, PAGINA_PADRAO } from "../adquirentes.constants.js";

/**
 * Contrato ENXUTO — só `busca` e paginação. Ao contrário dos demais CRUDs
 * administrativos (Produtos, Vendedores, ...), Adquirente não tem nenhuma
 * dimensão de faceta com significado próprio (não há "faixa de vendas" nem
 * data de vigência aqui) — inventar facetas sem uso real violaria a regra
 * desta etapa de não criar contratos além do especificado. Ordenação é
 * sempre por `nome` ascendente (mesmo critério padrão dos outros módulos).
 */
export class ListarAdquirentesQueryDto {
  @ApiPropertyOptional({ description: "Busca por nome." })
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
