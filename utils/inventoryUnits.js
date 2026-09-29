// Inventory quantities may only be added when they share a dimension. Keep
// the original unit label for display, and use this key for piece-only KPIs.
const PIECE_UNIT_ALIASES = Object.freeze([
  "pcs",
  "pc",
  "piece",
  "pieces",
  "pièce",
  "pièces",
]);

function normalizeUnit(unit) {
  return String(unit || "").trim().toLocaleLowerCase("fr");
}

function unitDimension(unit) {
  const normalized = normalizeUnit(unit);
  return PIECE_UNIT_ALIASES.includes(normalized) ? "piece" : normalized || "unspecified";
}

// MongoDB expression equivalent of unitDimension(unit) === "piece".
function isPieceUnitExpression(field = "$unit") {
  return {
    $in: [
      { $toLower: { $trim: { input: { $ifNull: [field, ""] } } } },
      PIECE_UNIT_ALIASES,
    ],
  };
}

module.exports = {
  PIECE_UNIT_ALIASES,
  isPieceUnitExpression,
  normalizeUnit,
  unitDimension,
};
