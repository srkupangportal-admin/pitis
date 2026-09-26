const dayjs = require("dayjs");

function getSingaporeNow() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return dayjs(`${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}`);
}

function getWeeklyPitisWindow(value) {
  const today = value == null ? getSingaporeNow() : dayjs(value);
  const dayOfWeek = today.day();
  const weekStart = dayOfWeek === 0
    ? today.subtract(6, "day").startOf("day")
    : today.subtract(dayOfWeek - 1, "day").startOf("day");
  const weekEnd = weekStart.add(5, "day").endOf("day");
  const isOpen = dayOfWeek >= 1 && dayOfWeek <= 6;

  return {
    isOpen,
    todayDate: today.format("YYYY-MM-DD"),
    weekStart: weekStart.format("YYYY-MM-DD"),
    weekEnd: weekEnd.format("YYYY-MM-DD"),
    latestAwardDate: today.isAfter(weekEnd, "day") ? weekEnd.format("YYYY-MM-DD") : today.format("YYYY-MM-DD"),
    label: `${weekStart.format("D MMM")}–${weekEnd.format("D MMM YYYY")}`,
    closesLabel: weekEnd.format("dddd, D MMMM [at] [11:59 pm]"),
    nextOpenDate: isOpen ? null : today.add(1, "day").format("YYYY-MM-DD")
  };
}

function validateWeeklyPitisRequest({ mode, action, awardDate }) {
  if (mode !== "weekly") return { mode: "standard", weekly: null };

  const weekly = getWeeklyPitisWindow();
  if (!weekly.isOpen) {
    return { error: "Weekly PITIS is closed on Sunday. A new week opens on Monday." };
  }
  if (action !== "award") {
    return { error: "Weekly PITIS supports awards only. Use the standard form for deductions." };
  }
  const normalizedDate = dayjs(awardDate || weekly.todayDate).format("YYYY-MM-DD");
  const requestedDate = String(awardDate || weekly.todayDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate) || !dayjs(normalizedDate).isValid() || normalizedDate !== requestedDate) {
    return { error: "Choose a valid weekly PITIS date." };
  }
  if (normalizedDate < weekly.weekStart || normalizedDate > weekly.weekEnd) {
    return { error: `Weekly PITIS must be recorded within ${weekly.label}.` };
  }
  if (normalizedDate > weekly.latestAwardDate) {
    return { error: "Weekly PITIS cannot be recorded for a future date." };
  }
  return { mode: "weekly", weekly, awardDate: normalizedDate };
}

module.exports = {
  getWeeklyPitisWindow,
  validateWeeklyPitisRequest
};
