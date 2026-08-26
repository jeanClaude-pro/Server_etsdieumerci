const BUSINESS_TIMEZONE = "Africa/Lubumbashi";
const BUSINESS_UTC_OFFSET_MS = 2 * 60 * 60 * 1000;

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePagination(query, defaultLimit = 50, maxLimit = 100) {
  const page = parsePositiveInteger(query.page, 1);
  const requestedLimit = parsePositiveInteger(query.limit, defaultLimit);
  const limit = Math.min(requestedLimit, maxLimit);

  return {
    page,
    limit,
    skip: (page - 1) * limit,
  };
}

function parseDateParts(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) {
    throw new Error(`Invalid date format: ${value}. Use YYYY-MM-DD format.`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new Error(`Invalid date: ${value}`);
  }

  return { year, month, day };
}

function businessDateStart(value) {
  const { year, month, day } = parseDateParts(value);
  return new Date(Date.UTC(year, month - 1, day) - BUSINESS_UTC_OFFSET_MS);
}

function businessDateEnd(value) {
  return new Date(businessDateStart(value).getTime() + 24 * 60 * 60 * 1000 - 1);
}

function currentBusinessDate() {
  const shifted = new Date(Date.now() + BUSINESS_UTC_OFFSET_MS);
  return [
    shifted.getUTCFullYear(),
    String(shifted.getUTCMonth() + 1).padStart(2, "0"),
    String(shifted.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function buildTimeframeFilter(query, field = "createdAt", defaultToToday = true) {
  const { from, to, date, year, month } = query;
  let start;
  let end;

  if (from || to) {
    start = from ? businessDateStart(from) : new Date(0);
    end = to ? businessDateEnd(to) : new Date();
  } else if (date) {
    start = businessDateStart(date);
    end = businessDateEnd(date);
  } else if (year && month) {
    const yearNumber = Number.parseInt(year, 10);
    const monthNumber = Number.parseInt(month, 10);
    if (yearNumber < 2000 || yearNumber > 2100) throw new Error("Invalid year");
    if (monthNumber < 1 || monthNumber > 12) throw new Error("Invalid month");
    const first = `${yearNumber}-${String(monthNumber).padStart(2, "0")}-01`;
    const nextMonthYear = monthNumber === 12 ? yearNumber + 1 : yearNumber;
    const nextMonth = monthNumber === 12 ? 1 : monthNumber + 1;
    start = businessDateStart(first);
    end = new Date(
      businessDateStart(
        `${nextMonthYear}-${String(nextMonth).padStart(2, "0")}-01`
      ).getTime() - 1
    );
  } else if (year) {
    const yearNumber = Number.parseInt(year, 10);
    if (yearNumber < 2000 || yearNumber > 2100) throw new Error("Invalid year");
    start = businessDateStart(`${yearNumber}-01-01`);
    end = new Date(businessDateStart(`${yearNumber + 1}-01-01`).getTime() - 1);
  } else if (defaultToToday) {
    const today = currentBusinessDate();
    start = businessDateStart(today);
    end = businessDateEnd(today);
  } else {
    return {};
  }

  if (start > end) throw new Error("Start date must be before or equal to end date");
  return { [field]: { $gte: start, $lte: end } };
}

function paginationMetadata(page, limit, totalRecords) {
  const totalPages = Math.ceil(totalRecords / limit);
  return {
    page,
    limit,
    totalRecords,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
}

module.exports = {
  BUSINESS_TIMEZONE,
  buildTimeframeFilter,
  businessDateEnd,
  businessDateStart,
  currentBusinessDate,
  paginationMetadata,
  parsePagination,
};
