import { ApiProperty } from "@nestjs/swagger";
import { IsIn, IsInt, IsMongoId, IsNotEmpty, IsString, MaxLength, Min } from "class-validator";
import { TIPOS_DE_MIDIA, type TipoMidia } from "../media.constants.js";

/**
 * Corpo de `POST /media/presigned-upload`. `contentType`/`size` são o que o cliente PRETENDE enviar: o backend
 * valida tipo e tamanho contra as regras do domínio e assina exatamente esses valores, então um envio diferente
 * do declarado é recusado pelo R2 (assinatura inválida). As regras cruzadas (MIME × `kind`, extensão × MIME,
 * limite por tipo) ficam em `MediaService`.
 */
export class SolicitarUploadDto {
  @ApiProperty({ example: "vestido.mp4", maxLength: 255, description: "Usado só para conferir a extensão — nunca vira parte da chave." })
  @IsString()
  @IsNotEmpty({ message: "Nome do arquivo é obrigatório." })
  @MaxLength(255)
  fileName!: string;

  @ApiProperty({ example: "video/mp4", description: "image/jpeg, image/png, image/webp, image/gif ou video/mp4." })
  @IsString()
  @IsNotEmpty({ message: "Tipo do arquivo é obrigatório." })
  contentType!: string;

  @ApiProperty({ enum: TIPOS_DE_MIDIA, example: "video" })
  @IsIn(TIPOS_DE_MIDIA, { message: "Tipo de mídia inválido. Use 'image' ou 'video'." })
  kind!: TipoMidia;

  @ApiProperty({ example: 4_200_000, description: "Tamanho do arquivo em bytes. Limites: imagem 5 MB, vídeo 15 MB." })
  @IsInt({ message: "Tamanho deve ser um número inteiro de bytes." })
  @Min(1, { message: "Tamanho deve ser maior que zero." })
  size!: number;

  @ApiProperty({ example: "64b0f0f0f0f0f0f0f0f0f0f0" })
  @IsMongoId({ message: "Id de produto inválido." })
  produtoId!: string;
}
