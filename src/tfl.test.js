import { describe, expect, it } from 'vitest';
import { fetchNetworkData, normaliseRouteSequence } from './tfl.js';

function createStorage(initialValue) {
  const values = new Map();

  if (initialValue) {
    values.set('subsurface.network.v4', JSON.stringify(initialValue));
  }

  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, value);
    }
  };
}

function createJsonResponse(data) {
  return {
    ok: true,
    async json() {
      return data;
    }
  };
}

describe('normaliseRouteSequence', () => {
  it('converts TfL route strings into line and station GeoJSON features', () => {
    const lineMeta = {
      id: 'victoria',
      name: 'Victoria',
      modeName: 'tube'
    };
    const routeSequence = {
      lineStrings: [
        '[[[-0.1,51.5],[-0.09,51.51],[-0.08,51.52]]]',
        '[[[-0.08,51.52],[-0.07,51.53]]]'
      ],
      stations: [
        {
          stationId: 'A',
          name: 'Alpha',
          lat: 51.5,
          lon: -0.1,
          zone: '1',
          modes: ['tube'],
          lines: [{ id: 'victoria' }]
        },
        {
          stationId: 'B',
          name: 'Bravo',
          lat: 51.52,
          lon: -0.08,
          zone: '1',
          modes: ['tube'],
          lines: [{ id: 'victoria' }]
        }
      ]
    };

    const result = normaliseRouteSequence(lineMeta, routeSequence);

    expect(result.lineFeatures).toHaveLength(2);
    expect(result.lineFeatures[0].geometry.coordinates).toEqual([
      [-0.1, 51.5],
      [-0.09, 51.51],
      [-0.08, 51.52]
    ]);
    expect(result.stationFeatures).toHaveLength(2);
    expect(result.stationFeatures[0].geometry.type).toBe('Point');
    expect(result.stationFeatures[0].properties.lineName).toBe('Victoria');
  });

  it('merges repeated stations inside a route sequence', () => {
    const lineMeta = {
      id: 'northern',
      name: 'Northern',
      modeName: 'tube'
    };
    const routeSequence = {
      lineStrings: ['[[[-0.13,51.51],[-0.12,51.52]]]'],
      stations: [
        {
          stationId: '940',
          id: '940',
          name: 'Shared',
          lat: 51.51,
          lon: -0.13,
          zone: '2',
          modes: ['tube'],
          lines: [{ id: 'northern' }]
        },
        {
          stationId: '940',
          id: '940',
          name: 'Shared',
          lat: 51.51,
          lon: -0.13,
          zone: '2',
          modes: ['tube'],
          lines: [{ id: 'northern' }]
        }
      ]
    };

    const result = normaliseRouteSequence(lineMeta, routeSequence);

    expect(result.stationFeatures).toHaveLength(1);
    expect(result.stationFeatures[0].properties.stationId).toBe('940');
    expect(result.stationFeatures[0].properties.lineId).toBe('northern');
  });

  it('removes the Underground Station suffix from station labels', () => {
    const lineMeta = {
      id: 'victoria',
      name: 'Victoria',
      modeName: 'tube'
    };
    const routeSequence = {
      lineStrings: ['[[[-0.1,51.5],[-0.09,51.51]]]'],
      stations: [
        {
          stationId: 'A',
          name: 'Oxford Circus Underground Station',
          lat: 51.515,
          lon: -0.141,
          zone: '1',
          modes: ['tube'],
          lines: [{ id: 'victoria' }]
        }
      ]
    };

    const result = normaliseRouteSequence(lineMeta, routeSequence);

    expect(result.stationFeatures[0].properties.name).toBe('Oxford Circus');
  });

  it('removes multiple transport suffixes from station labels', () => {
    const lineMeta = {
      id: 'district',
      name: 'District',
      modeName: 'tube'
    };
    const routeSequence = {
      lineStrings: ['[[[-0.3,51.46],[-0.29,51.47]]]'],
      stations: [
        {
          stationId: 'B',
          name: 'Richmond Underground Station Rail Station',
          lat: 51.463,
          lon: -0.301,
          zone: '4',
          modes: ['tube', 'national-rail'],
          lines: [{ id: 'district' }]
        }
      ]
    };

    const result = normaliseRouteSequence(lineMeta, routeSequence);

    expect(result.stationFeatures[0].properties.name).toBe('Richmond');
  });
});

describe('fetchNetworkData', () => {
  it('uses a fresh cache instead of refetching', async () => {
    const cachedData = {
      lines: { type: 'FeatureCollection', features: [] },
      stations: { type: 'FeatureCollection', features: [] },
      lineCount: 12,
      stationCount: 272
    };
    const storage = createStorage({
      cachedAt: 1_000,
      data: cachedData
    });
    let fetchCount = 0;

    const result = await fetchNetworkData({
      storage,
      now: 2_000,
      fetchImpl: async () => {
        fetchCount += 1;
        throw new Error('should not fetch');
      }
    });

    expect(fetchCount).toBe(0);
    expect(result.source).toBe('cache');
    expect(result.stationCount).toBe(272);
  });

  it('falls back to stale cache if the live refresh fails', async () => {
    const cachedData = {
      lines: { type: 'FeatureCollection', features: [] },
      stations: { type: 'FeatureCollection', features: [] },
      lineCount: 12,
      stationCount: 270
    };
    const storage = createStorage({
      cachedAt: 1_000,
      data: cachedData
    });

    const result = await fetchNetworkData({
      storage,
      now: 1_000 + 1000 * 60 * 60 * 25,
      fetchImpl: async () => {
        throw new Error('TfL unavailable');
      }
    });

    expect(result.source).toBe('stale-cache');
    expect(result.stationCount).toBe(270);
  });

  it('fetches live data and writes it to cache when there is no cache', async () => {
    const storage = createStorage();
    const calls = [];
    const lineMeta = [
      { id: 'victoria', name: 'Victoria', modeName: 'tube' },
      { id: 'elizabeth', name: 'Elizabeth line', modeName: 'elizabeth-line' }
    ];
    const routeSequence = {
      lineStrings: ['[[[-0.1,51.5],[-0.09,51.51]]]'],
      stations: [
        {
          stationId: 'A',
          id: 'A',
          name: 'Alpha',
          lat: 51.5,
          lon: -0.1,
          zone: '1',
          modes: ['tube'],
          lines: [{ id: 'victoria' }]
        }
      ]
    };

    const result = await fetchNetworkData({
      storage,
      now: 5_000,
      fetchImpl: async (url) => {
        calls.push(url);

        if (url.includes('/Line/Mode/tube,elizabeth-line/Route')) {
          return createJsonResponse(lineMeta);
        }

        return createJsonResponse(routeSequence);
      }
    });

    expect(result.source).toBe('live');
    expect(result.lineCount).toBe(2);
    expect(result.stationCount).toBe(1);
    expect(calls).toHaveLength(3);
    expect(result.scene.lineSegments[0].coordinates[0]).toHaveLength(3);
    expect(storage.getItem('subsurface.network.v4')).toContain('"cachedAt":5000');
  });

  it('snaps stations onto the nearest served line geometry', async () => {
    const storage = createStorage();
    const lineMeta = [{ id: 'victoria', name: 'Victoria', modeName: 'tube' }];
    const routeSequence = {
      lineStrings: ['[[[-0.1,51.5],[-0.1,51.52]]]'],
      stations: [
        {
          stationId: 'A',
          id: 'A',
          name: 'Alpha',
          lat: 51.51,
          lon: -0.102,
          zone: '1',
          modes: ['tube'],
          lines: [{ id: 'victoria' }]
        }
      ]
    };

    const result = await fetchNetworkData({
      storage,
      now: 5_000,
      fetchImpl: async (url) => {
        if (url.includes('/Line/Mode/tube,elizabeth-line/Route')) {
          return createJsonResponse(lineMeta);
        }

        return createJsonResponse(routeSequence);
      }
    });

    expect(result.stations.features[0].geometry.coordinates[0]).toBeCloseTo(-0.1, 8);
    expect(result.stations.features[0].geometry.coordinates[1]).toBeCloseTo(51.51, 8);
  });
});
