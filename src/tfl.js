import { INCLUDED_LINE_IDS, LINE_COLOURS } from './constants.js';
import stationDepthCsv from '../data/station-depths.csv?raw';

const API_BASE = 'https://api.tfl.gov.uk';
const CACHE_KEY = 'subsurface.network.v12';
const CACHE_TTL_MS = 1000 * 60 * 60 * 24;
const LONDON_CORE = [-0.118092, 51.509865];
const PLATFORM_HEIGHT_OFFSET_METRES = 100;
const DEPTH_SOURCE = 'station-depths.csv';
const LINE_STATION_BRANCH_MAX_DISTANCE_METRES = 75;

const CSV_LINE_NAMES = {
  Bakerloo: 'bakerloo',
  Central: 'central',
  District: 'district',
  'Hammersmith & City': 'hammersmith-city',
  Jubilee: 'jubilee',
  'Elizabeth Line': 'elizabeth',
  Metropoliton: 'metropolitan',
  Metropolitan: 'metropolitan',
  Northern: 'northern',
  Piccadilly: 'piccadilly',
  Victoria: 'victoria',
  Circle: 'circle',
  'Waterloo & City': 'waterloo-city'
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

function distanceKmFromCore([lon, lat]) {
  const referenceLat = ((lat + LONDON_CORE[1]) / 2) * (Math.PI / 180);
  const dx = (lon - LONDON_CORE[0]) * 111.32 * Math.cos(referenceLat);
  const dy = (lat - LONDON_CORE[1]) * 110.57;

  return Math.sqrt(dx * dx + dy * dy);
}

function parseCsvLine(line) {
  const cells = [];
  let current = '';
  let isQuoted = false;

  for (const character of line) {
    if (character === '"') {
      isQuoted = !isQuoted;
      continue;
    }

    if (character === ',' && !isQuoted) {
      cells.push(current);
      current = '';
      continue;
    }

    current += character;
  }

  cells.push(current);

  return cells;
}

function normaliseLookupName(name) {
  return formatStationName(name)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function buildStationDepthLookup(csvText) {
  const rows = csvText
    .trim()
    .split(/\r?\n/)
    .map(parseCsvLine);
  const lineHeader = rows[0];
  const directionHeader = rows[1];
  const columns = [];
  let currentLineId = null;

  lineHeader.forEach((rawName, index) => {
    const name = rawName.trim();

    if (name) {
      currentLineId = CSV_LINE_NAMES[name] ?? null;
    }

    if (currentLineId && /^(Northbound|Southbound|Eastbound|Westbound)$/i.test(directionHeader[index]?.trim())) {
      columns.push({ index, lineId: currentLineId });
    }
  });

  const lookup = new Map();
  const groundLevels = new Map();

  rows.slice(2).forEach((row) => {
    const stationName = row[0]?.trim();
    const groundLevelMetres = Number.parseFloat(row[1]);

    if (!stationName) {
      return;
    }

    if (Number.isFinite(groundLevelMetres)) {
      groundLevels.set(normaliseLookupName(stationName), {
        stationName: stationName.trim(),
        groundLevelMetres
      });
    }

    columns.forEach(({ index, lineId }) => {
      const rawPlatformHeight = Number.parseFloat(row[index]);

      if (!Number.isFinite(rawPlatformHeight) || !Number.isFinite(groundLevelMetres)) {
        return;
      }

      const key = `${normaliseLookupName(stationName)}|${lineId}`;
      const platformHeightMetres = rawPlatformHeight - PLATFORM_HEIGHT_OFFSET_METRES;
      const entry = lookup.get(key) ?? {
        stationName: stationName.trim(),
        lineId,
        groundLevelMetres,
        platformHeightsMetres: [],
        depthsBelowGroundMetres: []
      };

      entry.platformHeightsMetres.push(platformHeightMetres);
      entry.depthsBelowGroundMetres.push(groundLevelMetres - platformHeightMetres);
      lookup.set(key, entry);
    });
  });

  lookup.forEach((entry, key) => {
    lookup.set(key, {
      stationName: entry.stationName,
      lineId: entry.lineId,
      groundLevelMetres: entry.groundLevelMetres,
      platformHeightMetres: mean(entry.platformHeightsMetres),
      depthBelowGroundMetres: mean(entry.depthsBelowGroundMetres),
      source: DEPTH_SOURCE
    });
  });

  return {
    depths: lookup,
    groundLevels
  };
}

const STATION_DEPTH_DATA = buildStationDepthLookup(stationDepthCsv);
const STATION_DEPTHS = STATION_DEPTH_DATA.depths;
const STATION_GROUND_LEVELS = STATION_DEPTH_DATA.groundLevels;

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

    if (!cached?.data || typeof cached.cachedAt !== 'number' || !hasRenderableScene(cached.data)) {
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

function hasRenderableScene(data) {
  return data?.scene?.lineSegments?.length > 0 && data?.scene?.stationNodes?.length > 0;
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
      distanceMeters: Math.sqrt(dx * dx + dy * dy),
      t: 0
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
    distanceMeters: Math.sqrt(dx * dx + dy * dy),
    t
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

export function getStationDepthRecord(stationName, lineId) {
  const lookupName = normaliseLookupName(stationName);
  const directRecord = STATION_DEPTHS.get(`${lookupName}|${lineId}`);

  if (directRecord || lineId !== 'elizabeth') {
    return directRecord ?? null;
  }

  const piccadillyRecord = STATION_DEPTHS.get(`${lookupName}|piccadilly`);

  if (piccadillyRecord && lookupName.includes('heathrow')) {
    return {
      ...piccadillyRecord,
      lineId,
      source: `${DEPTH_SOURCE}; Elizabeth line Heathrow level approximated from same-station Piccadilly platform row`
    };
  }

  const groundRecord = STATION_GROUND_LEVELS.get(lookupName);
  const groundLevelMetres = groundRecord?.groundLevelMetres ?? 0;

  return {
    stationName: groundRecord?.stationName ?? formatStationName(stationName),
    lineId,
    groundLevelMetres,
    platformHeightMetres: groundLevelMetres,
    depthBelowGroundMetres: 0,
    source: `${DEPTH_SOURCE}; Elizabeth line surface-level fallback`
  };
}

function distanceMetersBetween(left, right) {
  const referenceLat = (left[1] + right[1]) / 2;
  const projectedLeft = projectCoordinate(left, referenceLat);
  const projectedRight = projectCoordinate(right, referenceLat);
  const dx = projectedRight.x - projectedLeft.x;
  const dy = projectedRight.y - projectedLeft.y;

  return Math.sqrt(dx * dx + dy * dy);
}

function measureCoordinateOnLineMatch(point, coordinates) {
  let bestMatch = null;
  let travelled = 0;

  for (let index = 0; index < coordinates.length - 1; index += 1) {
    const start = coordinates[index];
    const end = coordinates[index + 1];
    const segmentLength = distanceMetersBetween(start, end);
    const match = getNearestPointOnSegment(point, start, end);

    if (!bestMatch || match.distanceMeters < bestMatch.distanceMeters) {
      bestMatch = {
        distanceMeters: match.distanceMeters,
        measureMeters: travelled + segmentLength * match.t
      };
    }

    travelled += segmentLength;
  }

  return bestMatch ?? {
    distanceMeters: Number.POSITIVE_INFINITY,
    measureMeters: 0
  };
}

function measureCoordinateOnLine(point, coordinates) {
  return measureCoordinateOnLineMatch(point, coordinates).measureMeters;
}

function lineMeasures(coordinates) {
  const measures = [0];

  for (let index = 1; index < coordinates.length; index += 1) {
    measures.push(measures[index - 1] + distanceMetersBetween(coordinates[index - 1], coordinates[index]));
  }

  return measures;
}

function coordinateAtMeasure(coordinates, measures, measure) {
  if (measure <= measures[0]) {
    return [...coordinates[0]];
  }

  const lastIndex = coordinates.length - 1;

  if (measure >= measures[lastIndex]) {
    return [...coordinates[lastIndex]];
  }

  for (let index = 0; index < coordinates.length - 1; index += 1) {
    const startMeasure = measures[index];
    const endMeasure = measures[index + 1];

    if (measure >= startMeasure && measure <= endMeasure) {
      const span = endMeasure - startMeasure;
      const amount = span === 0 ? 0 : (measure - startMeasure) / span;
      const start = coordinates[index];
      const end = coordinates[index + 1];

      return [
        start[0] + (end[0] - start[0]) * amount,
        start[1] + (end[1] - start[1]) * amount
      ];
    }
  }

  return [...coordinates[lastIndex]];
}

function isSameCoordinate(left, right) {
  return Math.abs(left[0] - right[0]) < 1e-9 && Math.abs(left[1] - right[1]) < 1e-9;
}

function pushUniquePathPoint(points, point) {
  const previous = points[points.length - 1];

  if (!previous || !isSameCoordinate(previous.coordinate, point.coordinate)) {
    points.push(point);
  }
}

function extractMeasuredPath(coordinates, startMeasure, endMeasure) {
  const measures = lineMeasures(coordinates);
  const lowerMeasure = Math.min(startMeasure, endMeasure);
  const upperMeasure = Math.max(startMeasure, endMeasure);
  const span = upperMeasure - lowerMeasure;
  const points = [];

  pushUniquePathPoint(points, {
    coordinate: coordinateAtMeasure(coordinates, measures, lowerMeasure),
    amount: 0
  });

  coordinates.forEach((coordinate, index) => {
    const measure = measures[index];

    if (measure > lowerMeasure && measure < upperMeasure) {
      pushUniquePathPoint(points, {
        coordinate: [...coordinate],
        amount: span === 0 ? 0 : (measure - lowerMeasure) / span
      });
    }
  });

  pushUniquePathPoint(points, {
    coordinate: coordinateAtMeasure(coordinates, measures, upperMeasure),
    amount: 1
  });

  return startMeasure <= endMeasure ? points : points.reverse().map((point) => ({
    coordinate: point.coordinate,
    amount: 1 - point.amount
  }));
}

function pathLengthMeters(points) {
  let length = 0;

  for (let index = 0; index < points.length - 1; index += 1) {
    length += distanceMetersBetween(points[index].coordinate, points[index + 1].coordinate);
  }

  return length;
}

function interpolatePlatformHeight(measure, measuredStations) {
  if (measuredStations.length === 0) {
    return null;
  }

  if (measuredStations.length === 1 || measure <= measuredStations[0].measureMeters) {
    return measuredStations[0].platformHeightMetres;
  }

  const last = measuredStations[measuredStations.length - 1];

  if (measure >= last.measureMeters) {
    return last.platformHeightMetres;
  }

  for (let index = 0; index < measuredStations.length - 1; index += 1) {
    const start = measuredStations[index];
    const end = measuredStations[index + 1];

    if (measure >= start.measureMeters && measure <= end.measureMeters) {
      const span = end.measureMeters - start.measureMeters;
      const amount = span === 0 ? 0 : (measure - start.measureMeters) / span;

      return start.platformHeightMetres +
        (end.platformHeightMetres - start.platformHeightMetres) * amount;
    }
  }

  return null;
}

function sharedTrackSectionKey(leftStationId, rightStationId) {
  return [leftStationId, rightStationId].sort().join('|');
}

function buildSharedTrackSections(lineFeatures, sceneStationNodes) {
  const sectionsByKey = new Map();

  lineFeatures.forEach((feature) => {
    const orderedStations = sceneStationNodes
      .filter((node) => node.lineId === feature.properties.lineId)
      .map((node) => ({
        ...node,
        ...measureCoordinateOnLineMatch(node.coordinates, feature.geometry.coordinates)
      }))
      .filter((node) => node.distanceMeters <= LINE_STATION_BRANCH_MAX_DISTANCE_METRES)
      .sort((left, right) => left.measureMeters - right.measureMeters);

    for (let index = 0; index < orderedStations.length - 1; index += 1) {
      const start = orderedStations[index];
      const end = orderedStations[index + 1];

      if (start.stationId === end.stationId) {
        continue;
      }

      const key = sharedTrackSectionKey(start.stationId, end.stationId);
      const section = sectionsByKey.get(key) ?? {
        stationIds: [start.stationId, end.stationId].sort(),
        stationNamesById: new Map(),
        stationPointsById: new Map(),
        lines: new Map(),
        paths: []
      };

      [start, end].forEach((station) => {
        section.stationNamesById.set(station.stationId, station.name);

        const point = section.stationPointsById.get(station.stationId) ?? {
          lon: 0,
          lat: 0,
          elevation: 0,
          count: 0
        };

        point.lon += station.coordinates[0];
        point.lat += station.coordinates[1];
        point.elevation += station.elevation;
        point.count += 1;
        section.stationPointsById.set(station.stationId, point);
      });
      section.lines.set(feature.properties.lineId, {
        lineId: feature.properties.lineId,
        lineName: feature.properties.lineName,
        colour: feature.properties.colour
      });
      section.paths.push({
        lineId: feature.properties.lineId,
        stationIds: [start.stationId, end.stationId],
        points: extractMeasuredPath(feature.geometry.coordinates, start.measureMeters, end.measureMeters)
      });
      sectionsByKey.set(key, section);
    }
  });

  return Array.from(sectionsByKey.values())
    .filter((section) => section.lines.size > 1)
    .map((section) => {
      const selectedPath = section.paths
        .slice()
        .sort((left, right) => {
          const lengthDifference = pathLengthMeters(right.points) - pathLengthMeters(left.points);

          if (Math.abs(lengthDifference) > 0.1) {
            return lengthDifference;
          }

          return right.points.length - left.points.length;
        })[0];
      const startPoint = section.stationPointsById.get(selectedPath.stationIds[0]);
      const endPoint = section.stationPointsById.get(selectedPath.stationIds[1]);
      const startElevation = startPoint.elevation / startPoint.count;
      const endElevation = endPoint.elevation / endPoint.count;
      const coordinates = selectedPath.points.map((point) => {

        return [
          point.coordinate[0],
          point.coordinate[1],
          startElevation + (endElevation - startElevation) * point.amount
        ];
      });

      return {
        stationIds: section.stationIds,
        stationNames: section.stationIds.map((stationId) => section.stationNamesById.get(stationId)),
        lineIds: Array.from(section.lines.keys()).sort(),
        lines: Array.from(section.lines.values()).sort((left, right) => left.lineId.localeCompare(right.lineId)),
        coordinates: coordinates.map((coordinate, index) => {
          if (index !== 0 && index !== coordinates.length - 1) {
            return coordinate;
          }

          const stationId = index === 0 ? selectedPath.stationIds[0] : selectedPath.stationIds[1];
          const point = section.stationPointsById.get(stationId);

          return [
            point.lon / point.count,
            point.lat / point.count,
            point.elevation / point.count
          ];
        })
      };
    });
}

function buildSceneModel(lineFeatures, stationNodeFeatures) {
  const sceneStationNodes = stationNodeFeatures.flatMap((feature, index) => {
    const depthRecord = getStationDepthRecord(feature.properties.name, feature.properties.lineId);

    if (!depthRecord) {
      return [];
    }

    return [{
      id: `${feature.properties.stationId}-${feature.properties.lineId}-${index}`,
      stationId: feature.properties.stationId,
      name: feature.properties.name,
      lineId: feature.properties.lineId,
      lineName: feature.properties.lineName,
      colour: lineDisplayColour(feature.properties.lineId),
      zone: feature.properties.zone,
      coordinates: feature.geometry.coordinates,
      elevation: depthRecord.platformHeightMetres,
      depthBelowGroundMetres: depthRecord.depthBelowGroundMetres,
      groundLevelMetres: depthRecord.groundLevelMetres,
      depthSource: depthRecord.source,
      modes: feature.properties.modes
    }];
  });

  const sceneLineSegments = lineFeatures.map((feature, index) => ({
    feature,
    index
  })).flatMap(({ feature, index }) => {
    const lineStations = sceneStationNodes
      .filter((node) => node.lineId === feature.properties.lineId)
      .map((node) => ({
        measureMeters: measureCoordinateOnLine(node.coordinates, feature.geometry.coordinates),
        platformHeightMetres: node.elevation
      }))
      .sort((left, right) => left.measureMeters - right.measureMeters);

    if (lineStations.length === 0) {
      return [];
    }

    const measures = lineMeasures(feature.geometry.coordinates);
    const coordinates = feature.geometry.coordinates.map((coordinate, coordinateIndex) => {
      const elevation = interpolatePlatformHeight(measures[coordinateIndex], lineStations);

      return [coordinate[0], coordinate[1], elevation];
    });

    if (coordinates.some((coordinate) => coordinate[2] === null)) {
      return [];
    }

    return [{
      id: `${feature.properties.lineId}-${feature.properties.branchIndex}-${index}`,
      lineId: feature.properties.lineId,
      lineName: feature.properties.lineName,
      colour: feature.properties.colour,
      branchIndex: feature.properties.branchIndex,
      coordinates,
      depthSource: DEPTH_SOURCE
    }];
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
  const sharedTrackSections = buildSharedTrackSections(lineFeatures, sceneStationNodes);

  return {
    lineSegments: sceneLineSegments,
    stationNodes: sceneStationNodes,
    stationGroups: sceneStationGroups,
    sharedTrackSections
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

  lineStationFeatures.forEach((feature) => {
    const stationId = feature.properties.stationId;
    const existing = mergedStations.get(stationId);
    const depthRecord = getStationDepthRecord(feature.properties.name, feature.properties.lineId);

    if (!existing) {
      mergedStations.set(stationId, {
        type: 'Feature',
        properties: {
          stationId,
          name: feature.properties.name,
          zone: feature.properties.zone,
          lineId: feature.properties.lineId,
          lineName: feature.properties.lineName,
          interchangeCount: 1,
          hasDepthData: Boolean(depthRecord),
          depthSource: depthRecord?.source
        },
        geometry: {
          type: 'Point',
          coordinates: [...feature.geometry.coordinates]
        }
      });
      return;
    }

    const lineIds = new Set(existing.properties.lineId.split('|'));
    const lineNames = new Set(existing.properties.lineName.split(' | '));

    lineIds.add(feature.properties.lineId);
    lineNames.add(feature.properties.lineName);
    existing.properties.lineId = Array.from(lineIds).sort().join('|');
    existing.properties.lineName = Array.from(lineNames).sort().join(' | ');
    existing.properties.interchangeCount += 1;
    existing.properties.hasDepthData = existing.properties.hasDepthData || Boolean(depthRecord);
    existing.properties.depthSource ??= depthRecord?.source;
    existing.geometry.coordinates[0] += feature.geometry.coordinates[0];
    existing.geometry.coordinates[1] += feature.geometry.coordinates[1];
  });

  mergedStations.forEach((station) => {
    station.geometry.coordinates[0] /= station.properties.interchangeCount;
    station.geometry.coordinates[1] /= station.properties.interchangeCount;
  });

  scene.stationGroups.forEach((group) => {
    const lineNames = [];
    const lineIds = [];

    group.nodes.forEach((node) => {
      lineNames.push(node.lineName);
      lineIds.push(node.lineId);
    });

    const station = mergedStations.get(group.stationId);

    if (station) {
      station.properties.sceneLineId = Array.from(new Set(lineIds)).sort().join('|');
      station.properties.sceneLineName = Array.from(new Set(lineNames)).sort().join(' | ');
      station.properties.sceneInterchangeCount = group.nodes.length;
      station.properties.depthSource = DEPTH_SOURCE;
    }
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
