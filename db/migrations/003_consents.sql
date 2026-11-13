-- Registration consent (Kenya Data Protection Act: consent must be specific, recorded and provable).
-- users.consent_version = the consent version the user last accepted (NULL = never; asked on next visit).
-- user_consents keeps every acceptance with the boxes ticked, so we can show what someone agreed to and when.

ALTER TABLE users ADD COLUMN consent_version text;

CREATE TABLE user_consents (
  user_id     text NOT NULL REFERENCES users ON DELETE CASCADE,
  version     text NOT NULL,
  accepted_at bigint NOT NULL,
  choices     jsonb NOT NULL,   -- {"age":true,"terms":true,"idCheck":true,"location":true,"deals":false,"notify":true}
  PRIMARY KEY (user_id, version)
);
