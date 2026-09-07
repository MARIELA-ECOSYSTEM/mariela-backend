import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsBoolean } from "class-validator";

export class AlterarStatusVendedorDto {
  @ApiProperty({ example: false })
  @Type(() => Boolean)
  @IsBoolean()
  ativo!: boolean;
}
