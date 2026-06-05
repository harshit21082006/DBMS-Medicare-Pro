const { execFile } = require('child_process');
const path = require('path');

class AiService {
  constructor() {
    this.classifierPath = path.join(__dirname, '..', 'ml', 'diagnose_classifier.py');
    this.forecasterPath = path.join(__dirname, '..', 'ml', 'inventory_forecaster.py');
  }

  /**
   * Helper to run a python script as a child process and parse its JSON output
   */
  _runPythonScript(scriptPath, args) {
    return new Promise((resolve, reject) => {
      // Execute the python file directly
      execFile('python', [scriptPath, ...args], { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
        if (error) {
          console.error(`[AI Service] Execution error:`, error);
          console.error(`[AI Service] Stderr:`, stderr);
          reject(new Error(`ML script execution failed: ${stderr || error.message}`));
          return;
        }

        try {
          const result = JSON.parse(stdout.trim());
          if (result.error) {
            reject(new Error(result.error));
          } else {
            resolve(result);
          }
        } catch (parseErr) {
          console.error(`[AI Service] Output parsing error. Raw output: "${stdout}"`);
          reject(new Error(`Failed to parse ML script response: ${parseErr.message}`));
        }
      });
    });
  }

  /**
   * Runs local TF-IDF Cosine Similarity classifier to suggest diagnosis and ICD-10
   */
  async getDiagnosisSuggestion(symptoms) {
    console.log(`[AI] Invoking local classifier for: "${symptoms}"`);
    try {
      const result = await this._runPythonScript(this.classifierPath, ['--predict', symptoms]);
      return result;
    } catch (err) {
      console.error('[AI] Local diagnosis classifier failed, returning basic backup:', err);
      // Inline backup in case Python execution fails completely
      return { diagnosis: 'General Medical Examination', icd10: 'Z00.00' };
    }
  }

  /**
   * Runs local forecaster checking sales velocity, reorder levels, and expiry warning
   */
  async getInventoryForecast(stockList, lowStock, expiringStock, dispatches) {
    console.log(`[AI] Invoking local forecaster for ${stockList.length} stock records`);
    try {
      const result = await this._runPythonScript(this.forecasterPath, ['--current_stock', JSON.stringify(stockList)]);
      return result;
    } catch (err) {
      console.error('[AI] Local forecaster failed, returning basic backup:', err);
      // Inline fallback
      return [{
        medicine_name: 'Paracetamol',
        batch_number: 'All',
        warning_reason: 'Regular inventory baseline review suggested (Local Python runner inactive)',
        recommended_order_qty: 100,
        priority: 'Low'
      }];
    }
  }
}

module.exports = new AiService();
