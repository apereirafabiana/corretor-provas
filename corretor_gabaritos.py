# -*- coding: utf-8 -*-
"""Corretor local por camera para a folha de respostas gerada."""

from __future__ import annotations

import base64
import csv
import json
import math
import socket
import sys
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from pathlib import Path
from urllib.parse import urlparse

import numpy as np
from PIL import Image, ImageOps


ROOT = Path(__file__).resolve().parent
OUT = ROOT / "saida_prova_sistemas_controle"
GABARITOS_PATH = OUT / "gabaritos.json"
LAYOUT_PATH = OUT / "layout_gabarito.json"
RESULTS_PATH = OUT / "resultados_correcao.csv"
DEFAULT_PORT = 8080


HTML = """<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Corretor de Gabaritos - Sistemas de Controle</title>
  <style>
    :root { color-scheme: light; font-family: Arial, sans-serif; }
    body { margin: 0; background: #f3f5f7; color: #152238; }
    header { background: #0b3268; color: white; padding: 18px 16px; border-bottom: 5px solid #0b7a3b; }
    main { max-width: 760px; margin: 0 auto; padding: 18px 14px 48px; }
    h1 { margin: 0; font-size: 22px; }
    .panel { background: white; border: 1px solid #d8dee8; border-radius: 8px; padding: 16px; margin-top: 14px; }
    label { display: block; font-weight: 700; margin: 12px 0 6px; }
    input, select, button { width: 100%; box-sizing: border-box; font-size: 16px; }
    input[type="text"] { padding: 11px; border: 1px solid #c6ceda; border-radius: 6px; }
    select { padding: 11px; border: 1px solid #c6ceda; border-radius: 6px; background: #fff; }
    input[type="file"] { padding: 10px 0; }
    button { border: 0; border-radius: 6px; background: #0b7a3b; color: white; font-weight: 700; padding: 13px; margin-top: 12px; }
    button:disabled { opacity: .55; }
    .muted { color: #5b6677; font-size: 14px; line-height: 1.45; }
    .result { white-space: pre-wrap; font-family: Consolas, monospace; background: #101923; color: #eaf2ff; border-radius: 6px; padding: 14px; overflow-x: auto; }
    .ok { color: #0b7a3b; font-weight: 700; }
    .warn { color: #9a5d00; font-weight: 700; }
  </style>
</head>
<body>
  <header><h1>Corretor de Gabaritos - Sistemas de Controle</h1></header>
  <main>
    <section class="panel">
      <p class="muted">Fotografe a folha inteira, com os quatro marcadores pretos visíveis. A câmera do celular abre pelo seletor abaixo.</p>
      <label for="nome">Nome do aluno</label>
      <input id="nome" type="text" autocomplete="name" placeholder="Digite ou confira o nome">
      <label for="turma">Turma</label>
      <input id="turma" type="text" placeholder="Ex.: 2 Eletrônica">
      <label for="versao">Tipo da prova, se a leitura automática falhar</label>
      <select id="versao">
        <option value="">Detectar automaticamente</option>
        <option value="A">Tipo A</option>
        <option value="B">Tipo B</option>
        <option value="C">Tipo C</option>
        <option value="D">Tipo D</option>
      </select>
      <label for="foto">Foto do gabarito</label>
      <input id="foto" type="file" accept="image/*" capture="environment">
      <button id="corrigir">Corrigir gabarito</button>
      <p class="muted">As correções são salvas no computador em <strong>saida_prova_sistemas_controle/resultados_correcao.csv</strong>.</p>
    </section>
    <section id="saida" class="panel" style="display:none"></section>
  </main>
  <script>
    const btn = document.getElementById('corrigir');
    const saida = document.getElementById('saida');
    function readFileAsDataURL(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    }
    btn.addEventListener('click', async () => {
      const file = document.getElementById('foto').files[0];
      if (!file) {
        alert('Escolha ou fotografe uma folha de respostas.');
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Corrigindo...';
      saida.style.display = 'block';
      saida.innerHTML = '<p class="muted">Processando imagem...</p>';
      try {
        const image = await readFileAsDataURL(file);
        const resp = await fetch('/corrigir', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            nome: document.getElementById('nome').value,
            turma: document.getElementById('turma').value,
            versao_manual: document.getElementById('versao').value,
            image
          })
        });
        const data = await resp.json();
        if (!data.ok) {
          saida.innerHTML = `<p class="warn">Não foi possível corrigir.</p><div class="result">${data.error || 'Erro desconhecido'}</div>`;
          return;
        }
        const linhas = [];
        linhas.push(`Aluno: ${data.nome || '(sem nome)'}`);
        linhas.push(`Turma: ${data.turma || '-'}`);
        linhas.push(`Tipo: ${data.versao} (${data.origem_versao || 'automática'})`);
        linhas.push(`Acertos: ${data.acertos}/${data.total_questoes}`);
        linhas.push(`Nota: ${data.nota.toFixed(2)} / ${data.total_pontos.toFixed(1)}`);
        if (data.avisos.length) {
          linhas.push('');
          linhas.push('Avisos:');
          for (const aviso of data.avisos) linhas.push(`- ${aviso}`);
        }
        linhas.push('');
        linhas.push('Questão | Marcada | Correta | Situação');
        for (const item of data.detalhes) {
          linhas.push(`${String(item.questao).padStart(2, '0')}      | ${item.marcada || '-'}       | ${item.correta}       | ${item.status}`);
        }
        saida.innerHTML = `<p class="ok">Correção concluída.</p><div class="result">${linhas.join('\\n')}</div>`;
      } catch (err) {
        saida.innerHTML = `<p class="warn">Erro no envio.</p><div class="result">${err}</div>`;
      } finally {
        btn.disabled = false;
        btn.textContent = 'Corrigir gabarito';
      }
    });
  </script>
</body>
</html>
"""


def load_config() -> tuple[dict, dict]:
    if not GABARITOS_PATH.exists() or not LAYOUT_PATH.exists():
        raise FileNotFoundError(
            "Arquivos de gabarito nao encontrados. Execute gerar_prova_sistemas_controle.py primeiro."
        )
    return (
        json.loads(GABARITOS_PATH.read_text(encoding="utf-8")),
        json.loads(LAYOUT_PATH.read_text(encoding="utf-8")),
    )


def decode_image(data_url: str) -> Image.Image:
    if "," in data_url:
        data_url = data_url.split(",", 1)[1]
    raw = base64.b64decode(data_url)
    img = Image.open(BytesIO(raw))
    return ImageOps.exif_transpose(img).convert("RGB")


def prepare_gray(image: Image.Image) -> np.ndarray:
    gray = ImageOps.grayscale(image)
    gray = ImageOps.autocontrast(gray)
    max_width = 1400
    if gray.width > max_width:
        ratio = max_width / gray.width
        gray = gray.resize((max_width, int(gray.height * ratio)))
    return np.asarray(gray, dtype=np.uint8)


def integral_image(mask: np.ndarray) -> np.ndarray:
    return np.pad(mask.astype(np.int32), ((1, 0), (1, 0)), mode="constant").cumsum(0).cumsum(1)


def rect_sum(ii: np.ndarray, x: int, y: int, size: int) -> int:
    x2 = x + size
    y2 = y + size
    return int(ii[y2, x2] - ii[y, x2] - ii[y2, x] + ii[y, x])


def best_square(mask: np.ndarray, region: tuple[float, float, float, float]) -> tuple[float, float, float]:
    h, w = mask.shape
    x0 = int(region[0] * w)
    y0 = int(region[1] * h)
    x1 = int(region[2] * w)
    y1 = int(region[3] * h)
    ii = integral_image(mask)
    min_size = max(12, int(w * 0.014))
    max_size = min(90, max(min_size + 2, int(w * 0.06)))
    best = (0.0, 0.0, 0.0, 0.0)
    for size in range(min_size, max_size + 1, max(2, int(w * 0.004))):
        step = max(2, size // 5)
        max_y = max(y0, y1 - size)
        max_x = max(x0, x1 - size)
        for y in range(y0, max_y + 1, step):
            for x in range(x0, max_x + 1, step):
                dark = rect_sum(ii, x, y, size)
                density = dark / (size * size)
                if density < 0.58:
                    continue
                score = dark * density
                if score > best[3]:
                    best = (x + size / 2, y + size / 2, density, score)
    if best[3] == 0:
        raise ValueError("marcador nao localizado")
    return best[0], best[1], best[2]


def find_markers(gray: np.ndarray) -> dict[str, list[float]]:
    mask = gray < 90
    preferred = {
        "tl": (0.04, 0.16, 0.36, 0.62),
        "tr": (0.64, 0.16, 0.96, 0.62),
        "bl": (0.04, 0.45, 0.36, 0.95),
        "br": (0.64, 0.45, 0.96, 0.95),
    }
    broad = {
        "tl": (0.00, 0.00, 0.50, 0.55),
        "tr": (0.50, 0.00, 1.00, 0.55),
        "bl": (0.00, 0.45, 0.50, 1.00),
        "br": (0.50, 0.45, 1.00, 1.00),
    }
    for regions in (preferred, broad):
        try:
            markers = {}
            for key, region in regions.items():
                x, y, density = best_square(mask, region)
                if density < 0.62:
                    raise ValueError("marcador com baixa densidade")
                markers[key] = [x, y]
            return markers
        except ValueError:
            continue
    raise ValueError("Nao localizei os quatro marcadores pretos. Fotografe a folha inteira e evite sombras.")


def homography(src: list[list[float]], dst: list[list[float]]) -> np.ndarray:
    rows = []
    vals = []
    for (x, y), (u, v) in zip(src, dst):
        rows.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        vals.append(u)
        rows.append([0, 0, 0, x, y, 1, -v * x, -v * y])
        vals.append(v)
    coeffs = np.linalg.solve(np.asarray(rows, dtype=float), np.asarray(vals, dtype=float))
    return np.array(
        [
            [coeffs[0], coeffs[1], coeffs[2]],
            [coeffs[3], coeffs[4], coeffs[5]],
            [coeffs[6], coeffs[7], 1.0],
        ]
    )


def project(matrix: np.ndarray, point: list[float]) -> tuple[float, float]:
    x, y = point
    vec = matrix @ np.array([x, y, 1.0])
    return float(vec[0] / vec[2]), float(vec[1] / vec[2])


def bubble_score(gray: np.ndarray, matrix: np.ndarray, center: list[float], radius_pt: float) -> float:
    cx, cy = project(matrix, center)
    rx, ry = project(matrix, [center[0] + radius_pt, center[1]])
    radius = max(5, int(math.hypot(rx - cx, ry - cy) * 1.35))
    x0 = max(0, int(cx - radius))
    y0 = max(0, int(cy - radius))
    x1 = min(gray.shape[1], int(cx + radius + 1))
    y1 = min(gray.shape[0], int(cy + radius + 1))
    if x1 <= x0 or y1 <= y0:
        return 0.0
    patch = gray[y0:y1, x0:x1]
    yy, xx = np.ogrid[y0:y1, x0:x1]
    circle = (xx - cx) ** 2 + (yy - cy) ** 2 <= radius**2
    if not np.any(circle):
        return 0.0
    return float(np.mean(patch[circle] < 120))


def choose_mark(scores: dict[str, float], blank_threshold: float = 0.23) -> tuple[str, str]:
    ordered = sorted(scores.items(), key=lambda item: item[1], reverse=True)
    top_label, top_score = ordered[0]
    second_score = ordered[1][1] if len(ordered) > 1 else 0.0
    if top_score < blank_threshold:
        return "", "em branco"
    if second_score >= 0.68 * top_score and second_score > blank_threshold * 0.85:
        return "?", "rasurada/dupla"
    return top_label, "ok"


def correct_image(image: Image.Image, nome: str, turma: str, versao_manual: str = "") -> dict:
    gabaritos, layout = load_config()
    gray = prepare_gray(image)
    detected = find_markers(gray)
    marker_keys = ["tl", "tr", "bl", "br"]
    src = [layout["markers_pt"][key] for key in marker_keys]
    dst = [detected[key] for key in marker_keys]
    matrix = homography(src, dst)

    radius = float(layout["bubble_radius_pt"])
    manual_version = versao_manual.strip().upper()
    if manual_version:
        if manual_version not in gabaritos["versions"]:
            raise ValueError(f"Tipo manual invalido: {manual_version}.")
        version = manual_version
        version_source = "manual"
    else:
        version_scores = {
            label: bubble_score(gray, matrix, center, radius + 1)
            for label, center in layout["version_bubbles_pt"].items()
        }
        version, version_status = choose_mark(version_scores, blank_threshold=0.20)
        if version_status != "ok" or version not in gabaritos["versions"]:
            raise ValueError("Tipo de prova nao identificado ou rasurado. Se a folha estiver correta, selecione o tipo A/B/C/D manualmente e corrija de novo.")
        version_source = "automática"

    detalhes = []
    avisos = []
    acertos = 0
    answer_key = gabaritos["versions"][version]
    for question in range(1, gabaritos["question_count"] + 1):
        centers = layout["answer_bubbles_pt"][str(question)]
        scores = {label: bubble_score(gray, matrix, center, radius) for label, center in centers.items()}
        marcada, status = choose_mark(scores)
        correta = answer_key[question - 1]
        if status != "ok":
            avisos.append(f"Questao {question:02d}: {status}")
        if marcada == correta and status == "ok":
            acertos += 1
            result_status = "correta"
        elif status == "ok":
            result_status = "incorreta"
        else:
            result_status = status
        detalhes.append(
            {
                "questao": question,
                "marcada": marcada,
                "correta": correta,
                "status": result_status,
            }
        )

    nota = acertos * float(gabaritos["points_per_question"])
    result = {
        "ok": True,
        "nome": nome.strip(),
        "turma": turma.strip(),
        "versao": version,
        "origem_versao": version_source,
        "acertos": acertos,
        "nota": nota,
        "total_pontos": float(gabaritos["total_points"]),
        "total_questoes": int(gabaritos["question_count"]),
        "detalhes": detalhes,
        "avisos": avisos,
    }
    append_result(result)
    return result


def append_result(result: dict) -> None:
    new_file = not RESULTS_PATH.exists()
    with RESULTS_PATH.open("a", newline="", encoding="utf-8-sig") as fh:
        writer = csv.writer(fh, delimiter=";")
        if new_file:
            writer.writerow(
                ["Data/hora", "Nome", "Turma", "Tipo", "Acertos", "Nota"]
                + [f"Q{i}" for i in range(1, result["total_questoes"] + 1)]
                + ["Avisos"]
            )
        writer.writerow(
            [
                datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                result["nome"],
                result["turma"],
                result["versao"],
                result["acertos"],
                f"{result['nota']:.2f}".replace(".", ","),
            ]
            + [item["marcada"] for item in result["detalhes"]]
            + [" | ".join(result["avisos"])]
        )


class Handler(BaseHTTPRequestHandler):
    def send_json(self, payload: dict, status: int = 200) -> None:
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/":
            raw = HTML.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        if path == "/resultados.csv" and RESULTS_PATH.exists():
            raw = RESULTS_PATH.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/csv; charset=utf-8")
            self.send_header("Content-Disposition", "attachment; filename=resultados_correcao.csv")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        self.send_error(404)

    def do_POST(self) -> None:
        if urlparse(self.path).path != "/corrigir":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            image = decode_image(payload["image"])
            result = correct_image(image, payload.get("nome", ""), payload.get("turma", ""), payload.get("versao_manual", ""))
            self.send_json(result)
        except Exception as exc:
            self.send_json({"ok": False, "error": str(exc)}, status=200)

    def log_message(self, fmt: str, *args) -> None:
        print(f"{self.address_string()} - {fmt % args}")


def local_ip() -> str:
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.connect(("8.8.8.8", 80))
        ip = sock.getsockname()[0]
        sock.close()
        return ip
    except Exception:
        return socket.gethostbyname(socket.gethostname())


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    load_config()
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    ip = local_ip()
    print("Corretor de gabaritos iniciado.")
    print(f"No computador: http://localhost:{port}")
    print(f"No celular conectado ao mesmo Wi-Fi: http://{ip}:{port}")
    print("Pressione Ctrl+C para encerrar.")
    server.serve_forever()


if __name__ == "__main__":
    main()
