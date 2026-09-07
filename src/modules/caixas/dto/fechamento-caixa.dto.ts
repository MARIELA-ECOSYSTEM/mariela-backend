import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsNumber, IsOptional, IsString, Min } from "class-validator";

/**
 * Espelha `FechamentoCaixaPayload` (`src/types/caixa.ts`). `valorEsperado` e
 * `diferenca` NÃO fazem parte do payload — o backend sempre recalcula (nunca
 * confia no cliente para o valor esperado do sistema).
 */
export class FechamentoCaixaDto {
  @ApiProperty({ example: 1250.5, minimum: 0 })
  @Type(() => Number)
  @IsNumber()
  @Min(0, { message: "O valor contado não pode ser negativo." })
  valorInformado!: number;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  responsavelId?: string | null;

  @ApiPropertyOptional({ description: "Obrigatória quando existir diferença de caixa." })
  @IsOptional()
  @IsString()
  observacao?: string;
}
