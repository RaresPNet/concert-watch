/**
 * scripts/seed-reach.ts
 *
 * Populates the D1 `origins` and `reachability` tables (DESIGN.md §4, §7)
 * from the hand-researched route topology in `data/origins.json` and
 * `data/routes.json`. Idempotent: re-running after refreshing the two data
 * files (the monthly reachability refresh, §7/§6.4) replaces every row with
 * a freshly-derived one rather than accumulating duplicates.
 *
 * This is a maintenance script run outside the Worker (D1 bindings only
 * exist in the Workers runtime), not code the Worker imports. It shells out
 * to `wrangler d1 execute` to apply the SQL it derives, the same way you'd
 * apply a migration by hand.
 *
 * Tier derivation follows DESIGN.md §7.2:
 *   A — direct flight from an origin to the event city, or ≤60min ground
 *       from the arrival airport to the city centre.
 *   B — direct flight from an origin, then ≤3h train/ground: either (a) the
 *       arrival airport itself is 60–180min from the city centre (e.g.
 *       Beauvais→Paris), or (b) a further `ground_links` hop carries you
 *       from the directly-served city to a different, nearby one (e.g.
 *       Munich→Salzburg) in ≤180min.
 *   C — for CLJ specifically: direct from a secondary origin (BUD/OMR/SBZ/
 *       OTP/IAS), or drivable from Cluj (≤600km by road). For every origin
 *       (including CLJ): any other city we have a direct route to that
 *       didn't qualify for A/B — i.e. "one connection" territory, since a
 *       one-hop connection through that origin's own network is always
 *       findable in practice.
 *   D — nothing else known. Not expected to appear in this seed, since every
 *       city in the dataset arrived via a real direct route from one of the
 *       six origins; D is here for later manual/model-added rows for cities
 *       with no direct service anywhere nearby.
 *
 * Usage:
 *   node --experimental-strip-types scripts/seed-reach.ts --check
 *     Pure derivation, no DB. Prints row counts and the spot-checks named in
 *     IMPLEMENTATION_PLAN.md S1.2 (tier A for Leeds/London/Milan/Barcelona
 *     and Vienna from CLJ — direct Animawings service confirmed 2026-09 —
 *     tier C for Budapest from CLJ).
 *
 *   node --experimental-strip-types scripts/seed-reach.ts --sql > seed.sql
 *     Emit the idempotent SQL without running anything.
 *
 *   node --experimental-strip-types scripts/seed-reach.ts --local
 *   node --experimental-strip-types scripts/seed-reach.ts --remote
 *     Derive the SQL and apply it via `wrangler d1 execute concert-watch`
 *     against the local or remote D1 instance.
 */

import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const ROOT = join(import.meta.dirname, "..");
const D1_DATABASE_NAME = "concert-watch";

type OriginRow = {
  iata: string;
  name: string;
  drive_km: number;
  drive_minutes: number;
  penalty_minutes: number;
  notes?: string;
};

type RouteRow = {
  origin_iata: string;
  airline: string;
  dest_iata: string;
  dest_city: string;
  dest_country: string;
  city_key: string;
  ground_minutes: number;
  ground_note: string | null;
  weekly_frequency: number | null;
  days: string[] | null;
  seasonal: boolean;
};

type GroundLink = {
  from_city_key: string;
  to_city: string;
  to_country: string;
  to_cc: string;
  ground_minutes: number;
  mode: string;
  approximate: boolean;
  note: string;
};

type DrivableEntry = { city_key: string; km: number; note?: string };

type OriginsFile = { origins: OriginRow[] };
type RoutesFile = {
  routes: RouteRow[];
  ground_links: GroundLink[];
  drivable_from_cluj_km: DrivableEntry[];
};

const TIER_ORDER = { A: 0, B: 1, C: 2, D: 3 } as const;
type Tier = keyof typeof TIER_ORDER;

type Reachability = {
  city_key: string;
  origin_iata: string;
  tier: Tier;
  route_note: string;
};

function loadData(): { origins: OriginRow[]; routes: RouteRow[]; groundLinks: GroundLink[]; drivable: DrivableEntry[] } {
  const originsFile: OriginsFile = JSON.parse(readFileSync(join(ROOT, "data/origins.json"), "utf8"));
  const routesFile: RoutesFile = JSON.parse(readFileSync(join(ROOT, "data/routes.json"), "utf8"));
  return {
    origins: originsFile.origins,
    routes: routesFile.routes,
    groundLinks: routesFile.ground_links,
    drivable: routesFile.drivable_from_cluj_km,
  };
}

function freqSuffix(r: RouteRow): string {
  if (r.seasonal) return r.weekly_frequency ? `, seasonal, ~${r.weekly_frequency}/wk` : ", seasonal";
  if (r.weekly_frequency) return `, ~${r.weekly_frequency}/wk`;
  return "";
}

/** Derive tier + route_note for every (city_key, origin_iata) pair the route data can support. */
function deriveReachability(
  origins: OriginRow[],
  routes: RouteRow[],
  groundLinks: GroundLink[],
  drivable: DrivableEntry[]
): Reachability[] {
  const originIatas = origins.map((o) => o.iata);
  const cityKeys = new Set<string>(routes.map((r) => r.city_key));
  for (const d of drivable) cityKeys.add(d.city_key);

  // Best (lowest-ground-time) direct route per (origin, city_key), so a city
  // served by two airlines from the same origin gets one row, not two.
  const bestDirect = new Map<string, RouteRow>();
  for (const r of routes) {
    const key = `${r.origin_iata}|${r.city_key}`;
    const existing = bestDirect.get(key);
    if (!existing || r.ground_minutes < existing.ground_minutes) bestDirect.set(key, r);
  }

  // Ground links indexed by the city they depart from.
  const linksFrom = new Map<string, GroundLink[]>();
  for (const g of groundLinks) {
    const arr = linksFrom.get(g.from_city_key) ?? [];
    arr.push(g);
    linksFrom.set(g.from_city_key, arr);
  }

  const drivableKm = new Map(drivable.map((d) => [d.city_key, d]));

  // Each secondary origin's own home city, keyed by iata, e.g. BUD -> "hu:budapest".
  // Used to stop the derivation suggesting "fly OTP->BUD" to reach a Budapest
  // show when driving there directly is obviously the sane answer.
  const originHomeCityKeys = new Map<string, string>([
    ["BUD", "hu:budapest"],
    ["OMR", "ro:oradea"],
    ["SBZ", "ro:sibiu"],
    ["OTP", "ro:bucharest"],
    ["IAS", "ro:iasi"],
  ]);

  const result: Reachability[] = [];

  for (const originIata of originIatas) {
    for (const cityKey of cityKeys) {
      const direct = bestDirect.get(`${originIata}|${cityKey}`);

      // A: direct flight, ≤60min ground from the arrival airport.
      if (direct && direct.ground_minutes <= 60) {
        result.push({
          city_key: cityKey,
          origin_iata: originIata,
          tier: "A",
          route_note: `direct ${originIata}→${direct.dest_iata}, ${direct.airline}${freqSuffix(direct)}`,
        });
        continue;
      }

      // B(a): direct flight, 60–180min ground from the arrival airport itself.
      if (direct && direct.ground_minutes <= 180) {
        result.push({
          city_key: cityKey,
          origin_iata: originIata,
          tier: "B",
          route_note: `direct ${originIata}→${direct.dest_iata}, ${direct.airline}${freqSuffix(direct)}, then ~${direct.ground_minutes}min ground into ${direct.dest_city}${direct.ground_note ? ` (${direct.ground_note})` : ""}`,
        });
        continue;
      }

      // B(b): direct flight to a nearby A-tier hub city, then a ground_links
      // hop (≤180min) from that hub to this (different) city_key.
      let tierB: Reachability | null = null;
      for (const [hubKey, hubDirect] of bestDirect.entries()) {
        const [hubOrigin, hubCityKey] = hubKey.split("|");
        if (hubOrigin !== originIata || hubDirect.ground_minutes > 60) continue;
        const hops = linksFrom.get(hubCityKey) ?? [];
        for (const hop of hops) {
          if (hop.ground_minutes > 180) continue;
          const hopCityKey = `${hop.to_cc}:${hop.to_city.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")}`;
          if (hopCityKey !== cityKey) continue;
          tierB = {
            city_key: cityKey,
            origin_iata: originIata,
            tier: "B",
            route_note: `direct ${originIata}→${hubDirect.dest_iata}, ${hubDirect.airline}${freqSuffix(hubDirect)}, then ~${hop.ground_minutes}min ${hop.mode} to ${hop.to_city}${hop.approximate ? " (approx.)" : ""}`,
          };
          break;
        }
        if (tierB) break;
      }
      if (tierB) {
        result.push(tierB);
        continue;
      }

      // C, CLJ only: direct from a secondary origin, or drivable from Cluj
      // (≤600km). When the destination city IS one of our own origin
      // airports' home city (Budapest, Oradea, Sibiu, Bucharest, Iași),
      // driving straight there is always the sane answer — never suggest
      // flying through a second airport to reach the city you'd fly out of.
      if (originIata === "CLJ") {
        const isOriginHomeCity = [...originHomeCityKeys.values()].includes(cityKey);

        if (!isOriginHomeCity) {
          let secondary: { origin: string; route: RouteRow } | null = null;
          for (const otherOrigin of originIatas) {
            if (otherOrigin === "CLJ") continue;
            const otherDirect = bestDirect.get(`${otherOrigin}|${cityKey}`);
            if (otherDirect && otherDirect.ground_minutes <= 180) {
              if (!secondary || otherDirect.ground_minutes < secondary.route.ground_minutes) {
                secondary = { origin: otherOrigin, route: otherDirect };
              }
            }
          }
          if (secondary) {
            result.push({
              city_key: cityKey,
              origin_iata: originIata,
              tier: "C",
              route_note: `no direct CLJ route; direct ${secondary.origin}→${secondary.route.dest_iata}, ${secondary.route.airline}${freqSuffix(secondary.route)} (drive/connect via ${secondary.origin})`,
            });
            continue;
          }
        }

        // C, CLJ only: drivable from Cluj, ≤600km by road.
        const d = drivableKm.get(cityKey);
        if (d && d.km <= 600) {
          result.push({
            city_key: cityKey,
            origin_iata: originIata,
            tier: "C",
            route_note: `drivable from Cluj, ~${d.km}km${d.note ? ` (${d.note})` : ""}`,
          });
          continue;
        }
      }

      // C, any origin: a direct route exists but didn't qualify for A/B
      // above (long airport transfer) — still one hop, just an awkward one.
      if (direct) {
        result.push({
          city_key: cityKey,
          origin_iata: originIata,
          tier: "C",
          route_note: `direct ${originIata}→${direct.dest_iata}, ${direct.airline}${freqSuffix(direct)}, then ~${direct.ground_minutes}min ground into ${direct.dest_city}`,
        });
        continue;
      }

      // D: nothing else known from this origin. Only emit a row when we at
      // least know the city exists in our dataset (served by some origin),
      // so we're recording "reachable, but not well from here" rather than
      // inventing data for a city we've never actually researched.
      result.push({
        city_key: cityKey,
        origin_iata: originIata,
        tier: "D",
        route_note: `no direct or short-connection route found from ${originIata}`,
      });
    }
  }

  return result;
}

function toSql(origins: OriginRow[], reach: Reachability[]): string {
  const esc = (s: string | null) => (s === null ? "NULL" : `'${s.replace(/'/g, "''")}'`);
  const lines: string[] = [];
  lines.push("BEGIN TRANSACTION;");
  lines.push("DELETE FROM origins;");
  lines.push("DELETE FROM reachability;");
  for (const o of origins) {
    lines.push(
      `INSERT INTO origins (iata, name, drive_km, drive_minutes, penalty_minutes) VALUES (${esc(o.iata)}, ${esc(o.name)}, ${o.drive_km}, ${o.drive_minutes}, ${o.penalty_minutes});`
    );
  }
  for (const r of reach) {
    lines.push(
      `INSERT INTO reachability (city_key, origin_iata, tier, route_note, computed_at) VALUES (${esc(r.city_key)}, ${esc(r.origin_iata)}, ${esc(r.tier)}, ${esc(r.route_note)}, datetime('now'));`
    );
  }
  lines.push("COMMIT;");
  return lines.join("\n") + "\n";
}

function runSpotChecks(reach: Reachability[]): boolean {
  const by = new Map(reach.map((r) => [`${r.city_key}|${r.origin_iata}`, r]));
  const checks: Array<{ label: string; city_key: string; origin: string; expect: Tier }> = [
    { label: "Leeds from CLJ", city_key: "gb:leeds", origin: "CLJ", expect: "A" },
    { label: "London from CLJ", city_key: "gb:london", origin: "CLJ", expect: "A" },
    { label: "Milan from CLJ", city_key: "it:milan", origin: "CLJ", expect: "A" },
    { label: "Barcelona from CLJ", city_key: "es:barcelona", origin: "CLJ", expect: "A" },
    { label: "Budapest from CLJ", city_key: "hu:budapest", origin: "CLJ", expect: "C" },
    { label: "Vienna from CLJ", city_key: "at:vienna", origin: "CLJ", expect: "A" },
  ];
  let ok = true;
  for (const c of checks) {
    const row = by.get(`${c.city_key}|${c.origin}`);
    const got = row?.tier ?? "(missing)";
    const pass = got === c.expect;
    if (!pass) ok = false;
    console.log(`${pass ? "PASS" : "FAIL"}  ${c.label}: expected ${c.expect}, got ${got}${row ? `  — ${row.route_note}` : ""}`);
  }
  return ok;
}

function main() {
  const args = process.argv.slice(2);
  const { origins, routes, groundLinks, drivable } = loadData();
  const reach = deriveReachability(origins, routes, groundLinks, drivable);

  if (args.includes("--check") || args.length === 0) {
    console.log(`origins: ${origins.length}`);
    console.log(`routes: ${routes.length}`);
    console.log(`distinct city_keys: ${new Set(routes.map((r) => r.city_key)).size}`);
    console.log(`reachability rows derived: ${reach.length}`);
    const tierCounts = reach.reduce<Record<string, number>>((acc, r) => {
      acc[r.tier] = (acc[r.tier] ?? 0) + 1;
      return acc;
    }, {});
    console.log("tier distribution:", tierCounts);
    console.log("");
    const ok = runSpotChecks(reach);
    if (!ok) process.exitCode = 1;
    return;
  }

  const sql = toSql(origins, reach);

  if (args.includes("--sql")) {
    process.stdout.write(sql);
    return;
  }

  if (args.includes("--local") || args.includes("--remote")) {
    const mode = args.includes("--remote") ? "--remote" : "--local";
    const dir = mkdtempSync(join(tmpdir(), "seed-reach-"));
    const file = join(dir, "seed.sql");
    writeFileSync(file, sql);
    console.log(`Applying ${reach.length} reachability rows + ${origins.length} origins to D1 (${mode})...`);
    execFileSync(
      "npx",
      ["wrangler", "d1", "execute", D1_DATABASE_NAME, mode, "--file", file],
      { stdio: "inherit", cwd: ROOT, shell: true }
    );
    console.log("Done.");
    return;
  }

  console.error("Usage: seed-reach.ts [--check | --sql | --local | --remote]");
  process.exitCode = 1;
}

main();
