const fs = require("fs");
const path = require("path");
const api = require("./app.js");

const root = __dirname;
api.state.gabaritos = JSON.parse(fs.readFileSync(path.join(root, "data", "gabaritos.json"), "utf8"));
api.state.layout = JSON.parse(fs.readFileSync(path.join(root, "data", "layout_gabarito.json"), "utf8"));

function makeGraySheet(version = "A", includeVersion = true) {
  const layout = api.state.layout;
  const keys = api.state.gabaritos.versions[version];
  const width = 1240;
  const height = 1754;
  const data = new Uint8ClampedArray(width * height).fill(255);
  const pageW = layout.page_width_pt;
  const pageH = layout.page_height_pt;
  const conv = ([x, y]) => [Math.round((x / pageW) * width), Math.round(((pageH - y) / pageH) * height)];

  function setPixel(x, y, value) {
    if (x >= 0 && x < width && y >= 0 && y < height) data[y * width + x] = value;
  }

  function square(center, size, value = 0) {
    const [cx, cy] = conv(center);
    const half = Math.round((size / pageW) * width / 2);
    for (let y = cy - half; y <= cy + half; y += 1) {
      for (let x = cx - half; x <= cx + half; x += 1) setPixel(x, y, value);
    }
  }

  function circle(center, radiusPt, fill = false) {
    const [cx, cy] = conv(center);
    const radius = Math.max(3, Math.round((radiusPt / pageW) * width));
    const inner = Math.max(1, radius - 2);
    for (let y = cy - radius; y <= cy + radius; y += 1) {
      for (let x = cx - radius; x <= cx + radius; x += 1) {
        const dist2 = (x - cx) ** 2 + (y - cy) ** 2;
        if (fill && dist2 <= radius ** 2) setPixel(x, y, 0);
        if (!fill && dist2 <= radius ** 2 && dist2 >= inner ** 2) setPixel(x, y, 0);
      }
    }
  }

  for (const center of Object.values(layout.markers_pt)) square(center, layout.marker_size_pt);
  for (const center of Object.values(layout.version_bubbles_pt)) circle(center, layout.bubble_radius_pt + 1);
  for (const row of Object.values(layout.answer_bubbles_pt)) {
    for (const center of Object.values(row)) circle(center, layout.bubble_radius_pt);
  }

  if (includeVersion) circle(layout.version_bubbles_pt[version], layout.bubble_radius_pt + 1, true);
  keys.forEach((answer, index) => {
    circle(layout.answer_bubbles_pt[String(index + 1)][answer], layout.bubble_radius_pt, true);
  });

  return { width, height, data };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const result = api.correctGray(makeGraySheet("A"), { nome: "Teste", turma: "T" });
assert(result.versao === "A", `Versão esperada A, obtida ${result.versao}`);
assert(result.acertos === 20, `Acertos esperados 20, obtidos ${result.acertos}`);
assert(
  Math.abs(result.nota - api.state.gabaritos.total_points) < 1e-9,
  `Nota esperada ${api.state.gabaritos.total_points}, obtida ${result.nota}`,
);
assert(result.avisos.length === 0, `Avisos inesperados: ${result.avisos.join(", ")}`);

let failedAsExpected = false;
try {
  api.correctGray(makeGraySheet("A", false), { nome: "Sem versão", turma: "T" });
} catch {
  failedAsExpected = true;
}
assert(failedAsExpected, "Folha sem versão marcada deveria falhar.");

const manualResult = api.correctGray(makeGraySheet("A", false), {
  nome: "Sem versão",
  turma: "T",
  versaoManual: "A",
});
assert(manualResult.versao === "A", `Versão manual esperada A, obtida ${manualResult.versao}`);
assert(manualResult.versionSource === "manual", `Origem esperada manual, obtida ${manualResult.versionSource}`);
assert(manualResult.acertos === 20, `Acertos esperados 20 no modo manual, obtidos ${manualResult.acertos}`);

console.log(`PWA algorithm test ok: tipo A, 20/20, nota ${api.state.gabaritos.total_points}, erro sem versão e fallback manual validados.`);
