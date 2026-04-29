import { describe, expect, it } from 'vitest';
import { computeProjection, selectLabelGroups, visibleCoordinateRuns } from './scene.js';

const sceneData = {
  lineSegments: [
    {
      coordinates: [
        [-0.12, 51.5, -20],
        [-0.1, 51.52, 8]
      ]
    }
  ]
};

describe('computeProjection', () => {
  it('applies independent horizontal and vertical scale distortion', () => {
    const baseProject = computeProjection(sceneData, {
      horizontalScale: 1,
      verticalScale: 1
    });
    const distortedProject = computeProjection(sceneData, {
      horizontalScale: 2,
      verticalScale: 3
    });

    const base = baseProject([-0.1, 51.52], 8);
    const distorted = distortedProject([-0.1, 51.52], 8);

    expect(distorted.x).toBeCloseTo(base.x * 2);
    expect(distorted.z).toBeCloseTo(base.z * 2);
    expect(distorted.y).toBeCloseTo(base.y * 3);
  });
});

describe('selectLabelGroups', () => {
  it('selects ordinary stations by importance when space allows', () => {
    const groups = [
      {
        name: 'Alpha',
        importance: 1,
        coordinates: [-0.12, 51.5],
        nodes: [{ elevation: 0 }]
      },
      {
        name: 'Bravo',
        importance: 4,
        coordinates: [-0.08, 51.54],
        nodes: [{ elevation: 0 }]
      }
    ];
    const project = computeProjection(sceneData, {
      horizontalScale: 1,
      verticalScale: 1
    });

    const selected = selectLabelGroups(groups, project, 2);

    expect(selected.map(({ group }) => group.name)).toEqual(['Bravo', 'Alpha']);
  });
});

describe('visibleCoordinateRuns', () => {
  it('omits ordinary line geometry where a shared station-pair section owns the span', () => {
    const segment = {
      lineId: 'hammersmith-city',
      coordinates: [
        [-0.156, 51.522, -8],
        [-0.145, 51.524, -8],
        [-0.134, 51.525, -8],
        [-0.12, 51.526, -8]
      ]
    };
    const sharedSections = [
      {
        lineIds: ['circle', 'hammersmith-city', 'metropolitan'],
        coordinates: [
          [-0.156, 51.522, -8],
          [-0.145, 51.524, -8],
          [-0.134, 51.525, -8]
        ]
      }
    ];
    const project = computeProjection({
      lineSegments: [segment]
    });

    const runs = visibleCoordinateRuns(segment, sharedSections, project);

    expect(runs).toEqual([
      [
        [-0.134, 51.525, -8],
        [-0.12, 51.526, -8]
      ]
    ]);
  });
});
