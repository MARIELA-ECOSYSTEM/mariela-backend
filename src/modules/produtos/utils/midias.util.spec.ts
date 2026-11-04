import { describe, expect, it } from "bun:test";
import { Types } from "mongoose";
import { fotoDaVariante, idImagemPrincipal, imagensOrdenadas, urlImagemPrincipalDaGaleria, urlsImagensDaGaleria, type MidiaParaLeitura } from "./midias.util.js";

const varianteA = new Types.ObjectId();
const varianteB = new Types.ObjectId();

function midia(id: string, ordem: number, extra: Partial<MidiaParaLeitura> = {}): MidiaParaLeitura {
  return { _id: id, tipo: "image", url: `https://m.exemplo.com/${id}`, ordem, varianteId: null, ...extra };
}

describe("midias.util — leitura da galeria com compatibilidade legada (Fase 60.1)", () => {
  const midias = [midia("v", 0, { tipo: "video" }), midia("c", 3), midia("a", 1, { varianteId: varianteA }), midia("b", 2, { varianteId: varianteA })];

  it("imagens pela ordem, sem vídeos", () => {
    expect(imagensOrdenadas(midias).map((m) => m._id)).toEqual(["a", "b", "c"]);
    expect(urlsImagensDaGaleria({ midias, midiaPrincipalId: null })).toEqual(["https://m.exemplo.com/a", "https://m.exemplo.com/b", "https://m.exemplo.com/c"]);
  });

  it("principal: a marcada; sem marcação, marcada inexistente ou marcada sendo vídeo → primeira imagem pela ordem", () => {
    expect(idImagemPrincipal({ midias, midiaPrincipalId: "c" })).toBe("c");
    expect(idImagemPrincipal({ midias, midiaPrincipalId: null })).toBe("a");
    expect(idImagemPrincipal({ midias, midiaPrincipalId: "removida" })).toBe("a");
    expect(idImagemPrincipal({ midias, midiaPrincipalId: "v" })).toBe("a");
  });

  it("sem imagens na galeria, a principal é null (o chamador usa o legado)", () => {
    expect(idImagemPrincipal({ midias: [midia("v", 0, { tipo: "video" })], midiaPrincipalId: null })).toBeNull();
    expect(urlImagemPrincipalDaGaleria({ midias: [], midiaPrincipalId: null })).toBeNull();
  });

  it("foto da variante: 1ª imagem associada pela ordem; sem associada, a variante.foto legada", () => {
    const galeria = { midias, midiaPrincipalId: null };
    expect(fotoDaVariante(galeria, { _id: varianteA, foto: "https://legado/a.jpg" })).toBe("https://m.exemplo.com/a");
    expect(fotoDaVariante(galeria, { _id: varianteB, foto: "https://legado/b.jpg" })).toBe("https://legado/b.jpg");
    expect(fotoDaVariante({ midias: [], midiaPrincipalId: null }, { _id: varianteB, foto: null })).toBeNull();
  });
});
