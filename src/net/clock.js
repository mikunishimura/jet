// Shared clock (NTP-style). The server's monotonic seconds are the timeline
// every snapshot is stamped with; each client estimates offset = server - local
// from ping / pong pairs and trusts the lowest-RTT samples (least queueing,
// least asymmetry). The estimate slews instead of jumping, so dead reckoning
// never sees time step backwards.
const SLEW = 0.004; // s of correction per s of real time

export class ClockSync {
  constructor() { this.samples = []; this.offset = 0; this.target = 0; this.rtt = 0; this.synced = false; }

  /** t0: local send time, ts: server time, t1: local receive time (seconds) */
  sample(t0, ts, t1) {
    const rtt = Math.max(0, t1 - t0);
    this.samples.push({ rtt, offset: ts + rtt / 2 - t1 });
    if (this.samples.length > 24) this.samples.shift();
    // median offset of the round trips near the fastest one: queueing only ever adds
    // delay, so the fastest round trips carry the least asymmetry (NTP's clock filter)
    const sorted = [...this.samples].sort((a, b) => a.rtt - b.rtt);
    const best = sorted.filter((x) => x.rtt <= sorted[0].rtt * 1.5 + 0.001);
    const offs = best.map((s) => s.offset).sort((a, b) => a - b);
    this.target = offs[offs.length >> 1];
    this.rtt = best[best.length >> 1].rtt;
    if (!this.synced) { this.offset = this.target; this.synced = true; }
  }

  /** advance the slew (call once per frame with the real dt) */
  tick(dt) {
    const e = this.target - this.offset, max = SLEW * dt;
    this.offset += Math.abs(e) > 0.25 ? e : Math.max(-max, Math.min(max, e)); // big errors (first sync, sleep) jump
  }

  now(local) { return local + this.offset; }
}
