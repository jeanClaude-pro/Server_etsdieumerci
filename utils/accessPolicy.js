// Server-side page access policy.
//
// This table mirrors jean-client/src/config/navigation.ts. The client only
// uses its copy to hide buttons; THIS copy is the one that decides. A route
// protected with requirePageAccess() refuses the request even if a user
// crafts it by hand, whatever the interface shows.
//
// Rules (identical to the client):
//   1. Fixed-role pages ignore custom page permissions.
//   2. "Admin-only" pages are reserved to administrators.
//   3. A user with custom page permissions may open exactly those pages.
//   4. Otherwise the default role list of the page applies.

const PAGE_ROLES = Object.freeze({
  "/": ["admin", "manager", "cashier_supervisor", "inventory_manager"], // Nouvelle vente
  "/entry": ["admin", "cashier_supervisor", "inventory_manager", "manager"],
  "/sortie": ["admin", "cashier_supervisor", "inventory_manager", "manager"],
  "/rate": ["admin", "manager"],
  "/sales": ["admin", "manager", "cashier_supervisor", "inventory_manager"],
  "/entryhistory": ["admin", "cashier_supervisor", "inventory_manager", "manager"],
  "/sortiehistory": ["admin", "cashier_supervisor", "inventory_manager", "manager"],
  "/products": ["admin", "manager", "inventory_manager"],
  "/customers": ["admin"],
  "/payment-approval": ["admin", "cashier_supervisor"],
  "/payment-verification": ["admin", "inventory_manager"],
  "/dashboard": ["admin"],
  "/reports": ["admin"],
  "/remboursements": ["admin"],
  "/admin/sale-edit-approvals": ["admin"],
  "/admin": ["admin"],
  "/audit": ["admin"],
});

const FIXED_ROLE_PATHS = new Set([
  "/admin",
  "/admin/sale-edit-approvals",
  "/payment-approval",
  "/payment-verification",
  "/dashboard",
  "/audit",
]);

const ADMIN_ONLY_PATHS = new Set(["/customers", "/reports", "/remboursements", "/audit"]);

function canAccessPage(user, path) {
  if (!user || !user.role || user.isActive === false) return false;
  const roles = PAGE_ROLES[path];
  if (!roles) return false;
  if (ADMIN_ONLY_PATHS.has(path)) return user.role === "admin";
  if (FIXED_ROLE_PATHS.has(path)) return roles.includes(user.role);
  const permissions = Array.isArray(user.permissions) ? user.permissions : [];
  if (permissions.length > 0) return user.role === "admin" || permissions.includes(path);
  return roles.includes(user.role);
}

/**
 * Express middleware: the request passes when the user may open at least one
 * of the given pages. Must run after the authentication middleware.
 */
function requirePageAccess(...paths) {
  return (req, res, next) => {
    if (paths.some((path) => canAccessPage(req.user, path))) return next();
    res.locals.accessDenied = { reason: "page_access", pages: paths };
    return res.status(403).json({
      code: "ACCESS_DENIED",
      message: "Accès refusé : votre rôle ne permet pas cette opération.",
    });
  };
}

function requireAdmin(req, res, next) {
  if (req.user?.role === "admin") return next();
  res.locals.accessDenied = { reason: "admin_required" };
  return res.status(403).json({ code: "ACCESS_DENIED", message: "Accès réservé aux administrateurs." });
}

module.exports = {
  ADMIN_ONLY_PATHS,
  FIXED_ROLE_PATHS,
  PAGE_ROLES,
  canAccessPage,
  requireAdmin,
  requirePageAccess,
};
