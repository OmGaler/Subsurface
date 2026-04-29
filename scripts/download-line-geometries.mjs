import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INCLUDED_LINE_IDS, LINE_COLOURS } from '../src/constants.js';

const API_BASE = 'https://api.tfl.gov.uk';
const OUTPUT_DIR = 'data';
const WGS84_OUTPUT = 'tfl-line-geometries-wgs84.geojson';
const BNG_OUTPUT = 'tfl-line-geometries-epsg27700.geojson';
const SOURCE_CRS = 'EPSG:4326';
const DISPLAY_CRS = 'EPSG:27700';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

function parseEnv(text) {
  const values = new Map();

  text.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      return;
    }

    const separatorIndex = trimmed.indexOf('=');

    if (separatorIndex === -1) {
      return;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim().replace(/^["']|["']$/g, '');

    values.set(key, value);
  });

  return values;
}

async function readLocalEnv() {
  try {
    return parseEnv(await readFile(path.join(projectRoot, '.env'), 'utf8'));
  } catch {
    return new Map();
  }
}

function buildEndpoint(pathname, params = {}, auth = {}) {
  const url = new URL(pathname, API_BASE);

  Object.entries({
    ...params,
    app_id: auth.appId,
    app_key: auth.appKey
  }).forEach(([key, value]) => {
    if (value) {
      url.searchParams.set(key, value);
    }
  });

  return url;
}

async function fetchJson(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`TfL request failed ${response.status} ${response.statusText}: ${url.pathname}`);
  }

  return response.json();
}

function parseLineString(rawLineString) {
  const parsed = JSON.parse(rawLineString);

  if (!Array.isArray(parsed)) {
    return [];
  }

  if (typeof parsed[0]?.[0] === 'number') {
    return [parsed];
  }

  return parsed.filter((segment) => Array.isArray(segment) && segment.length > 1);
}

function makeCrs(name) {
  return {
    type: 'name',
    properties: {
      name
    }
  };
}

function makeFeatureCollection(features, crsName) {
  return {
    type: 'FeatureCollection',
    name: crsName === DISPLAY_CRS
      ? 'TfL line geometries projected to British National Grid'
      : 'TfL line geometries in WGS84',
    crs: makeCrs(crsName),
    metadata: {
      source: 'TfL Unified API Line Route Sequence',
      downloadedAt: new Date().toISOString(),
      projection: crsName,
      note: crsName === DISPLAY_CRS
        ? 'Projected for local GIS cleanup in QGIS. Coordinates are metres in British National Grid.'
        : 'Raw lon/lat source geometries from TfL, kept for traceability.'
    },
    features
  };
}

function cloneFeatureWithCoordinates(feature, coordinates, crsName) {
  return {
    type: 'Feature',
    properties: {
      ...feature.properties,
      crs: crsName
    },
    geometry: {
      type: 'LineString',
      coordinates
    }
  };
}

function degToRad(value) {
  return value * Math.PI / 180;
}

function latLonToCartesian(lat, lon, height, ellipsoid) {
  const phi = degToRad(lat);
  const lambda = degToRad(lon);
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const nu = ellipsoid.a / Math.sqrt(1 - ellipsoid.e2 * sinPhi * sinPhi);

  return {
    x: (nu + height) * cosPhi * Math.cos(lambda),
    y: (nu + height) * cosPhi * Math.sin(lambda),
    z: ((1 - ellipsoid.e2) * nu + height) * sinPhi
  };
}

function cartesianToLatLon({ x, y, z }, ellipsoid) {
  const p = Math.sqrt(x * x + y * y);
  let phi = Math.atan2(z, p * (1 - ellipsoid.e2));
  let previousPhi = 0;

  while (Math.abs(phi - previousPhi) > 1e-12) {
    previousPhi = phi;
    const sinPhi = Math.sin(phi);
    const nu = ellipsoid.a / Math.sqrt(1 - ellipsoid.e2 * sinPhi * sinPhi);
    phi = Math.atan2(z + ellipsoid.e2 * nu * sinPhi, p);
  }

  return {
    lat: phi,
    lon: Math.atan2(y, x)
  };
}

function helmertWgs84ToOsgb36(cartesian) {
  const tx = -446.448;
  const ty = 125.157;
  const tz = -542.060;
  const rx = degToRad(-0.1502 / 3600);
  const ry = degToRad(-0.2470 / 3600);
  const rz = degToRad(-0.8421 / 3600);
  const scale = 1 + 20.4894e-6;
  const { x, y, z } = cartesian;

  return {
    x: tx + scale * x - rz * y + ry * z,
    y: ty + rz * x + scale * y - rx * z,
    z: tz - ry * x + rx * y + scale * z
  };
}

function osgb36LatLonToBritishNationalGrid(lat, lon) {
  const a = 6377563.396;
  const b = 6356256.909;
  const f0 = 0.9996012717;
  const lat0 = degToRad(49);
  const lon0 = degToRad(-2);
  const n0 = -100000;
  const e0 = 400000;
  const e2 = 1 - (b * b) / (a * a);
  const n = (a - b) / (a + b);
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const tanLat = Math.tan(lat);
  const nu = a * f0 / Math.sqrt(1 - e2 * sinLat * sinLat);
  const rho = a * f0 * (1 - e2) / ((1 - e2 * sinLat * sinLat) ** 1.5);
  const eta2 = nu / rho - 1;
  const latDelta = lat - lat0;
  const latSum = lat + lat0;
  const m = b * f0 * (
    (1 + n + 5 / 4 * n ** 2 + 5 / 4 * n ** 3) * latDelta -
    (3 * n + 3 * n ** 2 + 21 / 8 * n ** 3) * Math.sin(latDelta) * Math.cos(latSum) +
    (15 / 8 * n ** 2 + 15 / 8 * n ** 3) * Math.sin(2 * latDelta) * Math.cos(2 * latSum) -
    (35 / 24 * n ** 3) * Math.sin(3 * latDelta) * Math.cos(3 * latSum)
  );
  const lonDelta = lon - lon0;
  const i = m + n0;
  const ii = nu / 2 * sinLat * cosLat;
  const iii = nu / 24 * sinLat * cosLat ** 3 * (5 - tanLat ** 2 + 9 * eta2);
  const iiia = nu / 720 * sinLat * cosLat ** 5 * (61 - 58 * tanLat ** 2 + tanLat ** 4);
  const iv = nu * cosLat;
  const v = nu / 6 * cosLat ** 3 * (nu / rho - tanLat ** 2);
  const vi = nu / 120 * cosLat ** 5 * (
    5 - 18 * tanLat ** 2 + tanLat ** 4 + 14 * eta2 - 58 * tanLat ** 2 * eta2
  );

  return [
    e0 + iv * lonDelta + v * lonDelta ** 3 + vi * lonDelta ** 5,
    i + ii * lonDelta ** 2 + iii * lonDelta ** 4 + iiia * lonDelta ** 6
  ];
}

function wgs84ToBritishNationalGrid([lon, lat]) {
  const wgs84 = {
    a: 6378137,
    b: 6356752.3141
  };
  const airy1830 = {
    a: 6377563.396,
    b: 6356256.909
  };
  wgs84.e2 = 1 - (wgs84.b * wgs84.b) / (wgs84.a * wgs84.a);
  airy1830.e2 = 1 - (airy1830.b * airy1830.b) / (airy1830.a * airy1830.a);

  const osgb36Cartesian = helmertWgs84ToOsgb36(latLonToCartesian(lat, lon, 0, wgs84));
  const osgb36LatLon = cartesianToLatLon(osgb36Cartesian, airy1830);

  return osgb36LatLonToBritishNationalGrid(osgb36LatLon.lat, osgb36LatLon.lon)
    .map((value) => Number(value.toFixed(3)));
}

function projectFeature(feature) {
  return cloneFeatureWithCoordinates(
    feature,
    feature.geometry.coordinates.map(wgs84ToBritishNationalGrid),
    DISPLAY_CRS
  );
}

async function fetchLineGeometries(auth) {
  const routeUrl = buildEndpoint('/Line/Mode/tube,elizabeth-line/Route', {}, auth);
  const allLines = await fetchJson(routeUrl);
  const linesById = new Map(allLines.map((line) => [line.id, line]));
  const targetLines = INCLUDED_LINE_IDS
    .map((lineId) => linesById.get(lineId))
    .filter(Boolean);
  const features = [];

  for (const line of targetLines) {
    const sequenceUrl = buildEndpoint(`/Line/${line.id}/Route/Sequence/all`, {
      serviceTypes: 'Regular'
    }, auth);
    const routeSequence = await fetchJson(sequenceUrl);

    (routeSequence.lineStrings ?? []).forEach((rawLineString, branchIndex) => {
      parseLineString(rawLineString).forEach((coordinates, segmentIndex) => {
        features.push({
          type: 'Feature',
          properties: {
            lineId: line.id,
            lineName: line.name,
            modeName: line.modeName,
            colour: LINE_COLOURS[line.id] ?? '#ffffff',
            branchIndex,
            segmentIndex,
            source: 'TfL Unified API Line Route Sequence',
            crs: SOURCE_CRS
          },
          geometry: {
            type: 'LineString',
            coordinates
          }
        });
      });
    });
  }

  return features;
}

function lineSummary(features) {
  const summary = new Map();

  features.forEach((feature) => {
    const lineId = feature.properties.lineId;
    const current = summary.get(lineId) ?? 0;
    summary.set(lineId, current + 1);
  });

  return Array.from(summary.entries())
    .map(([lineId, count]) => `${lineId}:${count}`)
    .join(', ');
}

async function main() {
  const env = await readLocalEnv();
  const auth = {
    appId: process.env.TFL_APP_ID ?? env.get('TFL_APP_ID'),
    appKey: process.env.TFL_APP_KEY ?? env.get('TFL_APP_KEY')
  };
  const features = await fetchLineGeometries(auth);
  const projectedFeatures = features.map(projectFeature);
  const outputPath = path.join(projectRoot, OUTPUT_DIR);

  await mkdir(outputPath, { recursive: true });
  await writeFile(
    path.join(outputPath, WGS84_OUTPUT),
    `${JSON.stringify(makeFeatureCollection(features, SOURCE_CRS), null, 2)}\n`
  );
  await writeFile(
    path.join(outputPath, BNG_OUTPUT),
    `${JSON.stringify(makeFeatureCollection(projectedFeatures, DISPLAY_CRS), null, 2)}\n`
  );

  console.log(`Wrote ${features.length} TfL route geometry features.`);
  console.log(`WGS84: ${path.join(OUTPUT_DIR, WGS84_OUTPUT)}`);
  console.log(`EPSG:27700: ${path.join(OUTPUT_DIR, BNG_OUTPUT)}`);
  console.log(`Feature counts by line: ${lineSummary(features)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
