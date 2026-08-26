function finiteAmount(value, fieldName) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    throw new TypeError(`${fieldName} must be a finite number`);
  }
  return amount;
}

function calculateNetCash(salesRevenue, activeEntries, validatedExpenses) {
  return finiteAmount(salesRevenue, "salesRevenue") +
    finiteAmount(activeEntries, "activeEntries") -
    finiteAmount(validatedExpenses, "validatedExpenses");
}

function calculateValidationRate(validatedCount, totalExpenseCount) {
  const validated = finiteAmount(validatedCount, "validatedCount");
  const total = finiteAmount(totalExpenseCount, "totalExpenseCount");
  return total > 0 ? (validated / total) * 100 : 0;
}

function percentChange(current, previous) {
  const previousValue = Number(previous);
  if (!Number.isFinite(previousValue) || previousValue === 0) return null;
  return ((finiteAmount(current, "current") - previousValue) / previousValue) * 100;
}

module.exports = {
  calculateNetCash,
  calculateValidationRate,
  percentChange,
};
