const dayjs = require("dayjs");
const { db } = require("../db/init");

const LEADERBOARD_SLIDESHOW_DURATION_KEY = "leaderboard_slideshow_duration_ms";
const LEADERBOARD_SLIDESHOW_MODE_KEY = "leaderboard_slideshow_mode";
const LEADERBOARD_SLIDESHOW_STUDENT_COUNT_KEY = "leaderboard_slideshow_student_count";
const DEFAULT_LEADERBOARD_SLIDESHOW_DURATION_MS = 4000;
const DEFAULT_LEADERBOARD_SLIDESHOW_MODE = "points";
const DEFAULT_LEADERBOARD_SLIDESHOW_STUDENT_COUNT = 8;
const MIN_LEADERBOARD_SLIDESHOW_DURATION_MS = 1500;
const MAX_LEADERBOARD_SLIDESHOW_DURATION_MS = 30000;
const MIN_LEADERBOARD_SLIDESHOW_STUDENT_COUNT = 1;
const MAX_LEADERBOARD_SLIDESHOW_STUDENT_COUNT = 12;
const LEADERBOARD_SLIDESHOW_MODES = new Set(["points", "class"]);

function clampDurationMs(value) {
  const duration = Number.parseInt(String(value || "").trim(), 10);
  if (!Number.isInteger(duration)) return DEFAULT_LEADERBOARD_SLIDESHOW_DURATION_MS;
  return Math.min(MAX_LEADERBOARD_SLIDESHOW_DURATION_MS, Math.max(MIN_LEADERBOARD_SLIDESHOW_DURATION_MS, duration));
}

function clampStudentCount(value) {
  const count = Number.parseInt(String(value || "").trim(), 10);
  if (!Number.isInteger(count)) return DEFAULT_LEADERBOARD_SLIDESHOW_STUDENT_COUNT;
  return Math.min(MAX_LEADERBOARD_SLIDESHOW_STUDENT_COUNT, Math.max(MIN_LEADERBOARD_SLIDESHOW_STUDENT_COUNT, count));
}

function getAppSetting(key, fallbackValue) {
  const row = db.prepare("SELECT setting_value FROM app_settings WHERE setting_key = ?").get(key);
  return row ? row.setting_value : fallbackValue;
}

function setAppSetting(key, value, updatedBy = null) {
  const now = dayjs().toISOString();
  db.prepare(`
    INSERT INTO app_settings (setting_key, setting_value, updated_at, updated_by)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(setting_key) DO UPDATE SET
      setting_value = excluded.setting_value,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by
  `).run(key, String(value), now, updatedBy ? Number(updatedBy) : null);
}

function getLeaderboardSlideshowDurationMs() {
  return clampDurationMs(getAppSetting(LEADERBOARD_SLIDESHOW_DURATION_KEY, DEFAULT_LEADERBOARD_SLIDESHOW_DURATION_MS));
}

function setLeaderboardSlideshowDurationSeconds(seconds, updatedBy = null) {
  const rawSeconds = Number.parseFloat(String(seconds || "").trim());
  const durationMs = clampDurationMs(Math.round(rawSeconds * 1000));
  setAppSetting(LEADERBOARD_SLIDESHOW_DURATION_KEY, durationMs, updatedBy);
  return durationMs;
}

function normalizeLeaderboardSlideshowMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  return LEADERBOARD_SLIDESHOW_MODES.has(mode) ? mode : DEFAULT_LEADERBOARD_SLIDESHOW_MODE;
}

function getLeaderboardSlideshowMode() {
  return normalizeLeaderboardSlideshowMode(getAppSetting(LEADERBOARD_SLIDESHOW_MODE_KEY, DEFAULT_LEADERBOARD_SLIDESHOW_MODE));
}

function setLeaderboardSlideshowMode(mode, updatedBy = null) {
  const normalizedMode = normalizeLeaderboardSlideshowMode(mode);
  setAppSetting(LEADERBOARD_SLIDESHOW_MODE_KEY, normalizedMode, updatedBy);
  return normalizedMode;
}

function getLeaderboardSlideshowStudentCount() {
  return clampStudentCount(getAppSetting(LEADERBOARD_SLIDESHOW_STUDENT_COUNT_KEY, DEFAULT_LEADERBOARD_SLIDESHOW_STUDENT_COUNT));
}

function setLeaderboardSlideshowStudentCount(count, updatedBy = null) {
  const normalizedCount = clampStudentCount(count);
  setAppSetting(LEADERBOARD_SLIDESHOW_STUDENT_COUNT_KEY, normalizedCount, updatedBy);
  return normalizedCount;
}

module.exports = {
  DEFAULT_LEADERBOARD_SLIDESHOW_DURATION_MS,
  DEFAULT_LEADERBOARD_SLIDESHOW_MODE,
  DEFAULT_LEADERBOARD_SLIDESHOW_STUDENT_COUNT,
  MAX_LEADERBOARD_SLIDESHOW_DURATION_MS,
  MAX_LEADERBOARD_SLIDESHOW_STUDENT_COUNT,
  MIN_LEADERBOARD_SLIDESHOW_DURATION_MS,
  MIN_LEADERBOARD_SLIDESHOW_STUDENT_COUNT,
  getLeaderboardSlideshowMode,
  getLeaderboardSlideshowDurationMs,
  getLeaderboardSlideshowStudentCount,
  setLeaderboardSlideshowMode,
  setLeaderboardSlideshowDurationSeconds,
  setLeaderboardSlideshowStudentCount
};
