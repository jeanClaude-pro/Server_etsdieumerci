const express = require("express");
const Sale = require("../models/Sale");
const Entry = require("../models/Entry");
const Expense = require("../models/Expense");
const Creditor = require("../models/Creditor");
const Loan = require("../models/Loan");
const authMiddleware = require("../middleware/auth");
const { requireAdmin } = require("../utils/accessPolicy");
const {
  BUSINESS_TIMEZONE,
  businessDateStart,
  buildTimeframeFilter,
} = require("../utils/queryHelpers");
const {
  calculateNetCash,
  percentChange,
} = require("../utils/financialCalculations");
const {
  VALID_SALE_MATCH,
  saleLineStages,
  lineAccumulators,
} = require("../utils/profitPipeline");

const router = express.Router();
// Revenue, cash and debt figures: administrators only, enforced here.
router.use(authMiddleware, requireAdmin);

// Operating expenses exclude debt repayments: repaying a loan moves cash but
// is not a cost of the period.

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
            },
          }],
          customerCount: [
            {
              $match: {
                $or: [
                  { customerId: { $ne: null } },
                  { "customer.phone": { $nin: [null, ""] } },
                ],
              },
            },
            {
              $group: {
                _id: { $ifNull: ["$customerId", "$customer.phone"] },
              },
            },
            { $count: "total" },
          ],
          products: [
            ...saleLineStages(),
            {
              $group: {
                _id: { productId: "$items.productId", name: "$items.name" },
                quantity: { $sum: "$items.quantity" },
                revenue: { $sum: "$_line.revenue" },
              },
            },
            { $sort: { quantity: -1, revenue: -1 } },
          ],
          units: [
            ...saleLineStages(),
            { $group: { _id: null, ...lineAccumulators() } },
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
    ]).allowDiskUse(true),
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
  };
  const entries = entryResult[0] || { count: 0, amount: 0 };
  const expenseFacet = expenseResult[0] || {};
  const validatedExpenses = expenseFacet.validated?.[0] || { count: 0, amount: 0 };

  return {
    totalSales: sales.totalSales,
    totalRevenue: sales.totalRevenue,
    reservationCount: sales.reservations,
    totalCustomers: salesFacet.customerCount?.[0]?.total || 0,
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
    unitsSold: Number(salesFacet.units?.[0]?.unitsSold) || 0,
    averageTicket: sales.totalSales > 0 ? sales.totalRevenue / sales.totalSales : 0,
    topProducts: (salesFacet.products || []).map((item) => ({
      productId: item._id.productId || null,
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

async function aggregateDebt(range) {
  const [loanRows, repaymentRows, outstandingRows] = await Promise.all([
    Loan.aggregate([{ $match: { borrowedAt: range } }, { $lookup: { from: "creditors", localField: "creditorId", foreignField: "_id", as: "creditor" } }, { $unwind: "$creditor" }, { $group: { _id: "$creditor.type", amount: { $sum: "$amountUSD" }, count: { $sum: 1 } } }]),
    Expense.aggregate([{ $match: { expenseType: "repayment", status: "validated", repaymentAppliedAt: range } }, { $group: { _id: null, amount: { $sum: "$amountUSD" }, count: { $sum: 1 } } }]),
    Creditor.aggregate([{ $group: { _id: "$type", outstanding: { $sum: "$remainingBalance" }, borrowed: { $sum: "$totalBorrowed" }, repaid: { $sum: "$totalRepaid" }, creditors: { $sum: 1 } } }])
  ]);
  return { borrowedDuringPeriod: loanRows.reduce((sum, row) => sum + row.amount, 0), repaidDuringPeriod: repaymentRows[0]?.amount || 0, repaymentCount: repaymentRows[0]?.count || 0, currentOutstanding: outstandingRows.reduce((sum, row) => sum + row.outstanding, 0), borrowedByCreditorType: loanRows, outstandingByCreditorType: outstandingRows };
}

// Change relative to the size of the previous value, so a move from a loss to
// a positive balance reads as an improvement (percentChange divides by a signed value).
function signedChange(current, previous) {
  const before = Number(previous);
  if (!Number.isFinite(before) || before === 0) return null;
  return ((Number(current) - before) / Math.abs(before)) * 100;
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

    const [current, previous, chartRows, debt] = await Promise.all([
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
      ]).allowDiskUse(true),
      req.user?.role === "admin" ? aggregateDebt(currentRange) : Promise.resolve(null),
    ]);

    const chartData = chartRows.map((row) => ({
      date: row._id,
      sales: row.sales,
      revenue: row.revenue,
    }));

    res.set("Cache-Control", "no-store");
    res.json({
      success: true,
      source: "mongodb-aggregation",
      paginated: false,
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
          netCashGrowth: signedChange(current.netCash, previous.netCash),
          entryGrowth: percentChange(current.totalEntries, previous.totalEntries),
          expenseGrowth: percentChange(current.totalValidatedExpenses, previous.totalValidatedExpenses),
        },
        previous: {
          totalSales: previous.totalSales,
          totalRevenue: previous.totalRevenue,
          totalValidatedExpenses: previous.totalValidatedExpenses,
          totalEntries: previous.totalEntries,
          netCash: previous.netCash,
          averageTicket: previous.averageTicket,
        },
        ...(debt ? { reimbursement: debt } : {}),
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

// ---------------------------------------------------------------------------
// GET /api/analytics/timeseries?from=YYYY-MM-DD&to=YYYY-MM-DD&granularity=auto|hour|day|week|month
// One bucket per hour / day / week / month of the period, every bucket present
// (a bucket without sales is a real 0, not an interpolated value). A single
// day ("today") is cut into hours, in Lubumbashi time, up to the current hour.
// ---------------------------------------------------------------------------
const DAY_MS = 86400000;
const MAX_BUCKETS = 400;

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(key, days) {
  return dateKey(new Date(Date.parse(`${key}T00:00:00Z`) + days * DAY_MS));
}

function mondayOf(key) {
  const day = new Date(`${key}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(key, -((day + 6) % 7));
}

function chooseGranularity(requested, from, to) {
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS + 1;
  if (requested === "hour") return days === 1 ? "hour" : "day";
  if (["day", "week", "month"].includes(requested)) return requested;
  if (days === 1) return "hour";
  if (days <= 62) return "day";
  if (days <= 182) return "week";
  return "month";
}

/** Business-time hour (Lubumbashi, UTC+2) of a date, as "YYYY-MM-DDTHH". */
function businessHourKey(date) {
  return new Date(date.getTime() + 2 * 3600000).toISOString().slice(0, 13);
}

function hourKeys(day, now = new Date()) {
  const current = businessHourKey(now);
  const keys = [];
  for (let hour = 0; hour < 24; hour += 1) {
    const key = `${day}T${String(hour).padStart(2, "0")}`;
    if (key > current) break; // the rest of today has not happened yet
    keys.push(key);
  }
  return keys;
}

function bucketKeys(from, to, granularity) {
  if (granularity === "hour") return hourKeys(from);
  const keys = [];
  const seen = new Set();
  for (let key = from; key <= to; key = addDays(key, 1)) {
    const bucket = granularity === "day" ? key : granularity === "week" ? mondayOf(key) : key.slice(0, 7);
    if (!seen.has(bucket)) {
      seen.add(bucket);
      keys.push(bucket);
    }
    if (keys.length > MAX_BUCKETS) break;
  }
  return keys;
}

function bucketExpression(field, granularity) {
  const truncated = {
    $dateTrunc: {
      date: field,
      unit: granularity,
      timezone: BUSINESS_TIMEZONE,
      ...(granularity === "week" ? { startOfWeek: "monday" } : {}),
    },
  };
  return {
    $dateToString: {
      format: granularity === "month" ? "%Y-%m" : granularity === "hour" ? "%Y-%m-%dT%H" : "%Y-%m-%d",
      date: truncated,
      timezone: BUSINESS_TIMEZONE,
    },
  };
}

router.get("/timeseries", async (req, res) => {
  try {
    const filter = buildTimeframeFilter(req.query);
    const range = filter.createdAt;
    const shift = (date) => dateKey(new Date(date.getTime() + 2 * 3600000));
    const from = shift(range.$gte);
    const to = shift(range.$lte);
    const granularity = chooseGranularity(req.query.granularity, from, to);
    const keys = bucketKeys(from, to, granularity);
    if (keys.length > MAX_BUCKETS) {
      return res.status(400).json({ error: "Période trop longue pour cette granularité" });
    }
    const bucket = bucketExpression("$createdAt", granularity);

    const [salesRows, expenseRows, entryRows] = await Promise.all([
      Sale.aggregate([
        { $match: { ...VALID_SALE_MATCH, createdAt: range } },
        { $set: { _bucket: bucket } },
        {
          $facet: {
            sales: [{ $group: { _id: "$_bucket", sales: { $sum: 1 }, revenue: { $sum: "$total" } } }],
            lines: [...saleLineStages(), { $group: { _id: "$_bucket", ...lineAccumulators() } }],
          },
        },
      ]).allowDiskUse(true),
      Expense.aggregate([
        { $match: { createdAt: range, status: "validated" } },
        {
          $group: {
            _id: bucket,
            validated: { $sum: "$amount" },
          },
        },
      ]),
      Entry.aggregate([
        { $match: { createdAt: range, status: "active" } },
        { $group: { _id: bucket, entries: { $sum: "$amount" } } },
      ]),
    ]);

    const facet = salesRows[0] || {};
    const byKey = (rows) => new Map((rows || []).map((row) => [row._id, row]));
    const sales = byKey(facet.sales);
    const lines = byKey(facet.lines);
    const expenses = byKey(expenseRows);
    const entries = byKey(entryRows);

    const points = keys.map((key) => {
      const sale = sales.get(key) || {};
      const expense = expenses.get(key) || {};
      const revenue = Number(sale.revenue) || 0;
      const entryAmount = Number(entries.get(key)?.entries) || 0;
      return {
        key,
        sales: sale.sales || 0,
        revenue,
        unitsSold: Number(lines.get(key)?.unitsSold) || 0,
        validatedExpenses: Number(expense.validated) || 0,
        entries: entryAmount,
        netCash: revenue + entryAmount - (Number(expense.validated) || 0),
      };
    });

    res.set("Cache-Control", "no-store");
    res.json({
      success: true,
      source: "mongodb-aggregation",
      currency: "USD",
      period: { from, to, start: range.$gte, end: range.$lte, granularity },
      points,
    });
  } catch (error) {
    if (/Invalid date|Invalid year|Invalid month|Start date/.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    console.error("Analytics time series failed:", error);
    res.status(500).json({ error: "Failed to calculate analytics time series" });
  }
});

module.exports = router;
module.exports.bucketKeys = bucketKeys;
module.exports.chooseGranularity = chooseGranularity;
