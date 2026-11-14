import { expect } from "bun:test";
import { descreverBarreiraAdmin } from "../../test-utils/barreira-admin-http.util.js";
import type { ResumoRelatorios } from "./relatorios.types.js";

/** Fase 22.8.1 — cobertura HTTP de 401 do módulo Relatórios (único endpoint: `GET /relatorios/resumo`, leitura). */
descreverBarreiraAdmin({
  modulo: "relatorios",
  metodo: "GET",
  rota: "/relatorios/resumo",
  validarSucesso: ({ data }) => {
    const resumo = data as ResumoRelatorios;
    expect(typeof resumo.geradoEm).toBe("string");
    expect(typeof resumo.totalProdutos).toBe("number");
    expect(typeof resumo.pecasEmEstoque).toBe("number");
  },
});
