import { describe, expect, it } from "bun:test";
import { Types } from "mongoose";
import { extrairChaveR2, idMidiaLegada, planejarProduto, type MidiaGravada, type ProdutoLegado, type VarianteLegada } from "./migrar-midias-legadas.plano.js";

/** Fase 60.2 — regras puras da migração (nenhum banco envolvido). */

const BASE = "https://media.exemplo.com";
const AGORA = new Date("2026-11-04T12:00:00.000Z");
const UUID_A = "11111111-2222-4333-8444-555555555555";

function variante(extra: Partial<Omit<VarianteLegada, "_id">> = {}): VarianteLegada {
  return { _id: new Types.ObjectId(), foto: null, video: null, ...extra };
}
function produto(variantes: VarianteLegada[], extra: Partial<ProdutoLegado> = {}): ProdutoLegado {
  return { _id: new Types.ObjectId(), __v: 0, codProduto: "PROD-0001", variantes, fotoPrincipalVarianteId: null, ...extra };
}
function plano(p: ProdutoLegado, base: string | null = BASE) {
  return planejarProduto(p, base, AGORA);
}
function novasDe(p: ProdutoLegado, base: string | null = BASE) {
  const { desfecho } = plano(p, base);
  if (desfecho.status !== "migrar") throw new Error(`esperava migrar, veio ${desfecho.status}`);
  return desfecho;
}
function midiaExistente(id: string, url: string, ordem: number, tipo = "image"): MidiaGravada {
  return { _id: id, tipo, url, ordem, varianteId: null };
}

describe("planejarProduto — migração dos campos legados (Fase 60.2)", () => {
  it("foto legada válida vira imagem de origem legado, associada à variante, URL preservada", () => {
    const v = variante({ foto: "https://cdn.externo.com/vestido.jpg" });
    const p = produto([v]);
    const { novas, definirPrincipal } = novasDe(p);
    expect(novas).toEqual([
      {
        _id: `legado-${String(p._id)}-${String(v._id)}-foto`,
        tipo: "image",
        chave: null,
        url: "https://cdn.externo.com/vestido.jpg",
        contentType: null,
        tamanho: null,
        nomeOriginal: null,
        origem: "legado",
        varianteId: v._id,
        ordem: 0,
        criadoEm: AGORA,
        criadoPor: null,
      },
    ]);
    expect(definirPrincipal).toBeNull();
  });

  it("vídeo legado válido vira vídeo do produto (varianteId null); ordem segue as variantes, foto antes do vídeo", () => {
    const a = variante({ foto: "https://x.com/a.jpg", video: "https://x.com/a.mp4" });
    const b = variante({ video: "https://x.com/b.mp4" });
    const c = variante({ foto: "https://x.com/c.png" });
    const { novas } = novasDe(produto([a, b, c]));
    expect(novas.map((m) => [m.tipo, m.url, m.ordem, m.varianteId === null ? null : String(m.varianteId)])).toEqual([
      ["image", "https://x.com/a.jpg", 0, String(a._id)],
      ["video", "https://x.com/a.mp4", 1, null],
      ["video", "https://x.com/b.mp4", 2, null],
      ["image", "https://x.com/c.png", 3, String(c._id)],
    ]);
  });

  it("ids são determinísticos: o mesmo produto gera sempre os mesmos ids", () => {
    const p = produto([variante({ foto: "https://x.com/a.jpg", video: "https://x.com/a.mp4" })]);
    expect(novasDe(p).novas.map((m) => m._id)).toEqual(novasDe(p).novas.map((m) => m._id));
    expect(idMidiaLegada("p", "v", "video")).toBe("legado-p-v-video");
  });

  it("URL externa válida (http ou https) é migrada como legado, com chave null e sem aviso", () => {
    const p = produto([variante({ foto: "http://loja-antiga.com.br/fotos/1.jpg" })]);
    const resultado = plano(p);
    expect(resultado.ocorrencias).toEqual([]);
    expect(novasDe(p).novas[0]!.chave).toBeNull();
  });

  it("URL do domínio R2 configurado com chave deste produto: chave extraída (também com base que tem caminho)", () => {
    const p = produto([]);
    const id = String(p._id);
    p.variantes = [variante({ foto: `${BASE}/products/${id}/${UUID_A}.jpg`, video: `${BASE}/products/${id}/${UUID_A}.mp4` })];
    expect(novasDe(p).novas.map((m) => m.chave)).toEqual([`products/${id}/${UUID_A}.jpg`, `products/${id}/${UUID_A}.mp4`]);
    expect(plano(p).ocorrencias).toEqual([]);

    const comCaminho = extrairChaveR2(new URL(`https://cdn.exemplo.com/midia/products/${id}/${UUID_A}.webp`), "https://cdn.exemplo.com/midia", id, "image");
    expect(comCaminho).toEqual({ chave: `products/${id}/${UUID_A}.webp`, doDominio: true });
  });

  it("URL R2 com caminho inválido: migrada com chave null e aviso — outro produto, extensão do tipo errado, query, segmento extra, não-UUID, fora do prefixo", () => {
    const p = produto([]);
    const id = String(p._id);
    const outro = new Types.ObjectId().toHexString();
    const invalidas = [
      [`${BASE}/products/${outro}/${UUID_A}.jpg`, "image"],
      [`${BASE}/products/${id}/${UUID_A}.jpg`, "video"],
      [`${BASE}/products/${id}/${UUID_A}.jpg?v=2`, "image"],
      [`${BASE}/products/${id}/extra/${UUID_A}.jpg`, "image"],
      [`${BASE}/products/${id}/foto.jpg`, "image"],
      [`${BASE}/products/${id}/${UUID_A}.JPG`, "image"],
    ] as const;
    for (const [url, tipo] of invalidas) expect(extrairChaveR2(new URL(url), BASE, id, tipo)).toEqual({ chave: null, doDominio: true });
    expect(extrairChaveR2(new URL(`https://cdn.exemplo.com/outra/products/${id}/${UUID_A}.jpg`), "https://cdn.exemplo.com/midia", id, "image")).toEqual({
      chave: null,
      doDominio: true,
    });
    // Outra origem (até um subdomínio) nunca é tratada como R2.
    expect(extrairChaveR2(new URL(`https://evil.media.exemplo.com/products/${id}/${UUID_A}.jpg`), BASE, id, "image")).toEqual({ chave: null, doDominio: false });

    p.variantes = [variante({ foto: `${BASE}/products/${outro}/${UUID_A}.jpg` })];
    expect(novasDe(p).novas[0]!.chave).toBeNull();
    expect(plano(p).ocorrencias).toEqual([{ tipo: "chave_r2_nao_reconhecida", varianteId: String(p.variantes[0]!._id), campo: "foto" }]);
  });

  it("sem domínio de mídia configurado: nenhuma chave é extraída, mesmo de URL que pareça do R2", () => {
    const p = produto([]);
    p.variantes = [variante({ foto: `${BASE}/products/${String(p._id)}/${UUID_A}.jpg` })];
    expect(novasDe(p, null).novas[0]!.chave).toBeNull();
    expect(plano(p, null).ocorrencias).toEqual([]);
  });

  it("URL inválida não entra na galeria e vai para as ocorrências; as demais mídias do produto migram", () => {
    const ruim = variante({ foto: "nao-e-uma-url", video: "javascript:alert(1)" });
    const ftp = variante({ foto: "ftp://arquivos/x.jpg" });
    const numero = variante({ foto: 42 });
    const boa = variante({ foto: "https://x.com/ok.jpg" });
    const p = produto([ruim, ftp, numero, boa]);
    const resultado = plano(p);
    expect(resultado.ocorrencias.map((o) => o.tipo)).toEqual(["url_invalida", "url_invalida", "url_invalida", "url_invalida"]);
    expect(novasDe(p).novas.map((m) => m.url)).toEqual(["https://x.com/ok.jpg"]);
  });

  it("só URLs inválidas: pendente (urls_invalidas), nada a gravar", () => {
    const resultado = plano(produto([variante({ foto: "lixo" })]));
    expect(resultado.temMidiaLegada).toBe(true);
    expect(resultado.desfecho).toMatchObject({ status: "pendente", motivo: "urls_invalidas" });
  });

  it("variante sem mídia não gera nada; produto sem nenhuma mídia é sem_midia (inclusive strings vazias e sem variantes)", () => {
    const p = produto([variante(), variante({ foto: "https://x.com/a.jpg" }), variante({ foto: "   ", video: "" })]);
    expect(novasDe(p).novas).toHaveLength(1);
    expect(plano(produto([variante(), variante({ foto: "" })])).desfecho).toEqual({ status: "sem_midia" });
    expect(plano({ _id: new Types.ObjectId() }).desfecho).toEqual({ status: "sem_midia" });
  });

  it("principal apontando para variante com foto válida vira midiaPrincipalId dessa imagem", () => {
    const a = variante({ foto: "https://x.com/a.jpg" });
    const b = variante({ foto: "https://x.com/b.jpg" });
    const p = produto([a, b], { fotoPrincipalVarianteId: b._id });
    expect(novasDe(p).definirPrincipal).toBe(idMidiaLegada(String(p._id), String(b._id), "foto"));
  });

  it("principal apontando para variante sem foto (ou com foto inválida, ou inexistente): nenhuma principal inventada + ocorrência", () => {
    const comFoto = variante({ foto: "https://x.com/a.jpg" });
    const semFoto = variante({ video: "https://x.com/v.mp4" });
    const invalida = variante({ foto: "lixo" });
    for (const alvo of [semFoto._id, invalida._id, new Types.ObjectId()]) {
      const p = produto([comFoto, semFoto, invalida], { fotoPrincipalVarianteId: alvo });
      expect(novasDe(p).definirPrincipal).toBeNull();
      expect(plano(p).ocorrencias).toContainEqual({ tipo: "principal_sem_imagem", varianteId: String(alvo) });
    }
  });

  it("produto já migrado: ja_migrado (associação de variante alterada depois não é conflito)", () => {
    const v = variante({ foto: "https://x.com/a.jpg", video: "https://x.com/a.mp4" });
    const p = produto([v]);
    const { novas } = novasDe(p);
    p.midias = novas.map((m) => ({ ...m, varianteId: null }));
    expect(plano(p).desfecho).toEqual({ status: "ja_migrado" });
  });

  it("produto já migrado com item legado ausente (removido da galeria ou variante nova): pendente, nunca reinsere", () => {
    const a = variante({ foto: "https://x.com/a.jpg" });
    const b = variante({ foto: "https://x.com/b.jpg" });
    const p = produto([a]);
    p.midias = novasDe(p).novas;
    p.variantes = [a, b];
    expect(plano(p).desfecho).toMatchObject({ status: "pendente", motivo: "divergencia_pos_migracao" });
  });

  it("produto com galeria nova (uploads): combina sem conflito, depois das existentes, preservando a principal existente", () => {
    const v = variante({ foto: "https://x.com/legado.jpg" });
    const p = produto([v], {
      fotoPrincipalVarianteId: v._id,
      midias: [midiaExistente("upload-1", `${BASE}/products/x/${UUID_A}.jpg`, 0), midiaExistente("upload-2", "https://x.com/u2.jpg", 4)],
      midiaPrincipalId: "upload-1",
    });
    const { novas, definirPrincipal } = novasDe(p);
    expect(novas.map((m) => [m.url, m.ordem])).toEqual([["https://x.com/legado.jpg", 5]]);
    expect(definirPrincipal).toBeNull();
  });

  it("conflito com mídia existente: mesma URL já na galeria, ou id determinístico com outra URL → pendente, nada a gravar", () => {
    const v = variante({ foto: "https://x.com/a.jpg" });
    const mesmaUrl = produto([v], { midias: [midiaExistente("upload-1", "https://x.com/a.jpg", 0)] });
    expect(plano(mesmaUrl).desfecho).toMatchObject({ status: "pendente", motivo: "conflito" });

    const p = produto([v]);
    p.midias = [midiaExistente(idMidiaLegada(String(p._id), String(v._id), "foto"), "https://x.com/OUTRA.jpg", 0)];
    expect(plano(p).desfecho).toMatchObject({ status: "pendente", motivo: "conflito" });
  });

  it("limites: exatamente 20 imagens e 3 vídeos migram; 21 imagens ou 4 vídeos ficam pendentes (nada descartado)", () => {
    const vinte = produto(Array.from({ length: 20 }, (_, i) => variante({ foto: `https://x.com/${i}.jpg` })));
    expect(novasDe(vinte).novas).toHaveLength(20);
    const tres = produto(Array.from({ length: 3 }, (_, i) => variante({ video: `https://x.com/${i}.mp4` })));
    expect(novasDe(tres).novas).toHaveLength(3);

    const vinteUma = produto(Array.from({ length: 21 }, (_, i) => variante({ foto: `https://x.com/${i}.jpg` })));
    expect(plano(vinteUma).desfecho).toMatchObject({ status: "pendente", motivo: "limite" });
    const quatro = produto(Array.from({ length: 4 }, (_, i) => variante({ video: `https://x.com/${i}.mp4` })));
    expect(plano(quatro).desfecho).toMatchObject({ status: "pendente", motivo: "limite" });
  });

  it("limite conta a galeria existente: 18 uploads + 3 fotos legadas = 21 → pendente", () => {
    const p = produto(Array.from({ length: 3 }, (_, i) => variante({ foto: `https://x.com/l${i}.jpg` })), {
      midias: Array.from({ length: 18 }, (_, i) => midiaExistente(`u${i}`, `https://x.com/u${i}.jpg`, i)),
    });
    expect(plano(p).desfecho).toMatchObject({ status: "pendente", motivo: "limite" });
  });
});
