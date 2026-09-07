import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { ArrayMinSize, IsArray, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength, ValidateNested } from "class-validator";
import { DevolucaoItemDto } from "./devolucao-item.dto.js";

/** Espelha `CancelamentoPayload` (`src/types/venda.ts`). */
export class CancelamentoDto {
  @ApiProperty({ enum: ["integral", "parcial"] })
  @IsIn(["integral", "parcial"])
  tipo!: "integral" | "parcial";

  @ApiProperty()
  @IsString()
  @IsNotEmpty({ message: "Informe o motivo do cancelamento." })
  @MaxLength(400)
  motivo!: string;

  @ApiPropertyOptional({ type: [DevolucaoItemDto], description: "Obrigatório quando `tipo` for 'parcial'." })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1, { message: "Selecione ao menos um item para devolver." })
  @ValidateNested({ each: true })
  @Type(() => DevolucaoItemDto)
  itens?: DevolucaoItemDto[];
}
