import { CriarCampanhaDto } from "./criar-campanha.dto.js";

/**
 * O Backoffice sempre envia o payload completo em `PUT /campanhas/:id` (não é
 * uma atualização parcial) — mesmo formato de `CriarCampanhaDto`, e não um
 * `PartialType`. O código da campanha continua imutável.
 */
export class AtualizarCampanhaDto extends CriarCampanhaDto {}
