import './styles.css';
import { createScene } from './scene.js';
import { fetchNetworkData } from './tfl.js';

const app = document.querySelector('#app');

app.innerHTML = `
  <div class="viewport">
    <div class="viewport__wash viewport__wash--a"></div>
    <div class="viewport__wash viewport__wash--b"></div>
    <div class="viewport__contours"></div>
    <div id="scene" class="scene" aria-label="3D view of the London Underground network"></div>
    <div id="loading" class="loading">Loading network</div>
    <div id="hover-card" class="hover-card" hidden></div>
  </div>
`;

const sceneEl = document.querySelector('#scene');
const loadingEl = document.querySelector('#loading');
const hoverCardEl = document.querySelector('#hover-card');

function showError(message) {
  loadingEl.textContent = message;
  loadingEl.classList.add('loading--error');
}

async function boot() {
  try {
    const networkData = await fetchNetworkData();

    createScene(sceneEl, networkData, {
      hoverEl: hoverCardEl,
      onReady() {
        loadingEl.hidden = true;
      }
    });
  } catch (error) {
    showError(error instanceof Error ? error.message : 'Unable to load network');
  }
}

boot();
