const express = require('express');
const escpos = require('escpos');
escpos.USB = require('escpos-usb');
const router = express.Router();

// Find and use the first available USB printer
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
          .text(`Nom: ${receiptData.customerName}`)
          .text(`Tél: ${receiptData.customerPhone}`);
        
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
          printer
            .text(`${item.quantity}x ${item.name}`)
            .align('rt')
            .text(`$${item.total.toFixed(2)}`)
            .align('lt');
        });

        // Total
        printer
          .feed(1)
          .style('b')
          .text('TOTAL:')
          .align('rt')
          .text(`$${receiptData.total.toFixed(2)}`)
          .align('lt')
          .text(`Paiement: ${receiptData.paymentMethod.toUpperCase()}`)
          .feed(1);

        // Sales person
        printer
          .style('normal')
          .text(`Agent: ${receiptData.salesPerson}`)
          .feed(1);

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
    res.status(500).json({ error: 'Server error' });
  }
});

// Print stub endpoint
router.post('/stub', async (req, res) => {
  try {
    const { receiptData, type = 'sale' } = req.body;
    
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
        printer
          .text(`Client: ${receiptData.customerName}`)
          .text(`Tél: ${receiptData.customerPhone}`)
          .feed(1);

        // Items summary
        printer
          .style('b')
          .text('ARTICLES:')
          .style('normal');

        receiptData.items.forEach((item) => {
          printer.text(`${item.quantity}x ${item.name}`);
        });

        // Total
        printer
          .feed(1)
          .style('b')
          .text(`Total: $${receiptData.total.toFixed(2)}`)
          .text(`Paiement: ${receiptData.paymentMethod.toUpperCase()}`)
          .feed(1);

        // Sales person
        printer.text(`Agent: ${receiptData.salesPerson}`);

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
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;