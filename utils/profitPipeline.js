// Aggregation helpers for the sales figures of the reports.
//
// This shop records no purchase price: every selling price is typed at the
// till (NewSale). The reports follow the cash logic of the business:
//   trésorerie nette = (ventes + entrées) − dépenses validées
// (see utils/financialCalculations.js). Amounts are in USD.

// Completed (and legacy pending) sales; voided / corrected / refunded rows
// are never revenue. Same definition as the analytics summary.
const VALID_SALE_MATCH = Object.freeze({
  type: "sale",
  status: { $in: ["completed", "pending"] },
});

/** One document per sold line with its revenue (USD) and quantity. */
function saleLineStages() {
  return [
    { $unwind: "$items" },
    {
      $set: {
        _line: {
          revenue: {
            $ifNull: [
              "$items.total",
              { $multiply: [{ $ifNull: ["$items.priceUSD", { $ifNull: ["$items.price", 0] }] }, { $ifNull: ["$items.quantity", 0] }] },
            ],
          },
          quantity: { $ifNull: ["$items.quantity", 0] },
        },
      },
    },
  ];
}

/** $group accumulators over lines produced by saleLineStages(). */
function lineAccumulators() {
  return {
    lineRevenue: { $sum: "$_line.revenue" },
    unitsSold: { $sum: "$_line.quantity" },
  };
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

module.exports = {
  VALID_SALE_MATCH,
  saleLineStages,
  lineAccumulators,
  round2,
};
