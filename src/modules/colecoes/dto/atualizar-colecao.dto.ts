import { CriarColecaoDto } from "./criar-colecao.dto.js";

/**
 * O Backoffice sempre envia o payload completo em `PUT /colecoes/:id` (não é
 * uma atualização parcial) — mesmo formato de `CriarColecaoDto`, e não um
 * `PartialType`. O código da coleção continua imutável.
 */
export class AtualizarColecaoDto extends CriarColecaoDto {}
