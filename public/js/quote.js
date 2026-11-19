// Teklif hesaplama — tarayıcı ve sunucu tarafından ortak kullanılır.
// Fiyatlar her zaman katalogdan hesaplanır; AI fiyat üretmez.

const round2 = (n) => Math.round(n * 100) / 100;

export function findProduct(catalog, code) {
  return catalog.products.find((p) => p.code === code) || null;
}

export function tierDiscountPercent(catalog, quantity) {
  const tiers = [...catalog.quantityDiscounts].sort((a, b) => b.minQuantity - a.minQuantity);
  const tier = tiers.find((t) => quantity >= t.minQuantity);
  return tier ? tier.percent : 0;
}

export function normalizeIncoterm(catalog, incoterm) {
  const code = (incoterm || '').toUpperCase().trim();
  return code in catalog.incotermAdjustments ? code : catalog.basePriceTerm;
}

/** Analiz sonucundaki eşleşen kalemlerden düzenlenebilir teklif satırları üretir. */
export function createQuoteLines(analysis, catalog) {
  const lines = [];
  for (const item of analysis.items || []) {
    const product = item.productCode && findProduct(catalog, item.productCode);
    if (!product) continue;
    const existing = lines.find((l) => l.code === product.code);
    const qty = item.quantity && item.quantity > 0 ? Math.round(item.quantity) : product.moq;
    if (existing) existing.quantity += qty;
    else lines.push({ code: product.code, quantity: qty, quantityAssumed: !(item.quantity > 0), priceOverride: null });
  }
  return lines;
}

/**
 * @param {{lines: {code:string, quantity:number, priceOverride:number|null}[], incoterm:string, extraDiscountPercent:number}} input
 */
export function calculateQuote(input, catalog) {
  const incoterm = normalizeIncoterm(catalog, input.incoterm);
  const incotermPct = catalog.incotermAdjustments[incoterm];
  const warnings = [];

  const lines = input.lines
    .map((line) => {
      const product = findProduct(catalog, line.code);
      if (!product) return null;
      const quantity = Math.max(0, Math.round(Number(line.quantity) || 0));
      const discountPct = tierDiscountPercent(catalog, quantity);
      const computed = round2(product.unitPrice * (1 + incotermPct / 100) * (1 - discountPct / 100));
      const hasOverride = line.priceOverride !== null && line.priceOverride !== undefined && line.priceOverride !== '';
      const unitPrice = hasOverride ? round2(Number(line.priceOverride)) : computed;
      if (quantity < product.moq) {
        warnings.push(`${product.code}: ${quantity} ${product.unit}, minimum sipariş miktarının (${product.moq}) altında.`);
      }
      return {
        code: product.code,
        name: product.name,
        description: product.description,
        unit: product.unit,
        quantity,
        listPrice: product.unitPrice,
        discountPct,
        incotermPct,
        computedUnitPrice: computed,
        unitPrice,
        priceOverridden: hasOverride,
        total: round2(unitPrice * quantity),
        moq: product.moq,
        leadTimeDays: product.leadTimeDays,
        quantityAssumed: !!line.quantityAssumed,
      };
    })
    .filter(Boolean);

  const subtotal = round2(lines.reduce((s, l) => s + l.total, 0));
  const extraDiscountPercent = Math.min(100, Math.max(0, Number(input.extraDiscountPercent) || 0));
  const extraDiscountAmount = round2((subtotal * extraDiscountPercent) / 100);

  return {
    currency: catalog.currency,
    incoterm,
    incotermPct,
    lines,
    subtotal,
    extraDiscountPercent,
    extraDiscountAmount,
    total: round2(subtotal - extraDiscountAmount),
    leadTimeDays: lines.length ? Math.max(...lines.map((l) => l.leadTimeDays)) : null,
    warnings,
  };
}

export function formatMoney(value, currency = 'USD') {
  return new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value) + ' ' + currency;
}

export function formatNumber(value) {
  return new Intl.NumberFormat('tr-TR').format(value);
}
