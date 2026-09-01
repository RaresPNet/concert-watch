/**
 * Tiny typed query layer over D1. No ORM — plain prepared statements wrapped
 * in functions that return the row types from `schema.ts`. This file
 * deliberately contains no business logic (no clustering, no notification
 * decisions, no mail handling): just reads and writes shaped to match the
 * tables in `migrations/`.
 *
 * Conventions:
 * - Every function takes `db: D1Database` first (the `DB` binding from `Env`).
 * - Insert helpers return the created row's `id` (or full key for tables
 *   without a surrogate key) rather than re-selecting, to keep round trips
 *   cheap; callers that need the full row call the matching `getBy*`.
 * - Booleans are stored as SQLite integers (0/1), matching `schema.ts`.
 */

import type {
  ArtistCoverage,
  ArtistRow,
  EventRow,
  InboxRow,
  InboxStatus,
  NotificationRow,
  NotificationTrigger,
  OriginRow,
  Priority,
  ReachabilityRow,
  SourceHealthRow,
  SubscriberRow,
  SubscriberStatus,
  TourRow,
  UsageRow,
  WatchlistRow,
} from './schema';

// ---------------------------------------------------------------------------
// subscribers
// ---------------------------------------------------------------------------

export async function insertSubscriber(
  db: D1Database,
  input: { email: string; display_name?: string | null; status?: SubscriberStatus },
): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO subscribers (email, display_name, status) VALUES (?, ?, ?) RETURNING id`,
    )
    .bind(input.email, input.display_name ?? null, input.status ?? 'invited')
    .first<{ id: number }>();
  if (!result) throw new Error('insertSubscriber: insert did not return an id');
  return result.id;
}

export async function getSubscriberById(db: D1Database, id: number): Promise<SubscriberRow | null> {
  return db.prepare(`SELECT * FROM subscribers WHERE id = ?`).bind(id).first<SubscriberRow>();
}

export async function getSubscriberByEmail(db: D1Database, email: string): Promise<SubscriberRow | null> {
  return db.prepare(`SELECT * FROM subscribers WHERE email = ?`).bind(email).first<SubscriberRow>();
}

export async function setSubscriberVerifiedAt(db: D1Database, id: number, verifiedAt: string): Promise<void> {
  await db.prepare(`UPDATE subscribers SET verified_at = ? WHERE id = ?`).bind(verifiedAt, id).run();
}

export async function appendSubscriberPreference(db: D1Database, id: number, note: string): Promise<void> {
  // Appends free text, one line per call — see DESIGN.md §11.3.
  await db
    .prepare(
      `UPDATE subscribers
       SET preferences = COALESCE(preferences || char(10), '') || ?
       WHERE id = ?`,
    )
    .bind(note, id)
    .run();
}

// ---------------------------------------------------------------------------
// artists
// ---------------------------------------------------------------------------

export async function insertArtist(
  db: D1Database,
  input: {
    mbid?: string | null;
    name: string;
    sort_name?: string | null;
    tm_attraction_id?: string | null;
    bit_slug?: string | null;
    songkick_id?: string | null;
    official_url?: string | null;
    tour_url?: string | null;
    image_url?: string | null;
    logo_url?: string | null;
    coverage?: ArtistCoverage;
    resolution_notes?: string | null;
  },
): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO artists (
        mbid, name, sort_name, tm_attraction_id, bit_slug, songkick_id,
        official_url, tour_url, image_url, logo_url, coverage, resolution_notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id`,
    )
    .bind(
      input.mbid ?? null,
      input.name,
      input.sort_name ?? null,
      input.tm_attraction_id ?? null,
      input.bit_slug ?? null,
      input.songkick_id ?? null,
      input.official_url ?? null,
      input.tour_url ?? null,
      input.image_url ?? null,
      input.logo_url ?? null,
      input.coverage ?? 'unknown',
      input.resolution_notes ?? null,
    )
    .first<{ id: number }>();
  if (!result) throw new Error('insertArtist: insert did not return an id');
  return result.id;
}

export async function getArtistById(db: D1Database, id: number): Promise<ArtistRow | null> {
  return db.prepare(`SELECT * FROM artists WHERE id = ?`).bind(id).first<ArtistRow>();
}

export async function getArtistByMbid(db: D1Database, mbid: string): Promise<ArtistRow | null> {
  return db.prepare(`SELECT * FROM artists WHERE mbid = ?`).bind(mbid).first<ArtistRow>();
}

export async function touchArtistPolled(db: D1Database, id: number, polledAt: string): Promise<void> {
  await db.prepare(`UPDATE artists SET last_polled_at = ? WHERE id = ?`).bind(polledAt, id).run();
}

// ---------------------------------------------------------------------------
// watchlist
// ---------------------------------------------------------------------------

export async function addToWatchlist(
  db: D1Database,
  input: { subscriber_id: number; artist_id: number; priority: Priority },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO watchlist (subscriber_id, artist_id, priority) VALUES (?, ?, ?)
       ON CONFLICT (subscriber_id, artist_id) DO UPDATE SET priority = excluded.priority`,
    )
    .bind(input.subscriber_id, input.artist_id, input.priority)
    .run();
}

export async function getWatchlistForSubscriber(db: D1Database, subscriberId: number): Promise<WatchlistRow[]> {
  const result = await db
    .prepare(`SELECT * FROM watchlist WHERE subscriber_id = ?`)
    .bind(subscriberId)
    .all<WatchlistRow>();
  return result.results;
}

/** The daily poll set: every artist watched by at least one subscriber (DESIGN.md §4). */
export async function getDistinctWatchedArtistIds(db: D1Database): Promise<number[]> {
  const result = await db.prepare(`SELECT DISTINCT artist_id FROM watchlist`).all<{ artist_id: number }>();
  return result.results.map((r) => r.artist_id);
}

// ---------------------------------------------------------------------------
// tours
// ---------------------------------------------------------------------------

export async function insertTour(
  db: D1Database,
  input: {
    artist_id: number;
    label?: string | null;
    official_url?: string | null;
    announced_on?: string | null;
    date_count?: number | null;
    first_date?: string | null;
    last_date?: string | null;
  },
): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO tours (artist_id, label, official_url, announced_on, date_count, first_date, last_date)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    )
    .bind(
      input.artist_id,
      input.label ?? null,
      input.official_url ?? null,
      input.announced_on ?? null,
      input.date_count ?? null,
      input.first_date ?? null,
      input.last_date ?? null,
    )
    .first<{ id: number }>();
  if (!result) throw new Error('insertTour: insert did not return an id');
  return result.id;
}

export async function getTourById(db: D1Database, id: number): Promise<TourRow | null> {
  return db.prepare(`SELECT * FROM tours WHERE id = ?`).bind(id).first<TourRow>();
}

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

export async function upsertEventByFingerprint(
  db: D1Database,
  input: {
    fingerprint: string;
    artist_id: number;
    tour_id?: number | null;
    starts_at?: string | null;
    timezone?: string | null;
    city?: string | null;
    country?: string | null;
    city_key?: string | null;
    venue_name?: string | null;
    lat?: number | null;
    lon?: number | null;
    onsale_at?: string | null;
    presale_at?: string | null;
    ticket_url?: string | null;
    status?: EventRow['status'];
    source?: string | null;
    source_event_id?: string | null;
    content_hash?: string | null;
  },
): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO events (
        fingerprint, artist_id, tour_id, starts_at, timezone, city, country, city_key,
        venue_name, lat, lon, onsale_at, presale_at, ticket_url, status, source,
        source_event_id, content_hash, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT (fingerprint) DO UPDATE SET
        tour_id = excluded.tour_id,
        starts_at = excluded.starts_at,
        timezone = excluded.timezone,
        city = excluded.city,
        country = excluded.country,
        city_key = excluded.city_key,
        venue_name = excluded.venue_name,
        lat = excluded.lat,
        lon = excluded.lon,
        onsale_at = excluded.onsale_at,
        presale_at = excluded.presale_at,
        ticket_url = excluded.ticket_url,
        status = excluded.status,
        source = excluded.source,
        source_event_id = excluded.source_event_id,
        content_hash = excluded.content_hash,
        last_seen_at = datetime('now')
      RETURNING id`,
    )
    .bind(
      input.fingerprint,
      input.artist_id,
      input.tour_id ?? null,
      input.starts_at ?? null,
      input.timezone ?? null,
      input.city ?? null,
      input.country ?? null,
      input.city_key ?? null,
      input.venue_name ?? null,
      input.lat ?? null,
      input.lon ?? null,
      input.onsale_at ?? null,
      input.presale_at ?? null,
      input.ticket_url ?? null,
      input.status ?? 'active',
      input.source ?? null,
      input.source_event_id ?? null,
      input.content_hash ?? null,
    )
    .first<{ id: number }>();
  if (!result) throw new Error('upsertEventByFingerprint: upsert did not return an id');
  return result.id;
}

export async function getEventByFingerprint(db: D1Database, fingerprint: string): Promise<EventRow | null> {
  return db.prepare(`SELECT * FROM events WHERE fingerprint = ?`).bind(fingerprint).first<EventRow>();
}

export async function getEventsForTour(db: D1Database, tourId: number): Promise<EventRow[]> {
  const result = await db
    .prepare(`SELECT * FROM events WHERE tour_id = ? ORDER BY starts_at ASC`)
    .bind(tourId)
    .all<EventRow>();
  return result.results;
}

// ---------------------------------------------------------------------------
// notifications
// ---------------------------------------------------------------------------

export async function insertNotification(
  db: D1Database,
  input: {
    subscriber_id: number;
    tour_id: number;
    event_id?: number | null;
    trigger: NotificationTrigger;
    notified_hash?: string | null;
  },
): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO notifications (subscriber_id, tour_id, event_id, trigger, notified_hash)
       VALUES (?, ?, ?, ?, ?)
       RETURNING id`,
    )
    .bind(input.subscriber_id, input.tour_id, input.event_id ?? null, input.trigger, input.notified_hash ?? null)
    .first<{ id: number }>();
  if (!result) throw new Error('insertNotification: insert did not return an id');
  return result.id;
}

export async function markNotificationSent(db: D1Database, id: number, sentAt: string): Promise<void> {
  await db.prepare(`UPDATE notifications SET sent_at = ? WHERE id = ?`).bind(sentAt, id).run();
}

export async function getUnsentNotificationsOlderThan(db: D1Database, isoCutoff: string): Promise<NotificationRow[]> {
  const result = await db
    .prepare(`SELECT * FROM notifications WHERE sent_at IS NULL AND created_at <= ?`)
    .bind(isoCutoff)
    .all<NotificationRow>();
  return result.results;
}

// ---------------------------------------------------------------------------
// reachability / origins
// ---------------------------------------------------------------------------

export async function upsertReachability(
  db: D1Database,
  input: { city_key: string; origin_iata: string; tier: ReachabilityRow['tier']; route_note?: string | null },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO reachability (city_key, origin_iata, tier, route_note, computed_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT (city_key, origin_iata) DO UPDATE SET
         tier = excluded.tier, route_note = excluded.route_note, computed_at = datetime('now')`,
    )
    .bind(input.city_key, input.origin_iata, input.tier, input.route_note ?? null)
    .run();
}

export async function getReachability(db: D1Database, cityKey: string): Promise<ReachabilityRow[]> {
  const result = await db
    .prepare(`SELECT * FROM reachability WHERE city_key = ?`)
    .bind(cityKey)
    .all<ReachabilityRow>();
  return result.results;
}

export async function upsertOrigin(db: D1Database, input: OriginRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO origins (iata, name, drive_km, drive_minutes, penalty_minutes)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (iata) DO UPDATE SET
         name = excluded.name, drive_km = excluded.drive_km,
         drive_minutes = excluded.drive_minutes, penalty_minutes = excluded.penalty_minutes`,
    )
    .bind(input.iata, input.name, input.drive_km ?? null, input.drive_minutes ?? null, input.penalty_minutes ?? null)
    .run();
}

export async function getAllOrigins(db: D1Database): Promise<OriginRow[]> {
  const result = await db.prepare(`SELECT * FROM origins`).all<OriginRow>();
  return result.results;
}

// ---------------------------------------------------------------------------
// inbox
// ---------------------------------------------------------------------------

export async function insertInboxMessage(
  db: D1Database,
  input: {
    from_addr: string;
    subscriber_id?: number | null;
    dkim_pass?: boolean | null;
    spf_pass?: boolean | null;
    subject?: string | null;
    body_text?: string | null;
    status?: InboxStatus;
    message_id?: string | null;
    in_reply_to?: string | null;
    references?: string | null;
    thread_id?: string | null;
  },
): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO inbox (
        from_addr, subscriber_id, dkim_pass, spf_pass, subject, body_text, status,
        message_id, in_reply_to, "references", thread_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id`,
    )
    .bind(
      input.from_addr,
      input.subscriber_id ?? null,
      input.dkim_pass === undefined || input.dkim_pass === null ? null : input.dkim_pass ? 1 : 0,
      input.spf_pass === undefined || input.spf_pass === null ? null : input.spf_pass ? 1 : 0,
      input.subject ?? null,
      input.body_text ?? null,
      input.status ?? 'pending',
      input.message_id ?? null,
      input.in_reply_to ?? null,
      input.references ?? null,
      input.thread_id ?? null,
    )
    .first<{ id: number }>();
  if (!result) throw new Error('insertInboxMessage: insert did not return an id');
  return result.id;
}

export async function getPendingInboxMessages(db: D1Database): Promise<InboxRow[]> {
  const result = await db
    .prepare(`SELECT * FROM inbox WHERE status = 'pending' ORDER BY received_at ASC`)
    .all<InboxRow>();
  return result.results;
}

export async function getInboxThread(db: D1Database, threadId: string): Promise<InboxRow[]> {
  const result = await db
    .prepare(`SELECT * FROM inbox WHERE thread_id = ? ORDER BY received_at ASC`)
    .bind(threadId)
    .all<InboxRow>();
  return result.results;
}

export async function markInboxHandled(
  db: D1Database,
  id: number,
  input: { status: InboxStatus; result_note?: string | null },
): Promise<void> {
  await db
    .prepare(
      `UPDATE inbox SET status = ?, result_note = ?, handled_at = datetime('now') WHERE id = ?`,
    )
    .bind(input.status, input.result_note ?? null, id)
    .run();
}

export async function incrementInboxAttempts(db: D1Database, id: number): Promise<number> {
  const result = await db
    .prepare(`UPDATE inbox SET attempts = attempts + 1 WHERE id = ? RETURNING attempts`)
    .bind(id)
    .first<{ attempts: number }>();
  if (!result) throw new Error('incrementInboxAttempts: update did not return attempts');
  return result.attempts;
}

// ---------------------------------------------------------------------------
// source_health
// ---------------------------------------------------------------------------

export async function recordSourceSuccess(db: D1Database, source: string, at: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO source_health (source, consecutive_failures, last_ok_at, last_error)
       VALUES (?, 0, ?, NULL)
       ON CONFLICT (source) DO UPDATE SET consecutive_failures = 0, last_ok_at = excluded.last_ok_at`,
    )
    .bind(source, at)
    .run();
}

export async function recordSourceFailure(db: D1Database, source: string, error: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO source_health (source, consecutive_failures, last_ok_at, last_error)
       VALUES (?, 1, NULL, ?)
       ON CONFLICT (source) DO UPDATE SET
         consecutive_failures = consecutive_failures + 1, last_error = excluded.last_error`,
    )
    .bind(source, error)
    .run();
}

export async function getSourceHealth(db: D1Database, source: string): Promise<SourceHealthRow | null> {
  return db.prepare(`SELECT * FROM source_health WHERE source = ?`).bind(source).first<SourceHealthRow>();
}

export async function getAllSourceHealth(db: D1Database): Promise<SourceHealthRow[]> {
  const result = await db.prepare(`SELECT * FROM source_health`).all<SourceHealthRow>();
  return result.results;
}

// ---------------------------------------------------------------------------
// usage
// ---------------------------------------------------------------------------

export async function recordUsage(
  db: D1Database,
  input: {
    day: string;
    path: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    est_cost: number;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO usage (day, path, model, input_tokens, output_tokens, est_cost)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(input.day, input.path, input.model, input.input_tokens, input.output_tokens, input.est_cost)
    .run();
}

export async function getUsageForMonth(db: D1Database, yyyyMm: string): Promise<UsageRow[]> {
  const result = await db
    .prepare(`SELECT * FROM usage WHERE day LIKE ? ORDER BY day ASC`)
    .bind(`${yyyyMm}%`)
    .all<UsageRow>();
  return result.results;
}

// ---------------------------------------------------------------------------
// rate_limit
// ---------------------------------------------------------------------------

/**
 * Increments the count for (sender, hour_bucket) and returns the new total.
 * Callers compare the result against the cap (6/hour per DESIGN.md §12.4).
 */
export async function incrementRateLimit(db: D1Database, sender: string, hourBucket: string): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO rate_limit (sender, hour_bucket, count) VALUES (?, ?, 1)
       ON CONFLICT (sender, hour_bucket) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(sender, hourBucket)
    .first<{ count: number }>();
  if (!result) throw new Error('incrementRateLimit: upsert did not return a count');
  return result.count;
}

export async function getRateLimitCount(db: D1Database, sender: string, hourBucket: string): Promise<number> {
  const row = await db
    .prepare(`SELECT count FROM rate_limit WHERE sender = ? AND hour_bucket = ?`)
    .bind(sender, hourBucket)
    .first<{ count: number }>();
  return row?.count ?? 0;
}
