let activeMaintenance = null;

function beginMaintenance(reason = "Portal maintenance is in progress") {
  if (activeMaintenance) throw new Error("Portal maintenance is already in progress");
  activeMaintenance = { reason: String(reason), startedAt: new Date().toISOString() };
  return activeMaintenance;
}

function endMaintenance() {
  activeMaintenance = null;
}

function getMaintenanceState() {
  return activeMaintenance ? { ...activeMaintenance } : null;
}

function maintenanceMiddleware(req, res, next) {
  const state = getMaintenanceState();
  if (!state) return next();
  res.set("Retry-After", "30");
  res.set("Cache-Control", "no-store");
  if (req.path.startsWith("/api/")) {
    return res.status(503).json({ error: state.reason, maintenance: true });
  }
  return res.status(503).send(`${state.reason}. Please try again shortly.`);
}

module.exports = { beginMaintenance, endMaintenance, getMaintenanceState, maintenanceMiddleware };
