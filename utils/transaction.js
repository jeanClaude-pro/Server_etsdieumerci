const mongoose = require("mongoose");

function isTransactionUnsupported(error) {
  return error?.code === 20 ||
    /transaction numbers are only allowed|replica set member or mongos/i.test(error?.message || "");
}

// Same contract as the helper in routes/sales.js: the callback may be retried
// by the driver on transient transaction errors, so it must be idempotent.
async function runTransaction(work) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

module.exports = { isTransactionUnsupported, runTransaction };
