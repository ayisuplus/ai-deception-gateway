export const EVENT_HORIZON_PREFIX = "/__event-horizon";

export const LAB_HOME_PATH = `${EVENT_HORIZON_PREFIX}/`;
export const HEALTH_PATH = `${EVENT_HORIZON_PREFIX}/health`;
export const ADMIN_PATH = `${EVENT_HORIZON_PREFIX}/admin`;
export const ADMIN_API_PREFIX = `${ADMIN_PATH}/api`;
export const TRAP_PREFIX = `${EVENT_HORIZON_PREFIX}/trap/`;
export const ARCHIVE_PREFIX = `${EVENT_HORIZON_PREFIX}/archive/`;
export const BLACK_HOLE_ASSET_PATH = `${EVENT_HORIZON_PREFIX}/assets/black-hole.v1.js`;

export const LEGACY_ROUTES = Object.freeze({
  home: "/",
  health: "/health",
  admin: "/admin",
  adminApiPrefix: "/admin/api",
  trapPrefix: "/__aidg/trap/",
  archivePrefix: "/__aidg/archive/",
  blackHoleAsset: "/assets/black-hole.v1.js",
});
