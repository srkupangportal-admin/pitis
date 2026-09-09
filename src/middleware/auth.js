function requireRole(roleOrRoles) {
  const allowedRoles = Array.isArray(roleOrRoles) ? roleOrRoles : [roleOrRoles];

  return (req, res, next) => {
    if (!req.session.user) {
      return res.redirect("/login");
    }
    if (req.session.user.mustChangePassword) {
      return res.redirect("/account/change-password");
    }
    if (!allowedRoles.includes(req.session.user.role)) {
      return res.status(403).send("Forbidden");
    }
    return next();
  };
}

function requireAnyAuth(req, res, next) {
  if (!req.session.user) return res.redirect("/");
  if (req.session.user.mustChangePassword) return res.redirect("/account/change-password");
  return next();
}

module.exports = {
  requireRole,
  requireAnyAuth
};
