const express = require('express');
const escpos = require('escpos');
escpos.USB = require('escpos-usb');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const crypto = require('crypto');
const Sale = require('../models/Sale');
const { decryptReceiptToken, normalizeReceiptToken } = require('../utils/receiptTokenCrypto');

router.use(authMiddleware);

function fcUnitPrice(item, saleRate) {
  if (item.enteredCurrency === 'FC' && Number.isFinite(Number(item.enteredPrice))) return Number(item.enteredPrice);
  if (Number.isFinite(Number(item.priceFC))) return Number(item.priceFC);
  const rate = Number(item.exchangeRate ?? saleRate);
  const usd = Number(item.priceUSD ?? item.unitPrice ?? item.price);
  return Number.isFinite(rate) && rate > 0 && Number.isFinite(usd) ? Math.round(usd * rate) : undefined;
}

function formatFc(value) {
  return `${Math.round(value).toLocaleString('fr-FR').replace(/\s/g, ' ')}FC`;
}

function dualItemAmount(item, quantity, saleRate) {
  const usd = Number(item.priceUSD ?? item.unitPrice ?? item.price) * quantity;
  const fcUnit = fcUnitPrice(item, saleRate);
  return `${usd.toFixed(2)}$${fcUnit === undefined ? '' : ` / ${formatFc(fcUnit * quantity)}`}`;
}

function dualSaleTotal(receiptData) {
  const items = Array.isArray(receiptData.items) ? receiptData.items : [];
  const fcTotals = items.map((item) => {
    const unit = fcUnitPrice(item, receiptData.exchangeRate);
    return unit === undefined ? undefined : unit * Number(item.quantity);
  });
  const fc = fcTotals.length && fcTotals.every((value) => value !== undefined)
    ? fcTotals.reduce((sum, value) => sum + value, 0)
    : Number.isFinite(Number(receiptData.exchangeRate))
      ? Math.round(Number(receiptData.total) * Number(receiptData.exchangeRate))
      : undefined;
  return `${Number(receiptData.total).toFixed(2)}$${fc === undefined ? '' : ` / ${formatFc(fc)}`}`;
}

async function authorizePrintedReceipt(receiptData) {
  const submittedToken = normalizeReceiptToken(receiptData?.qrToken);
  const receiptNumber = String(receiptData?.receiptNumber || '');
  if (!submittedToken || !receiptNumber || receiptNumber.length > 100) {
    const error = new Error('Invalid receipt print data');
    error.status = 400;
    throw error;
  }
  const sale = await Sale.findOne({
    $or: [{ saleId: receiptNumber }, { saleNumber: receiptNumber }],
    type: 'sale',
    status: { $nin: ['voided', 'corrected'] },
    'receiptVerification.invalidatedAt': null,
  })
    .select('+receiptVerification.tokenCiphertext')
    .lean();
  if (!sale?.receiptVerification?.tokenCiphertext) {
    const error = new Error('Receipt is not printable');
    error.status = 409;
    throw error;
  }
  const currentToken = decryptReceiptToken(sale.receiptVerification.tokenCiphertext);
  const submitted = Buffer.from(submittedToken, 'utf8');
  const current = Buffer.from(currentToken, 'utf8');
  if (submitted.length !== current.length || !crypto.timingSafeEqual(submitted, current)) {
    const error = new Error('Receipt token does not match the current version');
    error.status = 409;
    throw error;
  }
  return currentToken;
}

// Find and use the first available USB printer
//printer
function getPrinter() {
  try {
    const device = new escpos.USB();
    return new escpos.Printer(device);
  } catch (error) {
    console.error('No USB printer found:', error);
    return null;
  }
}

// Print receipt endpoint
router.post('/receipt', async (req, res) => {
  try {
    const { receiptData, type = 'sale' } = req.body;
    if (type === 'sale') receiptData.qrToken = await authorizePrintedReceipt(receiptData);
    
    const printer = getPrinter();
    if (!printer) {
      return res.status(500).json({ error: 'No printer found' });
    }

    const device = printer.device;

    device.open(async (error) => {
      if (error) {
        console.error('Printer error:', error);
        return res.status(500).json({ error: 'Printer connection failed' });
      }

      try {
        // Print receipt header
        printer
          .font('a')
          .align('ct')
          .style('b')
          .size(2, 2)
          .text('ETS. DIEU MERCI')
          .size(1, 1)
          .text('_Chez Dan Collection_')
          .align('lt')
          .text(receiptData.shopAddress)
          .text(`RCCM: ${receiptData.shopRegistration}`)
          .text(receiptData.shopNumber)
          .text(`Date: ${receiptData.date}`)
          .text(`Reçu #: ${receiptData.receiptNumber}`)
          .feed(1);

        // Customer information
        printer
          .style('b')
          .text('CLIENT')
          .style('normal')
          .text(`Nom: ${receiptData.customerName}`);

        if (receiptData.customerPhone) {
          printer.text(`Tél: ${receiptData.customerPhone}`);
        }

        if (receiptData.customerEmail) {
          printer.text(`Email: ${receiptData.customerEmail}`);
        }

        printer.feed(1);

        // Items
        printer
          .style('b')
          .text('ARTICLES')
          .style('normal');

        receiptData.items.forEach((item) => {
          const quantity = Number(item.quantity);
          const name = String(item.name || '').slice(0, 32);
          printer
            .text(`${quantity}x ${name}`)
            .align('rt')
            .text(dualItemAmount(item, quantity, receiptData.exchangeRate))
            .align('lt');
        });

        // Total
        printer
          .feed(1)
          .style('b')
          .text('TOTAL:')
          .align('rt')
          .text(dualSaleTotal(receiptData))
          .align('lt')
          .text(`Paiement: ${receiptData.paymentMethod.toUpperCase()}`)
          .feed(1);

        // Sales person
        printer
          .style('normal')
          .text(`Agent: ${receiptData.salesPerson}`)
          .feed(1);

        // The customer receipt carries the opaque payment-control token.
        // ESC/POS renders it natively at high contrast and a thermal-safe size.
        if (/^EDM1:[A-Za-z0-9_-]{43}$/.test(String(receiptData.qrToken || ''))) {
          printer
            .align('ct')
            .qrcode(receiptData.qrToken, 6, 'M', 6)
            .feed(1)
            .text('SCAN CONTROLE PAIEMENT')
            .align('lt');
        }

        // Footer
        printer
          .align('ct')
          .text('✅ Merci pour votre achat !')
          .text('Non échangeable - Non remboursable')
          .feed(2);

        if (type === 'reservation') {
          printer
            .style('b')
            .text('✅ RESERVATION CONFIRMÉE')
            .feed(1);
        }

        // Cut the paper (full cut)
        printer.cut();
        
        await new Promise((resolve) => {
          printer.close(() => {
            resolve();
          });
        });

        res.json({ success: true, message: 'Receipt printed successfully' });
      } catch (printError) {
        console.error('Print error:', printError);
        res.status(500).json({ error: 'Print failed' });
      }
    });
  } catch (error) {
    console.error('Server error:', error);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Server error' });
  }
});

// Print stub endpoint
router.post('/stub', async (req, res) => {
  try {
    const { receiptData, type = 'sale' } = req.body;
    if (type === 'sale') receiptData.qrToken = await authorizePrintedReceipt(receiptData);
    
    const printer = getPrinter();
    if (!printer) {
      return res.status(500).json({ error: 'No printer found' });
    }

    const device = printer.device;

    device.open(async (error) => {
      if (error) {
        return res.status(500).json({ error: 'Printer connection failed' });
      }

      try {
        // Print stub header
        printer
          .font('a')
          .align('ct')
          .style('b')
          .size(1, 1)
          .text('SOUCHE')
          .text('ETS. DIEU MERCI')
          .text('_Chez Dan Collection_')
          .align('lt')
          .text(`Date: ${receiptData.date}`)
          .text(`Reçu #: ${receiptData.receiptNumber}`)
          .feed(1);

        // Customer information
        printer.text(`Client: ${receiptData.customerName}`);
        if (receiptData.customerPhone) {
          printer.text(`Tél: ${receiptData.customerPhone}`);
        }
        printer.feed(1);

        // Items summary
        printer
          .style('b')
          .text('ARTICLES:')
          .style('normal');

        receiptData.items.forEach((item) => {
          const quantity = Number(item.quantity);
          printer
            .text(`${quantity}x ${String(item.name || '').slice(0, 32)}`)
            .text(dualItemAmount(item, quantity, receiptData.exchangeRate));
        });

        // Total
        printer
          .feed(1)
          .style('b')
          .text(`Total: ${dualSaleTotal(receiptData)}`)
          .text(`Paiement: ${receiptData.paymentMethod.toUpperCase()}`)
          .feed(1);

        // Sales person
        printer.text(`Agent: ${receiptData.salesPerson}`);

        // The stub carries the exact same opaque token/version as the customer receipt.
        if (/^EDM1:[A-Za-z0-9_-]{43}$/.test(String(receiptData.qrToken || ''))) {
          printer
            .feed(1)
            .align('ct')
            .qrcode(receiptData.qrToken, 6, 'M', 6)
            .feed(1)
            .text('SCAN CONTROLE PAIEMENT')
            .align('lt');
        }

        // Stub footer
        printer
          .feed(1)
          .align('ct')
          .style('b')
          .text(`SOUCHE N°${receiptData.stubNumber} DU JOUR`)
          .feed(1);

        if (type === 'reservation') {
          printer.text('✅ RESERVATION CONFIRMÉE');
        }

        printer.feed(2);

        // Cut the paper (full cut)
        printer.cut();
        
        await new Promise((resolve) => {
          printer.close(() => {
            resolve();
          });
        });

        res.json({ success: true, message: 'Stub printed successfully' });
      } catch (printError) {
        console.error('Print error:', printError);
        res.status(500).json({ error: 'Print failed' });
      }
    });
  } catch (error) {
    console.error('Server error:', error);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Server error' });
  }
});

module.exports = router;
