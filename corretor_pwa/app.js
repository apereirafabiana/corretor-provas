const APP_VERSION = "2026-05-23-paper-first-scan-now-1";
const SCANNER_FRAME_INTERVAL_MS = 250;
const RESULTS_KEY = "cefet_corretor_resultados_v1";
const HAS_DOM = typeof document !== "undefined";

const state = {
  gabaritos: null,
  layout: null,
  results: [],
  scanner: {
    active: false,
    locked: false,
    raf: 0,
    stream: null,
    lastProcessAt: 0,
    lastSignature: "",
    stableCount: 0,
    resolutionLabel: "",
    lastGray: null,
    lastMarkers: null,
    lastGeometry: null,
    lastResult: null,
  },
};

const $ = (selector) => (HAS_DOM ? document.querySelector(selector) : null);

const els = {
  status: $("#app-status"),
  name: $("#student-name"),
  turma: $("#student-class"),
  photo: $("#sheet-photo"),
  manualVersion: $("#manual-version"),
  scannerVideo: $("#scanner-video"),
  scannerOverlay: $("#scanner-overlay"),
  scannerStatus: $("#scanner-status"),
  startScanner: $("#start-scanner-button"),
  scanNow: $("#scan-now-button"),
  stopScanner: $("#stop-scanner-button"),
  correct: $("#correct-button"),
  resetForm: $("#reset-form-button"),
  resultPanel: $("#result-panel"),
  resultBadge: $("#result-badge"),
  resultSummary: $("#result-summary"),
  resultWarnings: $("#result-warnings"),
  resultDetails: $("#result-details"),
  savedCount: $("#saved-count"),
  savedResults: $("#saved-results"),
  exportButton: $("#export-button"),
  clearButton: $("#clear-button"),
  savedTemplate: $("#saved-result-template"),
};

if (HAS_DOM) {
  document.addEventListener("DOMContentLoaded", init);
}

async function init() {
  try {
    const [gabaritos, layout] = await Promise.all([
      fetchJson("./data/gabaritos.json"),
      fetchJson("./data/layout_gabarito.json"),
    ]);
    state.gabaritos = gabaritos;
    state.layout = layout;
    state.results = readStoredResults();
    els.status.textContent = `${gabaritos.question_count} questões | ${gabaritos.total_points.toFixed(1)} pts`;
    els.correct.disabled = false;
    updateCameraAvailability();
    renderSavedResults();
    wireEvents();
    registerServiceWorker();
  } catch (error) {
    els.status.textContent = "Erro ao carregar";
    showError(`Não consegui carregar os arquivos do gabarito: ${error.message}`);
  }
}

function wireEvents() {
  els.correct.addEventListener("click", handleCorrection);
  els.startScanner.addEventListener("click", startScanner);
  els.scanNow.addEventListener("click", handleScanNow);
  els.stopScanner.addEventListener("click", () => stopScanner(true));
  els.resetForm.addEventListener("click", resetForm);
  els.exportButton.addEventListener("click", exportCsv);
  els.clearButton.addEventListener("click", clearResults);
  window.addEventListener("resize", syncScannerOverlay);
  window.addEventListener("beforeunload", () => stopScanner(false));
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.json();
}

function cameraAvailable() {
  return Boolean(
    HAS_DOM &&
      window.isSecureContext &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === "function",
  );
}

function updateCameraAvailability() {
  if (!els.startScanner || !els.scannerStatus) return;
  const available = cameraAvailable();
  els.startScanner.disabled = !available;
  els.scanNow.disabled = true;
  if (!available) {
    els.scannerStatus.textContent =
      "Scanner ao vivo disponivel apenas em HTTPS ou localhost. Use a foto como backup.";
  }
}

function readStudentForm() {
  return {
    nome: els.name.value.trim(),
    turma: els.turma.value.trim(),
    versaoManual: els.manualVersion.value,
  };
}

async function startScanner() {
  if (!cameraAvailable()) {
    showError("A camera ao vivo exige HTTPS ou localhost. No celular, use o link publicado no GitHub Pages.");
    return;
  }

  stopScanner(false);
  setScannerStatus("Solicitando acesso a camera...");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1440 },
        aspectRatio: { ideal: 1.3333333333 },
      },
    });

    state.scanner.stream = stream;
    state.scanner.active = true;
    state.scanner.locked = false;
    resetScannerStability();
    els.scannerVideo.srcObject = stream;
    await waitForVideoReady(els.scannerVideo);
    await tuneCameraTrack(stream);
    await els.scannerVideo.play();
    updateScannerResolutionLabel();
    els.startScanner.disabled = true;
    els.scanNow.disabled = true;
    els.stopScanner.disabled = false;
    setScannerStatus(`Procurando os quatro quadrados pretos (${state.scanner.resolutionLabel})...`);
    state.scanner.raf = requestAnimationFrame(scannerLoop);
  } catch (error) {
    stopScanner(false);
    setScannerStatus("Nao foi possivel abrir a camera. Use o modo foto como backup.");
    showError(`Nao foi possivel abrir a camera: ${error.message}`);
  }
}

function waitForVideoReady(video) {
  if (video.readyState >= 2 && video.videoWidth > 0) return Promise.resolve();
  return new Promise((resolve) => {
    video.addEventListener("loadedmetadata", resolve, { once: true });
  });
}

async function tuneCameraTrack(stream) {
  const [track] = stream.getVideoTracks();
  if (!track || typeof track.getCapabilities !== "function" || typeof track.applyConstraints !== "function") return;

  const capabilities = track.getCapabilities();
  const advanced = [];
  if (capabilities.focusMode?.includes("continuous")) advanced.push({ focusMode: "continuous" });
  if (capabilities.exposureMode?.includes("continuous")) advanced.push({ exposureMode: "continuous" });
  if (capabilities.whiteBalanceMode?.includes("continuous")) advanced.push({ whiteBalanceMode: "continuous" });

  if (advanced.length) {
    try {
      await track.applyConstraints({ advanced });
    } catch {
      // Some browsers expose the capability but reject the constraint. The scanner still works.
    }
  }
}

function updateScannerResolutionLabel() {
  const [track] = state.scanner.stream?.getVideoTracks?.() || [];
  const settings = track?.getSettings?.() || {};
  const width = settings.width || els.scannerVideo.videoWidth || 0;
  const height = settings.height || els.scannerVideo.videoHeight || 0;
  state.scanner.resolutionLabel = width && height ? `${width}x${height}` : "camera ativa";
}

function scannerLoop(timestamp) {
  if (!state.scanner.active || state.scanner.locked) return;
  if (timestamp - state.scanner.lastProcessAt >= SCANNER_FRAME_INTERVAL_MS) {
    state.scanner.lastProcessAt = timestamp;
    processScannerFrame();
  }
  state.scanner.raf = requestAnimationFrame(scannerLoop);
}

function processScannerFrame() {
  if (!els.scannerVideo.videoWidth || !els.scannerVideo.videoHeight) return;

  try {
    const gray = prepareGray(els.scannerVideo);
    const markers = findMarkers(gray);
    drawScannerOverlay(gray, markers);
    rememberScannerFrame(gray, markers);

    const geometry = markerGeometry(markers, gray);
    if (scannerGeometryStable(geometry, state.scanner.lastGeometry)) {
      state.scanner.stableCount += 1;
    } else {
      state.scanner.lastGeometry = geometry;
      state.scanner.stableCount = 1;
    }

    let result = null;
    let correctionError = null;
    try {
      result = correctGray(gray, readStudentForm(), markers);
      state.scanner.lastResult = result;
    } catch (error) {
      correctionError = error;
      state.scanner.lastResult = null;
    }

    const needed = 2;
    if (result) {
      setScannerStatus(`${scannerSuccessMessage(gray, markers)} Segure parado: ${state.scanner.stableCount}/${needed}`);
      if (state.scanner.stableCount >= needed) finishScannerCorrection(result);
    } else if (correctionError?.message.includes("Tipo de prova")) {
      setScannerStatus("Folha encontrada. Selecione o tipo A/B/C/D ou toque em Corrigir agora.");
    } else {
      setScannerStatus(`${scannerSuccessMessage(gray, markers)} Toque em Corrigir agora ou ajuste luz/foco.`);
    }
  } catch (error) {
    resetScannerStability();
    clearScannerFrame();
    clearScannerOverlay();
    setScannerStatus(scannerErrorMessage(error.message));
  }
}

function rememberScannerFrame(gray, markers) {
  state.scanner.lastGray = gray;
  state.scanner.lastMarkers = markers;
  if (els.scanNow) els.scanNow.disabled = false;
}

function markerGeometry(markers, gray) {
  const box = markerBoundingBox(markers);
  const centerX = (box.minX + box.maxX) / 2 / gray.width;
  const centerY = (box.minY + box.maxY) / 2 / gray.height;
  return {
    centerX,
    centerY,
    width: box.width / gray.width,
    height: box.height / gray.height,
    points: [markers.tl, markers.tr, markers.bl, markers.br].map(([x, y]) => [x / gray.width, y / gray.height]),
  };
}

function scannerGeometryStable(current, previous) {
  if (!previous) return false;
  const centerShift = Math.hypot(current.centerX - previous.centerX, current.centerY - previous.centerY);
  const sizeShift = Math.abs(current.width - previous.width) + Math.abs(current.height - previous.height);
  let pointShift = 0;
  for (let i = 0; i < current.points.length; i += 1) {
    pointShift += Math.hypot(current.points[i][0] - previous.points[i][0], current.points[i][1] - previous.points[i][1]);
  }
  return centerShift < 0.025 && sizeShift < 0.055 && pointShift / current.points.length < 0.035;
}

function handleScanNow() {
  if (!state.scanner.lastGray || !state.scanner.lastMarkers) {
    setScannerStatus("Enquadre a folha ate aparecer o contorno verde.");
    return;
  }

  setScannerStatus("Corrigindo...");
  try {
    const result = correctGray(state.scanner.lastGray, readStudentForm(), state.scanner.lastMarkers);
    finishScannerCorrection(result);
  } catch (error) {
    if (error.message.includes("Tipo de prova")) {
      setScannerStatus("Selecione o tipo A/B/C/D e toque em Corrigir agora.");
    } else {
      showError(error.message);
    }
  }
}

function finishScannerCorrection(result) {
  state.scanner.locked = true;
  state.results.unshift(result);
  storeResults();
  renderResult(result);
  renderSavedResults();
  stopScanner(false);
  setScannerStatus(`Correcao concluida: ${result.acertos}/${result.totalQuestoes}, nota ${formatGrade(result.nota)}.`);
}

function stopScanner(showMessage = true) {
  if (state.scanner.raf) cancelAnimationFrame(state.scanner.raf);
  state.scanner.raf = 0;
  state.scanner.active = false;
  state.scanner.locked = false;
  resetScannerStability();
  clearScannerFrame();

  if (state.scanner.stream) {
    for (const track of state.scanner.stream.getTracks()) track.stop();
  }
  state.scanner.stream = null;
  if (els.scannerVideo) els.scannerVideo.srcObject = null;
  if (els.stopScanner) els.stopScanner.disabled = true;
  if (els.scanNow) els.scanNow.disabled = true;
  if (els.startScanner) els.startScanner.disabled = !cameraAvailable();
  if (showMessage) {
    clearScannerOverlay();
    setScannerStatus("Camera parada. Inicie de novo para corrigir outra folha.");
  }
}

function resetScannerStability() {
  state.scanner.lastSignature = "";
  state.scanner.stableCount = 0;
  state.scanner.lastProcessAt = 0;
  state.scanner.lastGeometry = null;
  state.scanner.lastResult = null;
}

function clearScannerFrame() {
  state.scanner.lastGray = null;
  state.scanner.lastMarkers = null;
  state.scanner.lastResult = null;
  if (els.scanNow) els.scanNow.disabled = true;
}

function setScannerStatus(message) {
  if (els.scannerStatus) els.scannerStatus.textContent = message;
}

function scannerErrorMessage(message) {
  const resolution = state.scanner.resolutionLabel ? ` (${state.scanner.resolutionLabel})` : "";
  if (message.includes("marcadores")) return "Aproxime ou afaste ate aparecerem os quatro quadrados pretos.";
  if (message.includes("Tipo de prova")) return "Folha encontrada. Marque o tipo A/B/C/D ou selecione manualmente.";
  return `Ajuste luz, foco e enquadramento da folha${resolution}.`;
}

function scannerSuccessMessage(gray, markers) {
  const box = markerBoundingBox(markers);
  const coverage = (box.width * box.height) / (gray.width * gray.height);
  const minDensity = markers._meta?.minDensity ?? 1;
  const resolution = state.scanner.resolutionLabel ? ` (${state.scanner.resolutionLabel})` : "";

  if (coverage < 0.18) return `Folha encontrada, mas esta longe. Aproxime um pouco${resolution}.`;
  if (coverage > 0.88) return `Folha encontrada, mas esta muito perto. Afaste um pouco${resolution}.`;
  if (minDensity < 0.5) return `Folha encontrada. Melhore a luz ou o foco${resolution}.`;
  return `Folha encontrada${resolution}.`;
}

function markerBoundingBox(markers) {
  const points = [markers.tl, markers.tr, markers.bl, markers.br];
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
}

function syncScannerOverlay() {
  if (!els.scannerOverlay || state.scanner.active) return;
  clearScannerOverlay();
}

function drawScannerOverlay(gray, markers) {
  const canvas = els.scannerOverlay;
  if (!canvas) return;
  if (canvas.width !== gray.width) canvas.width = gray.width;
  if (canvas.height !== gray.height) canvas.height = gray.height;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const points = [markers.tl, markers.tr, markers.br, markers.bl];
  ctx.strokeStyle = "#34d399";
  ctx.fillStyle = "#34d399";
  ctx.lineWidth = Math.max(3, Math.round(gray.width / 280));
  ctx.beginPath();
  points.forEach(([x, y], index) => {
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.stroke();

  const radius = Math.max(8, Math.round(gray.width / 70));
  for (const [x, y] of points) {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
}

function clearScannerOverlay() {
  const canvas = els.scannerOverlay;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function readStoredResults() {
  try {
    return JSON.parse(localStorage.getItem(RESULTS_KEY) || "[]");
  } catch {
    return [];
  }
}

function storeResults() {
  localStorage.setItem(RESULTS_KEY, JSON.stringify(state.results));
}

async function handleCorrection() {
  const file = els.photo.files[0];
  if (!file) {
    showError("Escolha ou fotografe uma folha de respostas antes de corrigir.");
    return;
  }

  setBusy(true);
  try {
    stopScanner(false);
    const image = await loadImage(file);
    const result = correctImage(image, readStudentForm());
    state.results.unshift(result);
    storeResults();
    renderResult(result);
    renderSavedResults();
  } catch (error) {
    showError(error.message);
  } finally {
    setBusy(false);
  }
}

function setBusy(isBusy) {
  els.correct.disabled = isBusy;
  els.correct.textContent = isBusy ? "Corrigindo..." : "Corrigir foto";
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Não consegui abrir a imagem escolhida."));
    };
    img.src = url;
  });
}

function correctImage(image, student) {
  const gray = prepareGray(image);
  return correctGray(gray, student);
}

function correctGray(gray, student, detectedMarkersOverride = null) {
  const detectedMarkers = detectedMarkersOverride || findMarkers(gray);
  const markerKeys = ["tl", "tr", "bl", "br"];
  const src = markerKeys.map((key) => state.layout.markers_pt[key]);
  const dst = markerKeys.map((key) => detectedMarkers[key]);
  const matrix = homography(src, dst);
  const radius = Number(state.layout.bubble_radius_pt);

  const manualVersion = String(student.versaoManual || "").trim().toUpperCase();
  let versao = "";
  let versionSource = "automática";
  let versionChoice = null;

  if (manualVersion) {
    if (!state.gabaritos.versions[manualVersion]) {
      throw new Error(`Tipo manual inválido: ${manualVersion}.`);
    }
    versao = manualVersion;
    versionSource = "manual";
  } else {
    const versionScores = {};
    for (const [label, center] of Object.entries(state.layout.version_bubbles_pt)) {
      versionScores[label] = bubbleScore(gray, matrix, center, radius + 1);
    }
    versionChoice = chooseMark(versionScores, 0.2);
    if (versionChoice.status !== "ok" || !state.gabaritos.versions[versionChoice.label]) {
      throw new Error("Tipo de prova não identificado ou rasurado. Se a folha estiver correta, selecione o tipo A/B/C/D manualmente e corrija de novo.");
    }
    versao = versionChoice.label;
  }

  const answerKey = state.gabaritos.versions[versao];
  const detalhes = [];
  const avisos = [];
  let acertos = 0;

  for (let question = 1; question <= state.gabaritos.question_count; question += 1) {
    const centers = state.layout.answer_bubbles_pt[String(question)];
    const scores = {};
    for (const [label, center] of Object.entries(centers)) {
      scores[label] = bubbleScore(gray, matrix, center, radius);
    }

    const choice = chooseMark(scores);
    const correta = answerKey[question - 1];
    let status = choice.status;
    if (choice.status !== "ok") {
      avisos.push(`Questão ${String(question).padStart(2, "0")}: ${choice.status}`);
    } else if (choice.label === correta) {
      acertos += 1;
      status = "correta";
    } else {
      status = "incorreta";
    }

    detalhes.push({
      questao: question,
      marcada: choice.label,
      correta,
      status,
    });
  }

  const nota = acertos * Number(state.gabaritos.points_per_question);
  return {
    id: cryptoRandomId(),
    createdAt: new Date().toISOString(),
    nome: student.nome,
    turma: student.turma,
    versao,
    versionSource,
    acertos,
    nota,
    totalQuestoes: Number(state.gabaritos.question_count),
    totalPontos: Number(state.gabaritos.total_points),
    detalhes,
    avisos,
  };
}

function prepareGray(image) {
  const maxWidth = 1400;
  const sourceWidth = image.naturalWidth || image.videoWidth || image.width;
  const sourceHeight = image.naturalHeight || image.videoHeight || image.height;
  if (!sourceWidth || !sourceHeight) throw new Error("Imagem sem dimensoes validas.");
  const scale = sourceWidth > maxWidth ? maxWidth / sourceWidth : 1;
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height).data;
  const values = new Uint8ClampedArray(width * height);

  let min = 255;
  let max = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    const gray = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    values[p] = gray;
    if (gray < min) min = gray;
    if (gray > max) max = gray;
  }

  if (max > min) {
    const span = max - min;
    for (let i = 0; i < values.length; i += 1) {
      values[i] = Math.max(0, Math.min(255, Math.round(((values[i] - min) * 255) / span)));
    }
  }

  return { width, height, data: values };
}

function findMarkers(gray) {
  const threshold = adaptiveDarkThreshold(gray.data);
  const mask = new Uint8Array(gray.width * gray.height);
  for (let i = 0; i < gray.data.length; i += 1) {
    mask[i] = gray.data[i] <= threshold ? 1 : 0;
  }
  const ii = integralImage(mask, gray.width, gray.height);
  const paper = detectPaperRegion(gray);

  const corners = {
    tl: [0.0, 0.0, 0.35, 0.35],
    tr: [0.65, 0.0, 1.0, 0.35],
    bl: [0.0, 0.65, 0.35, 1.0],
    br: [0.65, 0.65, 1.0, 1.0],
  };
  const preferred = {
    tl: [0.04, 0.12, 0.40, 0.64],
    tr: [0.60, 0.12, 0.96, 0.64],
    bl: [0.04, 0.40, 0.40, 0.98],
    br: [0.60, 0.40, 0.96, 0.98],
  };
  const broad = {
    tl: [0.0, 0.0, 0.55, 0.62],
    tr: [0.45, 0.0, 1.0, 0.62],
    bl: [0.0, 0.38, 0.55, 1.0],
    br: [0.45, 0.38, 1.0, 1.0],
  };
  const regionSets = [];
  if (paper) {
    regionSets.push(markerRegionsFromPaper(gray, paper, 0.11));
    regionSets.push(markerRegionsFromPaper(gray, paper, 0.18));
  }
  regionSets.push(corners, preferred, broad);

  for (const regions of regionSets) {
    try {
      const markers = {};
      const densities = [];
      for (const [key, region] of Object.entries(regions)) {
        const marker = bestSquare(ii, gray.width, gray.height, region);
        if (marker.density < 0.4) throw new Error("baixa densidade");
        markers[key] = [marker.x, marker.y];
        densities.push(marker.density);
      }
      if (!markersHavePlausibleGeometry(markers, gray.width, gray.height)) {
        throw new Error("geometria improvavel");
      }
      markers._meta = {
        threshold,
        minDensity: Math.min(...densities),
        paperCoverage: paper?.coverage || 0,
      };
      return markers;
    } catch {
      // Try the broader regions.
    }
  }

  throw new Error("Não localizei os quatro marcadores pretos. Fotografe a folha inteira e evite sombras.");
}

function detectPaperRegion(gray) {
  const histogram = new Int32Array(256);
  for (let i = 0; i < gray.data.length; i += 1) histogram[gray.data[i]] += 1;
  const p65 = percentileFromHistogram(histogram, gray.data.length, 0.65);
  const p88 = percentileFromHistogram(histogram, gray.data.length, 0.88);
  const brightThreshold = Math.round(clamp(Math.min(p65 - 22, p88 - 28), 130, 225));
  const step = Math.max(2, Math.floor(Math.min(gray.width, gray.height) / 320));
  let minX = gray.width;
  let maxX = 0;
  let minY = gray.height;
  let maxY = 0;
  let brightCount = 0;
  let sampleCount = 0;

  for (let y = 0; y < gray.height; y += step) {
    const row = y * gray.width;
    for (let x = 0; x < gray.width; x += step) {
      sampleCount += 1;
      if (gray.data[row + x] >= brightThreshold) {
        brightCount += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (!brightCount || brightCount / Math.max(sampleCount, 1) < 0.06) return null;

  const padding = Math.round(Math.min(gray.width, gray.height) * 0.025);
  minX = clamp(minX - padding, 0, gray.width - 1);
  maxX = clamp(maxX + padding, 1, gray.width);
  minY = clamp(minY - padding, 0, gray.height - 1);
  maxY = clamp(maxY + padding, 1, gray.height);

  const width = maxX - minX;
  const height = maxY - minY;
  if (width < gray.width * 0.32 || height < gray.height * 0.32) return null;

  return {
    x0: minX,
    y0: minY,
    x1: maxX,
    y1: maxY,
    width,
    height,
    coverage: (width * height) / (gray.width * gray.height),
  };
}

function markerRegionsFromPaper(gray, paper, margin) {
  const pageW = Number(state.layout?.page_width_pt) || 595.2755905511812;
  const pageH = Number(state.layout?.page_height_pt) || 841.8897637795277;
  const markers = state.layout?.markers_pt || {
    tl: [58, 604],
    tr: [537.2755905511812, 604],
    bl: [58, 136],
    br: [537.2755905511812, 136],
  };
  const halfW = Math.max(gray.width * 0.035, paper.width * margin);
  const halfH = Math.max(gray.height * 0.035, paper.height * margin);
  const regions = {};

  for (const key of ["tl", "tr", "bl", "br"]) {
    const [ptX, ptY] = markers[key];
    const x = paper.x0 + (ptX / pageW) * paper.width;
    const y = paper.y0 + ((pageH - ptY) / pageH) * paper.height;
    regions[key] = [
      clamp(Math.max(paper.x0, x - halfW) / gray.width, 0, 1),
      clamp(Math.max(paper.y0, y - halfH) / gray.height, 0, 1),
      clamp(Math.min(paper.x1, x + halfW) / gray.width, 0, 1),
      clamp(Math.min(paper.y1, y + halfH) / gray.height, 0, 1),
    ];
  }

  return regions;
}

function markersHavePlausibleGeometry(markers, width, height) {
  const { tl, tr, bl, br } = markers;
  if (!(tl[0] < tr[0] && bl[0] < br[0] && tl[1] < bl[1] && tr[1] < br[1])) return false;

  const top = Math.hypot(tr[0] - tl[0], tr[1] - tl[1]);
  const bottom = Math.hypot(br[0] - bl[0], br[1] - bl[1]);
  const left = Math.hypot(bl[0] - tl[0], bl[1] - tl[1]);
  const right = Math.hypot(br[0] - tr[0], br[1] - tr[1]);
  const box = markerBoundingBox(markers);

  if (box.width < width * 0.18 || box.height < height * 0.18) return false;
  if (top < width * 0.16 || bottom < width * 0.16 || left < height * 0.16 || right < height * 0.16) return false;

  const widthRatio = Math.min(top, bottom) / Math.max(top, bottom);
  const heightRatio = Math.min(left, right) / Math.max(left, right);
  if (widthRatio < 0.42 || heightRatio < 0.42) return false;

  const area = polygonArea([tl, tr, br, bl]);
  return area > width * height * 0.035;
}

function polygonArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

function adaptiveDarkThreshold(values) {
  const histogram = new Int32Array(256);
  for (let i = 0; i < values.length; i += 1) histogram[values[i]] += 1;

  const p08 = percentileFromHistogram(histogram, values.length, 0.08);
  const p45 = percentileFromHistogram(histogram, values.length, 0.45);
  const otsu = otsuThreshold(histogram, values.length);
  const percentileThreshold = p08 + (p45 - p08) * 0.55;
  return Math.round(clamp(Math.max(percentileThreshold, otsu * 0.82), 72, 145));
}

function percentileFromHistogram(histogram, total, fraction) {
  const target = Math.max(1, Math.floor(total * fraction));
  let running = 0;
  for (let i = 0; i < histogram.length; i += 1) {
    running += histogram[i];
    if (running >= target) return i;
  }
  return 255;
}

function otsuThreshold(histogram, total) {
  let sum = 0;
  for (let i = 0; i < 256; i += 1) sum += i * histogram[i];

  let sumBackground = 0;
  let weightBackground = 0;
  let maxVariance = -1;
  let threshold = 90;

  for (let i = 0; i < 256; i += 1) {
    weightBackground += histogram[i];
    if (weightBackground === 0) continue;
    const weightForeground = total - weightBackground;
    if (weightForeground === 0) break;

    sumBackground += i * histogram[i];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const variance = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;
    if (variance > maxVariance) {
      maxVariance = variance;
      threshold = i;
    }
  }
  return threshold;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function bestSquare(ii, width, height, region) {
  const x0 = Math.floor(clamp(region[0], 0, 1) * width);
  const y0 = Math.floor(clamp(region[1], 0, 1) * height);
  const x1 = Math.floor(clamp(region[2], 0, 1) * width);
  const y1 = Math.floor(clamp(region[3], 0, 1) * height);
  const minSize = Math.max(8, Math.floor(width * 0.008));
  const maxSize = Math.min(120, Math.max(minSize + 2, Math.floor(width * 0.075)));
  let best = null;
  const sizeStep = Math.max(2, Math.floor(width * 0.003));

  for (let size = minSize; size <= maxSize; size += sizeStep) {
    const step = Math.max(2, Math.floor(size / 4));
    const maxY = Math.max(y0, y1 - size);
    const maxX = Math.max(x0, x1 - size);
    for (let y = y0; y <= maxY; y += step) {
      for (let x = x0; x <= maxX; x += step) {
        const dark = rectSum(ii, width, x, y, size);
        const density = dark / (size * size);
        if (density < 0.34) continue;
        const margin = Math.max(4, Math.floor(size * 0.42));
        const outer = rectSumBox(ii, width, height, x - margin, y - margin, x + size + margin, y + size + margin);
        const outerArea =
          (clamp(x + size + margin, 0, width) - clamp(x - margin, 0, width)) *
          (clamp(y + size + margin, 0, height) - clamp(y - margin, 0, height));
        const borderArea = Math.max(1, outerArea - size * size);
        const borderDensity = Math.max(0, (outer - dark) / borderArea);
        if (borderDensity > 0.66) continue;
        const expectedSize = width * 0.03;
        const sizePenalty = Math.abs(size - expectedSize) / Math.max(expectedSize, 1);
        const whiteMarginBoost = 1 / (1 + borderDensity * 2.2);
        const score = dark * density * whiteMarginBoost * (1 / (1 + sizePenalty * 0.28));
        if (!best || score > best.score) {
          best = { x: x + size / 2, y: y + size / 2, density, score, borderDensity };
        }
      }
    }
  }

  if (!best) throw new Error("marcador não localizado");
  return best;
}

function integralImage(mask, width, height) {
  const stride = width + 1;
  const ii = new Int32Array((width + 1) * (height + 1));
  for (let y = 1; y <= height; y += 1) {
    let rowSum = 0;
    for (let x = 1; x <= width; x += 1) {
      rowSum += mask[(y - 1) * width + (x - 1)];
      ii[y * stride + x] = ii[(y - 1) * stride + x] + rowSum;
    }
  }
  return ii;
}

function rectSum(ii, width, x, y, size) {
  const stride = width + 1;
  const x2 = x + size;
  const y2 = y + size;
  return ii[y2 * stride + x2] - ii[y * stride + x2] - ii[y2 * stride + x] + ii[y * stride + x];
}

function rectSumBox(ii, width, height, x0, y0, x1, y1) {
  const stride = width + 1;
  const left = Math.floor(clamp(x0, 0, width));
  const top = Math.floor(clamp(y0, 0, height));
  const right = Math.floor(clamp(x1, 0, width));
  const bottom = Math.floor(clamp(y1, 0, height));
  if (right <= left || bottom <= top) return 0;
  return ii[bottom * stride + right] - ii[top * stride + right] - ii[bottom * stride + left] + ii[top * stride + left];
}

function homography(src, dst) {
  const a = [];
  const b = [];
  for (let i = 0; i < src.length; i += 1) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const c = solveLinearSystem(a, b);
  return [
    [c[0], c[1], c[2]],
    [c[3], c[4], c[5]],
    [c[6], c[7], 1],
  ];
}

function solveLinearSystem(a, b) {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    }
    if (Math.abs(m[pivot][col]) < 1e-12) throw new Error("Não consegui calcular a perspectiva da folha.");
    [m[col], m[pivot]] = [m[pivot], m[col]];
    const divisor = m[col][col];
    for (let j = col; j <= n; j += 1) m[col][j] /= divisor;
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = m[row][col];
      for (let j = col; j <= n; j += 1) m[row][j] -= factor * m[col][j];
    }
  }
  return m.map((row) => row[n]);
}

function project(matrix, point) {
  const [x, y] = point;
  const z = matrix[2][0] * x + matrix[2][1] * y + matrix[2][2];
  return [
    (matrix[0][0] * x + matrix[0][1] * y + matrix[0][2]) / z,
    (matrix[1][0] * x + matrix[1][1] * y + matrix[1][2]) / z,
  ];
}

function bubbleScore(gray, matrix, center, radiusPt) {
  const [cx, cy] = project(matrix, center);
  const [rx, ry] = project(matrix, [center[0] + radiusPt, center[1]]);
  const radius = Math.max(5, Math.floor(Math.hypot(rx - cx, ry - cy) * 1.35));
  const x0 = Math.max(0, Math.floor(cx - radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const x1 = Math.min(gray.width, Math.floor(cx + radius + 1));
  const y1 = Math.min(gray.height, Math.floor(cy + radius + 1));
  if (x1 <= x0 || y1 <= y0) return 0;

  let dark = 0;
  let total = 0;
  const r2 = radius * radius;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) {
        total += 1;
        if (gray.data[y * gray.width + x] < 120) dark += 1;
      }
    }
  }
  return total ? dark / total : 0;
}

function chooseMark(scores, blankThreshold = 0.23) {
  const ordered = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [topLabel, topScore] = ordered[0];
  const secondScore = ordered[1]?.[1] ?? 0;
  if (topScore < blankThreshold) return { label: "", status: "em branco" };
  if (secondScore >= 0.68 * topScore && secondScore > blankThreshold * 0.85) {
    return { label: "?", status: "rasurada/dupla" };
  }
  return { label: topLabel, status: "ok" };
}

function renderResult(result) {
  els.resultPanel.hidden = false;
  els.resultBadge.textContent = result.avisos.length ? "Com avisos" : "Correção OK";
  els.resultBadge.className = `badge ${result.avisos.length ? "warn" : "ok"}`;
  els.resultSummary.innerHTML = "";
  addSummaryItem("Aluno", result.nome || "(sem nome)");
  addSummaryItem("Tipo", `${result.versao} (${result.versionSource || "automática"})`);
  addSummaryItem("Acertos", `${result.acertos}/${result.totalQuestoes}`);
  addSummaryItem("Nota", `${formatGrade(result.nota)} / ${result.totalPontos.toFixed(1)}`);

  els.resultWarnings.innerHTML = result.avisos.length
    ? `<strong>Avisos:</strong><br>${result.avisos.map(escapeHtml).join("<br>")}`
    : "";

  const lines = ["Questão | Marcada | Correta | Situação"];
  for (const item of result.detalhes) {
    lines.push(
      `${String(item.questao).padStart(2, "0")}      | ${(item.marcada || "-").padEnd(7)} | ${item.correta.padEnd(7)} | ${item.status}`,
    );
  }
  els.resultDetails.textContent = lines.join("\n");
  els.resultPanel.scrollIntoView({ behavior: "smooth", block: "start" });
}

function addSummaryItem(label, value) {
  const div = document.createElement("div");
  div.className = "summary-item";
  div.innerHTML = `<span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong>`;
  els.resultSummary.appendChild(div);
}

function renderSavedResults() {
  els.savedCount.textContent = `${state.results.length} ${state.results.length === 1 ? "correção" : "correções"}`;
  els.savedResults.innerHTML = "";
  if (!state.results.length) {
    els.savedResults.innerHTML = `<p class="hint">Nenhuma correção salva ainda.</p>`;
    return;
  }
  for (const result of state.results.slice(0, 20)) {
    const node = els.savedTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector(".saved-name").textContent = result.nome || "(sem nome)";
    node.querySelector(".saved-meta").textContent =
      `${formatDate(result.createdAt)} | Turma: ${result.turma || "-"} | Tipo ${result.versao} | ${result.acertos}/${result.totalQuestoes}`;
    node.querySelector(".saved-grade").textContent = formatGrade(result.nota);
    els.savedResults.appendChild(node);
  }
}

function exportCsv() {
  if (!state.results.length) {
    showError("Ainda não há resultados para exportar.");
    return;
  }
  const header = [
    "Data/hora",
    "Nome",
    "Turma",
    "Tipo",
    "Acertos",
    "Nota",
    ...Array.from({ length: state.gabaritos.question_count }, (_, i) => `Q${i + 1}`),
    "Avisos",
  ];
  const rows = state.results.map((result) => [
    formatDate(result.createdAt),
    result.nome,
    result.turma,
    result.versao,
    result.acertos,
    formatGrade(result.nota),
    ...result.detalhes.map((item) => item.marcada || ""),
    result.avisos.join(" | "),
  ]);
  const csv = [header, ...rows].map((row) => row.map(csvCell).join(";")).join("\n");
  const blob = new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `resultados_correcao_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function clearResults() {
  if (!state.results.length) return;
  if (!confirm("Limpar todos os resultados salvos neste aparelho?")) return;
  state.results = [];
  storeResults();
  renderSavedResults();
}

function resetForm() {
  stopScanner(false);
  clearScannerOverlay();
  setScannerStatus("Inicie o scanner e enquadre a folha inteira, com os quatro quadrados pretos visiveis.");
  els.photo.value = "";
  els.name.value = "";
  els.turma.value = "";
  els.manualVersion.value = "";
  els.resultPanel.hidden = true;
}

function showError(message) {
  els.resultPanel.hidden = false;
  els.resultBadge.textContent = "Atenção";
  els.resultBadge.className = "badge warn";
  els.resultSummary.innerHTML = "";
  els.resultWarnings.innerHTML = `<strong>Não foi possível corrigir:</strong><br>${escapeHtml(message)}`;
  els.resultDetails.textContent = "";
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatGrade(value) {
  return Number(value).toFixed(2).replace(".", ",");
}

function formatDate(value) {
  return new Date(value).toLocaleString("pt-BR");
}

function cryptoRandomId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {
      // The app still works without offline support.
    });
  }
}

if (typeof window !== "undefined") {
  window.__CORRETOR_TEST__ = {
    correctImage,
    correctGray,
    prepareGray,
    findMarkers,
    chooseMark,
    homography,
    project,
    bubbleScore,
    state,
    APP_VERSION,
  };
}

if (typeof module !== "undefined") {
  module.exports = {
    state,
    correctGray,
    findMarkers,
    chooseMark,
    homography,
    project,
    bubbleScore,
    APP_VERSION,
  };
}
