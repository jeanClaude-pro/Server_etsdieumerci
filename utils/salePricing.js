const SUPPORTED_CURRENCIES = new Set(["USD", "FC"]);

function toPositiveNumber(value, fieldName) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${fieldName} must be a positive number`);
  }
  return number;
}

function normalizeExchangeRate(value) {
  if (value === undefined || value === null || value === "") return undefined;
  return toPositiveNumber(value, "exchangeRate");
}

function normalizeSaleItemPricing(item, saleExchangeRate) {
  const hasOriginalPricing =
    item.enteredPrice !== undefined || item.enteredCurrency !== undefined;

  if (!hasOriginalPricing) {
    return { price: toPositiveNumber(item.price, "price") };
  }

  if (!SUPPORTED_CURRENCIES.has(item.enteredCurrency)) {
    throw new Error("enteredCurrency must be USD or FC");
  }

  const enteredPrice = toPositiveNumber(item.enteredPrice, "enteredPrice");
  const exchangeRate = normalizeExchangeRate(
    item.exchangeRate ?? saleExchangeRate
  );

  if (item.enteredCurrency === "FC" && !exchangeRate) {
    throw new Error("exchangeRate is required for an FC price");
  }

  // The entered currency is authoritative. Only the other currency is derived.
  const priceUSD =
    item.enteredCurrency === "USD"
      ? enteredPrice
      : enteredPrice / exchangeRate;
  const priceFC =
    item.enteredCurrency === "FC"
      ? enteredPrice
      : exchangeRate
        ? Math.round(enteredPrice * exchangeRate)
        : undefined;

  return {
    price: priceUSD,
    enteredPrice,
    enteredCurrency: item.enteredCurrency,
    priceUSD,
    priceFC,
    exchangeRate,
  };
}

function normalizeAmountSnapshot(input, fallbackExchangeRate) {
  const enteredCurrency = input.enteredCurrency || "USD";
  if (!SUPPORTED_CURRENCIES.has(enteredCurrency)) {
    throw new Error("enteredCurrency must be USD or FC");
  }

  const enteredAmount = toPositiveNumber(
    input.enteredAmount ?? input.amount,
    "enteredAmount"
  );
  const exchangeRate = normalizeExchangeRate(
    input.exchangeRate ?? fallbackExchangeRate
  );

  if (enteredCurrency === "FC" && !exchangeRate) {
    throw new Error("exchangeRate is required for an FC amount");
  }

  const amountUSD =
    enteredCurrency === "USD" ? enteredAmount : enteredAmount / exchangeRate;
  const amountFC =
    enteredCurrency === "FC"
      ? enteredAmount
      : exchangeRate
        ? Math.round(enteredAmount * exchangeRate)
        : undefined;

  return {
    amount: amountUSD,
    enteredAmount,
    enteredCurrency,
    amountUSD,
    amountFC,
    exchangeRate,
  };
}

module.exports = {
  normalizeExchangeRate,
  normalizeAmountSnapshot,
  normalizeSaleItemPricing,
};
