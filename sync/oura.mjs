// Oura API v2 client (official, personal access token).
// Docs: https://cloud.ouraring.com/v2/docs

const BASE = 'https://api.ouraring.com/v2/usercollection';

export class OuraClient {
  constructor({ token }) {
    if (!token) throw new Error('OURA_TOKEN is required');
    this.token = token;
  }

  async get(path, params = {}) {
    const url = new URL(`${BASE}/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const res = await fetch(url, { headers: { Authorization: `Bearer ${this.token}` } });
    if (!res.ok) throw new Error(`Oura ${path} error: HTTP ${res.status} ${await res.text()}`);
    const body = await res.json();
    return body.data ?? [];
  }

  // Merged daily view: readiness score, sleep score, avg overnight HRV, lowest overnight HR.
  async daily(startDate, endDate) {
    const params = { start_date: startDate, end_date: endDate };
    const [readiness, dailySleep, sleepPeriods] = await Promise.all([
      this.get('daily_readiness', params),
      this.get('daily_sleep', params),
      this.get('sleep', params), // long-form periods carry average_hrv & total durations
    ]);

    const byDate = new Map();
    const day = (d) => byDate.get(d) ?? byDate.set(d, { date: d }).get(d);

    for (const r of readiness) day(r.day).readiness = r.score;
    for (const s of dailySleep) day(s.day).sleepScore = s.score;
    for (const p of sleepPeriods) {
      if (p.type !== 'long_sleep' && p.type !== 'sleep') continue;
      const rec = day(p.day);
      if (p.average_hrv != null) rec.hrv = p.average_hrv;
      if (p.lowest_heart_rate != null) rec.lowestHr = p.lowest_heart_rate;
      if (p.total_sleep_duration != null) rec.sleepMin = Math.round(p.total_sleep_duration / 60);
    }
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  }
}
