import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString } from "class-validator";

export class RefreshPdvDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty({ message: "Refresh token é obrigatório." })
  refreshToken!: string;
}
