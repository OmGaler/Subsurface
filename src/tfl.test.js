import { describe, expect, it } from 'vitest';
import { fetchNetworkData, getStationDepthRecord, normaliseRouteSequence } from './tfl.js';

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

  it('uses the TfL id when stationId is blank', () => {
    const lineMeta = {
      id: 'piccadilly',
      name: 'Piccadilly',
      modeName: 'tube'
    };
    const routeSequence = {
      lineStrings: ['[[[-0.454037,51.471618],[-0.446419,51.458837],[-0.489556,51.471569]]]'],
      stations: [
        {
          stationId: '',
          id: 'HUBH13',
          name: 'Heathrow Terminals 2 & 3',
          lat: 51.471618,
          lon: -0.454037,
          zone: '6',
          modes: ['tube'],
          lines: [{ id: 'piccadilly' }]
        },
        {
          stationId: '',
          id: 'HUBHX4',
          name: 'Heathrow Airport Terminal 4',
          lat: 51.458837,
          lon: -0.446419,
          zone: '6',
          modes: ['tube'],
          lines: [{ id: 'piccadilly' }]
        }
      ]
    };

    const result = normaliseRouteSequence(lineMeta, routeSequence);

    expect(result.stationFeatures.map((feature) => feature.properties.stationId)).toEqual([
      'HUBH13',
      'HUBHX4'
    ]);
  });

  it('deduplicates route geometries that TfL supplies in both directions', () => {
    const lineMeta = {
      id: 'piccadilly',
      name: 'Piccadilly',
      modeName: 'tube'
    };
    const routeSequence = {
      lineStrings: [
        '[[[-0.314719,51.499319],[-0.452265,51.471235],[-0.49056,51.470052]]]',
        '[[[-0.49056,51.470052],[-0.452265,51.471235],[-0.314719,51.499319]]]'
      ],
      stations: []
    };

    const result = normaliseRouteSequence(lineMeta, routeSequence);

    expect(result.lineFeatures).toHaveLength(1);
    expect(result.lineFeatures[0].geometry.coordinates).toEqual([
      [-0.314719, 51.499319],
      [-0.452265, 51.471235],
      [-0.49056, 51.470052]
    ]);
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
  it('fetches live data without browser storage', async () => {
    const calls = [];
    const lineMeta = [
      { id: 'bakerloo', name: 'Bakerloo', modeName: 'tube' },
      { id: 'elizabeth', name: 'Elizabeth line', modeName: 'elizabeth-line' }
    ];
    const routeSequence = {
      lineStrings: ['[[[-0.1,51.5],[-0.09,51.51]]]'],
      stations: [
        {
          stationId: 'A',
          id: 'A',
          name: 'Waterloo Underground Station',
          lat: 51.5,
          lon: -0.1,
          zone: '1',
          modes: ['tube'],
          lines: [{ id: 'bakerloo' }]
        }
      ]
    };

    const result = await fetchNetworkData({
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
  });

  it('snaps stations onto the nearest served line geometry', async () => {
    const lineMeta = [{ id: 'bakerloo', name: 'Bakerloo', modeName: 'tube' }];
    const routeSequence = {
      lineStrings: ['[[[-0.1,51.5],[-0.1,51.52]]]'],
      stations: [
        {
          stationId: 'A',
          id: 'A',
          name: 'Waterloo Underground Station',
          lat: 51.51,
          lon: -0.102,
          zone: '1',
          modes: ['tube'],
          lines: [{ id: 'bakerloo' }]
        }
      ]
    };

    const result = await fetchNetworkData({
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

describe('station depth data', () => {
  it('uses station depth data for Waterloo line ordering', () => {
    const bakerloo = getStationDepthRecord('Waterloo', 'bakerloo');
    const jubilee = getStationDepthRecord('Waterloo', 'jubilee');
    const northern = getStationDepthRecord('Waterloo', 'northern');
    const waterlooCity = getStationDepthRecord('Waterloo', 'waterloo-city');

    expect(waterlooCity.platformHeightMetres).toBeCloseTo(-1.8, 1);
    expect(waterlooCity.platformHeightMetres).toBeGreaterThan(bakerloo.platformHeightMetres);
    expect(waterlooCity.platformHeightMetres).toBeGreaterThan(northern.platformHeightMetres);
    expect(waterlooCity.platformHeightMetres).toBeGreaterThan(jubilee.platformHeightMetres);
  });

  it('uses explicit Circle platform rows from the station depth data', () => {
    const circle = getStationDepthRecord('Baker Street', 'circle');
    const hammersmithCity = getStationDepthRecord('Baker Street', 'hammersmith-city');

    expect(circle.platformHeightMetres).toBeCloseTo(hammersmithCity.platformHeightMetres, 8);
    expect(circle.source).toBe('station-depths.csv');
  });

  it('uses explicit Hammersmith & City eastern platform rows from the station depth data', () => {
    const district = getStationDepthRecord('East Ham', 'district');
    const hammersmithCity = getStationDepthRecord('East Ham', 'hammersmith-city');

    expect(hammersmithCity.platformHeightMetres).toBeCloseTo(district.platformHeightMetres, 8);
    expect(hammersmithCity.source).toBe('station-depths.csv');
  });

  it('uses explicit Elizabeth line core platform rows where available', () => {
    const bondStreet = getStationDepthRecord('Bond Street', 'elizabeth');

    expect(bondStreet.platformHeightMetres).toBeCloseTo(-28, 8);
    expect(bondStreet.depthBelowGroundMetres).toBeCloseTo(50, 8);
    expect(bondStreet.source).toBe('station-depths.csv');
  });

  it('uses explicit Elizabeth line Heathrow platform rows where available', () => {
    const piccadilly = getStationDepthRecord('Heathrow Terminal 5', 'piccadilly');
    const elizabeth = getStationDepthRecord('Heathrow Terminal 5', 'elizabeth');

    expect(piccadilly.platformHeightMetres).toBeCloseTo(10.3, 8);
    expect(elizabeth.platformHeightMetres).toBeCloseTo(-10, 8);
    expect(elizabeth.source).toBe('station-depths.csv');
  });

  it('matches TfL Heathrow Terminals 2 & 3 naming to the depth row', () => {
    const piccadilly = getStationDepthRecord('Heathrow Terminals 2 & 3', 'piccadilly');
    const compactPiccadilly = getStationDepthRecord('Heathrow Terminals 2&3', 'piccadilly');
    const elizabeth = getStationDepthRecord('Heathrow Terminals 2 & 3', 'elizabeth');

    expect(piccadilly.platformHeightMetres).toBeCloseTo(9.6, 8);
    expect(compactPiccadilly.platformHeightMetres).toBeCloseTo(9.6, 8);
    expect(elizabeth.platformHeightMetres).toBeCloseTo(-10, 8);
    expect(elizabeth.source).toBe('station-depths.csv');
  });

  it('matches TfL Heathrow Airport Terminal names to the depth rows', () => {
    const terminal4 = getStationDepthRecord('Heathrow Airport Terminal 4', 'piccadilly');
    const terminal5 = getStationDepthRecord('Heathrow Airport Terminal 5', 'piccadilly');

    expect(terminal4.platformHeightMetres).toBeCloseTo(12.9, 8);
    expect(terminal5.platformHeightMetres).toBeCloseTo(10.3, 8);
  });

  it('uses surface-level fallback for Elizabeth line stations without depth data', () => {
    const reading = getStationDepthRecord('Reading', 'elizabeth');

    expect(reading.platformHeightMetres).toBe(0);
    expect(reading.depthBelowGroundMetres).toBe(0);
    expect(reading.source).toContain('surface-level fallback');
  });

  it('marks shared track by consecutive station pairs rather than exact route vertices', async () => {
    const lineMeta = [
      { id: 'circle', name: 'Circle', modeName: 'tube' },
      { id: 'hammersmith-city', name: 'Hammersmith & City', modeName: 'tube' }
    ];
    const routeSequence = {
      lineStrings: ['[[[-0.156,51.522],[-0.145,51.524],[-0.134,51.525]]]'],
      stations: [
        {
          stationId: '940GZZLUBST',
          id: '940GZZLUBST',
          name: 'Baker Street Underground Station',
          lat: 51.522,
          lon: -0.156,
          zone: '1',
          modes: ['tube'],
          lines: [{ id: 'circle' }, { id: 'hammersmith-city' }]
        },
        {
          stationId: '940GZZLUESQ',
          id: '940GZZLUESQ',
          name: 'Euston Square Underground Station',
          lat: 51.525,
          lon: -0.134,
          zone: '1',
          modes: ['tube'],
          lines: [{ id: 'circle' }, { id: 'hammersmith-city' }]
        }
      ]
    };

    const result = await fetchNetworkData({
      now: 5_000,
      fetchImpl: async (url) => {
        if (url.includes('/Line/Mode/tube,elizabeth-line/Route')) {
          return createJsonResponse(lineMeta);
        }

        return createJsonResponse(routeSequence);
      }
    });

    expect(result.scene.sharedTrackSections).toHaveLength(1);
    expect(result.scene.sharedTrackSections[0].lineIds).toEqual(['circle', 'hammersmith-city']);
    expect(result.scene.sharedTrackSections[0].coordinates).toHaveLength(3);
    expect(result.scene.sharedTrackSections[0].coordinates[1][0]).toBeCloseTo(-0.145, 8);
    expect(result.scene.sharedTrackSections[0].coordinates[1][1]).toBeCloseTo(51.524, 8);
  });

  it('groups all co-running lines for the same consecutive station pair', async () => {
    const lineMeta = [
      { id: 'circle', name: 'Circle', modeName: 'tube' },
      { id: 'hammersmith-city', name: 'Hammersmith & City', modeName: 'tube' },
      { id: 'metropolitan', name: 'Metropolitan', modeName: 'tube' }
    ];
    const stations = [
      {
        stationId: '940GZZLUBST',
        id: '940GZZLUBST',
        name: 'Baker Street Underground Station',
        lat: 51.522,
        lon: -0.156,
        zone: '1',
        modes: ['tube'],
        lines: lineMeta.map(({ id }) => ({ id }))
      },
      {
        stationId: '940GZZLUESQ',
        id: '940GZZLUESQ',
        name: 'Euston Square Underground Station',
        lat: 51.525,
        lon: -0.134,
        zone: '1',
        modes: ['tube'],
        lines: lineMeta.map(({ id }) => ({ id }))
      }
    ];

    const result = await fetchNetworkData({
      now: 5_000,
      fetchImpl: async (url) => {
        if (url.includes('/Line/Mode/tube,elizabeth-line/Route')) {
          return createJsonResponse(lineMeta);
        }

        const hasHammersmithCity = url.includes('/Line/hammersmith-city/');
        const lineStrings = hasHammersmithCity
          ? ['[[[-0.156,51.522],[-0.148,51.524],[-0.134,51.525]]]']
          : ['[[[-0.156,51.522],[-0.145,51.524],[-0.134,51.525]]]'];

        return createJsonResponse({ lineStrings, stations });
      }
    });

    expect(result.scene.sharedTrackSections).toHaveLength(1);
    expect(result.scene.sharedTrackSections[0].lineIds).toEqual([
      'circle',
      'hammersmith-city',
      'metropolitan'
    ]);
  });

  it('does not mark lines at different platform levels as shared just because station pairs match', async () => {
    const lineMeta = [
      { id: 'district', name: 'District', modeName: 'tube' },
      { id: 'piccadilly', name: 'Piccadilly', modeName: 'tube' }
    ];
    const stations = [
      {
        stationId: '940GZZLUSKS',
        id: '940GZZLUSKS',
        name: 'South Kensington Underground Station',
        lat: 51.4941,
        lon: -0.1738,
        zone: '1',
        modes: ['tube'],
        lines: lineMeta.map(({ id }) => ({ id }))
      },
      {
        stationId: '940GZZLUGTR',
        id: '940GZZLUGTR',
        name: 'Gloucester Road Underground Station',
        lat: 51.4945,
        lon: -0.1829,
        zone: '1',
        modes: ['tube'],
        lines: lineMeta.map(({ id }) => ({ id }))
      }
    ];

    const result = await fetchNetworkData({
      now: 5_000,
      fetchImpl: async (url) => {
        if (url.includes('/Line/Mode/tube,elizabeth-line/Route')) {
          return createJsonResponse(lineMeta);
        }

        return createJsonResponse({
          lineStrings: ['[[[-0.1738,51.4941],[-0.178,51.4943],[-0.1829,51.4945]]]'],
          stations
        });
      }
    });

    expect(result.scene.sharedTrackSections).toHaveLength(0);
  });

  it('does not treat Elizabeth line Heathrow stations as shared Piccadilly track', async () => {
    const lineMeta = [
      { id: 'elizabeth', name: 'Elizabeth line', modeName: 'elizabeth-line' },
      { id: 'piccadilly', name: 'Piccadilly', modeName: 'tube' }
    ];
    const stations = [
      {
        stationId: '910GHTRWTM5',
        id: '910GHTRWTM5',
        name: 'Heathrow Terminal 5 Rail Station',
        lat: 51.4723,
        lon: -0.4877,
        zone: '6',
        modes: ['tube', 'elizabeth-line'],
        lines: lineMeta.map(({ id }) => ({ id }))
      },
      {
        stationId: '940GZZLUHRC',
        id: '940GZZLUHRC',
        name: 'Heathrow Terminals 2 & 3 Underground Station',
        lat: 51.4713,
        lon: -0.4524,
        zone: '6',
        modes: ['tube', 'elizabeth-line'],
        lines: lineMeta.map(({ id }) => ({ id }))
      }
    ];

    const result = await fetchNetworkData({
      now: 5_000,
      fetchImpl: async (url) => {
        if (url.includes('/Line/Mode/tube,elizabeth-line/Route')) {
          return createJsonResponse(lineMeta);
        }

        return createJsonResponse({
          lineStrings: ['[[[-0.4877,51.4723],[-0.4524,51.4713]]]'],
          stations
        });
      }
    });

    expect(result.scene.stationNodes.some((node) =>
      node.lineId === 'piccadilly' && node.name === 'Heathrow Terminals 2 & 3'
    )).toBe(true);
    expect(result.scene.sharedTrackSections).toHaveLength(0);
  });

  it('builds separate Piccadilly station nodes for blank-id Heathrow hubs', async () => {
    const lineMeta = [{ id: 'piccadilly', name: 'Piccadilly', modeName: 'tube' }];
    const routeSequence = {
      lineStrings: [
        '[[[-0.423191,51.466747],[-0.452265,51.471235],[-0.49056,51.470052]]]',
        '[[[-0.423191,51.466747],[-0.452265,51.471235],[-0.445771,51.458524]]]'
      ],
      stations: [
        {
          stationId: '',
          id: 'HUBH13',
          name: 'Heathrow Terminals 2 & 3',
          lat: 51.471618,
          lon: -0.454037,
          zone: '6',
          modes: ['tube'],
          lines: [{ id: 'piccadilly' }]
        },
        {
          stationId: '',
          id: 'HUBHX4',
          name: 'Heathrow Airport Terminal 4',
          lat: 51.458837,
          lon: -0.446419,
          zone: '6',
          modes: ['tube'],
          lines: [{ id: 'piccadilly' }]
        },
        {
          stationId: '',
          id: 'HUBHX5',
          name: 'Heathrow Airport Terminal 5',
          lat: 51.471569,
          lon: -0.489556,
          zone: '6',
          modes: ['tube'],
          lines: [{ id: 'piccadilly' }]
        }
      ]
    };

    const result = await fetchNetworkData({
      fetchImpl: async (url) => {
        if (url.includes('/Line/Mode/tube,elizabeth-line/Route')) {
          return createJsonResponse(lineMeta);
        }

        return createJsonResponse(routeSequence);
      }
    });

    const heathrowNodes = result.scene.stationNodes
      .filter((node) => node.lineId === 'piccadilly' && node.name.includes('Heathrow'))
      .sort((left, right) => left.stationId.localeCompare(right.stationId));

    expect(heathrowNodes.map((node) => node.stationId)).toEqual([
      'heathrow:heathrow airport terminal 1, 2 & 3',
      'heathrow:heathrow terminal 4',
      'heathrow:heathrow terminal 5'
    ]);
    expect(heathrowNodes.map((node) => node.sourceStationId)).toEqual(['HUBH13', 'HUBHX4', 'HUBHX5']);
    expect(heathrowNodes.map((node) => node.depthSource)).toEqual([
      'station-depths.csv',
      'station-depths.csv',
      'station-depths.csv'
    ]);

    const terminal4Branch = result.scene.lineSegments.find((segment) =>
      segment.coordinates.some(([lon, lat]) => lon === -0.445771 && lat === 51.458524)
    );
    const terminal5Branch = result.scene.lineSegments.find((segment) =>
      segment.coordinates.some(([lon, lat]) => lon === -0.49056 && lat === 51.470052)
    );

    expect(terminal4Branch.coordinates.at(-1)[2]).toBeCloseTo(12.9, 8);
    expect(terminal5Branch.coordinates.at(-1)[2]).toBeCloseTo(10.3, 8);
  });
});
