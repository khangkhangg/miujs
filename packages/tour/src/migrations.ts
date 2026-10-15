import type { Migration } from "@miujs/db";

/**
 * Tables for @miujs/tour. Applied automatically on first use; you can also add them to
 * `db({ migrations: [...yours, ...tourMigrations] })` or your migration files. All tables
 * start with `miu_tour`. SQLite / D1 dialect.
 */
export const tourMigrations: Migration[] = [
  {
    id: "miu_tour_001_init",
    sql: `
CREATE TABLE miu_tours (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'unlisted', 'private')),
  org_id TEXT,
  privacy TEXT NOT NULL DEFAULT 'standard' CHECK (privacy IN ('standard', 'strict')),
  watermark TEXT,
  allowed_embed_origins TEXT NOT NULL DEFAULT '[]',
  start_scene_id TEXT,
  password_hash TEXT,
  password_version INTEGER NOT NULL DEFAULT 0,
  share_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX miu_tours_org ON miu_tours (org_id);

CREATE TABLE miu_tour_scenes (
  id TEXT PRIMARY KEY,
  tour_id TEXT NOT NULL REFERENCES miu_tours (id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('pano360', 'model3d', 'image')),
  asset_id TEXT,
  yaw REAL NOT NULL DEFAULT 0,
  pitch REAL NOT NULL DEFAULT 0,
  fov REAL NOT NULL DEFAULT 75,
  floor INTEGER,
  position INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX miu_tour_scenes_tour ON miu_tour_scenes (tour_id, position);

CREATE TABLE miu_tour_hotspots (
  id TEXT PRIMARY KEY,
  tour_id TEXT NOT NULL REFERENCES miu_tours (id) ON DELETE CASCADE,
  scene_id TEXT NOT NULL REFERENCES miu_tour_scenes (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('link', 'info', 'media', 'url')),
  yaw REAL,
  pitch REAL,
  x REAL,
  y REAL,
  z REAL,
  target_scene_id TEXT REFERENCES miu_tour_scenes (id) ON DELETE CASCADE,
  title TEXT,
  body TEXT,
  media_key TEXT,
  url TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX miu_tour_hotspots_tour ON miu_tour_hotspots (tour_id);

CREATE TABLE miu_tour_floorplans (
  id TEXT PRIMARY KEY,
  tour_id TEXT NOT NULL REFERENCES miu_tours (id) ON DELETE CASCADE,
  floor INTEGER NOT NULL,
  title TEXT,
  image_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (tour_id, floor)
);

CREATE TABLE miu_tour_floorplan_markers (
  floorplan_id TEXT NOT NULL REFERENCES miu_tour_floorplans (id) ON DELETE CASCADE,
  scene_id TEXT NOT NULL REFERENCES miu_tour_scenes (id) ON DELETE CASCADE,
  x REAL NOT NULL,
  y REAL NOT NULL,
  PRIMARY KEY (floorplan_id, scene_id)
);

CREATE TABLE miu_tour_assets (
  id TEXT PRIMARY KEY,
  tour_id TEXT NOT NULL REFERENCES miu_tours (id) ON DELETE CASCADE,
  scene_id TEXT REFERENCES miu_tour_scenes (id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('pano', 'model', 'image')),
  source_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'ready', 'failed')),
  progress REAL NOT NULL DEFAULT 0,
  error TEXT,
  output TEXT,
  processor TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX miu_tour_assets_tour ON miu_tour_assets (tour_id);

CREATE TABLE miu_tour_events (
  tour_id TEXT NOT NULL REFERENCES miu_tours (id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('view', 'scene', 'hotspot')),
  scene_id TEXT,
  hotspot_id TEXT,
  dwell_ms INTEGER,
  ip_prefix TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX miu_tour_events_day ON miu_tour_events (tour_id, day);

CREATE TABLE miu_tour_daily (
  tour_id TEXT NOT NULL REFERENCES miu_tours (id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  views INTEGER NOT NULL,
  sessions INTEGER NOT NULL,
  PRIMARY KEY (tour_id, day)
);

CREATE TABLE miu_tour_daily_scenes (
  tour_id TEXT NOT NULL REFERENCES miu_tours (id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  scene_id TEXT NOT NULL,
  views INTEGER NOT NULL,
  dwell_ms_total INTEGER NOT NULL,
  dwell_count INTEGER NOT NULL,
  PRIMARY KEY (tour_id, day, scene_id)
);

CREATE TABLE miu_tour_daily_hotspots (
  tour_id TEXT NOT NULL REFERENCES miu_tours (id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  hotspot_id TEXT NOT NULL,
  clicks INTEGER NOT NULL,
  PRIMARY KEY (tour_id, day, hotspot_id)
);
`,
  },
];
