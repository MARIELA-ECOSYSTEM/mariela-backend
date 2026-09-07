import { ApiPropertyOptional, ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString, Max, MaxLength, Min } from "class-validator";

/**
 * Espelha `PagamentoSolicitado` (`modules/vendas/vendas.types.ts`). `forma`
 * é `string` livre de propósito — auditado o domínio real (`BaixarParcelaDto`,
 * `PagamentoVenda`) e confirmado que NÃO existe nenhum enum de forma de
 * pagamento em nenhuma parte do código-base hoje; validar contra uma lista
 * fechada aqui seria inventar uma regra que não existe (ver relatório).
 */
export class PagamentoVendaPdvDto {
  @ApiProperty({ example: "Dinheiro", maxLength: 60 })
  @IsString()
  @IsNotEmpty({ message: "Forma de pagamento é obrigatória." })
  @MaxLength(60, { message: "Máximo de 60 caracteres." })
  forma!: string;

  @ApiProperty({ example: 100 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: "Informe um valor com até 2 casas decimais." })
  @IsPositive({ message: "Valor do pagamento deve ser maior que zero." })
  valor!: number;

  @ApiPropertyOptional({ example: 1, minimum: 1, maximum: 24 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(24)
  parcelas?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  observacao?: string;
}
