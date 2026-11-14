import { expect } from "bun:test";
import { descreverBarreiraAdmin } from "../../test-utils/barreira-admin-http.util.js";

/** Fase 22.8.1 — cobertura HTTP de 401 do módulo Integrações (único endpoint: `GET /integracoes`, leitura). */
descreverBarreiraAdmin({
  modulo: "integracoes",
  metodo: "GET",
  rota: "/integracoes",
  validarSucesso: ({ data }) => {
    expect(Array.isArray(data)).toBe(true);
    const ids = (data as { id: string }[]).map((integracao) => integracao.id);
    expect(ids).toContain("int_pdv");
  },
});
