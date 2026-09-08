import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsIn, IsInt, IsNumber, Max, Min } from "class-validator";
import { MODALIDADES_TARIFA, PARCELAS_MAXIMO_CREDITO, PARCELAS_MINIMO, type ModalidadeTarifa } from "../adquirentes.constants.js";

/**
 * Uma entrada da tabela de tarifas. `parcelas` aceita de 1 a 24 no formato do
 * campo — a regra "débito só pode ter 1 parcela" depende de outro campo
 * (`modalidade`), por isso é validada no service, não aqui (mesmo critério já
 * usado no projeto para regras que cruzam dois campos, ex.: `fim >= inicio`
 * em Coleções).
 */
export class TarifaConfigDto {
  @ApiProperty({ enum: MODALIDADES_TARIFA, example: "credito" })
  @IsIn(MODALIDADES_TARIFA, { message: "Modalidade deve ser \"debito\" ou \"credito\"." })
  modalidade!: ModalidadeTarifa;

  @ApiProperty({ example: 6, minimum: PARCELAS_MINIMO, maximum: PARCELAS_MAXIMO_CREDITO })
  @Type(() => Number)
  @IsInt({ message: "Use um número inteiro de parcelas." })
  @Min(PARCELAS_MINIMO, { message: "Parcelas deve ser maior ou igual a 1." })
  @Max(PARCELAS_MAXIMO_CREDITO, { message: `Parcelas não pode ser maior que ${PARCELAS_MAXIMO_CREDITO}.` })
  parcelas!: number;

  @ApiProperty({ example: 5.99, minimum: 0 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: "Informe um percentual com até 2 casas decimais." })
  @Min(0, { message: "Percentual não pode ser negativo." })
  percentual!: number;
}
