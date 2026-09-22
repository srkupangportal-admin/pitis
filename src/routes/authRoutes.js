const express = require("express");
const bcrypt = require("bcryptjs");
const { db } = require("../db/init");
const { recordUserLogin } = require("../services/userLoginLogService");

const router = express.Router();

function normalizeNextPath(value) {
  const nextPath = String(value || "").trim();
  if (!nextPath || !nextPath.startsWith("/") || nextPath.startsWith("//")) {
    return "";
  }
  return nextPath;
}

function canUserAccessPath(user, nextPath) {
  const safeNextPath = normalizeNextPath(nextPath);
  if (!safeNextPath) return false;

  if (safeNextPath === "/" || safeNextPath === "/rewards" || safeNextPath.startsWith("/leaderboard")) {
    return true;
  }

  if (!user) return false;

  if (safeNextPath.startsWith("/admin")) {
    return user.role === "admin";
  }

  if (safeNextPath.startsWith("/teacher") || safeNextPath.startsWith("/devices")) {
    return ["admin", "teacher", "staff"].includes(user.role);
  }

  if (safeNextPath === "/pwa" || safeNextPath.startsWith("/pwa/")) {
    return ["admin", "teacher", "staff"].includes(user.role);
  }

  if (safeNextPath.startsWith("/notes") || safeNextPath.startsWith("/informations") || safeNextPath.startsWith("/photos-upload")) {
    return ["admin", "teacher", "staff"].includes(user.role);
  }

  return false;
}

function getLoginViewModel(error, nextPath) {
  return {
    error: error || null,
    nextPath: normalizeNextPath(nextPath)
  };
}

function redirectUserByRole(res, user, nextPath) {
  if (user && user.mustChangePassword) return res.redirect("/account/change-password");
  const safeNextPath = normalizeNextPath(nextPath);
  if (safeNextPath && canUserAccessPath(user, safeNextPath)) return res.redirect(safeNextPath);
  return res.redirect("/");
}

function authenticateAndRoute(req, res) {
  const { username, password, next: nextPath } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE username = ?").get((username || "").trim());

  if (!user || Number(user.is_active || 0) !== 1 || !bcrypt.compareSync(password || "", user.password_hash)) {
    return res.status(401).render("login", getLoginViewModel("Invalid credentials", nextPath));
  }

  return req.session.regenerate((err) => {
    if (err) {
      return res.status(500).render("login", getLoginViewModel("Unable to start your session. Please try again.", nextPath));
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      role: user.role,
      userType: user.user_type || user.role,
      mustChangePassword: user.role !== "admin" && Number(user.must_change_password || 0) === 1
    };
    req.session.showTeacherProgressWelcome = req.session.user.role === "teacher"
      && req.session.user.userType === "teacher";
    recordUserLogin(req, user);

    req.session.save((saveErr) => {
      if (saveErr) {
        return res.status(500).render("login", getLoginViewModel("Unable to save your session. Please try again.", nextPath));
      }
      return redirectUserByRole(res, req.session.user, nextPath);
    });
  });
}

router.get("/login", (req, res) => {
  if (req.session.user) {
    return redirectUserByRole(res, req.session.user, req.query.next);
  }

  return res.render("login", getLoginViewModel(req.query.error || null, req.query.next));
});

router.post("/login", authenticateAndRoute);
router.get("/login/teacher", (_req, res) => res.redirect("/login"));
router.post("/login/teacher", authenticateAndRoute);
router.get("/login/admin", (_req, res) => res.redirect("/login"));
router.post("/login/admin", authenticateAndRoute);

router.get("/account/change-password", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  if (!req.session.user.mustChangePassword) return res.redirect("/");
  return res.render("change-password", { error: req.query.error || null });
});

router.post("/account/change-password", (req, res) => {
  const userId = Number((req.session.user || {}).id || 0);
  const currentPassword = String(req.body.current_password || "");
  const newPassword = String(req.body.new_password || "");
  const confirmPassword = String(req.body.confirm_password || "");
  const user = db.prepare("SELECT * FROM users WHERE id = ? AND is_active = 1").get(userId);
  if (!user || !bcrypt.compareSync(currentPassword, user.password_hash)) {
    return res.status(400).render("change-password", { error: "Your current password is incorrect." });
  }
  if (newPassword.length < 12) {
    return res.status(400).render("change-password", { error: "Choose a password with at least 12 characters." });
  }
  if (bcrypt.compareSync(newPassword, user.password_hash)) {
    return res.status(400).render("change-password", { error: "Your new password must be different from the temporary password." });
  }
  if (newPassword !== confirmPassword) {
    return res.status(400).render("change-password", { error: "The new passwords do not match." });
  }
  db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?").run(bcrypt.hashSync(newPassword, 12), user.id);
  req.session.user.mustChangePassword = false;
  return req.session.save((err) => {
    if (err) return res.status(500).render("change-password", { error: "Password changed, but the session could not be refreshed. Please sign in again." });
    return res.redirect("/");
  });
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

module.exports = router;
