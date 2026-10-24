export class AvailabilityMonitor {
  constructor({ probe, onChange, onAvailable, schedule = setTimeout, unschedule = clearTimeout, interval = 300000 }) {
    // Window timer methods may reject a monitor instance as their receiver.
    // Wrapping also keeps injected test schedulers working without a `this` contract.
    Object.assign(this, { probe, onChange, onAvailable, schedule: (...args) => schedule(...args), unschedule: (...args) => unschedule(...args), interval });
    this.running = false; this.revision = 0;
  }
  start() { this.stop(); this.running = true; const revision = this.revision; this.tick(revision); }
  stop() { this.running = false; this.checking = false; this.revision++; this.unschedule(this.timer); this.controller?.abort(); }
  checkNow() {
    if (!this.running || this.checking) return false;
    this.unschedule(this.timer);
    this.tick(this.revision);
    return true;
  }
  async tick(revision) {
    if (!this.running || revision !== this.revision) return;
    this.checking = true;
    this.controller = new AbortController();
    this.onChange({ checking: true });
    let result;
    try { result = await this.probe(this.controller.signal); }
    catch { result = { available: false, httpStatus: 0, message: '本地服务暂不可用，等待下一次探测。' }; }
    this.checking = false;
    if (!this.running || revision !== this.revision) return;
    if (result.available) {
      this.stop(); this.onChange(result); this.onAvailable(); return;
    }
    const nextAt = Date.now() + this.interval;
    this.onChange({ ...result, nextAt });
    this.timer = this.schedule(() => this.tick(revision), this.interval);
  }
}
