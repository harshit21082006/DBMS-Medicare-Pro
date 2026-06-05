const db = require('../config/db');

class StateEngine {
  constructor() {
    this.medicines = new Map(); // medicineId -> { medicine_name, category, manufacturer, unit_price, unit }
    this.stock = new Map();     // medicineId -> Array of { stock_id, batch_number, quantity, expiry_date, reorder_level }
    this.beds = [];             // Array of { bed_id, bed_number, status, ward_id, ward_name }
    this.admissions = new Map(); // bedId -> { admission_id, patient_id, bed_id, patient_name, diagnosis, doctor_name }
    this.isInitialized = false;
  }

  /**
   * Initializes the state engine by pre-loading all beds, wards, admissions, medicines, and stock from MySQL.
   */
  async initialize() {
    console.log('[IMSE] Initializing In-Memory State Engine...');
    try {
      // 1. Fetch Bed & Ward layout
      const [bedsRows] = await db.query(`
        SELECT b.bed_id, b.bed_number, b.status, b.ward_id, w.ward_name
        FROM beds b
        JOIN wards w ON b.ward_id = w.ward_id
        ORDER BY w.ward_id, b.bed_number
      `);
      this.beds = bedsRows;

      // 2. Fetch Active Admissions
      const [admissionsRows] = await db.query(`
        SELECT a.admission_id, a.patient_id, a.bed_id, p.full_name as patient_name,
               a.diagnosis, d.full_name as doctor_name
        FROM ipd_admissions a
        JOIN patients p ON a.patient_id = p.patient_id
        JOIN doctors d ON a.attending_doctor = d.doctor_id
        WHERE a.status = 'Admitted'
      `);
      this.admissions.clear();
      admissionsRows.forEach(adm => {
        this.admissions.set(adm.bed_id, adm);
      });

      // 3. Fetch Medicines and Stock
      const [stockRows] = await db.query(`
        SELECT m.medicine_id, m.medicine_name, m.category, m.manufacturer, m.unit_price, m.unit,
               s.stock_id, s.batch_number, IFNULL(s.quantity, 0) as quantity, s.expiry_date, s.reorder_level
        FROM medicines m
        LEFT JOIN stock s ON m.medicine_id = s.medicine_id
        ORDER BY m.medicine_name ASC, s.expiry_date ASC
      `);

      this.medicines.clear();
      this.stock.clear();

      stockRows.forEach(row => {
        const medId = row.medicine_id;
        if (!this.medicines.has(medId)) {
          this.medicines.set(medId, {
            medicine_id: medId,
            medicine_name: row.medicine_name,
            category: row.category,
            manufacturer: row.manufacturer,
            unit_price: row.unit_price,
            unit: row.unit
          });
        }

        if (row.stock_id) {
          if (!this.stock.has(medId)) {
            this.stock.set(medId, []);
          }
          this.stock.get(medId).push({
            stock_id: row.stock_id,
            batch_number: row.batch_number,
            quantity: parseInt(row.quantity, 10),
            expiry_date: new Date(row.expiry_date),
            reorder_level: parseInt(row.reorder_level, 10)
          });
        }
      });

      this.isInitialized = true;
      console.log(`[IMSE] Initialization successful! Loaded ${this.medicines.size} medicines and ${this.beds.length} beds.`);
    } catch (error) {
      console.error('[IMSE] Error during initialization:', error);
      throw error;
    }
  }

  // --- Bed Queries ---
  getAvailableBeds() {
    return this.beds
      .filter(b => b.status === 'Available')
      .map(b => ({
        bed_id: b.bed_id,
        bed_number: b.bed_number,
        ward_name: b.ward_name
      }));
  }

  getBedStatusLayout() {
    return this.beds.map(bed => {
      if (bed.status === 'Occupied' && this.admissions.has(bed.bed_id)) {
        return {
          ...bed,
          patient: this.admissions.get(bed.bed_id)
        };
      }
      return bed;
    });
  }

  async syncBedState(bedId) {
    try {
      const [bedsRows] = await db.query(`
        SELECT b.bed_id, b.bed_number, b.status, b.ward_id, w.ward_name
        FROM beds b
        JOIN wards w ON b.ward_id = w.ward_id
        WHERE b.bed_id = ?
      `, [bedId]);

      if (bedsRows.length > 0) {
        const bedIndex = this.beds.findIndex(b => b.bed_id === bedId);
        if (bedIndex !== -1) {
          this.beds[bedIndex] = bedsRows[0];
        } else {
          this.beds.push(bedsRows[0]);
        }

        if (bedsRows[0].status === 'Occupied') {
          const [admRows] = await db.query(`
            SELECT a.admission_id, a.patient_id, a.bed_id, p.full_name as patient_name,
                   a.diagnosis, d.full_name as doctor_name
            FROM ipd_admissions a
            JOIN patients p ON a.patient_id = p.patient_id
            JOIN doctors d ON a.attending_doctor = d.doctor_id
            WHERE a.bed_id = ? AND a.status = 'Admitted'
          `, [bedId]);
          if (admRows.length > 0) {
            this.admissions.set(bedId, admRows[0]);
          } else {
            this.admissions.delete(bedId);
          }
        } else {
          this.admissions.delete(bedId);
        }
      }
    } catch (err) {
      console.error(`[IMSE] Failed to sync bed state for bed_id ${bedId}:`, err);
    }
  }

  // --- Stock Queries ---
  getStockList() {
    const list = [];
    this.medicines.forEach((med, medId) => {
      const batches = this.stock.get(medId) || [];
      if (batches.length === 0) {
        list.push({
          ...med,
          stock_id: null,
          batch_number: null,
          quantity: 0,
          expiry_date: null,
          reorder_level: 50
        });
      } else {
        batches.forEach(b => {
          list.push({
            ...med,
            stock_id: b.stock_id,
            batch_number: b.batch_number,
            quantity: b.quantity,
            expiry_date: b.expiry_date.toISOString().split('T')[0],
            reorder_level: b.reorder_level
          });
        });
      }
    });
    // Sort by medicine name alphabetically
    return list.sort((a, b) => a.medicine_name.localeCompare(b.medicine_name));
  }

  getLowStockReport() {
    const alerts = [];
    this.stock.forEach((batches, medId) => {
      const medicine = this.medicines.get(medId);
      batches.forEach(b => {
        if (b.quantity <= b.reorder_level) {
          alerts.push({
            medicine_id: medId,
            medicine_name: medicine.medicine_name,
            current_qty: b.quantity,
            reorder_level: b.reorder_level,
            status: b.quantity === 0 ? 'OUT OF STOCK' : 'LOW STOCK'
          });
        }
      });
    });
    return alerts;
  }

  async syncMedicineStock(medicineId) {
    try {
      const [rows] = await db.query(`
        SELECT m.medicine_id, m.medicine_name, m.category, m.manufacturer, m.unit_price, m.unit,
               s.stock_id, s.batch_number, IFNULL(s.quantity, 0) as quantity, s.expiry_date, s.reorder_level
        FROM medicines m
        LEFT JOIN stock s ON m.medicine_id = s.medicine_id
        WHERE m.medicine_id = ?
        ORDER BY s.expiry_date ASC
      `, [medicineId]);

      if (rows.length > 0) {
        // Update medicine info
        this.medicines.set(medicineId, {
          medicine_id: medicineId,
          medicine_name: rows[0].medicine_name,
          category: rows[0].category,
          manufacturer: rows[0].manufacturer,
          unit_price: rows[0].unit_price,
          unit: rows[0].unit
        });

        // Update stock list
        const batches = [];
        rows.forEach(row => {
          if (row.stock_id) {
            batches.push({
              stock_id: row.stock_id,
              batch_number: row.batch_number,
              quantity: parseInt(row.quantity, 10),
              expiry_date: new Date(row.expiry_date),
              reorder_level: parseInt(row.reorder_level, 10)
            });
          }
        });
        this.stock.set(medicineId, batches);
      }
    } catch (err) {
      console.error(`[IMSE] Failed to sync medicine stock for medicine_id ${medicineId}:`, err);
    }
  }

  // --- Dispatch Helpers ---
  
  /**
   * Pre-checks stock availability in memory and performs an optimistic reservation.
   * Walks batches in FEFO order.
   * Returns array of deductions if successful, throws error if stock is insufficient.
   */
  optimisticDeductStock(medicineId, quantity) {
    const batches = this.stock.get(parseInt(medicineId, 10)) || [];
    const today = new Date();
    today.setHours(0,0,0,0);

    // Filter valid non-expired batches with quantity > 0
    const validBatches = batches
      .filter(b => b.quantity > 0 && b.expiry_date > today)
      .sort((a, b) => a.expiry_date - b.expiry_date); // FEFO order

    const totalAvailable = validBatches.reduce((acc, b) => acc + b.quantity, 0);
    if (totalAvailable < quantity) {
      throw new Error('Insufficient non-expired stock to fulfil this dispatch.');
    }

    let remaining = quantity;
    const deductions = [];

    for (let b of validBatches) {
      if (remaining <= 0) break;

      const take = Math.min(b.quantity, remaining);
      b.quantity -= take;
      remaining -= take;

      deductions.push({
        stock_id: b.stock_id,
        quantityDeducted: take
      });
    }

    return deductions;
  }

  /**
   * Rolls back an optimistic stock reservation in memory in case of downstream database failure.
   */
  rollbackDeductStock(medicineId, deductions) {
    const batches = this.stock.get(parseInt(medicineId, 10)) || [];
    deductions.forEach(deduction => {
      const batch = batches.find(b => b.stock_id === deduction.stock_id);
      if (batch) {
        batch.quantity += deduction.quantityDeducted;
      }
    });
  }
}

module.exports = new StateEngine();
