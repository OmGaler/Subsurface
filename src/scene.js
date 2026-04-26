import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

const HORIZONTAL_SCALE = 0.058;
const VERTICAL_SCALE = 4.6;
const LINE_RADIUS = 9.8;
const LABEL_LIMIT = 6;
const MIN_LABEL_DISTANCE = 360;
let stationTexture = null;

function hexToColor(value) {
  return new THREE.Color(value);
}

function darkenColour(value, amount = 0.42) {
  const colour = hexToColor(value);
  colour.multiplyScalar(amount);
  return colour;
}

function computeProjection(sceneData) {
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
      (lon - centreLon) * 111320 * cosine * HORIZONTAL_SCALE,
      (elevation + elevationOffset) * VERTICAL_SCALE,
      -(lat - centreLat) * 110540 * HORIZONTAL_SCALE
    );
}

function tubePoints(segment, project) {
  return segment.coordinates.map(([lon, lat, elevation]) => project([lon, lat], elevation));
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
    options.radialSegments ?? 12,
    false
  );
  const material = new THREE.MeshStandardMaterial({
    color: colour,
    emissive: options.emissive ?? '#000000',
    emissiveIntensity: options.emissiveIntensity ?? 0,
    roughness: options.roughness ?? 0.64,
    metalness: options.metalness ?? 0.02
  });

  return new THREE.Mesh(geometry, material);
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
  context.fillStyle = '#2d2a27';
  context.fill();
  context.beginPath();
  context.arc(64, 64, 42, 0, Math.PI * 2);
  context.fillStyle = '#d9d5cf';
  context.fill();
  context.beginPath();
  context.arc(58, 56, 33, 0, Math.PI * 2);
  context.fillStyle = '#fffdf9';
  context.fill();

  stationTexture = new THREE.CanvasTexture(canvas);
  stationTexture.colorSpace = THREE.SRGBColorSpace;

  return stationTexture;
}

function makeStationNode(node, project) {
  const anchor = new THREE.Group();
  const position = project(node.coordinates, node.elevation);
  anchor.position.copy(position);

  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: getStationTexture(),
      transparent: true,
      depthTest: true,
      depthWrite: false
    })
  );
  sprite.scale.set(34, 34, 1);

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
    color: '#4a4640',
    roughness: 0.7
  });
  const connector = new THREE.Mesh(geometry, material);
  const midpoint = start.clone().add(end).multiplyScalar(0.5);

  connector.position.copy(midpoint);
  connector.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());

  return connector;
}

function selectLabelGroups(stationGroups, project) {
  const selected = [];

  stationGroups
    .filter((group) => group.nodes.length > 1)
    .slice()
    .sort((left, right) => right.importance - left.importance)
    .forEach((group) => {
      if (selected.length >= LABEL_LIMIT) {
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

function fitCamera(camera, controls, points, width, height) {
  const box = new THREE.Box3().setFromPoints(points);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const aspect = width / Math.max(1, height);
  const fovRadians = (camera.fov * Math.PI) / 180;
  const fitHeightDistance = (size.y * 0.85 + size.z * 0.52) / Math.tan(fovRadians / 2);
  const fitWidthDistance = (size.x * 0.78) / Math.tan(fovRadians / 2) / Math.max(aspect, 0.7);
  const responsiveScale = aspect < 0.75 ? 2.45 : 0.64;
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

function makeLabel(group, project) {
  const label = document.createElement('div');
  label.className = 'station-label';
  label.textContent = group.name;

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
  const { hoverEl, onReady } = options;
  const project = computeProjection(networkData.scene);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#f6f4ee');

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

  networkData.scene.lineSegments.forEach((segment) => {
    const points = tubePoints(segment, project);
    scenePoints.push(...points);
    const radius = lineRadiusFor(segment.lineId);
    const underlayMesh = makeTubeMesh(points, darkenColour(segment.colour), radius + 2.2, {
      roughness: 0.78
    });
    const lineMesh = makeTubeMesh(points, segment.colour, radius, {
      emissive: segment.colour,
      emissiveIntensity: 0.05
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

  networkData.scene.stationGroups.forEach((group) => {
    if (group.nodes.length < 2) {
      return;
    }

    for (let index = 0; index < group.nodes.length - 1; index += 1) {
      const start = project(group.nodes[index].coordinates, group.nodes[index].elevation);
      const end = project(group.nodes[index + 1].coordinates, group.nodes[index + 1].elevation);
      const connector = makeConnector(start, end);

      if (connector) {
        scene.add(connector);
      }
    }
  });

  networkData.scene.stationNodes.forEach((node) => {
    const stationAnchor = makeStationNode(node, project);
    scenePoints.push(stationAnchor.position.clone());
    interactiveObjects.push(stationAnchor);
    scene.add(stationAnchor);
  });

  selectLabelGroups(networkData.scene.stationGroups, project).forEach(({ group }) => {
    scene.add(makeLabel(group, project));
  });

  fitCamera(camera, controls, scenePoints, container.clientWidth, container.clientHeight);

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
    fitCamera(camera, controls, scenePoints, width, height);
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
    }
  };
}
