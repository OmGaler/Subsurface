import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

const HORIZONTAL_SCALE = 0.058;
const VERTICAL_SCALE = 4.6;
const LINE_RADIUS = 12.4;
const DESKTOP_LABEL_LIMIT = 76;
const MIN_LABEL_DISTANCE = 160;
const SHARED_ROUTE_STRIPE_LENGTH = 46;
const SHARED_SECTION_HIDE_DISTANCE = 44;
const DIMMED_ROUTE_OPACITY = 0.14;
let stationTexture = null;

function hexToColor(value) {
  return new THREE.Color(value);
}

function darkenColour(value, amount = 0.42) {
  const colour = hexToColor(value);
  colour.multiplyScalar(amount);
  return colour;
}

function applyViewState(camera, controls, viewState) {
  if (!viewState) {
    return;
  }

  camera.position.fromArray(viewState.position);
  controls.target.fromArray(viewState.target);
  camera.zoom = viewState.zoom;
  camera.updateProjectionMatrix();
  controls.update();
}

export function computeProjection(sceneData, options = {}) {
  const {
    horizontalScale = HORIZONTAL_SCALE,
    verticalScale = VERTICAL_SCALE
  } = options;
  const coordinates = [];
  const elevations = [];

  sceneData.lineSegments.forEach((segment) => {
    segment.coordinates.forEach(([lon, lat, elevation]) => {
      coordinates.push([lon, lat]);
      elevations.push(elevation);
    });
  });

  const longitudes = coordinates.map(([lon]) => lon);
  const latitudes = coordinates.map(([, lat]) => lat);
  const centreLon = (Math.min(...longitudes) + Math.max(...longitudes)) / 2;
  const centreLat = (Math.min(...latitudes) + Math.max(...latitudes)) / 2;
  const cosine = Math.cos((centreLat * Math.PI) / 180);
  const minElevation = Math.min(...elevations);
  const elevationOffset = Math.max(12, -minElevation + 8);

  return ([lon, lat], elevation = 0) =>
    new THREE.Vector3(
      (lon - centreLon) * 111320 * cosine * horizontalScale,
      (elevation + elevationOffset) * verticalScale,
      -(lat - centreLat) * 110540 * horizontalScale
    );
}

function tubePoints(segment, project) {
  return segment.coordinates.map(([lon, lat, elevation]) => project([lon, lat], elevation));
}

function pointToSegmentDistanceSquared(point, start, end) {
  const spanX = end.x - start.x;
  const spanZ = end.z - start.z;
  const spanLengthSquared = spanX * spanX + spanZ * spanZ;

  if (spanLengthSquared === 0) {
    const dx = point.x - start.x;
    const dz = point.z - start.z;

    return { distanceSquared: dx * dx + dz * dz, t: 0 };
  }

  const t = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * spanX + (point.z - start.z) * spanZ) / spanLengthSquared)
  );
  const closestX = start.x + spanX * t;
  const closestZ = start.z + spanZ * t;
  const dx = point.x - closestX;
  const dz = point.z - closestZ;

  return { distanceSquared: dx * dx + dz * dz, t };
}

function isSharedSectionEdge(segment, start, end, sharedSections, project) {
  const projectedStart = project(start, start[2]);
  const projectedEnd = project(end, end[2]);
  const midpoint = projectedStart.clone().add(projectedEnd).multiplyScalar(0.5);
  const maxDistanceSquared = SHARED_SECTION_HIDE_DISTANCE * SHARED_SECTION_HIDE_DISTANCE;

  return sharedSections.some((section) => {
    if (!section.lineIds?.includes(segment.lineId)) {
      return false;
    }

    for (let index = 0; index < section.coordinates.length - 1; index += 1) {
      const sectionStart = section.coordinates[index];
      const sectionEnd = section.coordinates[index + 1];
      const projectedSectionStart = project(sectionStart, sectionStart[2]);
      const projectedSectionEnd = project(sectionEnd, sectionEnd[2]);
      const match = pointToSegmentDistanceSquared(
        midpoint,
        projectedSectionStart,
        projectedSectionEnd
      );

      if (match.t > 0.02 && match.t < 0.98 && match.distanceSquared <= maxDistanceSquared) {
        return true;
      }
    }

    return false;
  });
}

export function visibleCoordinateRuns(segment, sharedSections, project) {
  const runs = [];
  let currentRun = [];

  segment.coordinates.forEach((coordinate, index) => {
    if (index === 0) {
      currentRun.push(coordinate);
      return;
    }

    const previous = segment.coordinates[index - 1];

    if (isSharedSectionEdge(segment, previous, coordinate, sharedSections, project)) {
      if (currentRun.length > 1) {
        runs.push(currentRun);
      }

      currentRun = [coordinate];
      return;
    }

    currentRun.push(coordinate);
  });

  if (currentRun.length > 1) {
    runs.push(currentRun);
  }

  return runs;
}

function dedupePoints(points) {
  const deduped = [];

  points.forEach((point) => {
    const previous = deduped[deduped.length - 1];

    if (!previous || previous.distanceToSquared(point) > 0.5) {
      deduped.push(point);
    }
  });

  return deduped;
}

function makeTubeMesh(points, colour, radius, options = {}) {
  const dedupedPoints = dedupePoints(points);

  if (dedupedPoints.length < 2) {
    return null;
  }

  const curvePath = new THREE.CurvePath();

  for (let index = 0; index < dedupedPoints.length - 1; index += 1) {
    curvePath.add(new THREE.LineCurve3(dedupedPoints[index], dedupedPoints[index + 1]));
  }

  const geometry = new THREE.TubeGeometry(
    curvePath,
    Math.max(24, dedupedPoints.length * 3),
    radius,
    options.radialSegments ?? 16,
    false
  );
  const material = new THREE.MeshStandardMaterial({
    color: colour,
    emissive: options.emissive ?? '#000000',
    emissiveIntensity: options.emissiveIntensity ?? 0,
    roughness: options.roughness ?? 0.42,
    metalness: options.metalness ?? 0.04,
    transparent: (options.opacity ?? 1) < 1,
    opacity: options.opacity ?? 1,
    depthWrite: (options.opacity ?? 1) >= 1
  });

  return new THREE.Mesh(geometry, material);
}

function makeCylinderBetween(start, end, radius, colour, options = {}) {
  const direction = end.clone().sub(start);
  const length = direction.length();

  if (length < 1) {
    return null;
  }

  const geometry = new THREE.CylinderGeometry(radius, radius, length, options.radialSegments ?? 16);
  const material = new THREE.MeshStandardMaterial({
    color: colour,
    emissive: options.emissive ?? colour,
    emissiveIntensity: options.emissiveIntensity ?? 0.03,
    roughness: options.roughness ?? 0.34,
    metalness: options.metalness ?? 0.04,
    transparent: (options.opacity ?? 1) < 1,
    opacity: options.opacity ?? 1,
    depthWrite: (options.opacity ?? 1) >= 1
  });
  const mesh = new THREE.Mesh(geometry, material);
  const midpoint = start.clone().add(end).multiplyScalar(0.5);

  mesh.position.copy(midpoint);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  mesh.renderOrder = options.renderOrder ?? 12;

  return mesh;
}

function makeStripedSharedSectionOverlay(section, project, options = {}) {
  const projectedPoints = section.coordinates.map((coordinate) => project(coordinate, coordinate[2]));
  const meshes = [];
  let stripeOffset = 0;

  if (projectedPoints.length < 2) {
    return [];
  }

  const colours = section.lines.map((line) => line.colour);

  for (let pointIndex = 0; pointIndex < projectedPoints.length - 1; pointIndex += 1) {
    const start = projectedPoints[pointIndex];
    const end = projectedPoints[pointIndex + 1];
    const length = start.distanceTo(end);

    if (length < 1) {
      continue;
    }

    const stripeCount = Math.max(colours.length, Math.ceil(length / SHARED_ROUTE_STRIPE_LENGTH));

    for (let stripeIndex = 0; stripeIndex < stripeCount; stripeIndex += 1) {
      const overlap = Math.min(0.006, 0.2 / stripeCount);
      const from = Math.max(0, stripeIndex / stripeCount - overlap);
      const to = Math.min(1, (stripeIndex + 1) / stripeCount + overlap);
      const segmentStart = start.clone().lerp(end, from);
      const segmentEnd = start.clone().lerp(end, to);
      const mesh = makeCylinderBetween(
        segmentStart,
        segmentEnd,
        LINE_RADIUS + (options.isFocused ? 1.8 : 1.1),
        colours[(stripeOffset + stripeIndex) % colours.length],
        {
          opacity: options.opacity ?? 1,
          radialSegments: 20,
          renderOrder: options.isFocused ? 22 : 18
        }
      );

      if (mesh) {
        meshes.push(mesh);
      }
    }

    stripeOffset += stripeCount;
  }

  return meshes;
}


function lineRadiusFor(lineId) {
  return lineId === 'waterloo-city' ? LINE_RADIUS * 0.82 : LINE_RADIUS;
}

function getStationTexture() {
  if (stationTexture) {
    return stationTexture;
  }

  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext('2d');

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.beginPath();
  context.arc(64, 64, 50, 0, Math.PI * 2);
  context.fillStyle = 'rgba(20, 21, 21, 0.88)';
  context.fill();
  context.beginPath();
  context.arc(64, 64, 40, 0, Math.PI * 2);
  context.fillStyle = '#fffdf8';
  context.fill();
  context.beginPath();
  context.arc(50, 48, 14, 0, Math.PI * 2);
  context.fillStyle = 'rgba(255, 255, 255, 0.72)';
  context.fill();

  stationTexture = new THREE.CanvasTexture(canvas);
  stationTexture.colorSpace = THREE.SRGBColorSpace;

  return stationTexture;
}

function makeStationNode(node, project, options = {}) {
  const anchor = new THREE.Group();
  const position = project(node.coordinates, node.elevation);
  anchor.position.copy(position);

  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: getStationTexture(),
      transparent: true,
      opacity: options.opacity ?? 1,
      depthTest: false,
      depthWrite: false
    })
  );
  sprite.renderOrder = 40;
  const scale = options.scale ?? 22;
  sprite.scale.set(scale, scale, 1);

  anchor.add(sprite);
  anchor.userData = { type: 'station', node, sprite };

  return anchor;
}

function makeConnector(start, end) {
  const direction = end.clone().sub(start);
  const length = direction.length();

  if (length < 1) {
    return null;
  }

  const geometry = new THREE.CylinderGeometry(1.35, 1.35, length, 8);
  const material = new THREE.MeshStandardMaterial({
    color: '#3f4240',
    roughness: 0.48,
    metalness: 0.08
  });
  const connector = new THREE.Mesh(geometry, material);
  const midpoint = start.clone().add(end).multiplyScalar(0.5);

  connector.position.copy(midpoint);
  connector.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());

  return connector;
}

export function selectLabelGroups(stationGroups, project, labelLimit = DESKTOP_LABEL_LIMIT) {
  const selected = [];

  stationGroups
    .slice()
    .sort((left, right) => right.importance - left.importance)
    .forEach((group) => {
      if (selected.length >= labelLimit) {
        return;
      }

      const meanElevation =
        group.nodes.reduce((sum, node) => sum + node.elevation, 0) / Math.max(1, group.nodes.length);
      const position = project(group.coordinates, meanElevation);
      const isTooClose = selected.some((item) => item.position.distanceTo(position) < MIN_LABEL_DISTANCE);

      if (!isTooClose) {
        selected.push({ group, position });
      }
    });

  return selected;
}

function fitCamera(camera, controls, points, width, height, options = {}) {
  const box = new THREE.Box3().setFromPoints(points);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const aspect = width / Math.max(1, height);
  const fovRadians = (camera.fov * Math.PI) / 180;
  const fitHeightDistance = (size.y * 0.85 + size.z * 0.52) / Math.tan(fovRadians / 2);
  const fitWidthDistance = (size.x * 0.78) / Math.tan(fovRadians / 2) / Math.max(aspect, 0.7);
  const baseScale = options.closeCrop ? 0.42 : 0.64;
  const responsiveScale = aspect < 0.75 ? (options.closeCrop ? 1.85 : 2.45) : baseScale;
  const distance = Math.max(fitHeightDistance, fitWidthDistance, 780) * responsiveScale;
  const offset = new THREE.Vector3(-0.72, 0.66, 1.12)
    .normalize()
    .multiplyScalar(distance);

  controls.target.copy(center);
  controls.target.y += 40;
  camera.position.copy(center.clone().add(offset));
  camera.near = 1;
  camera.far = Math.max(12000, distance * 10);
  camera.updateProjectionMatrix();
  controls.update();
}

function makeLabel(group, project, focusedLineId = 'all') {
  const label = document.createElement('div');
  const hasFocus = focusedLineId !== 'all';
  const isFocused = group.nodes.some((node) => node.lineId === focusedLineId);
  const isMajor = group.importance >= 12 || group.nodes.length > 2;
  label.className = [
    'station-label',
    isMajor ? 'station-label--major' : '',
    hasFocus && isFocused ? 'station-label--focused' : '',
    hasFocus && !isFocused ? 'station-label--dimmed' : ''
  ].filter(Boolean).join(' ');
  label.textContent = group.name;
  label.dataset.stationName = group.name;

  const object = new CSS2DObject(label);
  const meanElevation =
    group.nodes.reduce((sum, node) => sum + node.elevation, 0) / Math.max(1, group.nodes.length);
  const position = project(group.coordinates, meanElevation);
  position.y += 25;
  object.position.copy(position);

  return object;
}

function updateHoverCard(hoverEl, content) {
  if (!hoverEl) {
    return;
  }

  if (!content) {
    hoverEl.hidden = true;
    hoverEl.innerHTML = '';
    return;
  }

  hoverEl.hidden = false;
  hoverEl.innerHTML = content;
}

function hoverStationMarkup(node) {
  return `
    <p class="hover-card__eyebrow">${node.lineName}</p>
    <h2 class="hover-card__title">${node.name}</h2>
    <p class="hover-card__meta">Zone ${node.zone} | ${node.modes}</p>
  `;
}

function hoverLineMarkup(line) {
  return `
    <p class="hover-card__eyebrow">Line</p>
    <h2 class="hover-card__title">${line.lineName}</h2>
  `;
}

export function createScene(container, networkData, options = {}) {
  const { hoverEl, onReady, distortion = {}, initialViewState = null, focusedLineId = 'all' } = options;
  const hasLineFocus = focusedLineId !== 'all';
  const project = computeProjection(networkData.scene, distortion);

  const scene = new THREE.Scene();
  scene.background = null;

  const camera = new THREE.PerspectiveCamera(
    26,
    container.clientWidth / container.clientHeight,
    1,
    18000
  );
  camera.position.set(-1200, 860, 1600);

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = false;
  container.innerHTML = '';
  container.append(renderer.domElement);

  const labelRenderer = new CSS2DRenderer();
  labelRenderer.setSize(container.clientWidth, container.clientHeight);
  labelRenderer.domElement.className = 'label-layer';
  container.append(labelRenderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enablePan = true;
  controls.minDistance = 420;
  controls.maxDistance = 18000;
  controls.minPolarAngle = 0.68;
  controls.maxPolarAngle = 1.24;
  controls.target.set(0, 120, 0);
  controls.autoRotate = false;

  renderer.domElement.addEventListener(
    'pointerdown',
    () => {
      controls.autoRotate = false;
    },
    { passive: true }
  );

  scene.add(new THREE.AmbientLight('#ffffff', 1.22));

  const keyLight = new THREE.DirectionalLight('#ffffff', 1.35);
  keyLight.position.set(-900, 1800, 1200);
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight('#f8fbff', 0.8);
  fillLight.position.set(1400, 900, -1200);
  scene.add(fillLight);

  const rimLight = new THREE.DirectionalLight('#ffffff', 0.52);
  rimLight.position.set(0, 1600, -1600);
  scene.add(rimLight);

  const interactiveObjects = [];
  const scenePoints = [];
  const focusPoints = [];

  const sharedTrackSections = networkData.scene.sharedTrackSections ?? [];

  networkData.scene.lineSegments.forEach((segment) => {
    const coordinateRuns = visibleCoordinateRuns(segment, sharedTrackSections, project);
    const radius = lineRadiusFor(segment.lineId);
    const isFocused = !hasLineFocus || segment.lineId === focusedLineId;
    const routeOpacity = isFocused ? 1 : DIMMED_ROUTE_OPACITY;
    const underlayOpacity = isFocused ? 1 : 0.08;

    coordinateRuns.forEach((coordinates) => {
      const points = coordinates.map(([lon, lat, elevation]) => project([lon, lat], elevation));
      scenePoints.push(...points);
      if (segment.lineId === focusedLineId) {
        focusPoints.push(...points);
      }
      const underlayMesh = makeTubeMesh(points, darkenColour(segment.colour, 0.28), radius + 3.4, {
        opacity: underlayOpacity,
        roughness: 0.56
      });
      const lineMesh = makeTubeMesh(points, segment.colour, radius, {
        emissive: segment.colour,
        emissiveIntensity: 0.04,
        opacity: routeOpacity,
        roughness: 0.36
      });

      if (!lineMesh) {
        return;
      }

      lineMesh.userData = {
        type: 'line',
        line: segment,
        material: lineMesh.material,
        baseColour: hexToColor(segment.colour).clone()
      };

      if (underlayMesh) {
        scene.add(underlayMesh);
      }

      interactiveObjects.push(lineMesh);
      scene.add(lineMesh);
    });
  });

  sharedTrackSections.forEach((section) => {
    const isFocused = !hasLineFocus || section.lineIds?.includes(focusedLineId);
    const points = section.coordinates.map(([lon, lat, elevation]) => project([lon, lat], elevation));

    if (section.lineIds?.includes(focusedLineId)) {
      focusPoints.push(...points);
    }

    makeStripedSharedSectionOverlay(section, project, {
      isFocused,
      opacity: isFocused ? 1 : DIMMED_ROUTE_OPACITY
    }).forEach((mesh) => {
      scene.add(mesh);
    });
  });

  networkData.scene.stationGroups.forEach((group) => {
    if (group.nodes.length < 2) {
      return;
    }

    for (let index = 0; index < group.nodes.length - 1; index += 1) {
      if (
        hasLineFocus &&
        group.nodes[index].lineId !== focusedLineId &&
        group.nodes[index + 1].lineId !== focusedLineId
      ) {
        continue;
      }

      const start = project(group.nodes[index].coordinates, group.nodes[index].elevation);
      const end = project(group.nodes[index + 1].coordinates, group.nodes[index + 1].elevation);
      const connector = makeConnector(start, end);

      if (connector) {
        scene.add(connector);
      }
    }
  });

  networkData.scene.stationNodes.forEach((node) => {
    const isFocused = !hasLineFocus || node.lineId === focusedLineId;
    const stationAnchor = makeStationNode(node, project, {
      opacity: isFocused ? 1 : 0.2,
      scale: isFocused ? 24 : 16
    });
    scenePoints.push(stationAnchor.position.clone());
    if (node.lineId === focusedLineId) {
      focusPoints.push(stationAnchor.position.clone());
    }
    interactiveObjects.push(stationAnchor);
    scene.add(stationAnchor);
  });

  const mobileLabelLimit = hasLineFocus ? 24 : 3;
  const desktopLabelLimit = hasLineFocus ? 88 : 62;
  const labelLimit = container.clientWidth < 720 ? mobileLabelLimit : desktopLabelLimit;
  const labelSourceGroups = hasLineFocus
    ? networkData.scene.stationGroups.filter((group) => group.nodes.some((node) => node.lineId === focusedLineId))
    : networkData.scene.stationGroups;

  selectLabelGroups(labelSourceGroups, project, labelLimit).forEach(({ group }) => {
    scene.add(makeLabel(group, project, focusedLineId));
  });

  let cameraFitPoints = hasLineFocus && focusPoints.length > 1 ? focusPoints : scenePoints;
  fitCamera(camera, controls, cameraFitPoints, container.clientWidth, container.clientHeight, {
    closeCrop: hasLineFocus
  });
  applyViewState(camera, controls, initialViewState);

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let hoveredObject = null;

  function clearHover() {
    if (!hoveredObject) {
      updateHoverCard(hoverEl, null);
      return;
    }

    if (hoveredObject.userData?.type === 'line') {
      hoveredObject.userData.material.color.copy(hoveredObject.userData.baseColour);
    }

    if (hoveredObject.userData?.type === 'station') {
      hoveredObject.scale.setScalar(1);
    }

    hoveredObject = null;
    updateHoverCard(hoverEl, null);
    renderer.domElement.style.cursor = 'grab';
  }

  function setHover(object) {
    if (hoveredObject === object) {
      return;
    }

    clearHover();
    hoveredObject = object;

    if (object.userData?.type === 'line') {
      object.userData.material.color.copy(hexToColor('#000000').lerp(object.userData.baseColour, 0.78));
      updateHoverCard(hoverEl, hoverLineMarkup(object.userData.line));
      renderer.domElement.style.cursor = 'pointer';
      return;
    }

    if (object.userData?.type === 'station') {
      object.scale.setScalar(1.16);
      updateHoverCard(hoverEl, hoverStationMarkup(object.userData.node));
      renderer.domElement.style.cursor = 'pointer';
    }
  }

  function onPointerMove(event) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);

    const intersections = raycaster.intersectObjects(interactiveObjects, true);
    const target = intersections[0]?.object.parent?.userData?.type === 'station'
      ? intersections[0].object.parent
      : intersections[0]?.object;

    if (target?.userData?.type === 'station' || target?.userData?.type === 'line') {
      setHover(target);
      return;
    }

    clearHover();
  }

  function onPointerLeave() {
    clearHover();
  }

  renderer.domElement.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('pointerleave', onPointerLeave);
  renderer.domElement.style.cursor = 'grab';

  const resizeObserver = new ResizeObserver(() => {
    const width = container.clientWidth;
    const height = container.clientHeight;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    fitCamera(camera, controls, cameraFitPoints, width, height, {
      closeCrop: hasLineFocus
    });
    renderer.setSize(width, height);
    labelRenderer.setSize(width, height);
  });

  resizeObserver.observe(container);

  let animationFrameId = 0;

  function render() {
    animationFrameId = window.requestAnimationFrame(render);
    controls.update();
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
  }

  render();
  onReady?.();

  return {
    destroy() {
      window.cancelAnimationFrame(animationFrameId);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
      controls.dispose();
      renderer.dispose();
      container.innerHTML = '';
    },
    getViewState() {
      return {
        position: camera.position.toArray(),
        target: controls.target.toArray(),
        zoom: camera.zoom
      };
    }
  };
}
