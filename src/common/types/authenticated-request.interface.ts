import type { Request } from "express";
import type { JwtPayload } from "./jwt-payload.interface.js";

/** Populado por `JwtAuthGuard` a partir do access token validado. */
export interface AuthenticatedRequest extends Request {
  user: JwtPayload;
}
