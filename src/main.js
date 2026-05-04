import './styles.css';
import { createScene } from './scene.js';
import { fetchNetworkData } from './tfl.js';

const app = document.querySelector('#app');
const DEFAULT_DISTORTION = {
  horizontalScale: 0.058,
  verticalScale: 4.6
};
const TOUR_INTERVAL_MS = 7000;
const DISTORTION_RENDER_DEBOUNCE_MS = 140;

app.innerHTML = `
  <div class="viewport">
    <div class="viewport__wash viewport__wash--a"></div>
    <div class="viewport__wash viewport__wash--b"></div>
    <div class="viewport__contours"></div>
    <div id="scene" class="scene" aria-label="3D view of the London Underground network"></div>
    <div id="loading" class="loading">Loading network</div>
    <div id="hover-card" class="hover-card" hidden></div>
    <section id="line-story" class="line-story" hidden>
      <p id="line-story-kicker" class="line-story__kicker">Subsurface model</p>
      <h1 id="line-story-title" class="line-story__title">London Underground</h1>
      <p id="line-story-copy" class="line-story__copy">A depth-distorted schematic of the network.</p>
    </section>
    <form id="distortion-controls" class="view-controls" aria-label="View controls" hidden>
      <label class="view-control view-control--focus">
        <span>Focus</span>
        <select id="line-focus"></select>
      </label>
      <label class="view-control view-control--tour">
        <input id="tour-mode" type="checkbox">
        <span>Tour</span>
      </label>
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
const lineStoryEl = document.querySelector('#line-story');
const lineStoryKickerEl = document.querySelector('#line-story-kicker');
const lineStoryTitleEl = document.querySelector('#line-story-title');
const lineStoryCopyEl = document.querySelector('#line-story-copy');
const lineFocusEl = document.querySelector('#line-focus');
const tourModeEl = document.querySelector('#tour-mode');
const horizontalScaleEl = document.querySelector('#horizontal-scale');
const horizontalScaleValueEl = document.querySelector('#horizontal-scale-value');
const verticalScaleEl = document.querySelector('#vertical-scale');
const verticalScaleValueEl = document.querySelector('#vertical-scale-value');
let sceneHandle = null;
let networkDataCache = null;
let renderFrameId = 0;
let renderTimerId = 0;
let tourTimerId = 0;
let lineOptions = [];
let activeLineId = 'all';
let preserveViewOnNextRender = true;

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

  const viewState = preserveViewOnNextRender ? sceneHandle?.getViewState() : null;
  preserveViewOnNextRender = true;

  sceneHandle?.destroy();
  sceneHandle = createScene(sceneEl, networkDataCache, {
    hoverEl: hoverCardEl,
    distortion: currentDistortion(),
    focusedLineId: activeLineId,
    initialViewState: viewState,
    onReady() {
      loadingEl.hidden = true;
    }
  });
}

function queueRenderScene() {
  window.clearTimeout(renderTimerId);
  renderTimerId = 0;

  if (renderFrameId) {
    window.cancelAnimationFrame(renderFrameId);
  }

  renderFrameId = window.requestAnimationFrame(() => {
    renderFrameId = 0;
    renderScene();
  });
}

function queueDebouncedDistortionUpdate() {
  if (renderTimerId) {
    window.clearTimeout(renderTimerId);
  }

  renderTimerId = window.setTimeout(() => {
    renderTimerId = 0;

    if (sceneHandle?.updateDistortion) {
      sceneHandle.updateDistortion(currentDistortion());
      return;
    }

    queueRenderScene();
  }, DISTORTION_RENDER_DEBOUNCE_MS);
}

function buildLineOptions(networkData) {
  const linesById = new Map();

  networkData.scene.lineSegments.forEach((segment) => {
    if (!linesById.has(segment.lineId)) {
      linesById.set(segment.lineId, {
        id: segment.lineId,
        name: segment.lineName,
        colour: segment.colour
      });
    }
  });

  return Array.from(linesById.values()).sort((left, right) => left.name.localeCompare(right.name));
}

function populateLineFocus() {
  lineFocusEl.replaceChildren();
  lineFocusEl.add(new Option('All lines', 'all'));
  lineOptions.forEach((line) => {
    lineFocusEl.add(new Option(line.name, line.id));
  });
  lineFocusEl.value = activeLineId;
}

function countStationsForLine(lineId) {
  if (lineId === 'all') {
    return networkDataCache?.scene.stationGroups.length ?? 0;
  }

  return networkDataCache?.scene.stationGroups
    .filter((group) => group.nodes.some((node) => node.lineId === lineId))
    .length ?? 0;
}

function countSharedSectionsForLine(lineId) {
  if (lineId === 'all') {
    return networkDataCache?.scene.sharedTrackSections?.length ?? 0;
  }

  return networkDataCache?.scene.sharedTrackSections
    ?.filter((section) => section.lineIds.includes(lineId))
    .length ?? 0;
}

function updateLineStory() {
  const line = lineOptions.find((option) => option.id === activeLineId);
  const accent = line?.colour ?? '#181817';
  const stationCount = countStationsForLine(activeLineId);
  const sharedSectionCount = countSharedSectionsForLine(activeLineId);

  lineStoryEl.style.setProperty('--line-accent', accent);
  lineStoryKickerEl.textContent = activeLineId === 'all' ? 'Subsurface model' : 'Line focus';
  lineStoryTitleEl.textContent = line?.name ?? 'London Underground';
  lineStoryCopyEl.textContent = activeLineId === 'all'
    ? `${networkDataCache.lineCount} lines, ${stationCount} station groups, depth-distorted for legibility.`
    : `${stationCount} station groups, ${sharedSectionCount} shared sections, cropped for route-level inspection.`;
}

function setActiveLine(lineId, options = {}) {
  activeLineId = lineId;
  lineFocusEl.value = lineId;
  preserveViewOnNextRender = Boolean(options.preserveView);
  updateLineStory();
  queueRenderScene();
}

function stopTour() {
  window.clearInterval(tourTimerId);
  tourTimerId = 0;
  tourModeEl.checked = false;
}

function advanceTour() {
  if (lineOptions.length === 0) {
    return;
  }

  const currentIndex = lineOptions.findIndex((line) => line.id === activeLineId);
  const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % lineOptions.length : 0;

  setActiveLine(lineOptions[nextIndex].id, { preserveView: false });
}

function syncTourMode() {
  window.clearInterval(tourTimerId);
  tourTimerId = 0;

  if (!tourModeEl.checked) {
    return;
  }

  if (activeLineId === 'all') {
    advanceTour();
  }

  tourTimerId = window.setInterval(advanceTour, TOUR_INTERVAL_MS);
}

function syncScaleControl(rangeInput, numberInput, rawValue) {
  const value = clampControlValue(rangeInput, rawValue);
  const displayValue = String(value);

  rangeInput.value = displayValue;
  numberInput.value = displayValue;
  queueDebouncedDistortionUpdate();
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
    lineOptions = buildLineOptions(networkDataCache);
    populateLineFocus();
    updateLineStory();
    lineStoryEl.hidden = false;
    controlsEl.hidden = false;

    renderScene();
  } catch (error) {
    showError(error instanceof Error ? error.message : 'Unable to load network');
  }
}

bindScaleControl(horizontalScaleEl, horizontalScaleValueEl);
bindScaleControl(verticalScaleEl, verticalScaleValueEl);
lineFocusEl.addEventListener('change', () => {
  stopTour();
  setActiveLine(lineFocusEl.value, { preserveView: false });
});
tourModeEl.addEventListener('change', syncTourMode);
boot();
