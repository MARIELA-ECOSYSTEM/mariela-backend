import { ApiPropertyOptional, ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString, Max, MaxLength, Min } from "class-validator";
import { MODALIDADES_PAGAMENTO, type ModalidadePagamento } from "../../vendas/vendas.constants.js";

/**
 * Espelha `PagamentoSolicitado` (`modules/vendas/vendas.types.ts`). `forma`
 * é `string` livre de propósito — auditado o domínio real (`BaixarParcelaDto`,
 * `PagamentoVenda`) e confirmado que NÃO existe nenhum enum de forma de
 * pagamento em nenhuma parte do código-base hoje; validar contra uma lista
 * fechada aqui seria inventar uma regra que não existe (ver relatório).
 *
 * `modalidade`/`adquirenteId` são ADITIVOS e OPCIONAIS (Etapa 10.4) — um
 * pagamento sem eles continua sendo aceito exatamente como antes. Este DTO
 * só valida FORMATO (modalidade é um dos 4 valores; adquirenteId é string);
 * as regras que dependem do banco — adquirente existe/está ativa, tarifa
 * configurada para a modalidade/parcelas — são responsabilidade exclusiva de
 * `VendasService.validarPagamentoEstruturado`, nunca deste DTO.
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

  @ApiPropertyOptional({ enum: MODALIDADES_PAGAMENTO, example: "credito" })
  @IsOptional()
  @IsIn(MODALIDADES_PAGAMENTO, { message: 'Modalidade deve ser "dinheiro", "pix", "debito" ou "credito".' })
  modalidade?: ModalidadePagamento;

  @ApiPropertyOptional({ description: "Obrigatório quando modalidade é débito ou crédito." })
  @IsOptional()
  @IsString()
  adquirenteId?: string;
}
