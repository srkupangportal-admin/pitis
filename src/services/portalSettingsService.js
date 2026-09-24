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
const PITIS_NOTIFICATION_DEFAULTS = Object.freeze({
  noAwardEnabled: true,
  noAwardTime: "09:30",
  noAwardTitle: "A positive start is still waiting",
  noAwardMessage: "A small recognition can brighten a student’s day. Award your first PITIS when you are ready.",
  firstAwardEnabled: true,
  winnerTitle: "First PITIS award today!",
  winnerMessage: "Great start, {teacher}! You made the school's first PITIS award today. Keep the positive momentum going.",
  peerTitle: "Today's PITIS recognition has started",
  peerMessage: "{teacher} made the first PITIS award today. Follow their lead and recognise a student when you can."
});
const PITIS_NOTIFICATION_KEYS = Object.freeze({
  noAwardEnabled: "pitis_notification_no_award_enabled",
  noAwardTime: "pitis_notification_no_award_time",
  noAwardTitle: "pitis_notification_no_award_title",
  noAwardMessage: "pitis_notification_no_award_message",
  firstAwardEnabled: "pitis_notification_first_award_enabled",
  winnerTitle: "pitis_notification_winner_title",
  winnerMessage: "pitis_notification_winner_message",
  peerTitle: "pitis_notification_peer_title",
  peerMessage: "pitis_notification_peer_message"
});

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

function normalizeBoolean(value, fallback = true) {
  if (typeof value === "boolean") return value;
  if (["1", "true", "on", "yes"].includes(String(value || "").trim().toLowerCase())) return true;
  if (["0", "false", "off", "no"].includes(String(value || "").trim().toLowerCase())) return false;
  return fallback;
}

function normalizeTime(value) {
  const time = String(value || "").trim();
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : PITIS_NOTIFICATION_DEFAULTS.noAwardTime;
}

function normalizeMessage(value, fallback, maxLength) {
  const text = String(value || "").trim();
  return (text || fallback).slice(0, maxLength);
}

function getPitisNotificationAutomationSettings() {
  const values = {};
  for (const [field, key] of Object.entries(PITIS_NOTIFICATION_KEYS)) values[field] = getAppSetting(key, PITIS_NOTIFICATION_DEFAULTS[field]);
  return {
    schoolDaysOnly: true,
    noAwardEnabled: normalizeBoolean(values.noAwardEnabled, PITIS_NOTIFICATION_DEFAULTS.noAwardEnabled),
    noAwardTime: normalizeTime(values.noAwardTime),
    noAwardTitle: normalizeMessage(values.noAwardTitle, PITIS_NOTIFICATION_DEFAULTS.noAwardTitle, 160),
    noAwardMessage: normalizeMessage(values.noAwardMessage, PITIS_NOTIFICATION_DEFAULTS.noAwardMessage, 500),
    firstAwardEnabled: normalizeBoolean(values.firstAwardEnabled, PITIS_NOTIFICATION_DEFAULTS.firstAwardEnabled),
    winnerTitle: normalizeMessage(values.winnerTitle, PITIS_NOTIFICATION_DEFAULTS.winnerTitle, 160),
    winnerMessage: normalizeMessage(values.winnerMessage, PITIS_NOTIFICATION_DEFAULTS.winnerMessage, 500),
    peerTitle: normalizeMessage(values.peerTitle, PITIS_NOTIFICATION_DEFAULTS.peerTitle, 160),
    peerMessage: normalizeMessage(values.peerMessage, PITIS_NOTIFICATION_DEFAULTS.peerMessage, 500)
  };
}

function setPitisNotificationAutomationSettings(input, updatedBy = null) {
  const settings = {
    noAwardEnabled: normalizeBoolean(input.noAwardEnabled, false),
    noAwardTime: normalizeTime(input.noAwardTime),
    noAwardTitle: normalizeMessage(input.noAwardTitle, PITIS_NOTIFICATION_DEFAULTS.noAwardTitle, 160),
    noAwardMessage: normalizeMessage(input.noAwardMessage, PITIS_NOTIFICATION_DEFAULTS.noAwardMessage, 500),
    firstAwardEnabled: normalizeBoolean(input.firstAwardEnabled, false),
    winnerTitle: normalizeMessage(input.winnerTitle, PITIS_NOTIFICATION_DEFAULTS.winnerTitle, 160),
    winnerMessage: normalizeMessage(input.winnerMessage, PITIS_NOTIFICATION_DEFAULTS.winnerMessage, 500),
    peerTitle: normalizeMessage(input.peerTitle, PITIS_NOTIFICATION_DEFAULTS.peerTitle, 160),
    peerMessage: normalizeMessage(input.peerMessage, PITIS_NOTIFICATION_DEFAULTS.peerMessage, 500)
  };
  for (const [field, key] of Object.entries(PITIS_NOTIFICATION_KEYS)) setAppSetting(key, typeof settings[field] === "boolean" ? (settings[field] ? "1" : "0") : settings[field], updatedBy);
  return { schoolDaysOnly: true, ...settings };
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
  PITIS_NOTIFICATION_DEFAULTS,
  getLeaderboardSlideshowMode,
  getLeaderboardSlideshowDurationMs,
  getLeaderboardSlideshowStudentCount,
  getPitisNotificationAutomationSettings,
  setLeaderboardSlideshowMode,
  setLeaderboardSlideshowDurationSeconds,
  setLeaderboardSlideshowStudentCount,
  setPitisNotificationAutomationSettings
};
