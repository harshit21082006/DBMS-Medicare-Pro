const express = require('express');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth');
const stateEngine = require('../services/stateEngine');
const aiService = require('../services/aiService');

// @route   POST api/ai/diagnose
// @desc    Suggest standard diagnosis & ICD-10 code based on unstructured symptoms
router.post('/diagnose', auth, async (req, res) => {
  const { symptoms } = req.body;

  if (!symptoms || symptoms.trim() === '') {
    return res.status(400).json({ message: 'Symptoms/Notes text is required for AI coding' });
  }

  try {
    const suggestion = await aiService.getDiagnosisSuggestion(symptoms);
    res.json(suggestion);
  } catch (error) {
    console.error('Diagnosis router error:', error);
    res.status(500).json({ message: 'Failed to run AI diagnosis suggestion' });
  }
});

// @route   GET api/ai/forecast
// @desc    Predict inventory purchase forecasting based on expiry, stock levels, and dispatch velocity
router.get('/forecast', auth, auth.requireRole('Admin', 'Pharmacist'), async (req, res) => {
  try {
    // 1. Get Stock lists from stateEngine cache
    const stockList = stateEngine.getStockList();
    const lowStock = stateEngine.getLowStockReport();

    // 2. Query expiring stock (next 30 days)
    const [expiringStock] = await db.query(
      `SELECT s.stock_id, m.medicine_name, s.batch_number, s.quantity, s.expiry_date
       FROM stock s
       JOIN medicines m ON s.medicine_id = m.medicine_id
       WHERE s.quantity > 0 
         AND s.expiry_date > CURDATE()
         AND s.expiry_date <= DATE_ADD(CURDATE(), INTERVAL 30 DAY)
       ORDER BY s.expiry_date ASC`
    );

    // 3. Query dispatch history (last 50 dispatches)
    const [dispatches] = await db.query(
      `SELECT d.dispatch_id, m.medicine_name, d.quantity, d.dispatch_date
       FROM dispatch d
       JOIN medicines m ON d.medicine_id = m.medicine_id
       ORDER BY d.dispatch_date DESC LIMIT 50`
    );

    // 4. Run forecasting service
    const forecast = await aiService.getInventoryForecast(stockList, lowStock, expiringStock, dispatches);
    res.json(forecast);

  } catch (error) {
    console.error('Inventory forecast router error:', error);
    res.status(500).json({ message: 'Failed to run AI stock forecasting' });
  }
});

module.exports = router;
