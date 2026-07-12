#!/usr/bin/env node
// Sync pipeline: COROS + Oura → site/data.json
//
// Modes:
//   node sync/sync.mjs               live sync (needs COROS_EMAIL, COROS_PASSWORD, OURA_TOKEN)
//   node sync/sync.mjs --fixtures    build data.json from sync/fixtures (local dev, no creds)
//   node sync/sync.mjs --probe      login and dump raw API responses to sync/probe-output/
//
// History accumulates: each run merges into the existing data.json by date, so the
// site keeps data older than the API windows (24 weeks daily / 28 days fitness).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CorosClient, SPORT_NAMES } from './coros.mjs';
import { OuraClient } from './oura.mjs';
import { computeTrainingStatus, toDailyLoadSeries, statusForRatio, validateAgainst } from './metrics.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA_PATH = path.join(ROOT, 'site', 'data.json');
const FIXTURES = path.join(ROOT, 'sync', 'fixtures', 'coros-snapshot.json');

const ATHLETE = {
  name: 'Bradley',
  race: { name: 'Long Beach Half', date: '2026-10-10', goalSec: 1 * 3600 + 59 * 60 },
};

const iso = (d) => d.toISOString().slice(0, 10);
const compact = (s) => s.replaceAll('-', ''); // 2026-07-12 → 20260712
const fromCompact = (s) => `${String(s).slice(0, 4)}-${String(s).slice(4, 6)}-${String(s).slice(6, 8)}`;

async function loadExisting() {
  try {
    return JSON.parse(await readFile(DATA_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function mergeByDate(oldRows = [], newRows = [], key = 'date') {
  const map = new Map(oldRows.map((r) => [r[key], r]));
  for (const r of newRows) map.set(r[key], { ...map.get(r[key]), ...r });
  return [...map.values()].sort((a, b) => String(a[key]).localeCompare(String(b[key])));
}

function mergeActivities(oldActs = [], newActs = []) {
  const keyOf = (a) => a.labelId ?? `${a.date}|${a.name}|${a.sec}`;
  const map = new Map(oldActs.map((a) => [keyOf(a), a]));
  for (const a of newActs) map.set(keyOf(a), { ...map.get(keyOf(a)), ...a });
  let merged = [...map.values()];
  // Drop id-less rows (fixture/seed era) that duplicate an id'd activity with the
  // same name within a day — dates can differ by one because seeds were logged in
  // local time while the API reports epoch start times.
  const dayMs = 86400000;
  merged = merged.filter((a) => {
    if (a.labelId) return true;
    return !merged.some(
      (b) =>
        b.labelId &&
        b.name === a.name &&
        Math.abs(new Date(b.date) - new Date(a.date)) <= dayMs,
    );
  });
  return merged.sort((a, b) => b.date.localeCompare(a.date));
}

// Recursively hunt for a numeric field by key regex — used for fields whose exact
// location in the COROS payloads varies (race predictions, recovery).
function deepFind(obj, keyRe, depth = 0) {
  if (obj == null || depth > 6 || typeof obj !== 'object') return undefined;
  for (const [k, v] of Object.entries(obj)) {
    if (keyRe.test(k) && (typeof v === 'number' || typeof v === 'string')) return v;
    const found = deepFind(v, keyRe, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/* ---------------- fixtures mode ---------------- */

async function buildFromFixtures() {
  const fx = JSON.parse(await readFile(FIXTURES, 'utf8'));
  const rhrByDate = new Map(fx.restingHR.map((r) => [r.date, r.bpm]));
  const sleepByDate = new Map(fx.sleep.map((s) => [s.date, s]));
  const daily = fx.trainingLoad.map((t, i, arr) => ({
    date: t.date,
    baseFitness: t.longTerm,
    loadImpact: t.shortTerm,
    intensityTrend: t.ratio,
    status: t.status ?? statusForRatio(t.ratio, arr[i - 1]?.status ?? null),
    rhr: rhrByDate.get(t.date) ?? null,
    corosSleepScore: sleepByDate.get(t.date)?.score ?? null,
    corosSleepMin: sleepByDate.get(t.date)?.durationMin ?? null,
  }));
  return {
    generatedAt: new Date().toISOString(),
    source: 'fixtures',
    athlete: ATHLETE,
    recovery: fx.recovery,
    fitness: fx.fitness,
    daily,
    oura: [],
    activities: fx.activities,
  };
}

/* ---------------- live mode ---------------- */

function parseDailyRecords(dayList) {
  return dayList
    .filter((d) => d.happenDay)
    .map((d) => ({
      date: fromCompact(d.happenDay),
      baseFitness: d.cti != null ? Math.round(d.cti) : null,
      loadImpact: d.ati != null ? Math.round(d.ati) : null,
      intensityTrend:
        d.trainingLoadRatio != null
          ? Math.trunc(d.trainingLoadRatio * 100) / 100
          : d.cti > 0
            ? Math.trunc((d.ati / d.cti) * 100) / 100
            : null,
      trainingLoad: d.trainingLoad ?? null,
      rhr: d.rhr ?? null,
      corosHrv: d.avgSleepHrv ?? null,
    }))
    .map((d, i, arr) => ({
      ...d,
      status: d.intensityTrend != null ? statusForRatio(d.intensityTrend, arr[i - 1]?.status ?? null) : null,
    }));
}

const TZ = process.env.DASH_TZ || 'America/Los_Angeles';
const localDate = (epochSec) =>
  new Date(Number(epochSec) * 1000).toLocaleDateString('en-CA', { timeZone: TZ });

function parseActivities(items) {
  return items.map((a) => ({
    labelId: a.labelId != null ? String(a.labelId) : undefined,
    date: a.startTime ? localDate(a.startTime) : fromCompact(a.happenDay ?? ''),
    name: a.name || a.remark || SPORT_NAMES[a.sportType] || `Sport ${a.sportType}`,
    sportType: a.sportType,
    km: a.distance != null ? +(a.distance / 1000).toFixed(2) : null,
    // workoutTime is moving/workout duration (what COROS displays); totalTime includes pauses
    sec: a.workoutTime ?? a.totalTime ?? null,
    avgHr: a.avgHr ?? null,
    trainingLoad: a.trainingLoad ?? null,
  }));
}

async function pullCoros() {
  const coros = await new CorosClient({
    email: process.env.COROS_EMAIL,
    password: process.env.COROS_PASSWORD,
    region: process.env.COROS_REGION || 'us',
  }).login();

  const end = new Date();
  const start = new Date(end);
  start.setDate(end.getDate() - 7 * 24 + 1); // API max ≈ 24 weeks

  const [dayList, analyse, dashboard, acts] = await Promise.all([
    coros.dailyRecords(compact(iso(start)), compact(iso(end))),
    coros.analyse().catch((e) => (console.warn('analyse failed:', e.message), null)),
    coros.dashboard().catch((e) => (console.warn('dashboard failed:', e.message), null)),
    coros.activities({ size: 100 }).catch((e) => (console.warn('activities failed:', e.message), { items: [] })),
  ]);

  const daily = parseDailyRecords(dayList);

  // Validate the emulation against COROS's own numbers whenever we have both.
  if (daily.length > 30) {
    const series = toDailyLoadSeries(
      daily.filter((d) => d.trainingLoad != null).map((d) => ({ date: d.date, trainingLoad: d.trainingLoad })),
      daily[0].date,
      daily[daily.length - 1].date,
    );
    const truth = daily.filter((d) => d.baseFitness != null);
    console.log('emulation check vs API:', JSON.stringify(validateAgainst(computeTrainingStatus(series), truth)));
  }

  // Fitness overview: best-effort extraction; exact field names confirmed via --probe.
  const t7 = analyse?.t7dayList ?? [];
  const latestFit = [...t7].reverse().find((d) => d.vo2max != null) ?? {};
  const fitness = {
    vo2max: latestFit.vo2max ?? deepFind(analyse, /^vo2max$/i) ?? null,
    runningLevel: latestFit.staminaLevel ?? deepFind(analyse, /staminaLevel$/i) ?? null,
    thresholdPaceSecPerKm: latestFit.ltsp ?? deepFind(analyse, /^ltsp$/i) ?? null,
    predictions: {
      k5: deepFind(analyse, /^(fiveKm|predict5k|raceTime5)/i) ?? null,
      k10: deepFind(analyse, /^(tenKm|predict10k|raceTime10)/i) ?? null,
      half: deepFind(analyse, /^(halfMarathon|predictHalf)/i) ?? null,
      marathon: deepFind(analyse, /^(marathon|predictFull)/i) ?? null,
    },
  };

  const recoveryPct = deepFind(dashboard, /^(recoveryRate|tiredRate|recovery)$/i);
  const recovery = recoveryPct != null ? { percent: Number(recoveryPct), level: null, fullRecoveryHours: null } : null;

  return { daily, fitness, recovery, activities: parseActivities(acts.items), raw: { analyse, dashboard } };
}

async function pullOura() {
  if (!process.env.OURA_TOKEN) {
    console.warn('OURA_TOKEN not set — skipping Oura');
    return [];
  }
  const oura = new OuraClient({ token: process.env.OURA_TOKEN });
  const end = new Date();
  const start = new Date(end);
  start.setDate(end.getDate() - 60);
  return oura.daily(iso(start), iso(end));
}

/* ---------------- probe mode ---------------- */

async function probe() {
  const coros = await new CorosClient({
    email: process.env.COROS_EMAIL,
    password: process.env.COROS_PASSWORD,
    region: process.env.COROS_REGION || 'us',
  }).login();
  console.log('login OK');
  const outDir = path.join(ROOT, 'sync', 'probe-output');
  await mkdir(outDir, { recursive: true });
  const end = new Date();
  const start = new Date(end);
  start.setDate(end.getDate() - 28);
  const dumps = {
    'daydetail.json': () => coros.dailyRecords(compact(iso(start)), compact(iso(end))),
    'analyse.json': () => coros.analyse(),
    'dashboard.json': () => coros.dashboard(),
    'activities.json': () => coros.activities({ size: 10 }),
  };
  for (const [file, fn] of Object.entries(dumps)) {
    try {
      await writeFile(path.join(outDir, file), JSON.stringify(await fn(), null, 2));
      console.log('wrote', file);
    } catch (e) {
      console.warn(file, 'failed:', e.message);
    }
  }
}

/* ---------------- main ---------------- */

async function main() {
  const mode = process.argv[2];
  if (mode === '--probe') return probe();

  const existing = await loadExisting();
  let fresh;
  if (mode === '--fixtures') {
    fresh = await buildFromFixtures();
  } else {
    const [coros, oura] = await Promise.all([pullCoros(), pullOura()]);
    fresh = {
      generatedAt: new Date().toISOString(),
      source: 'live',
      athlete: ATHLETE,
      recovery: coros.recovery ?? existing?.recovery ?? null,
      fitness: {
        ...existing?.fitness,
        ...Object.fromEntries(Object.entries(coros.fitness).filter(([, v]) => v != null && typeof v !== 'object')),
        predictions: {
          ...existing?.fitness?.predictions,
          ...Object.fromEntries(Object.entries(coros.fitness.predictions).filter(([, v]) => v != null)),
        },
      },
      daily: coros.daily,
      oura,
      activities: coros.activities,
    };
  }

  const merged = {
    ...fresh,
    daily: mergeByDate(existing?.daily, fresh.daily),
    oura: mergeByDate(existing?.oura, fresh.oura),
    activities: mergeActivities(existing?.activities, fresh.activities),
  };

  await mkdir(path.dirname(DATA_PATH), { recursive: true });
  await writeFile(DATA_PATH, JSON.stringify(merged, null, 1));
  console.log(
    `wrote ${DATA_PATH} — ${merged.daily.length} daily records, ${merged.oura.length} oura days, ${merged.activities.length} activities (${merged.source})`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
