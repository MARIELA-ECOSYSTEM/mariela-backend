import type { Schema } from "mongoose";

/**
 * Uniformiza a serialização JSON de todo schema Mongoose do domínio:
 * `_id` (ObjectId) vira `id` (string) e a versão interna (`__v`) desaparece.
 * `camposOcultos` remove campos de uso puramente interno (ex.: um índice de
 * normalização usado só para consultas de unicidade).
 *
 * Precisa ser aplicado em CADA schema (incluindo subdocumentos) — o Mongoose
 * usa a configuração `toJSON` de cada schema ao serializar recursivamente.
 */
export function aplicarSerializacaoPadrao(schema: Schema, camposOcultos: string[] = []): void {
  schema.set("toJSON", {
    virtuals: true,
    versionKey: false,
    transform: (_doc: unknown, ret: Record<string, unknown>) => {
      if (ret["_id"] !== undefined) {
        ret["id"] = String(ret["_id"]);
        delete ret["_id"];
      }
      for (const campo of camposOcultos) delete ret[campo];
      return ret;
    },
  });
}
