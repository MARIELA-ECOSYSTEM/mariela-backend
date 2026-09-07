import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, MaxLength } from "class-validator";

/** Espelha `BaixaParcelaPayload` (`src/types/venda.ts`). */
export class BaixarParcelaDto {
  @ApiPropertyOptional({ description: "Ausente = mantém a forma de pagamento já registrada na venda." })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  formaPagamento?: string;
}
