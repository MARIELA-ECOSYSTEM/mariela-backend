import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsNotEmpty, IsNumber, IsOptional, IsString, MaxLength, Min } from "class-validator";

/** Espelha `EntradaCaixaPayload` (`src/types/caixa.ts`). */
export class EntradaCaixaDto {
  @ApiProperty({ example: "Suprimento de troco" })
  @IsString()
  @IsNotEmpty({ message: "Informe a descrição." })
  @MaxLength(200, { message: "Máximo de 200 caracteres." })
  descricao!: string;

  @ApiProperty({ example: 100 })
  @Type(() => Number)
  @IsNumber()
  @Min(0.01, { message: "O valor deve ser maior que zero." })
  valor!: number;

  @ApiProperty({ example: "Dinheiro" })
  @IsString()
  @IsNotEmpty({ message: "Informe a forma de pagamento." })
  @MaxLength(60)
  formaPagamento!: string;

  @ApiPropertyOptional({
    nullable: true,
    description: "Id de um Vendedor responsável; ausente/null = o próprio ADMIN (Backoffice).",
  })
  @IsOptional()
  @IsString()
  responsavelId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(400)
  observacao?: string;

  @ApiPropertyOptional({
    description: "Chave de idempotência opcional — repetir a mesma chave para o mesmo caixa devolve o movimento já criado, sem duplicar.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  idempotencyKey?: string;
}
