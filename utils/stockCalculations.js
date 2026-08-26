function totalByProduct(items = []) {
  const quantities = new Map();
  for (const item of items) {
    const productId = String(item.productId);
    quantities.set(
      productId,
      (quantities.get(productId) || 0) + Number(item.quantity || 0)
    );
  }
  return quantities;
}

function buildStockAdjustments(previousItems = [], nextItems = []) {
  const previousQuantities = totalByProduct(previousItems);
  const nextQuantities = totalByProduct(nextItems);

  return [...new Set([...previousQuantities.keys(), ...nextQuantities.keys()])]
    .map((productId) => ({
      productId,
      // Positive returns stock; negative consumes additional stock.
      adjustment:
        (previousQuantities.get(productId) || 0) -
        (nextQuantities.get(productId) || 0),
    }))
    .filter(({ adjustment }) => adjustment !== 0);
}

module.exports = { buildStockAdjustments };
