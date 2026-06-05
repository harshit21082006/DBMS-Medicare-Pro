const express = require('express');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth');
const stateEngine = require('../services/stateEngine');
const writeQueue = require('../services/writeQueue');

// @route   POST api/dispatch
// @desc    Dispatch medicine to a patient (Calls TRANSACTION Stored Procedure through serial Queue)
router.post('/', auth, auth.requireRole('Admin', 'Pharmacist'), async (req, res) => {
  const { patient_id, medicine_id, quantity } = req.body;
  const staff_id = req.user.staff_id; // Securely fetched from JWT token

  if (!patient_id || !medicine_id || !quantity) {
    return res.status(400).json({ message: 'Patient ID, Medicine ID, and quantity are required' });
  }

  // Step 1: Pre-check & optimistic deduction in memory
  let deductions;
  try {
    deductions = stateEngine.optimisticDeductStock(medicine_id, quantity);
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }

  // Step 2: Enqueue database transaction to process sequentially
  try {
    const result = await writeQueue.enqueue(async () => {
      try {
        // Call the transaction-based stored procedure
        await db.query('CALL sp_dispatch_medicine(?, ?, ?, ?)', [
          patient_id,
          medicine_id,
          quantity,
          staff_id
        ]);

        // Fetch the stock_log entries written during this dispatch
        const [logRows] = await db.query(`
            SELECT sl.quantity, s.batch_number, s.expiry_date
            FROM   stock_log sl
            JOIN   stock s ON s.stock_id = sl.batch_stock_id
            WHERE  sl.medicine_id = ?
              AND  sl.change_type = 'OUT'
              AND  sl.reason = ?
            ORDER BY sl.log_time DESC
        `, [medicine_id, `FEFO dispatch | patient=${patient_id}`]);

        // Sync local cache with the DB for this medicine ID to ensure alignment
        await stateEngine.syncMedicineStock(medicine_id);

        return {
          message: 'Medicine dispatched successfully',
          batchesConsumed: logRows
        };
      } catch (dbError) {
        // Rollback memory deduction if the DB operation failed
        stateEngine.rollbackDeductStock(medicine_id, deductions);
        throw dbError;
      }
    });

    res.json(result);

  } catch (error) {
    console.error('Dispatch error:', error.message);
    
    // Check if error is from our SIGNAL in SQL
    if (error.sqlState === '45000') {
      return res.status(400).json({ message: error.message });
    }
    
    res.status(500).json({ message: 'Server error during medicine dispatch transaction' });
  }
});

// @route   GET api/dispatch/pending
// @desc    Get prescriptions with items not yet dispatched
router.get('/pending', auth, auth.requireRole('Admin', 'Pharmacist'), async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT 
          pr.prescription_id,
          pr.patient_id,
          p.full_name AS patient_name,
          pr.prescribed_on,
          m.medicine_name,
          pi.medicine_id,
          pi.quantity AS prescribed_quantity,
          COALESCE(
              (SELECT SUM(d.quantity) 
               FROM dispatch d 
               WHERE d.patient_id = pr.patient_id 
                 AND d.medicine_id = pi.medicine_id
                 AND d.dispatch_date >= pr.prescribed_on), 
              0
          ) AS dispatched_quantity
      FROM prescriptions pr
      JOIN patients p ON pr.patient_id = p.patient_id
      JOIN prescription_items pi ON pr.prescription_id = pi.prescription_id
      JOIN medicines m ON pi.medicine_id = m.medicine_id
      HAVING dispatched_quantity < prescribed_quantity
      ORDER BY pr.prescribed_on DESC
    `);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error retrieving pending dispatches' });
  }
});

// @route   GET api/dispatch/history
// @desc    Get recent dispatches
router.get('/history', auth, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT d.dispatch_id, d.patient_id, p.full_name as patient_name,
              m.medicine_name, d.quantity, d.dispatch_date, s.full_name as staff_name
       FROM dispatch d
       JOIN patients p ON d.patient_id = p.patient_id
       JOIN medicines m ON d.medicine_id = m.medicine_id
       JOIN staff s ON d.dispatched_by = s.staff_id
       ORDER BY d.dispatch_date DESC LIMIT 50`
    );
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error retrieving dispatch history' });
  }
});

module.exports = router;

