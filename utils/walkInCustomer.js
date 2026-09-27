// Walk-in ("client de passage") sales may carry an optional display name so
// the cashier can personalise the receipt. The name lives only on the sale's
// customer snapshot: no phone, no email and never a Customer record.
const WALK_IN_DEFAULT_NAME = "Client de passage";
const WALK_IN_NAME_MAX_LENGTH = 80;

function buildWalkInCustomer(customer) {
  const name =
    typeof customer?.name === "string"
      ? customer.name.replace(/\s+/g, " ").trim().slice(0, WALK_IN_NAME_MAX_LENGTH)
      : "";
  return { name: name || WALK_IN_DEFAULT_NAME, phone: "", email: "" };
}

module.exports = { buildWalkInCustomer, WALK_IN_DEFAULT_NAME, WALK_IN_NAME_MAX_LENGTH };
