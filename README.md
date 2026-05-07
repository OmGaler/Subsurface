# Subsurface

Subsurface is a lightweight interactive 3D map of the London Underground and Elizabeth line. It uses TfL route geometry for the network layout, local station-depth data for vertical placement, and Three.js to render a depth-distorted model that can be explored by line or as a full network.

## Features

- A 3D view of the Tube and Elizabeth line network, with orbit controls.
- Line focus for inspecting one line at a time.
- Horizontal and vertical distortion controls, because geographic truth is not always legible (Harry Beck).
- Keyboard navigation: Shift + arrow keys to pan, +/- to zoom.
- Station labels and hover details for stations and lines.
- Shared-track sections shown as striped route spans.
- Browser caching, plus support for a static `network-cache.json` snapshot when deployed.

## Tech Stack

- Vite
- Three.js
- Vitest
- TfL Unified API

## Getting Started

Install the dependencies:

```sh
npm install
```

Start the development server:

```sh
npm run dev
```

Run the tests:

```sh
npm test
```

Build it for production:

```sh
npm run build
```

Preview the production build locally:

```sh
npm run preview
```

## TfL API Credentials

The app can request live TfL data without credentials, but TfL credentials are recommended. If you have them, add a local `.env` file:

```sh
TFL_APP_ID=your_app_id
TFL_APP_KEY=your_app_key
```

Vite injects these values at build time. Do not commit `.env`.

## Data

The network geometry is loaded from the TfL Unified API. Station depth and ground-level values are loaded from [`data/station-depths.csv`](data/station-depths.csv).

The depth data is mostly from an older Freedom of Information response, with some local normalisation so station names and lines match the TfL API and the reality on, or more precisely under, the ground. It should be treated as an approximate model for visual exploration, not as anything resembling survey-grade accuracy. Because Elizabeth line depth data is missing outside the core, the rest of that line is assumed to be at surface level.

For a more resilient public deployment, publish a static `public/network-cache.json` file in the same shape as `fetchNetworkData()` returns. The app checks that snapshot before making live TfL requests, then falls back to browser cache if live data is unavailable.

## Optional Data Export

There is also a helper script for downloading TfL line geometries for GIS review:

```sh
npm run download:geometries
```

It writes WGS84 and British National Grid GeoJSON files into `data/`.

## Publication Checklist

- Run `npm test` and `npm run build`.
- Add a `public/network-cache.json` snapshot if the hosted version should not depend on live TfL calls.
- Add fuller source notes for `station-depths.csv` if the FOI response can be cited publicly.
- Add a screenshot or short demo GIF once there is a public URL worth pointing at.

## Licence

This project is released under the [MIT Licence](LICENCE.md).
