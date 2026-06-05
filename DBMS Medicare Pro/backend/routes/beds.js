const express = require('express');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth');
const stateEngine = require('../services/stateEngine');

// @route   GET api/beds/wards
// @desc    Get all wards
router.get('/wards', auth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM wards');
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error retrieving wards' });
  }
});

// @route   GET api/beds/available
// @desc    Get all available beds (Reads from IMSE cache)
router.get('/available', auth, async (req, res) => {
  try {
    const beds = stateEngine.getAvailableBeds();
    res.json(beds);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error retrieving available beds' });
  }
});

// @route   GET api/beds/status
// @desc    Get all beds grouped by ward with active patient details (Reads from IMSE cache)
router.get('/status', auth, async (req, res) => {
  try {
    const bedsWithDetails = stateEngine.getBedStatusLayout();
    res.json(bedsWithDetails);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error retrieving bed status layout' });
  }
});

module.exports = router;
