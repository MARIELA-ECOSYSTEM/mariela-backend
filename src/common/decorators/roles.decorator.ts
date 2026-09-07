import { SetMetadata } from "@nestjs/common";
import type { Role } from "../types/role.type.js";

export const ROLES_KEY = "roles";

/**
 * Marca uma rota/controller como exigindo um dos papéis informados.
 * Authentication ("quem é você?") já foi resolvida pelo `JwtAuthGuard`;
 * `@Roles()` + `RolesGuard` cuidam só de Authorization ("o que você pode
 * fazer?") — os dois SEMPRE andam juntos: `@UseGuards(JwtAuthGuard, RolesGuard)`.
 */
export const Roles = (...roles: Role[]): ReturnType<typeof SetMetadata> => SetMetadata(ROLES_KEY, roles);
