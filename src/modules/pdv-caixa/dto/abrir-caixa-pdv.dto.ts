import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsNumber, IsOptional, IsString, Min } from "class-validator";

/**
 * Espelha exatamente os campos suportados por `AbrirCaixaDto` (Backoffice,
 * `modules/caixas/dto/abrir-caixa.dto.ts`) MENOS `responsavelId`: no PDV o
 * responsável é sempre o vendedor autenticado (`@VendedorPdv()`), nunca um
 * valor enviado pelo cliente — ver `pdv-caixa.controller.ts`. Como o
 * `ValidationPipe` global usa `forbidNonWhitelisted: true`, um cliente que
 * tentasse enviar `responsavelId` mesmo assim receberia 400, não uma
 * substituição silenciosa.
 */
export class AbrirCaixaPdvDto {
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
