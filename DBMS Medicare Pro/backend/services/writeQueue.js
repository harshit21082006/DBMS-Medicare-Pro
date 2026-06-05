class WriteQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
  }

  /**
   * Enqueues a transaction task and returns a Promise that resolves or rejects
   * when that specific task has been executed sequentially.
   * 
   * @param {Function} taskFn - An async function containing the database/state operation.
   * @returns {Promise<any>}
   */
  enqueue(taskFn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ taskFn, resolve, reject });
      this.process();
    });
  }

  /**
   * Processes the queue sequentially (concurrency = 1) to eliminate SQL lock contention and deadlocks.
   */
  async process() {
    if (this.processing) {
      return;
    }
    this.processing = true;

    while (this.queue.length > 0) {
      const { taskFn, resolve, reject } = this.queue.shift();
      try {
        const result = await taskFn();
        resolve(result);
      } catch (error) {
        reject(error);
      }
    }

    this.processing = false;
  }
}

module.exports = new WriteQueue();
