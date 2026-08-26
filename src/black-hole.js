export { BLACK_HOLE_ASSET_PATH } from "./routes.js";

import { BLACK_HOLE_ASSET_PATH } from "./routes.js";

export const BLACK_HOLE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

// Depth-to-intensity curve. Keep in sync with intensityFromDepth in
// public/black-hole.v1.js (the browser asset is dependency-free and cannot import this).
export function blackHoleIntensity(depth) {
  return Number(Math.min(1, 0.2 + Math.max(0, depth) * 0.2).toFixed(2));
}

export function renderBlackHoleCanvas() {
  return '<canvas class="black-hole-canvas" data-black-hole-canvas aria-hidden="true"></canvas>';
}

export function renderBlackHoleScript() {
  return `<script defer src="${BLACK_HOLE_ASSET_PATH}"></script>`;
}
