-- Migration number: 0005 	 2026-09-02T00:00:02.000Z
-- S4.6 (inbound command handler): a durable record of every reply the
-- reply path itself sends, keyed to the inbox row it answered.
--
-- Why this table exists, when DESIGN.md §4 never lists one: §11.2 says
-- "Store message_id, in_reply_to and references on every inbox row and
-- every sent mail" -- the "every sent mail" half was never given a home.
-- Without it, S4.6 would have no way to (a) show the model its own prior
-- replies when reconstructing a thread for a later turn (the 3-turn
-- "add Fontaines D.C." -> "make that P1" -> "Prague trip" conversation this
-- step's done-when requires only works if the model can see what it said
-- last time, not just what the subscriber wrote), or (b) build a correct
-- References chain (RFC 5322 §3.6.4: a message's References is its
-- parent's References plus the parent's own Message-ID) for a reply to a
-- reply, since our own sent Message-IDs would otherwise never be recorded
-- anywhere. Flagged in PROGRESS.md's S4.6 entry as a real design decision,
-- not assumed silently.
--
-- One row per sent reply, not one column bolted onto `inbox` -- a thread can
-- accumulate several replies against several different inbound rows, and
-- `inbox` rows are the *inbound* side of the conversation only.

CREATE TABLE sent_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inbox_id INTEGER NOT NULL REFERENCES inbox(id),   -- the pending/deferred row this reply answers
  subscriber_id INTEGER NOT NULL REFERENCES subscribers(id),
  thread_id TEXT NOT NULL,                          -- same derivation as inbox.thread_id (§11.2)
  message_id TEXT NOT NULL,                         -- the Message-ID the mailer actually returned
  in_reply_to TEXT,                                 -- the inbox row's own message_id, verbatim
  "references" TEXT,                                -- inbox row's references + its message_id
  body_text TEXT NOT NULL,                          -- the plain-text reply, for thread reconstruction
  sent_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_sent_replies_thread_id ON sent_replies(thread_id);
