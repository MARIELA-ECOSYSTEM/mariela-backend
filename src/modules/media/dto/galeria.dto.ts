import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsMongoId, IsNotEmpty, IsOptional, IsString, MaxLength, Min, ValidateIf } from "class-validator";
import { TIPOS_DE_MIDIA, type TipoMidia } from "../media.constants.js";

/** Corpo de `POST /produtos/:id/midias/uploads` — mesmo formato do upload antigo, sem `produtoId` (vem da rota). */
export class SolicitarUploadGaleriaDto {
  @ApiProperty({ example: "vestido.jpg", maxLength: 255, description: "Usado para conferir a extensão e guardado como nome original — nunca vira parte da chave." })
  @IsString()
  @IsNotEmpty({ message: "Nome do arquivo é obrigatório." })
  @MaxLength(255)
  fileName!: string;

  @ApiProperty({ example: "image/jpeg", description: "image/jpeg, image/png, image/webp, image/gif ou video/mp4." })
  @IsString()
  @IsNotEmpty({ message: "Tipo do arquivo é obrigatório." })
  contentType!: string;

  @ApiProperty({ enum: TIPOS_DE_MIDIA, example: "image" })
  @IsIn(TIPOS_DE_MIDIA, { message: "Tipo de mídia inválido. Use 'image' ou 'video'." })
  kind!: TipoMidia;

  @ApiProperty({ example: 420_000, description: "Tamanho do arquivo em bytes. Limites: imagem 5 MB, vídeo 15 MB." })
  @IsInt({ message: "Tamanho deve ser um número inteiro de bytes." })
  @Min(1, { message: "Tamanho deve ser maior que zero." })
  size!: number;

  @ApiPropertyOptional({
    description:
      "Fase 60.1.1 — id de uma mídia ATIVA deste produto, do MESMO tipo (`kind`), que o novo arquivo vai substituir. " +
      "Não conta no limite (permite trocar com a galeria cheia) e fica registrado: a confirmação usa este alvo.",
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: "Id da mídia a substituir é obrigatório quando informado." })
  @MaxLength(100)
  substituiMidiaId?: string;
}

/** Corpo (opcional) de `POST /produtos/:id/midias/uploads/:uploadId/confirmacao`. */
export class ConfirmarUploadDto {
  @ApiPropertyOptional({
    example: "65f1a2b3c4d5e6f7a8b9c0d1",
    nullable: true,
    description: "Associa a imagem a uma variante deste produto (não permitido para vídeo). Na substituição, ausente = herda a variante da antiga; null = sem variante.",
  })
  @IsOptional()
  @IsMongoId({ message: "Id de variante inválido." })
  varianteId?: string | null;

  @ApiPropertyOptional({ example: true, description: "Torna a imagem a principal do produto. Não permitido para vídeo." })
  @IsOptional()
  @IsBoolean({ message: "principal deve ser verdadeiro ou falso." })
  principal?: boolean;

  @ApiPropertyOptional({
    description:
      "Opcional e só confirmatório (Fase 60.1.1): se informado, precisa ser IGUAL ao `substituiMidiaId` da solicitação (senão 409). " +
      "A substituição em si (herda ordem, variante e principal) vem sempre do que foi registrado na solicitação.",
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: "Id da mídia a substituir é obrigatório quando informado." })
  @MaxLength(100)
  substituiMidiaId?: string;
}

/** Corpo de `PATCH /produtos/:id/midias/:midiaId`. `null` desassocia. Só imagens. */
export class AssociarVarianteMidiaDto {
  @ApiProperty({ example: "65f1a2b3c4d5e6f7a8b9c0d1", nullable: true })
  @ValidateIf((dto: AssociarVarianteMidiaDto) => dto.varianteId !== null)
  @IsMongoId({ message: "Id de variante inválido (use null para desassociar)." })
  varianteId!: string | null;
}

/** Corpo de `PUT /produtos/:id/midias/principal`. */
export class DefinirMidiaPrincipalDto {
  @ApiProperty({ example: "4b1f3c1e-7d2a-4c8e-9f00-123456789abc" })
  @IsString()
  @IsNotEmpty({ message: "Id da mídia é obrigatório." })
  @MaxLength(100)
  midiaId!: string;
}

/** Corpo de `PUT /produtos/:id/midias/ordem`: a lista COMPLETA das mídias da galeria, na nova ordem. */
export class ReordenarMidiasDto {
  @ApiProperty({ type: [String], example: ["4b1f3c1e-7d2a-4c8e-9f00-123456789abc", "9a0e…"] })
  @IsArray({ message: "midiaIds deve ser uma lista." })
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @IsNotEmpty({ each: true, message: "Ids de mídia não podem ser vazios." })
  @MaxLength(100, { each: true })
  midiaIds!: string[];
}
