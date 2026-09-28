-- =============================================================================
-- Migration: 002_create_notifications.sql
-- Description: In-app notification feed backing /dashboard/notifications.
--
-- Shape matches what the backend already writes via
-- HasuraService.insertNotification (user_id / type / title / message / read).
-- user_id is TEXT because it holds the Firebase UID, not a UUID.
--
-- Hasura permissions (role: user):
--   select / update(read) — filter: { user_id: { _eq: X-Hasura-User-Id } }
-- Inserts come from the backend with the admin secret only.
--
-- Also backs the watchlist price-change job (issue #334): the job compares a
-- watched listing's current price against the price recorded at watch-time
-- and inserts a 'price_change' notification for the watcher. The saved price
-- is persisted here so the comparison survives across job runs.
-- =============================================================================

CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id VARCHAR(255) NOT NULL,
    type VARCHAR(50) NOT NULL DEFAULT 'info',
    title VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    read BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_created
    ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
    ON notifications(user_id) WHERE read = FALSE;

-- -----------------------------------------------------------------------------
-- Watchlist price tracking (issue #334)
--
-- Mirrors the client-side favorites.store.ts `savedPrices` map: the price a
-- listing had when the user started watching it. The backend price-change job
-- reads saved_price, compares it to the listing's current price, and emits a
-- notification when they differ.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS watchlist_price_tracking (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id VARCHAR(255) NOT NULL,
    listing_id UUID NOT NULL,
    saved_price NUMERIC(14, 2) NOT NULL,
    last_notified_price NUMERIC(14, 2),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, listing_id)
);

CREATE INDEX IF NOT EXISTS idx_watchlist_price_tracking_listing
    ON watchlist_price_tracking(listing_id);
CREATE INDEX IF NOT EXISTS idx_watchlist_price_tracking_user
    ON watchlist_price_tracking(user_id);
