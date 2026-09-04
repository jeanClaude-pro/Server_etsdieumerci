const { businessDateStart } = require("./queryHelpers");

const RECEIPT_SCANNER_ROLLOUT_DATE = "2026-09-04";
const RECEIPT_SCANNER_CUTOFF = businessDateStart(RECEIPT_SCANNER_ROLLOUT_DATE);

const VALID_SCAN_STATUSES = ["completed", "pending"];

function buildScanStatsPipeline(match = {}) {
  return [
    {
      $match: {
        ...match,
        type: "sale",
        status: { $in: VALID_SCAN_STATUSES },
      },
    },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        paymentApproved: {
          $sum: {
            $cond: [
              {
                $or: [
                  { $lt: ["$createdAt", RECEIPT_SCANNER_CUTOFF] },
                  { $eq: ["$receiptVerification.paymentStatus", "approved"] },
                ],
              },
              1,
              0,
            ],
          },
        },
        exitControlled: {
          $sum: {
            $cond: [
              {
                $or: [
                  { $lt: ["$createdAt", RECEIPT_SCANNER_CUTOFF] },
                  { $eq: ["$receiptVerification.exitVerification.verified", true] },
                ],
              },
              1,
              0,
            ],
          },
        },
      },
    },
    {
      $project: {
        _id: 0,
        total: 1,
        paymentApproved: 1,
        paymentPending: { $subtract: ["$total", "$paymentApproved"] },
        exitControlled: 1,
        awaitingExitControl: { $subtract: ["$paymentApproved", "$exitControlled"] },
      },
    },
  ];
}

function scanBusinessStatus(sale) {
  const legacy = new Date(sale.createdAt) < RECEIPT_SCANNER_CUTOFF;
  return {
    paymentApproved: legacy || sale.receiptVerification?.paymentStatus === "approved",
    exitControlled: legacy || sale.receiptVerification?.exitVerification?.verified === true,
  };
}

module.exports = {
  RECEIPT_SCANNER_CUTOFF,
  RECEIPT_SCANNER_ROLLOUT_DATE,
  buildScanStatsPipeline,
  scanBusinessStatus,
};
