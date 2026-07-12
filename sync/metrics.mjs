// COROS Training Status emulation, per COROS's published definitions:
//   Base Fitness    = weighted 42-day rolling average of daily training load (CTL-style)
//   Load Impact     = 7-day rolling average of daily training load (ATL-style)
//   Intensity Trend = Load Impact / Base Fitness
// Zones: >150% Excessive · 100–149% Optimized · 80–99% Maintaining ·
//        50–79% Resuming/Performance (history-dependent) · <50% Decreasing
// Used as a fallback / extension when the API's own ati/cti series has gaps.

export function statusForRatio(ratio, prevStatus = null) {
  const pct = ratio * 100;
  if (pct >= 150) return 'Excessive';
  if (pct >= 100) return 'Optimized';
  if (pct >= 80) return 'Maintaining';
  if (pct >= 50) return prevStatus === 'Decreasing' ? 'Resuming' : 'Performance';
  return 'Decreasing';
}

// Exponentially-weighted rolling averages (the standard CTL/ATL impulse-response
// model, time constants 42d / 7d). loads: [{date, load}] sorted ascending, one
// entry per calendar day (0 for rest days).
export function computeTrainingStatus(loads) {
  let cti = 0, ati = 0;
  const kC = 1 - Math.exp(-1 / 42);
  const kA = 1 - Math.exp(-1 / 7);
  const out = [];
  let prevStatus = null;
  for (const { date, load } of loads) {
    cti += (load - cti) * kC;
    ati += (load - ati) * kA;
    const ratio = cti > 0 ? Math.trunc((ati / cti) * 100) / 100 : 0;
    const status = statusForRatio(ratio, prevStatus);
    out.push({ date, baseFitness: Math.round(cti), loadImpact: Math.round(ati), intensityTrend: ratio, status });
    prevStatus = status;
  }
  return out;
}

// Fill calendar gaps with zero-load days so rolling averages decay correctly.
export function toDailyLoadSeries(activities, startDate, endDate) {
  const byDate = new Map();
  for (const a of activities) {
    if (a.trainingLoad == null) continue;
    byDate.set(a.date, (byDate.get(a.date) ?? 0) + a.trainingLoad);
  }
  const out = [];
  for (let d = new Date(`${startDate}T12:00:00Z`); ; d.setUTCDate(d.getUTCDate() + 1)) {
    const date = d.toISOString().slice(0, 10);
    if (date > endDate) break;
    out.push({ date, load: byDate.get(date) ?? 0 });
  }
  return out;
}

// Compare an emulated series against API-provided truth; returns mean absolute error
// per field so we can verify the emulation before trusting it for gap-filling.
export function validateAgainst(emulated, truth) {
  const emByDate = new Map(emulated.map((r) => [r.date, r]));
  let n = 0, bfErr = 0, liErr = 0;
  for (const t of truth) {
    const e = emByDate.get(t.date);
    if (!e) continue;
    n++;
    bfErr += Math.abs(e.baseFitness - t.baseFitness);
    liErr += Math.abs(e.loadImpact - t.loadImpact);
  }
  return n ? { days: n, maeBaseFitness: bfErr / n, maeLoadImpact: liErr / n } : { days: 0 };
}
