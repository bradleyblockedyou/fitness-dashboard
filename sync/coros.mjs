// COROS Training Hub client (unofficial API — same endpoints the web app uses).
// Auth: POST /account/login with MD5-hashed password → accessToken header on all calls.
// Endpoints verified against open-source clients (cygnusb/coros-mcp, NYT87/coros-connect).

import { createHash } from 'node:crypto';

const BASE_URLS = {
  us: 'https://teamapi.coros.com',
  eu: 'https://teameuapi.coros.com',
  cn: 'https://teamcnapi.coros.com',
};

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

export class CorosClient {
  constructor({ email, password, region = 'us' }) {
    if (!email || !password) throw new Error('COROS_EMAIL and COROS_PASSWORD are required');
    this.email = email;
    this.password = password;
    this.base = BASE_URLS[region] ?? BASE_URLS.us;
    this.accessToken = null;
    this.userId = null;
  }

  async login() {
    const pwd = createHash('md5').update(this.password).digest('hex');
    const res = await fetch(`${this.base}/account/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify({ account: this.email, accountType: 2, pwd }),
    });
    const body = await res.json();
    if (body.result !== '0000') {
      throw new Error(`COROS login failed: ${body.message ?? 'unknown'} (result=${body.result})`);
    }
    this.accessToken = body.data.accessToken;
    this.userId = String(body.data.userId ?? '');
    return this;
  }

  headers() {
    return {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
      accessToken: this.accessToken,
      yfheader: JSON.stringify({ userId: this.userId }),
    };
  }

  async get(path, params = {}) {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const res = await fetch(url, { headers: this.headers() });
    const body = await res.json();
    if (body.result !== '0000') {
      throw new Error(`COROS ${path} error: ${body.message ?? 'unknown'} (result=${body.result})`);
    }
    return body.data;
  }

  // Daily records for a date range (up to ~24 weeks): happenDay, rhr, trainingLoad,
  // ati (Load Impact / 7d), cti (Base Fitness / 42d), trainingLoadRatio, avgSleepHrv, …
  async dailyRecords(startDay, endDay) {
    const data = await this.get('/analyse/dayDetail/query', { startDay, endDay });
    return data?.dayList ?? [];
  }

  // Last ~28 days incl. vo2max, lthr, ltsp (threshold pace s/km), staminaLevel — plus summary.
  async analyse() {
    return this.get('/analyse/query');
  }

  // Recent summary widgets: HRV (summaryInfo.sleepHrvData), recovery, etc.
  async dashboard() {
    return this.get('/dashboard/query');
  }

  async activities({ size = 50, pageNumber = 1 } = {}) {
    const data = await this.get('/activity/query', { size, pageNumber });
    return { items: data?.dataList ?? data?.list ?? [], total: data?.totalCount ?? data?.count ?? 0 };
  }
}

export const SPORT_NAMES = {
  100: 'Running', 102: 'Trail Running', 103: 'Track Running', 104: 'Hiking',
  200: 'Road Bike', 201: 'Indoor Cycling', 203: 'Gravel Bike', 204: 'MTB',
  400: 'Cardio', 402: 'Strength', 403: 'Yoga', 900: 'Walking',
};
