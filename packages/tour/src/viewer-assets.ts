// Pinned viewer libraries. CDN mode loads them from jsDelivr with Subresource Integrity;
// self-hosted mode (required by privacy: "strict") loads the same files from your own
// static folder: download each `cdn` URL to `<your static dir><basePath>/<path>` (see README,
// "Self-hosting the viewer"). The hashes below were computed from the pinned files; a changed
// file on the CDN fails the integrity check instead of running.

export interface ViewerAsset {
  /** Pinned CDN URL. */
  cdn: string;
  /** Path under the self-hosted basePath. */
  path: string;
  /** SRI hash, when the browser loads the file itself (not when a library injects it). */
  integrity?: string;
}

const JSD = "https://cdn.jsdelivr.net/npm/";
const asset = (pkg: string, file: string, integrity?: string): ViewerAsset => ({
  cdn: `${JSD}${pkg}/${file}`,
  path: `${pkg.replace(/@[^@/]+$/, "")}/${file}`,
  integrity,
});

export const VIEWER_VERSIONS = { psv: "5.15.1", three: "0.185.1", modelViewer: "4.3.1", meshopt: "0.25.0" } as const;

export const VIEWER_ASSETS = {
  three: asset("three@0.185.1", "build/three.module.js", "sha384-Ecdwhw2t8c3nTR0hkEDZbwj+5rkKqzJ376RCQN2x1uofujOCuW/EvGg3BQzE7TS6"),
  /** Imported by three.module.js. */
  threeCore: asset("three@0.185.1", "build/three.core.js", "sha384-tfsIoyn3ACQbjob5Sw0zEGbcRscYZPCUEypq6YYs/TKQlq7Yg9jILDm/oZnfpq3D"),
  psvCore: asset("@photo-sphere-viewer/core@5.15.1", "index.module.js", "sha384-hZQgapgsS+zAk2AwifABW1X8MfLIb43CN5l3MxVMHYiTMy7yHpaEp3AtbbhMpHkO"),
  psvCoreCss: asset("@photo-sphere-viewer/core@5.15.1", "index.css", "sha384-MUDeJzy/kC226Woqun+4AUOuTd2QGFrYMHmm6uvnycL6knrocU41aC9R4GmCBwyn"),
  psvMarkers: asset("@photo-sphere-viewer/markers-plugin@5.15.1", "index.module.js", "sha384-OnJv8ez0h1/26CZEb/PlPn7vImD4uEi4mRSzp8/WUKS5XMmZkbfW3LX/b/qN35Ly"),
  psvMarkersCss: asset("@photo-sphere-viewer/markers-plugin@5.15.1", "index.css", "sha384-e9IDkzq93IfCUB0ypp3Yu7ODYsq12yr6YbV53mQvd6rvwl+R6Ty5Nmt9X7fGsT3P"),
  psvVirtualTour: asset("@photo-sphere-viewer/virtual-tour-plugin@5.15.1", "index.module.js", "sha384-ws+xvpi08AhtmV5xvs83MnPt+6jlpJjJANK48XXR8qL4uVckr/GMoI+DrA9GPZGt"),
  psvVirtualTourCss: asset("@photo-sphere-viewer/virtual-tour-plugin@5.15.1", "index.css", "sha384-7gZQVOzr2zBovxp9uGobzboH3GV+8bzD3rPGx3o8m4flbeXnnsx2p5+8XCjWUTfU"),
  psvCubemap: asset("@photo-sphere-viewer/cubemap-adapter@5.15.1", "index.module.js", "sha384-ZXUux1mTUX1QNYIh+yYLd1e29+xDd/eQnP7/cRnEw9usjab/oDctYrUd5Kciudl2"),
  psvCubemapTiles: asset("@photo-sphere-viewer/cubemap-tiles-adapter@5.15.1", "index.module.js", "sha384-BQd25Dvw6/Y3aF+UaJJa5p+gTUdMDLnMpiaHqmzbgK+gaViPjAP3H8P8vHGT+cRg"),
  psvEquirectTiles: asset("@photo-sphere-viewer/equirectangular-tiles-adapter@5.15.1", "index.module.js", "sha384-HOEmEenl1fK1Lo0/UeSZkbnXTsOOzTLslswjTMZWmg2qa07zjPz1dK30TaAsZ47S"),
  modelViewer: asset("@google/model-viewer@4.3.1", "dist/model-viewer.min.js", "sha384-cprcVQt7wbUl0xngF3PGP6yBB7n4/t+4AoAMG9biiMCGFiWOdzUH10Ie2COTqFNW"),
  /** Loaded by <model-viewer> itself (no SRI possible) for meshopt-compressed models. */
  meshoptDecoder: asset("meshoptimizer@0.25.0", "meshopt_decoder.js"),
} as const satisfies Record<string, ViewerAsset>;

/**
 * Decoders <model-viewer> fetches at runtime for Draco geometry and KTX2 textures (Google's
 * gstatic CDN by default; no SRI). Strict privacy sets their locations to your own copies:
 * vendor the folders below under `<basePath>/decoders/draco/` and `<basePath>/decoders/basis/`.
 */
export const MODEL_DECODERS = {
  draco: { cdn: "https://www.gstatic.com/draco/versioned/decoders/1.5.6/", path: "decoders/draco/" },
  basis: { cdn: "https://www.gstatic.com/basis-universal/versioned/2021-04-15-ba1c3e4/", path: "decoders/basis/" },
} as const;

/** Bare specifiers in the import map → asset. */
export const IMPORT_MAP_ENTRIES: Record<string, keyof typeof VIEWER_ASSETS> = {
  three: "three",
  "@photo-sphere-viewer/core": "psvCore",
  "@photo-sphere-viewer/markers-plugin": "psvMarkers",
  "@photo-sphere-viewer/virtual-tour-plugin": "psvVirtualTour",
  "@photo-sphere-viewer/cubemap-adapter": "psvCubemap",
  "@photo-sphere-viewer/cubemap-tiles-adapter": "psvCubemapTiles",
  "@photo-sphere-viewer/equirectangular-tiles-adapter": "psvEquirectTiles",
};

export const CDN_ORIGINS = ["https://cdn.jsdelivr.net", "https://www.gstatic.com"];
