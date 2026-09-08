import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsIn, IsNumber, Min } from "class-validator";
import { TIPOS_DESCONTO, type TipoDesconto } from "../../vendas/vendas.constants.js";

/**
 * Espelha `Desconto` (`modules/vendas/vendas.types.ts`) — a INTENÇÃO de
 * desconto (percentual ou valor absoluto), usada tanto por item quanto pela
 * venda. Só valida FORMATO aqui (tipo é um dos dois valores, valor não é
 * negativo) — os limites que dependem de contexto (percentual ≤ 100%, valor
 * ≤ base sobre a qual incide) são regras cruzadas com outro dado (a base),
 * então são responsabilidade do service (`VendasService.resolverDesconto`),
 * mesmo critério já usado no projeto para regras que cruzam dois campos.
 */
export class DescontoDto {
  @ApiProperty({ enum: TIPOS_DESCONTO, example: "percentual" })
  @IsIn(TIPOS_DESCONTO, { message: 'Tipo de desconto deve ser "percentual" ou "valor".' })
  tipo!: TipoDesconto;

  @ApiProperty({ example: 10, minimum: 0 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: "Informe um valor com até 2 casas decimais." })
  @Min(0, { message: "Desconto não pode ser negativo." })
  valor!: number;
}
