// @flow

import { log } from "@ledgerhq/logs";
import type { Currency, Account } from "../types";
import { flattenAccounts } from "../account";
import { getAccountCurrency } from "../account";
import { promiseAllBatched } from "../promise";
import type {
  CounterValuesState,
  CounterValuesStateRaw,
  CountervaluesSettings,
  TrackingPair,
  RateMap,
  RateGranularity,
  PairRateMapCache,
  RateMapStats,
} from "./types";
import {
  pairId,
  magFromTo,
  formatPerGranularity,
  formatCounterValueDay,
  formatCounterValueHour,
  parseFormattedDate,
  incrementPerGranularity,
  datapointLimits,
} from "./helpers";

import {
  fetchHistorical,
  fetchLatest,
  isCountervalueEnabled,
  aliasPair,
  resolveTrackingPair,
} from "./modules";

// yield raw version of the countervalues state to be saved in a db
export function exportCountervalues(
  s: CounterValuesState
): CounterValuesStateRaw {
  return { ...s.data, status: s.status };
}

// restore a countervalues state from the raw version
export function importCountervalues(
  obj: CounterValuesStateRaw,
  settings: CountervaluesSettings
): CounterValuesState {
  const data = {};
  const cache = {};
  let status = {};
  Object.keys(obj).forEach((key) => {
    if (key === "status") {
      status = obj[key];
    } else {
      data[key] = obj[key];
      cache[key] = generateCache(key, obj[key], settings);
    }
  });
  return { data, status, cache };
}

// infer the tracking pair from user accounts to know which pairs are concerned
export function inferTrackingPairForAccounts(
  accounts: Account[],
  countervalue: Currency
): TrackingPair[] {
  return resolveTrackingPairs(
    flattenAccounts(accounts).map((a) => {
      const currency = getAccountCurrency(a);
      return { from: currency, to: countervalue, startDate: a.creationDate };
    })
  );
}

export const initialState: CounterValuesState = {
  data: {},
  status: {},
  cache: {},
};

const MAX_RETRY_DELAY = 7 * incrementPerGranularity.daily;

// synchronize all countervalues incrementally (async update of the countervalues state)
export async function loadCountervalues(
  state: CounterValuesState,
  settings: CountervaluesSettings
): Promise<CounterValuesState> {
  const data = { ...state.data };
  const cache = { ...state.cache };
  const status = { ...state.status };

  const nowDate = new Date();
  const latestToFetch = settings.trackingPairs;

  // determines what historical data need to be fetched
  const histoToFetch = [];
  ["daily", "hourly"].forEach((granularity: RateGranularity) => {
    const format = formatPerGranularity[granularity];
    const earliestHisto = format(nowDate);
    log("countervalues", "earliestHisto=" + earliestHisto);

    const limit = datapointLimits[granularity];
    settings.trackingPairs.forEach(({ from, to, startDate }) => {
      const key = pairId({ from, to });
      const value: ?RateMap = data[key];
      const stats = value && rateMapStats(value);
      const s = status[key];

      // when there are too much http failures, slow down the rate to be actually re-fetched
      if (s?.failures && s.timestamp) {
        const { failures, timestamp } = s;
        const secondsBetweenRetries = Math.min(
          Math.exp(failures * 0.5),
          MAX_RETRY_DELAY
        );
        const nextTarget = timestamp + 1000 * secondsBetweenRetries;
        if (nowDate < nextTarget) {
          log(
            "countervalues",
            `${key}@${granularity} discarded: too much HTTP failures (${failures}) retry in ~${Math.round(
              (nextTarget - nowDate) / 1000
            )}s`
          );
          return;
        }
      }

      let start = startDate || nowDate;
      const limitDate = Date.now() - limit;
      if (limitDate && start < limitDate) {
        start = new Date(limitDate);
      }

      const needOlderReload =
        s && s.oldestDateRequested && start < new Date(s.oldestDateRequested);
      if (needOlderReload) {
        log(
          "countervalues",
          `${key}@${granularity} need older reload (${start.toISOString()} < ${String(
            s && s.oldestDateRequested
          )})`
        );
      }
      if (!needOlderReload) {
        // we do not miss datapoints in the past so we can ask the only remaining part
        if (stats && stats.earliestDate && stats.earliestDate > start) {
          start = stats.earliestDate;
        }
      }

      // nothing to fetch for historical
      if (format(start) === earliestHisto) return;

      histoToFetch.push([granularity, { from, to, startDate: start }, key]);
    });
  });

  log(
    "countervalues",
    `${histoToFetch.length} historical value to fetch (${settings.trackingPairs.length} pairs)`
  );

  // Fetch it all
  const [histo, latest] = await Promise.all([
    promiseAllBatched(10, histoToFetch, ([granularity, pair, key]) =>
      fetchHistorical(granularity, pair)
        .then((rates) => {
          // Update status infos
          const id = pairId(pair);
          let oldestDateRequested = status[id]?.oldestDateRequested;
          if (pair.startDate) {
            if (
              !oldestDateRequested ||
              pair.startDate < new Date(oldestDateRequested)
            ) {
              oldestDateRequested = pair.startDate.toISOString();
            }
          }
          status[id] = { timestamp: Date.now(), oldestDateRequested };
          return { [key]: rates };
        })
        .catch((e) => {
          // TODO work on the semantic of failure.
          // do we want to opt-in for the 404 cases and make other fails it all?
          // do we want to be resilient on individual pulling / keep error somewhere?
          const id = pairId(pair);

          // only on HTTP error, we count the failures (not network down case)
          if (e && typeof e.status === "number" && e.status) {
            const s = status[id];
            status[id] = {
              timestamp: Date.now(),
              failures: (s?.failures || 0) + 1,
              oldestDateRequested: s?.oldestDateRequested,
            };
          }

          log(
            "countervalues-error",
            `Failed to fetch ${granularity} history for ${pair.from.ticker}-${
              pair.to.ticker
            } ${String(e)}`
          );
          return null;
        })
    ),
    fetchLatest(latestToFetch)
      .then((rates) => {
        const out = {};
        let hasData = false;
        latestToFetch.forEach((pair, i) => {
          const key = pairId(pair);
          const latest = rates[i];
          if (data[key]?.latest === latest) return;
          out[key] = { latest: rates[i] };
          hasData = true;
        });
        if (!hasData) return null;
        return out;
      })
      .catch((e) => {
        log(
          "countervalues-error",
          "Failed to fetch latest for " +
            latestToFetch
              .map((p) => `${p.from.ticker}-${p.to.ticker}`)
              .join(",") +
            " " +
            String(e)
        );
        return null;
      }),
  ]);

  const updates = histo.concat(latest).filter(Boolean);

  log("countervalues", updates.length + " updates to apply");

  const changesKeys = {};
  updates.forEach((patch) => {
    Object.keys(patch).forEach((key) => {
      changesKeys[key] = 1;
      data[key] = { ...data[key], ...patch[key] };
    });
  });

  // synchronize the cache
  Object.keys(changesKeys).forEach((pair) => {
    cache[pair] = generateCache(pair, data[pair], settings);
  });

  return { data, cache, status };
}

export function lenseRateMap(
  state: CounterValuesState,
  pair: { from: Currency, to: Currency }
): ?PairRateMapCache {
  if (!isCountervalueEnabled(pair.from) || !isCountervalueEnabled(pair.to)) {
    return;
  }
  const rateId = pairId(pair);
  return state.cache[rateId];
}

export function lenseRate(
  { stats, fallback, map }: PairRateMapCache,
  query: {
    from: Currency,
    to: Currency,
    date?: ?Date,
  }
): ?number {
  const { date } = query;
  if (!date) return map.latest;
  const hourFormat = formatCounterValueHour(date);
  if (hourFormat in map) return map[hourFormat];
  const dayFormat = formatCounterValueDay(date);
  if (dayFormat in map) return map[dayFormat];
  if (stats.earliest && dayFormat > stats.earliest) return map.latest;
  return fallback;
}

export function calculate(
  state: CounterValuesState,
  initialQuery: {
    value: number,
    from: Currency,
    to: Currency,
    disableRounding?: boolean,
    date?: ?Date,
    reverse?: boolean,
  }
): ?number {
  const { from, to } = aliasPair({
    from: initialQuery.from,
    to: initialQuery.to,
  });
  if (from === to) return initialQuery.value;
  const query = { ...initialQuery, from, to };
  const map = lenseRateMap(state, query);
  if (!map) return;
  const rate = lenseRate(map, query);
  if (!rate) return;
  const { value, disableRounding } = query;
  const val = !initialQuery.reverse
    ? value * rate * magFromTo(from, to)
    : (value / rate) * magFromTo(to, from);
  return disableRounding ? val : Math.round(val);
}

export function calculateMany(
  state: CounterValuesState,
  dataPoints: Array<{ value: number, date: ?Date }>,
  initialQuery: {
    from: Currency,
    to: Currency,
    disableRounding?: boolean,
    reverse?: boolean,
  }
): Array<?number> {
  const query = aliasPair(initialQuery);
  const map = lenseRateMap(state, query);
  if (!map) return Array(dataPoints.length).fill(); // undefined array
  const { from, to } = query;
  return dataPoints.map(({ value, date }) => {
    if (from === to) return value;
    const rate = lenseRate(map, { from, to, date });
    if (!rate) return;
    const val = !initialQuery.reverse
      ? value * rate * magFromTo(from, to)
      : (value / rate) * magFromTo(to, from);
    return initialQuery.disableRounding ? val : Math.round(val);
  });
}

function rateMapStats(map: RateMap): RateMapStats {
  const sorted = Object.keys(map)
    .sort()
    .filter((k) => k !== "latest");
  const oldest = sorted[0];
  const earliest = sorted[sorted.length - 1];
  const oldestDate = oldest ? parseFormattedDate(oldest) : null;
  const earliestDate = earliest ? parseFormattedDate(earliest) : null;
  return { oldest, earliest, oldestDate, earliestDate };
}

function generateCache(
  pair: string,
  rateMap: RateMap,
  settings: CountervaluesSettings
): PairRateMapCache {
  const map = { ...rateMap };
  const stats = rateMapStats(map);
  let fallback;

  const { oldest, oldestDate } = stats;
  if (settings.autofillGaps) {
    if (oldestDate && oldest) {
      // shifting daily gaps (hourly don't need to be shifted as it automatically fallback on a day rate)
      const now = Date.now();
      const oldestTime = oldestDate.getTime();
      let shiftingValue = map[oldest];
      fallback = shiftingValue;
      for (let t = oldestTime; t < now; t += incrementPerGranularity.daily) {
        const k = formatCounterValueDay(new Date(t));
        if (!(k in map)) {
          map[k] = shiftingValue;
        } else {
          shiftingValue = map[k];
        }
      }
      if (!map.latest) {
        map.latest = shiftingValue;
      }
    } else {
      fallback = map.latest || 0;
    }
  }

  return { map, stats, fallback };
}

// apply dedup & aliasing logics
export function resolveTrackingPairs(pairs: TrackingPair[]): TrackingPair[] {
  const d: { [_: string]: TrackingPair } = {};
  pairs.map((p) => {
    const { from, to } = resolveTrackingPair({ from: p.from, to: p.to });
    if (!isCountervalueEnabled(from) || !isCountervalueEnabled(to)) return;
    if (from === to) return;
    // dedup and keep oldest date
    let date = p.startDate;
    const k = pairId(p);
    if (d[k]) {
      const { startDate } = d[k];
      if (startDate && date) {
        date = date < startDate ? date : startDate;
      }
    }
    d[k] = { from, to, startDate: date };
  });
  // $FlowFixMe -_-
  return Object.values(d);
}