import { INCLUDED_LINE_IDS, LINE_COLOURS } from './constants.js';

const API_BASE = 'https://api.tfl.gov.uk';
const CACHE_KEY = 'subsurface.network.v4';
const CACHE_TTL_MS = 1000 * 60 * 60 * 24;
const LONDON_CORE = [-0.118092, 51.509865];

const LINE_ELEVATION_PROFILES = {
  bakerloo: { coreDepth: -46, outerHeight: 8, coreRadiusKm: 4.8, outerRadiusKm: 20 },
  central: { coreDepth: -40, outerHeight: 10, coreRadiusKm: 4.5, outerRadiusKm: 22 },
  circle: { coreDepth: -8, outerHeight: 6, coreRadiusKm: 4, outerRadiusKm: 17 },
  district: { coreDepth: -10, outerHeight: 8, coreRadiusKm: 4.2, outerRadiusKm: 21 },
  elizabeth: { coreDepth: -30, outerHeight: 12, coreRadiusKm: 5.5, outerRadiusKm: 26 },
  'hammersmith-city': { coreDepth: -8, outerHeight: 8, coreRadiusKm: 4, outerRadiusKm: 19 },
  jubilee: { coreDepth: -34, outerHeight: 8, coreRadiusKm: 5.2, outerRadiusKm: 18 },
  metropolitan: { coreDepth: -8, outerHeight: 16, coreRadiusKm: 4.5, outerRadiusKm: 30 },
  northern: { coreDepth: -48, outerHeight: 7, coreRadiusKm: 4.8, outerRadiusKm: 21 },
  piccadilly: { coreDepth: -40, outerHeight: 10, coreRadiusKm: 5.1, outerRadiusKm: 26 },
  victoria: { coreDepth: -34, outerHeight: 6, coreRadiusKm: 4.6, outerRadiusKm: 16 },
  'waterloo-city': { coreDepth: -54, outerHeight: -38, coreRadiusKm: 0, outerRadiusKm: 7 }
};

function buildAuthQuery() {
  const params = new URLSearchParams();

  if (__TFL_APP_ID__) {
    params.set('app_id', __TFL_APP_ID__);
  }

  if (__TFL_APP_KEY__) {
    params.set('app_key', __TFL_APP_KEY__);
  }

  return params;
}

function buildEndpoint(path, extraParams = {}) {
  const params = buildAuthQuery();

  Object.entries(extraParams).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      params.set(key, value);
    }
  });

  return `${API_BASE}${path}?${params.toString()}`;
}

function lineDisplayColour(lineId) {
  return LINE_COLOURS[lineId] ?? '#ffffff';
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function smoothstep(edge0, edge1, value) {
  if (edge0 === edge1) {
    return value < edge0 ? 0 : 1;
  }

  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function lerp(start, end, amount) {
  return start + (end - start) * amount;
}

function distanceKmFromCore([lon, lat]) {
  const referenceLat = ((lat + LONDON_CORE[1]) / 2) * (Math.PI / 180);
  const dx = (lon - LONDON_CORE[0]) * 111.32 * Math.cos(referenceLat);
  const dy = (lat - LONDON_CORE[1]) * 110.57;

  return Math.sqrt(dx * dx + dy * dy);
}

function estimateLineElevation(lineId, coordinate) {
  const profile = LINE_ELEVATION_PROFILES[lineId] ?? {
    coreDepth: -12,
    outerHeight: 8,
    coreRadiusKm: 5,
    outerRadiusKm: 20
  };
  const distanceKm = distanceKmFromCore(coordinate);
  const outerness = smoothstep(profile.coreRadiusKm, profile.outerRadiusKm, distanceKm);
  const contourLift = Math.sin((coordinate[0] + 0.2) * 18) * 1.6;

  return lerp(profile.coreDepth, profile.outerHeight, outerness) + contourLift;
}

function formatStationName(name) {
  if (typeof name !== 'string') {
    return name;
  }

  return name
    .replace(
      /(?:\s+(?:Underground Station|Rail Station|Overground Station|DLR Station|Tram Stop))+$/gi,
      ''
    )
    .trim();
}

function readCache(storage, now) {
  if (!storage?.getItem) {
    return null;
  }

  const rawValue = storage.getItem(CACHE_KEY);

  if (!rawValue) {
    return null;
  }

  try {
    const cached = JSON.parse(rawValue);

    if (!cached?.data || typeof cached.cachedAt !== 'number') {
      return null;
    }

    return {
      data: cached.data,
      cachedAt: cached.cachedAt,
      isFresh: now - cached.cachedAt < CACHE_TTL_MS
    };
  } catch {
    return null;
  }
}

function writeCache(storage, data, now) {
  if (!storage?.setItem) {
    return;
  }

  storage.setItem(
    CACHE_KEY,
    JSON.stringify({
      cachedAt: now,
      data
    })
  );
}

function parseLineString(rawLineString) {
  const parsed = JSON.parse(rawLineString);

  if (!Array.isArray(parsed)) {
    return [];
  }

  if (Array.isArray(parsed[0]) && typeof parsed[0][0] === 'number') {
    return [parsed];
  }

  return parsed.filter((segment) => Array.isArray(segment) && segment.length > 1);
}

function projectCoordinate([lon, lat], referenceLat) {
  const radians = (referenceLat * Math.PI) / 180;

  return {
    x: lon * 111320 * Math.cos(radians),
    y: lat * 110540
  };
}

function getNearestPointOnSegment(point, segmentStart, segmentEnd) {
  const referenceLat = (point[1] + segmentStart[1] + segmentEnd[1]) / 3;
  const projectedPoint = projectCoordinate(point, referenceLat);
  const projectedStart = projectCoordinate(segmentStart, referenceLat);
  const projectedEnd = projectCoordinate(segmentEnd, referenceLat);
  const deltaX = projectedEnd.x - projectedStart.x;
  const deltaY = projectedEnd.y - projectedStart.y;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;

  if (lengthSquared === 0) {
    const dx = projectedPoint.x - projectedStart.x;
    const dy = projectedPoint.y - projectedStart.y;

    return {
      coordinates: segmentStart,
      distanceMeters: Math.sqrt(dx * dx + dy * dy)
    };
  }

  const rawT =
    ((projectedPoint.x - projectedStart.x) * deltaX +
      (projectedPoint.y - projectedStart.y) * deltaY) /
    lengthSquared;
  const t = clamp(rawT, 0, 1);
  const snapped = [
    segmentStart[0] + (segmentEnd[0] - segmentStart[0]) * t,
    segmentStart[1] + (segmentEnd[1] - segmentStart[1]) * t
  ];
  const projectedSnapped = projectCoordinate(snapped, referenceLat);
  const dx = projectedPoint.x - projectedSnapped.x;
  const dy = projectedPoint.y - projectedSnapped.y;

  return {
    coordinates: snapped,
    distanceMeters: Math.sqrt(dx * dx + dy * dy)
  };
}

function buildLineFeature(lineMeta, coordinates, branchIndex) {
  return {
    type: 'Feature',
    properties: {
      lineId: lineMeta.id,
      lineName: lineMeta.name,
      mode: lineMeta.modeName,
      colour: lineDisplayColour(lineMeta.id),
      branchIndex
    },
    geometry: {
      type: 'LineString',
      coordinates
    }
  };
}

function buildStationFeature(station, lineMeta) {
  return {
    type: 'Feature',
    properties: {
      stationId: station.stationId ?? station.id,
      lineId: lineMeta.id,
      lineName: lineMeta.name,
      name: formatStationName(station.name),
      zone: station.zone ?? 'Unknown',
      modes: Array.isArray(station.modes) ? station.modes.join(', ') : lineMeta.modeName,
      interchangeCount: Array.isArray(station.lines) ? station.lines.length : 0
    },
    geometry: {
      type: 'Point',
      coordinates: [station.lon, station.lat]
    }
  };
}

function cloneFeature(feature) {
  return {
    type: feature.type,
    properties: { ...feature.properties },
    geometry: {
      type: feature.geometry.type,
      coordinates: Array.isArray(feature.geometry.coordinates?.[0])
        ? feature.geometry.coordinates.map((coordinate) => [...coordinate])
        : [...feature.geometry.coordinates]
    }
  };
}

function snapStationToLines(stationFeature, lineFeatures) {
  const servedLineIds = new Set(stationFeature.properties.lineId.split('|'));
  const stationCoordinates = stationFeature.geometry.coordinates;
  let bestMatch = null;

  lineFeatures.forEach((lineFeature) => {
    if (!servedLineIds.has(lineFeature.properties.lineId)) {
      return;
    }

    const coordinates = lineFeature.geometry.coordinates;

    for (let index = 0; index < coordinates.length - 1; index += 1) {
      const candidate = getNearestPointOnSegment(
        stationCoordinates,
        coordinates[index],
        coordinates[index + 1]
      );

      if (!bestMatch || candidate.distanceMeters < bestMatch.distanceMeters) {
        bestMatch = candidate;
      }
    }
  });

  if (bestMatch) {
    stationFeature.geometry.coordinates = bestMatch.coordinates;
  }
}

function stationZoneValue(zone) {
  const parsed = Number.parseFloat(zone);
  return Number.isFinite(parsed) ? parsed : 6;
}

function buildSceneModel(lineFeatures, stationNodeFeatures) {
  const sceneLineSegments = lineFeatures.map((feature, index) => ({
    id: `${feature.properties.lineId}-${feature.properties.branchIndex}-${index}`,
    lineId: feature.properties.lineId,
    lineName: feature.properties.lineName,
    colour: feature.properties.colour,
    branchIndex: feature.properties.branchIndex,
    coordinates: feature.geometry.coordinates.map((coordinate) => [
      coordinate[0],
      coordinate[1],
      estimateLineElevation(feature.properties.lineId, coordinate)
    ])
  }));

  const sceneStationNodes = stationNodeFeatures.map((feature, index) => {
    const coordinates = feature.geometry.coordinates;
    const elevation = estimateLineElevation(feature.properties.lineId, coordinates);

    return {
      id: `${feature.properties.stationId}-${feature.properties.lineId}-${index}`,
      stationId: feature.properties.stationId,
      name: feature.properties.name,
      lineId: feature.properties.lineId,
      lineName: feature.properties.lineName,
      colour: lineDisplayColour(feature.properties.lineId),
      zone: feature.properties.zone,
      coordinates,
      elevation,
      modes: feature.properties.modes
    };
  });

  const stationGroupsById = new Map();

  sceneStationNodes.forEach((node) => {
    const existing = stationGroupsById.get(node.stationId);

    if (!existing) {
      stationGroupsById.set(node.stationId, {
        stationId: node.stationId,
        name: node.name,
        zone: node.zone,
        coordinates: [...node.coordinates],
        nodes: [node]
      });
      return;
    }

    existing.nodes.push(node);
    existing.coordinates[0] += node.coordinates[0];
    existing.coordinates[1] += node.coordinates[1];
  });

  const sceneStationGroups = Array.from(stationGroupsById.values()).map((group) => {
    group.coordinates[0] /= group.nodes.length;
    group.coordinates[1] /= group.nodes.length;
    group.nodes.sort((left, right) => left.elevation - right.elevation);
    group.lineIds = group.nodes.map((node) => node.lineId);
    group.importance =
      group.nodes.length * 4 +
      Math.max(0, 7 - stationZoneValue(group.zone)) +
      Math.max(0, 6 - distanceKmFromCore(group.coordinates));

    return group;
  });

  return {
    lineSegments: sceneLineSegments,
    stationNodes: sceneStationNodes,
    stationGroups: sceneStationGroups
  };
}

export function normaliseRouteSequence(lineMeta, routeSequence) {
  const lineFeatures = [];
  const stationFeaturesById = new Map();

  (routeSequence.lineStrings ?? []).forEach((rawLineString, branchIndex) => {
    const segments = parseLineString(rawLineString);

    segments.forEach((coordinates) => {
      if (coordinates.length > 1) {
        lineFeatures.push(buildLineFeature(lineMeta, coordinates, branchIndex));
      }
    });
  });

  (routeSequence.stations ?? []).forEach((station) => {
    if (typeof station.lon !== 'number' || typeof station.lat !== 'number') {
      return;
    }

    const stationId = station.stationId ?? station.id;

    if (!stationFeaturesById.has(stationId)) {
      stationFeaturesById.set(stationId, buildStationFeature(station, lineMeta));
    }
  });

  return {
    lineFeatures,
    stationFeatures: Array.from(stationFeaturesById.values())
  };
}

async function fetchFreshNetworkData(fetchImpl) {
  const lineResponse = await fetchImpl(
    buildEndpoint('/Line/Mode/tube,elizabeth-line/Route', {
      serviceTypes: 'Regular'
    })
  );

  if (!lineResponse.ok) {
    throw new Error(`Unable to load line metadata (${lineResponse.status})`);
  }

  const allLines = await lineResponse.json();
  const targetLines = allLines.filter((line) => INCLUDED_LINE_IDS.includes(line.id));

  const routeSequences = await Promise.all(
    targetLines.map(async (line) => {
      const response = await fetchImpl(
        buildEndpoint(`/Line/${line.id}/Route/Sequence/all`, {
          serviceTypes: 'Regular',
          excludeCrowding: 'true'
        })
      );

      if (!response.ok) {
        throw new Error(`Unable to load route sequence for ${line.name} (${response.status})`);
      }

      return {
        line,
        routeSequence: await response.json()
      };
    })
  );

  const lineFeatures = [];
  const lineStationFeatures = [];

  routeSequences.forEach(({ line, routeSequence }) => {
    const normalised = normaliseRouteSequence(line, routeSequence);
    lineFeatures.push(...normalised.lineFeatures);
    lineStationFeatures.push(...normalised.stationFeatures.map((feature) => cloneFeature(feature)));
  });

  lineStationFeatures.forEach((stationFeature) => snapStationToLines(stationFeature, lineFeatures));

  const scene = buildSceneModel(lineFeatures, lineStationFeatures);
  const mergedStations = new Map();

  scene.stationGroups.forEach((group) => {
    const lineNames = [];
    const lineIds = [];

    group.nodes.forEach((node) => {
      lineNames.push(node.lineName);
      lineIds.push(node.lineId);
    });

    mergedStations.set(group.stationId, {
      type: 'Feature',
      properties: {
        stationId: group.stationId,
        name: group.name,
        zone: group.zone,
        lineId: Array.from(new Set(lineIds)).sort().join('|'),
        lineName: Array.from(new Set(lineNames)).sort().join(' | '),
        interchangeCount: group.nodes.length
      },
      geometry: {
        type: 'Point',
        coordinates: group.coordinates
      }
    });
  });

  return {
    lines: {
      type: 'FeatureCollection',
      features: lineFeatures
    },
    stations: {
      type: 'FeatureCollection',
      features: Array.from(mergedStations.values())
    },
    scene,
    lineCount: targetLines.length,
    stationCount: mergedStations.size
  };
}

export async function fetchNetworkData(options = {}) {
  const {
    fetchImpl = fetch,
    storage = globalThis.localStorage,
    now = Date.now()
  } = options;

  const cached = readCache(storage, now);

  if (cached?.isFresh) {
    return {
      ...cached.data,
      source: 'cache',
      cachedAt: cached.cachedAt
    };
  }

  try {
    const freshData = await fetchFreshNetworkData(fetchImpl);
    writeCache(storage, freshData, now);

    return {
      ...freshData,
      source: 'live',
      cachedAt: now
    };
  } catch (error) {
    if (cached?.data) {
      return {
        ...cached.data,
        source: 'stale-cache',
        cachedAt: cached.cachedAt
      };
    }

    throw error;
  }
}
