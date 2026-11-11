/**
 * Seasonal greeting printed on 80mm ESC/POS receipts.
 *
 * Presentation only: it never reads or changes sale data, amounts or payment
 * information. The season is evaluated on the store's business calendar
 * (Africa/Lubumbashi, UTC+2, no DST), like utils/queryHelpers.js.
 *
 * The greeting is sent as a 1-bit raster (GS v 0) rather than text so the
 * star, "Ë", "É" and the "œ" ligature print correctly whatever character code
 * page the printer uses. The bitmap comes from scripts/build_festive_raster.py;
 * keep its wording in step with jean-client/src/utils/festiveGreeting.ts,
 * which renders the same block in the browser receipts and previews.
 */
const raster = require("./festiveGreetingRaster");

const FESTIVE_TIMEZONE = "Africa/Lubumbashi";
// Inclusive business dates (YYYY-MM-DD).
const FESTIVE_SEASON = Object.freeze({ start: "2026-11-10", end: "2027-01-15" });
// Rows per GS v 0 command: keeps each command small for printers with limited input buffers.
const BAND_ROWS = 64;

const businessDayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: FESTIVE_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function festiveBusinessDate(now) {
  const parts = businessDayFormatter.formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function isFestiveSeason(now = new Date()) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return false;
  const day = festiveBusinessDate(now);
  return day >= FESTIVE_SEASON.start && day <= FESTIVE_SEASON.end;
}

/** ESC/POS bytes for the greeting bitmap, split into bands. */
function festiveGreetingRasterCommands() {
  const data = Buffer.from(raster.data, "base64");
  const { widthBytes, height } = raster;
  if (data.length !== widthBytes * height) {
    throw new Error("Festive greeting raster is corrupted");
  }
  const commands = [];
  for (let row = 0; row < height; row += BAND_ROWS) {
    const rows = Math.min(BAND_ROWS, height - row);
    const header = Buffer.from([
      0x1d, 0x76, 0x30, 0x00, // GS v 0, normal density
      widthBytes & 0xff, (widthBytes >> 8) & 0xff,
      rows & 0xff, (rows >> 8) & 0xff,
    ]);
    commands.push(Buffer.concat([header, data.subarray(row * widthBytes, (row + rows) * widthBytes)]));
  }
  return Buffer.concat(commands);
}

/**
 * Appends the greeting to an escpos Printer when the festive season is on.
 * Returns true when it was added. Leaves alignment centred and text style
 * normal; the caller's footer sets its own alignment afterwards.
 */
function printFestiveGreeting(printer, now = new Date()) {
  if (!isFestiveSeason(now)) return false;
  printer
    .align("ct")
    .style("normal")
    .size(1, 1)
    .feed(1)
    .print(festiveGreetingRasterCommands())
    .feed(1);
  return true;
}

module.exports = {
  FESTIVE_SEASON,
  FESTIVE_TIMEZONE,
  festiveBusinessDate,
  festiveGreetingRasterCommands,
  isFestiveSeason,
  printFestiveGreeting,
};
