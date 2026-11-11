const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  FESTIVE_SEASON,
  festiveGreetingRasterCommands,
  isFestiveSeason,
  printFestiveGreeting,
} = require("../utils/festiveGreeting");
const raster = require("../utils/festiveGreetingRaster");

test("festive season is evaluated on the Lubumbashi business calendar (UTC+2)", () => {
  assert.deepEqual({ ...FESTIVE_SEASON }, { start: "2026-11-10", end: "2027-01-15" });
  assert.equal(isFestiveSeason(new Date("2026-11-09T21:59:59Z")), false); // 23:59:59 on 9 Nov in store
  assert.equal(isFestiveSeason(new Date("2026-11-09T22:00:00Z")), true); // 00:00 on 10 Nov in store
  assert.equal(isFestiveSeason(new Date("2026-12-25T12:00:00Z")), true);
  assert.equal(isFestiveSeason(new Date("2027-01-15T21:59:59Z")), true); // 23:59:59 on 15 Jan in store
  assert.equal(isFestiveSeason(new Date("2027-01-15T22:00:00Z")), false); // 00:00 on 16 Jan in store
  assert.equal(isFestiveSeason(new Date("2027-11-20T12:00:00Z")), false);
  assert.equal(isFestiveSeason(new Date("invalid")), false);
});

test("greeting raster fits 80mm paper and is encoded as banded GS v 0 commands", () => {
  assert.ok(raster.widthBytes * 8 <= 512, "must fit 64mm and 72mm print heads");
  assert.equal(Buffer.from(raster.data, "base64").length, raster.widthBytes * raster.height);
  const bytes = festiveGreetingRasterCommands();
  let offset = 0;
  let rows = 0;
  while (offset < bytes.length) {
    assert.deepEqual([...bytes.subarray(offset, offset + 4)], [0x1d, 0x76, 0x30, 0x00]);
    const width = bytes[offset + 4] | (bytes[offset + 5] << 8);
    const height = bytes[offset + 6] | (bytes[offset + 7] << 8);
    assert.equal(width, raster.widthBytes);
    assert.ok(height > 0 && height <= 64);
    offset += 8 + width * height;
    rows += height;
  }
  assert.equal(offset, bytes.length);
  assert.equal(rows, raster.height);
});

function fakePrinter() {
  const calls = [];
  const printer = {};
  for (const name of ["align", "style", "size", "feed", "print", "text"]) {
    printer[name] = (...args) => { calls.push([name, ...args]); return printer; };
  }
  return { printer, calls };
}

test("printer receives the greeting only during the season", () => {
  const inSeason = fakePrinter();
  assert.equal(printFestiveGreeting(inSeason.printer, new Date("2026-12-24T10:00:00Z")), true);
  assert.ok(inSeason.calls.some(([name, arg]) => name === "print" && Buffer.isBuffer(arg)));
  assert.ok(inSeason.calls.some(([name, arg]) => name === "align" && arg === "ct"));

  const offSeason = fakePrinter();
  assert.equal(printFestiveGreeting(offSeason.printer, new Date("2027-02-01T10:00:00Z")), false);
  assert.equal(offSeason.calls.length, 0);
});

test("ESC/POS receipt prints the greeting after payment and before the footer only", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "routes", "print.js"), "utf8");
  const receipt = source.slice(source.indexOf("router.post('/receipt'"), source.indexOf("router.post('/stub'"));
  const stub = source.slice(source.indexOf("router.post('/stub'"));
  const payment = receipt.indexOf("Paiement:");
  const greeting = receipt.indexOf("printFestiveGreeting(printer)");
  const footer = receipt.indexOf("Merci pour votre achat");
  assert.ok(payment > 0 && greeting > payment && footer > greeting);
  assert.equal(stub.includes("printFestiveGreeting"), false);
});
