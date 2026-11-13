-- Drinking Buddies schema. All timestamps are epoch milliseconds (bigint), matching Date.now().

CREATE TABLE users (
  id               text PRIMARY KEY,
  username         text NOT NULL UNIQUE,
  name             text NOT NULL,
  dob              text,                       -- YYYY-MM-DD
  bio              text NOT NULL DEFAULT '',
  created_at       bigint NOT NULL,
  bot              boolean NOT NULL DEFAULT false,
  pw               jsonb,                      -- { alg, salt, hash, N }
  phone            text,
  phone_verified   boolean NOT NULL DEFAULT false,
  phone_otp        jsonb,
  email            text,
  email_verified   boolean NOT NULL DEFAULT false,
  email_token      jsonb,
  reset_token      jsonb,
  selfie           jsonb NOT NULL DEFAULT '{"status":"none"}',  -- includes the pending image until reviewed
  selfie_challenge jsonb,
  kyc              jsonb NOT NULL DEFAULT '{"status":"none"}',
  id_hash          text UNIQUE,                -- keyed fingerprint of the government ID number
  name_locked      boolean NOT NULL DEFAULT false,
  failed_logins    int NOT NULL DEFAULT 0,
  locked_until     bigint NOT NULL DEFAULT 0,
  banned           jsonb,
  under_review     boolean NOT NULL DEFAULT false,
  promo_opt_in     boolean NOT NULL DEFAULT false,
  push_subs        jsonb NOT NULL DEFAULT '[]',
  plus_until       bigint NOT NULL DEFAULT 0,
  boosts           int NOT NULL DEFAULT 0 CHECK (boosts >= 0),
  boost_until      bigint NOT NULL DEFAULT 0,
  -- "I'm out" status (null when not out)
  status_joint     text,
  status_drink     text,
  status_lat       double precision,
  status_lng       double precision,
  status_until     bigint,
  status_since     bigint,
  status_venue_id  text
);
-- One verified account per phone / email.
CREATE UNIQUE INDEX users_phone_verified ON users (phone) WHERE phone_verified;
CREATE UNIQUE INDEX users_email_verified ON users (email) WHERE email_verified;
CREATE INDEX users_out ON users (status_until) WHERE status_until IS NOT NULL;
CREATE INDEX users_out_geo ON users (status_lat, status_lng) WHERE status_until IS NOT NULL;

CREATE TABLE photos (
  id         text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users ON DELETE CASCADE,
  position   int NOT NULL,                     -- 0 = main photo
  mime       text NOT NULL,
  data       bytea NOT NULL,
  created_at bigint NOT NULL
);
CREATE INDEX photos_user ON photos (user_id, position);

CREATE TABLE sessions (
  hash      text PRIMARY KEY,                  -- sha256 of the cookie token
  user_id   text NOT NULL REFERENCES users ON DELETE CASCADE,
  created   bigint NOT NULL,
  last_seen bigint NOT NULL,
  ip        text,
  ua        text
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE swipes (
  from_id text NOT NULL REFERENCES users ON DELETE CASCADE,
  to_id   text NOT NULL REFERENCES users ON DELETE CASCADE,
  liked   boolean NOT NULL,
  at      bigint NOT NULL,
  PRIMARY KEY (from_id, to_id)
);
CREATE INDEX swipes_to ON swipes (to_id) WHERE liked;
CREATE INDEX swipes_from_at ON swipes (from_id, at);

-- Matches outlive a deleted account (ended), so no FK on the user columns.
CREATE TABLE matches (
  id         text PRIMARY KEY,
  user_a     text NOT NULL,
  user_b     text NOT NULL,
  created_at bigint NOT NULL,
  ended      boolean NOT NULL DEFAULT false,
  ended_by   text,
  seen       jsonb NOT NULL DEFAULT '{}'        -- { userId: true }
);
CREATE INDEX matches_a ON matches (user_a);
CREATE INDEX matches_b ON matches (user_b);
-- Only one live match per pair (stored with the ids in sorted order).
CREATE UNIQUE INDEX matches_live_pair ON matches (LEAST(user_a, user_b), GREATEST(user_a, user_b)) WHERE NOT ended;

CREATE TABLE messages (
  id         text PRIMARY KEY,
  match_id   text NOT NULL REFERENCES matches ON DELETE CASCADE,
  from_id    text NOT NULL,
  text       text NOT NULL,
  at         bigint NOT NULL,
  updated_at bigint,
  kind       text,                             -- null | 'drink'
  drink      text,
  note       text,
  state      text                              -- drink offers: pending | accepted | declined
);
CREATE INDEX messages_match ON messages (match_id, at);

CREATE TABLE reports (
  id       text PRIMARY KEY,
  from_id  text NOT NULL,
  about_id text NOT NULL,
  reason   text NOT NULL DEFAULT '',
  at       bigint NOT NULL,
  resolved boolean NOT NULL DEFAULT false
);
CREATE INDEX reports_about ON reports (about_id) WHERE NOT resolved;

CREATE TABLE audit (
  id     bigserial PRIMARY KEY,
  at     bigint NOT NULL,
  action text NOT NULL,
  uid    text,
  ip     text,
  meta   jsonb
);
CREATE INDEX audit_at ON audit (at);

-- ---------- partner bars ----------
CREATE TABLE venues (
  id             text PRIMARY KEY,
  name           text NOT NULL,
  area           text NOT NULL,
  address        text NOT NULL,
  description    text NOT NULL DEFAULT '',
  kra_pin        text NOT NULL,
  contact_phone  text NOT NULL,
  lat            double precision NOT NULL,
  lng            double precision NOT NULL,
  status         text NOT NULL DEFAULT 'pending',   -- pending | active | rejected | suspended
  note           text,
  featured_until bigint NOT NULL DEFAULT 0,
  reminder_for   bigint,
  deal           jsonb NOT NULL DEFAULT '{"title":"","details":"","active":false}',
  last_promo_at  bigint,
  created_at     bigint NOT NULL,
  approved_at    bigint
);

CREATE TABLE venue_members (
  venue_id text NOT NULL REFERENCES venues ON DELETE CASCADE,
  user_id  text NOT NULL REFERENCES users ON DELETE CASCADE,
  role     text NOT NULL CHECK (role IN ('owner', 'staff')),
  added_at bigint NOT NULL,
  PRIMARY KEY (venue_id, user_id)
);
CREATE INDEX venue_members_user ON venue_members (user_id);

CREATE TABLE checkins (
  venue_id text NOT NULL REFERENCES venues ON DELETE CASCADE,
  user_id  text NOT NULL REFERENCES users ON DELETE CASCADE,
  day      text NOT NULL,
  at       bigint NOT NULL,
  PRIMARY KEY (venue_id, user_id, day)
);

CREATE TABLE venue_matches (
  venue_id text NOT NULL REFERENCES venues ON DELETE CASCADE,
  match_id text NOT NULL,
  at       bigint NOT NULL
);
CREATE INDEX venue_matches_venue ON venue_matches (venue_id, at);

CREATE TABLE redemptions (
  id          text PRIMARY KEY,
  venue_id    text NOT NULL REFERENCES venues ON DELETE CASCADE,
  match_id    text NOT NULL,
  code        text NOT NULL UNIQUE,
  created_at  bigint NOT NULL,
  redeemed_at bigint,
  redeemed_by text
);
CREATE INDEX redemptions_match ON redemptions (match_id, venue_id);

CREATE TABLE promos (
  id       bigserial PRIMARY KEY,
  venue_id text NOT NULL REFERENCES venues ON DELETE CASCADE,
  at       bigint NOT NULL,
  text     text NOT NULL,
  reach    int NOT NULL
);

-- ---------- payments (kept even if the account/venue is deleted: financial records) ----------
CREATE TABLE payments (
  id                  text PRIMARY KEY,
  uid                 text,
  venue_id            text,
  product_id          text,
  plan_id             text,
  days                int,
  amount              int NOT NULL,
  msisdn              text,
  status              text NOT NULL,        -- pending | paid | failed | expired | review | gift
  checkout_request_id text UNIQUE,
  merchant_request_id text,
  receipt             text,
  result_code         text,
  result_desc         text,
  boosts              int,
  created_at          bigint NOT NULL,
  paid_at             bigint,
  period_start        bigint,
  period_end          bigint,
  last_query_at       bigint
);
CREATE UNIQUE INDEX payments_receipt ON payments (receipt) WHERE receipt IS NOT NULL AND status = 'paid';
CREATE INDEX payments_venue ON payments (venue_id, created_at);
CREATE INDEX payments_user ON payments (uid, created_at);
-- At most one pending STK push per venue, and per user for personal purchases.
CREATE UNIQUE INDEX payments_one_pending_venue ON payments (venue_id) WHERE status = 'pending' AND venue_id IS NOT NULL;
CREATE UNIQUE INDEX payments_one_pending_user ON payments (uid) WHERE status = 'pending' AND venue_id IS NULL;
