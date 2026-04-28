import './styles.css';
import { createScene } from './scene.js';
import { fetchNetworkData } from './tfl.js';

const app = document.querySelector('#app');
const DEFAULT_DISTORTION = {
  horizontalScale: 0.058,
  verticalScale: 4.6
};

app.innerHTML = `
  <div class="viewport">
    <div class="viewport__wash viewport__wash--a"></div>
    <div class="viewport__wash viewport__wash--b"></div>
    <div class="viewport__contours"></div>
    <div id="scene" class="scene" aria-label="3D view of the London Underground network"></div>
    <div id="loading" class="loading">Loading network</div>
    <div id="hover-card" class="hover-card" hidden></div>
    <form id="distortion-controls" class="distortion-controls" aria-label="Scale distortion controls">
      <label class="distortion-control">
        <span>Horizontal</span>
        <input id="horizontal-scale" type="range" min="0.025" max="0.11" step="0.001" value="${DEFAULT_DISTORTION.horizontalScale}">
        <input id="horizontal-scale-value" type="number" min="0.025" max="0.11" step="0.001" value="${DEFAULT_DISTORTION.horizontalScale}">
      </label>
      <label class="distortion-control">
        <span>Vertical</span>
        <input id="vertical-scale" type="range" min="1.2" max="9" step="0.1" value="${DEFAULT_DISTORTION.verticalScale}">
        <input id="vertical-scale-value" type="number" min="1.2" max="9" step="0.1" value="${DEFAULT_DISTORTION.verticalScale}">
      </label>
    </form>
  </div>
`;

const sceneEl = document.querySelector('#scene');
const loadingEl = document.querySelector('#loading');
const hoverCardEl = document.querySelector('#hover-card');
const controlsEl = document.querySelector('#distortion-controls');
const horizontalScaleEl = document.querySelector('#horizontal-scale');
const horizontalScaleValueEl = document.querySelector('#horizontal-scale-value');
const verticalScaleEl = document.querySelector('#vertical-scale');
const verticalScaleValueEl = document.querySelector('#vertical-scale-value');
let sceneHandle = null;
let networkDataCache = null;
let renderFrameId = 0;

function showError(message) {
  loadingEl.textContent = message;
  loadingEl.classList.add('loading--error');
}

function clampControlValue(input, value) {
  const min = Number.parseFloat(input.min);
  const max = Number.parseFloat(input.max);
  const parsed = Number.parseFloat(value);

  if (!Number.isFinite(parsed)) {
    return Number.parseFloat(input.value);
  }

  return Math.min(max, Math.max(min, parsed));
}

function currentDistortion() {
  return {
    horizontalScale: Number.parseFloat(horizontalScaleEl.value),
    verticalScale: Number.parseFloat(verticalScaleEl.value)
  };
}

function renderScene() {
  if (!networkDataCache) {
    return;
  }

  const viewState = sceneHandle?.getViewState();

  sceneHandle?.destroy();
  sceneHandle = createScene(sceneEl, networkDataCache, {
    hoverEl: hoverCardEl,
    distortion: currentDistortion(),
    initialViewState: viewState,
    onReady() {
      loadingEl.hidden = true;
    }
  });
}

function queueRenderScene() {
  if (renderFrameId) {
    window.cancelAnimationFrame(renderFrameId);
  }

  renderFrameId = window.requestAnimationFrame(() => {
    renderFrameId = 0;
    renderScene();
  });
}

function syncScaleControl(rangeInput, numberInput, rawValue) {
  const value = clampControlValue(rangeInput, rawValue);
  const displayValue = String(value);

  rangeInput.value = displayValue;
  numberInput.value = displayValue;
  queueRenderScene();
}

function bindScaleControl(rangeInput, numberInput) {
  rangeInput.addEventListener('input', () => {
    syncScaleControl(rangeInput, numberInput, rangeInput.value);
  });
  numberInput.addEventListener('input', () => {
    syncScaleControl(rangeInput, numberInput, numberInput.value);
  });
}

async function boot() {
  try {
    networkDataCache = await fetchNetworkData();
    controlsEl.hidden = false;

    renderScene();
  } catch (error) {
    showError(error instanceof Error ? error.message : 'Unable to load network');
  }
}

bindScaleControl(horizontalScaleEl, horizontalScaleValueEl);
bindScaleControl(verticalScaleEl, verticalScaleValueEl);
boot();
