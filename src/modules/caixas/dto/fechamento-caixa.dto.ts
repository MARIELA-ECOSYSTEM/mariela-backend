import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsNumber, IsOptional, IsString } from "class-validator";

/**
 * Espelha `FechamentoCaixaPayload` (`src/types/caixa.ts`). `valorEsperado` e
 * `diferenca` NÃO fazem parte do payload — o backend sempre recalcula (nunca
 * confia no cliente para o valor esperado do sistema).
 *
 * Etapa 18.2 — `valorInformado` SEM limite inferior: o Caixa Geral da Loja
 * pode fechar negativo (sangria/cancelamento sem cobertura de saldo é
 * permitido, ver `caixas.constants.ts`), então o valor contado na
 * conferência também precisa poder ser negativo.
 */
export class FechamentoCaixaDto {
  @ApiProperty({ example: 1250.5 })
  @Type(() => Number)
  @IsNumber()
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
