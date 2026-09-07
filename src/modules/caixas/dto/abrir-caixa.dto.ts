import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsNumber, IsOptional, IsString, Min } from "class-validator";

/** Espelha `AberturaCaixaPayload` (`src/types/caixa.ts`). Data/hora e código nascem no backend. */
export class AbrirCaixaDto {
  @ApiPropertyOptional({
    nullable: true,
    description: "Id de um Vendedor responsável pela abertura; ausente/null = o próprio ADMIN (Backoffice).",
  })
  @IsOptional()
  @IsString()
  responsavelId?: string | null;

  @ApiProperty({ example: 200, minimum: 0 })
  @Type(() => Number)
  @IsNumber()
  @Min(0, { message: "O valor inicial não pode ser negativo." })
  valorInicial!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  observacao?: string;
}
