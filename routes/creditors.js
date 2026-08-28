const express = require("express");
const mongoose = require("mongoose");
const auth = require("../middleware/auth");
const Creditor = require("../models/Creditor");
const Loan = require("../models/Loan");
const Expense = require("../models/Expense");
const { normalizeAmountSnapshot } = require("../utils/salePricing");

const router = express.Router();
const adminOnly = (req, res, next) => req.user?.role === "admin" ? next() : res.status(403).json({ error: "Administrator access required" });
const clean = (value) => String(value || "").trim();

router.get("/selector", auth, async (_req, res) => {
  const rows = await Creditor.find({ isActive: true }).select("name type phone").sort({ name: 1 }).lean();
  res.json(rows);
});

router.use(auth, adminOnly);

router.get("/", async (_req, res) => {
  const creditors = await Creditor.find().sort({ isActive: -1, name: 1 }).lean();
  res.json(creditors);
});

router.post("/", async (req, res) => {
  const name = clean(req.body.name);
  if (!name || !["person", "bank", "company"].includes(req.body.type)) return res.status(400).json({ error: "Valid name and type are required" });
  const creditor = await Creditor.create({ name, type: req.body.type, phone: clean(req.body.phone), address: clean(req.body.address), createdBy: req.user._id || req.user.id });
  res.status(201).json(creditor);
});

router.put("/:id", async (req, res) => {
  const name = clean(req.body.name);
  if (!name || !["person", "bank", "company"].includes(req.body.type)) return res.status(400).json({ error: "Valid name and type are required" });
  const creditor = await Creditor.findByIdAndUpdate(req.params.id, { name, type: req.body.type, phone: clean(req.body.phone), address: clean(req.body.address), updatedBy: req.user._id || req.user.id }, { new: true, runValidators: true });
  if (!creditor) return res.status(404).json({ error: "Creditor not found" });
  res.json(creditor);
});

router.patch("/:id/archive", async (req, res) => {
  const creditor = await Creditor.findByIdAndUpdate(req.params.id, { isActive: false, updatedBy: req.user._id || req.user.id }, { new: true });
  if (!creditor) return res.status(404).json({ error: "Creditor not found" });
  res.json(creditor);
});

router.post("/:id/loans", async (req, res) => {
  let snapshot;
  try { snapshot = normalizeAmountSnapshot(req.body); } catch (error) { return res.status(400).json({ error: error.message }); }
  const borrowedAt = req.body.borrowedAt ? new Date(req.body.borrowedAt) : new Date();
  if (Number.isNaN(borrowedAt.getTime())) return res.status(400).json({ error: "Invalid borrowedAt date" });
  const session = await mongoose.startSession();
  try {
    let loan;
    await session.withTransaction(async () => {
      const creditor = await Creditor.findOneAndUpdate({ _id: req.params.id, isActive: true }, { $inc: { totalBorrowed: snapshot.amountUSD, remainingBalance: snapshot.amountUSD }, $set: { updatedBy: req.user._id || req.user.id } }, { new: true, session });
      if (!creditor) throw Object.assign(new Error("Active creditor not found"), { status: 404 });
      [loan] = await Loan.create([{ creditorId: creditor._id, ...snapshot, borrowedAt, reference: clean(req.body.reference), note: clean(req.body.note), createdBy: req.user._id || req.user.id }], { session });
    });
    res.status(201).json(loan);
  } catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : "Failed to record loan" }); }
  finally { await session.endSession(); }
});

router.get("/:id/history", async (req, res) => {
  const creditor = await Creditor.findById(req.params.id).lean();
  if (!creditor) return res.status(404).json({ error: "Creditor not found" });
  const [loans, repayments] = await Promise.all([
    Loan.find({ creditorId: creditor._id }).populate("createdBy", "username role").sort({ borrowedAt: -1 }).lean(),
    Expense.find({ creditorId: creditor._id, expenseType: "repayment" }).select("expenseId amountUSD enteredAmount enteredCurrency exchangeRate status repaymentAppliedAt createdAt recordedBy notes").sort({ createdAt: -1 }).lean()
  ]);
  const sums = await Promise.all([
    Loan.aggregate([{ $match: { creditorId: creditor._id } }, { $group: { _id: null, total: { $sum: "$amountUSD" } } }]),
    Expense.aggregate([{ $match: { creditorId: creditor._id, expenseType: "repayment", status: "validated", repaymentAppliedAt: { $ne: null } } }, { $group: { _id: null, total: { $sum: "$amountUSD" } } }])
  ]);
  res.json({ creditor, loans, repayments, reconciliation: { borrowed: sums[0][0]?.total || 0, repaid: sums[1][0]?.total || 0, calculatedOutstanding: (sums[0][0]?.total || 0) - (sums[1][0]?.total || 0), storedOutstanding: creditor.remainingBalance } });
});

router.use((error, _req, res, _next) => {
  if (error instanceof mongoose.Error.CastError) return res.status(400).json({ error: "Invalid identifier" });
  console.error("Creditor route error:", error);
  res.status(500).json({ error: "Creditor operation failed" });
});

module.exports = router;
