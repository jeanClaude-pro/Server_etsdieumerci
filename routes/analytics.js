const express = require("express");
const Sale = require("../models/Sale");
const Entry = require("../models/Entry");
const Expense = require("../models/Expense");
const authMiddleware = require("../middleware/auth");
const {
  BUSINESS_TIMEZONE,
  businessDateStart,
  buildTimeframeFilter,
} = require("../utils/queryHelpers");
const {
  calculateNetCash,
  percentChange,
} = require("../utils/financialCalculations");

const router = express.Router();
router.use(authMiddleware);

const VALID_SALE_MATCH = {
  type: { $in: ["sale", "reservation"] },
  status: { $in: ["completed", "pending"] },
};

function previousRange(range) {
  const duration = range.$lte.getTime() - range.$gte.getTime() + 1;
  return {
    $gte: new Date(range.$gte.getTime() - duration),
    $lte: new Date(range.$gte.getTime() - 1),
  };
}

function chartConfiguration(timeframe, currentRange) {
  const end = currentRange.$lte;
  if (timeframe === "day") {
    return { unit: "day", start: new Date(end.getTime() - 7 * 86400000 + 1) };
  }
  if (timeframe === "week") {
    return { unit: "week", start: new Date(end.getTime() - 28 * 86400000 + 1) };
  }
  if (timeframe === "month") {
    const firstChartMonth = new Date(
      Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 5, 1)
    );
    return {
      unit: "month",
      start: businessDateStart(firstChartMonth.toISOString().slice(0, 7) + "-01"),
    };
  }
  return { unit: "month", start: currentRange.$gte };
}

async function aggregatePeriod(createdAt) {
  const saleMatch = { ...VALID_SALE_MATCH, createdAt };
  const [salesResult, entryResult, expenseResult] = await Promise.all([
    Sale.aggregate([
      { $match: saleMatch },
      {
        $facet: {
          metrics: [{
            $group: {
              _id: null,
              totalSales: { $sum: 1 },
              totalRevenue: { $sum: "$total" },
              reservations: { $sum: { $cond: [{ $eq: ["$type", "reservation"] }, 1, 0] } },
              customerIds: { $addToSet: { $ifNull: ["$customerId", "$customer.phone"] } },
            },
          }],
          products: [
            { $unwind: "$items" },
            {
              $group: {
                _id: { productId: "$items.productId", name: "$items.name" },
                quantity: { $sum: "$items.quantity" },
                revenue: { $sum: { $multiply: [{ $ifNull: ["$items.priceUSD", "$items.price"] }, "$items.quantity"] } },
              },
            },
            { $sort: { quantity: -1, revenue: -1 } },
            { $limit: 10 },
          ],
          productCount: [
            { $unwind: "$items" },
            { $group: { _id: "$items.productId" } },
            { $count: "total" },
          ],
          customers: [
            { $match: { isWalkIn: { $ne: true }, customerId: { $ne: null } } },
            {
              $group: {
                _id: "$customerId",
                name: { $last: "$customer.name" },
                purchases: { $sum: 1 },
                totalSpent: { $sum: "$total" },
              },
            },
            { $sort: { totalSpent: -1 } },
            { $limit: 5 },
          ],
          paymentMethods: [
            { $group: { _id: "$paymentMethod", count: { $sum: 1 }, amount: { $sum: "$total" } } },
            { $sort: { amount: -1 } },
          ],
        },
      },
    ]),
    Entry.aggregate([
      { $match: { createdAt, status: "active" } },
      { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: "$amount" } } },
    ]),
    Expense.aggregate([
      { $match: { createdAt } },
      {
        $facet: {
          validated: [
            { $match: { status: "validated" } },
            { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: "$amount" } } },
          ],
          statuses: [
            { $group: { _id: "$status", count: { $sum: 1 }, amount: { $sum: "$amount" } } },
          ],
        },
      },
    ]),
  ]);

  const salesFacet = salesResult[0] || {};
  const sales = salesFacet.metrics?.[0] || {
    totalSales: 0,
    totalRevenue: 0,
    reservations: 0,
    customerIds: [],
  };
  const entries = entryResult[0] || { count: 0, amount: 0 };
  const expenseFacet = expenseResult[0] || {};
  const validatedExpenses = expenseFacet.validated?.[0] || { count: 0, amount: 0 };
  const customerIds = (sales.customerIds || []).filter(Boolean);

  return {
    totalSales: sales.totalSales,
    totalRevenue: sales.totalRevenue,
    reservationCount: sales.reservations,
    totalCustomers: customerIds.length,
    totalProducts: salesFacet.productCount?.[0]?.total || 0,
    totalEntries: entries.amount,
    entryCount: entries.count,
    totalValidatedExpenses: validatedExpenses.amount,
    validatedExpenseCount: validatedExpenses.count,
    netCash: calculateNetCash(
      sales.totalRevenue,
      entries.amount,
      validatedExpenses.amount
    ),
    topProducts: (salesFacet.products || []).map((item) => ({
      name: item._id.name || "Article inconnu",
      quantity: item.quantity,
      revenue: item.revenue,
    })),
    topCustomers: (salesFacet.customers || []).map((item) => ({
      name: item.name || "Client inconnu",
      purchases: item.purchases,
      totalSpent: item.totalSpent,
    })),
    paymentMethods: salesFacet.paymentMethods || [],
    expenseStatuses: expenseFacet.statuses || [],
  };
}

router.get("/summary", async (req, res) => {
  try {
    const timeframe = ["day", "week", "month", "year"].includes(req.query.timeframe)
      ? req.query.timeframe
      : "day";
    const filter = buildTimeframeFilter(req.query);
    const currentRange = filter.createdAt;
    const priorRange = previousRange(currentRange);
    const chart = chartConfiguration(timeframe, currentRange);
    const dateTrunc = {
      date: "$createdAt",
      unit: chart.unit,
      timezone: BUSINESS_TIMEZONE,
    };
    if (chart.unit === "week") dateTrunc.startOfWeek = "monday";

    const [current, previous, chartRows] = await Promise.all([
      aggregatePeriod(currentRange),
      aggregatePeriod(priorRange),
      Sale.aggregate([
        {
          $match: {
            ...VALID_SALE_MATCH,
            createdAt: { $gte: chart.start, $lte: currentRange.$lte },
          },
        },
        {
          $group: {
            _id: {
              $dateTrunc: dateTrunc,
            },
            sales: { $sum: 1 },
            revenue: { $sum: "$total" },
          },
        },
        { $sort: { _id: 1 } },
      ]),
    ]);

    const chartData = chartRows.map((row) => ({
      date: row._id,
      sales: row.sales,
      revenue: row.revenue,
    }));

    res.json({
      success: true,
      timeframe: {
        type: timeframe,
        start: currentRange.$gte,
        end: currentRange.$lte,
        previousStart: priorRange.$gte,
        previousEnd: priorRange.$lte,
      },
      data: {
        ...current,
        netRevenue: current.netCash,
        chartData,
        recentTrends: {
          salesGrowth: percentChange(current.totalSales, previous.totalSales),
          revenueGrowth: percentChange(current.totalRevenue, previous.totalRevenue),
          customerGrowth: percentChange(current.totalCustomers, previous.totalCustomers),
        },
      },
    });
  } catch (error) {
    if (/Invalid date|Invalid year|Invalid month|Start date/.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    console.error("Analytics aggregation failed:", error);
    res.status(500).json({ error: "Failed to calculate analytics" });
  }
});

module.exports = router;
