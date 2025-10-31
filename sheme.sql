-- WARNING: This schema is for context only and is not meant to be run.
-- Table order and constraints may not be valid for execution.

CREATE TABLE public.auction_listings (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  external_id text NOT NULL UNIQUE,
  title text NOT NULL,
  category text,
  status text NOT NULL DEFAULT 'active'::text CHECK (status = ANY (ARRAY['active'::text, 'scheduled'::text, 'completed'::text, 'cancelled'::text])),
  seller_minecraft_id uuid,
  seller_username text,
  currency text NOT NULL DEFAULT 'emerald'::text,
  starting_bid numeric NOT NULL DEFAULT 0,
  current_bid numeric,
  buyout_price numeric,
  bid_count integer NOT NULL DEFAULT 0,
  watchers integer NOT NULL DEFAULT 0,
  started_at timestamp with time zone,
  ends_at timestamp with time zone NOT NULL,
  last_synced_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT auction_listings_pkey PRIMARY KEY (id)
);
CREATE TABLE public.auction_snapshots (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL,
  collected_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  current_bid numeric,
  bid_count integer,
  watchers integer,
  status text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT auction_snapshots_pkey PRIMARY KEY (id),
  CONSTRAINT auction_snapshots_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES public.auction_listings(id)
);
CREATE TABLE public.auction_sync_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  sync_started_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  sync_finished_at timestamp with time zone,
  status text NOT NULL CHECK (status = ANY (ARRAY['success'::text, 'error'::text])),
  processed_listing_count integer NOT NULL DEFAULT 0,
  error_message text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT auction_sync_logs_pkey PRIMARY KEY (id)
);
CREATE TABLE public.chests (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  label text NOT NULL UNIQUE,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT chests_pkey PRIMARY KEY (id)
);
CREATE TABLE public.enchantments (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  label text NOT NULL,
  max_level integer NOT NULL DEFAULT 255,
  CONSTRAINT enchantments_pkey PRIMARY KEY (id)
);
CREATE TABLE public.guild_settings (
  guild_id text NOT NULL,
  locale text,
  admin_role_ids ARRAY,
  mute_role_id text,
  audit_webhook_url text,
  moderation_channel_id text,
  marketplace_channel_id text,
  marketplace_post_interval_hours integer,
  mod_feature text NOT NULL DEFAULT 'disable' CHECK (mod_feature = ANY (ARRAY['enable', 'disable'])),
  automod text NOT NULL DEFAULT 'disable' CHECK (automod = ANY (ARRAY['enable', 'disable'])),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT guild_settings_pkey PRIMARY KEY (guild_id)
);
CREATE TABLE public.invite_events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  inviter_id uuid NOT NULL,
  invitee_id uuid NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending'::text CHECK (status = ANY (ARRAY['pending'::text, 'verified'::text, 'cancelled'::text])),
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  verified_at timestamp with time zone,
  CONSTRAINT invite_events_pkey PRIMARY KEY (id),
  CONSTRAINT invite_events_inviter_id_fkey FOREIGN KEY (inviter_id) REFERENCES public.users(id),
  CONSTRAINT invite_events_invitee_id_fkey FOREIGN KEY (invitee_id) REFERENCES public.users(id)
);
CREATE TABLE public.item_audit_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL,
  actor_id uuid,
  action text NOT NULL CHECK (action = ANY (ARRAY['created'::text, 'updated'::text, 'status_change'::text])),
  note text,
  changes jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT item_audit_logs_pkey PRIMARY KEY (id),
  CONSTRAINT item_audit_logs_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id),
  CONSTRAINT item_audit_logs_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id)
);
CREATE TABLE public.item_effects (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  label text NOT NULL UNIQUE,
  max_level integer NOT NULL DEFAULT 255 CHECK (max_level >= 1 AND max_level <= 1000),
  CONSTRAINT item_effects_pkey PRIMARY KEY (id)
);
CREATE TABLE public.item_enchantments (
  item_id uuid NOT NULL,
  enchantment_id uuid NOT NULL,
  level integer NOT NULL CHECK (level >= 1 AND level <= 255),
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT item_enchantments_pkey PRIMARY KEY (item_id, enchantment_id),
  CONSTRAINT item_enchantments_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id),
  CONSTRAINT item_enchantments_enchantment_id_fkey FOREIGN KEY (enchantment_id) REFERENCES public.enchantments(id)
);
CREATE TABLE public.item_images (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL,
  type text NOT NULL CHECK (type = ANY (ARRAY['lore'::text, 'ingame'::text])),
  path text NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT item_images_pkey PRIMARY KEY (id),
  CONSTRAINT item_images_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id),
  CONSTRAINT item_images_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id)
);
CREATE TABLE public.item_item_effects (
  item_id uuid NOT NULL,
  effect_id uuid NOT NULL,
  level integer NOT NULL CHECK (level >= 1 AND level <= 1000),
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT item_item_effects_pkey PRIMARY KEY (item_id, effect_id),
  CONSTRAINT item_item_effects_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id),
  CONSTRAINT item_item_effects_effect_id_fkey FOREIGN KEY (effect_id) REFERENCES public.item_effects(id)
);
CREATE TABLE public.item_likes (
  item_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT item_likes_pkey PRIMARY KEY (item_id, user_id),
  CONSTRAINT item_likes_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id),
  CONSTRAINT item_likes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.item_market_links (
  item_id uuid NOT NULL,
  listing_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'draft'::text CHECK (status = ANY (ARRAY['draft'::text, 'confirmed'::text])),
  confidence numeric,
  source text,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  created_by uuid,
  confirmed_at timestamp with time zone,
  confirmed_by uuid,
  CONSTRAINT item_market_links_pkey PRIMARY KEY (item_id, listing_id),
  CONSTRAINT item_market_links_confirmed_by_fkey FOREIGN KEY (confirmed_by) REFERENCES public.users(id),
  CONSTRAINT item_market_links_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id),
  CONSTRAINT item_market_links_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES public.auction_listings(id),
  CONSTRAINT item_market_links_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id)
);
CREATE TABLE public.item_signatures (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL,
  signer_name text NOT NULL CHECK (char_length(btrim(signer_name)) >= 2 AND char_length(btrim(signer_name)) <= 120),
  created_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT item_signatures_pkey PRIMARY KEY (id),
  CONSTRAINT item_signatures_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id),
  CONSTRAINT item_signatures_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id)
);
CREATE TABLE public.item_supplement_requests (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL,
  requested_by uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending'::text CHECK (status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])),
  proposed_origin text CHECK (proposed_origin = ANY (ARRAY['OPSUCHT'::text, 'Durchrasten'::text, '24Sucht'::text])),
  proposed_chest_id uuid,
  proposed_material text,
  notes text,
  moderation_note text,
  moderated_by uuid,
  moderated_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  proposed_chest_remove boolean NOT NULL DEFAULT false,
  proposed_material_remove boolean NOT NULL DEFAULT false,
  proposed_signatures jsonb,
  proposed_enchantments jsonb,
  proposed_effects jsonb,
  proposed_rarity_id uuid,
  proposed_image_additions jsonb,
  proposed_image_removals jsonb,
  CONSTRAINT item_supplement_requests_pkey PRIMARY KEY (id),
  CONSTRAINT item_supplement_requests_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id),
  CONSTRAINT item_supplement_requests_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id),
  CONSTRAINT item_supplement_requests_proposed_chest_id_fkey FOREIGN KEY (proposed_chest_id) REFERENCES public.chests(id),
  CONSTRAINT item_supplement_requests_moderated_by_fkey FOREIGN KEY (moderated_by) REFERENCES public.users(id),
  CONSTRAINT item_supplement_requests_proposed_rarity_id_fkey FOREIGN KEY (proposed_rarity_id) REFERENCES public.rarities(id)
);
CREATE TABLE public.item_trade_intents (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL,
  user_id uuid NOT NULL,
  intent_type text NOT NULL CHECK (intent_type = ANY (ARRAY['buy'::text, 'sell'::text])),
  quantity integer CHECK (quantity IS NULL OR quantity > 0),
  price_min numeric CHECK (price_min IS NULL OR price_min >= 0::numeric),
  price_max numeric CHECK (price_max IS NULL OR price_max >= 0::numeric),
  contact_method text,
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT item_trade_intents_pkey PRIMARY KEY (id),
  CONSTRAINT item_trade_intents_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id),
  CONSTRAINT item_trade_intents_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.item_types (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  label text NOT NULL,
  sort numeric NOT NULL,
  CONSTRAINT item_types_pkey PRIMARY KEY (id)
);
CREATE TABLE public.item_views (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL,
  viewer_token text NOT NULL,
  viewer_user_id uuid,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  last_viewed_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT item_views_pkey PRIMARY KEY (id),
  CONSTRAINT item_views_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id),
  CONSTRAINT item_views_viewer_user_id_fkey FOREIGN KEY (viewer_user_id) REFERENCES public.users(id)
);
CREATE TABLE public.items (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  item_type_id uuid NOT NULL,
  stars integer NOT NULL DEFAULT 0 CHECK (stars >= 0 AND stars <= 5),
  status text NOT NULL DEFAULT 'pending'::text CHECK (status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])),
  created_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  material text,
  rarity_id uuid NOT NULL,
  origin text DEFAULT 'OPSUCHT'::text CHECK (origin = ANY (ARRAY['OPSUCHT'::text, 'Durchrasten'::text, '24Sucht'::text])),
  delete_requested_at timestamp with time zone,
  delete_requested_by uuid,
  delete_reason text,
  deleted_at timestamp with time zone,
  deleted_by uuid,
  chest_id uuid,
  view_count bigint NOT NULL DEFAULT 0,
  CONSTRAINT items_pkey PRIMARY KEY (id),
  CONSTRAINT items_item_type_id_fkey FOREIGN KEY (item_type_id) REFERENCES public.item_types(id),
  CONSTRAINT items_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id),
  CONSTRAINT items_rarity_id_fkey FOREIGN KEY (rarity_id) REFERENCES public.rarities(id),
  CONSTRAINT items_chest_id_fkey FOREIGN KEY (chest_id) REFERENCES public.chests(id),
  CONSTRAINT items_delete_requested_by_fkey FOREIGN KEY (delete_requested_by) REFERENCES public.users(id),
  CONSTRAINT items_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES public.users(id)
);
CREATE TABLE public.moderation_notifications (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type = 'item_pending'::text),
  status text NOT NULL DEFAULT 'open'::text CHECK (status = ANY (ARRAY['open'::text, 'acknowledged'::text])),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  acknowledged_at timestamp with time zone,
  CONSTRAINT moderation_notifications_pkey PRIMARY KEY (id),
  CONSTRAINT moderation_notifications_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id)
);
CREATE TABLE public.rarities (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  label text NOT NULL,
  sort_order smallint NOT NULL UNIQUE CHECK (sort_order > 0),
  CONSTRAINT rarities_pkey PRIMARY KEY (id)
);
CREATE TABLE public.user_badge_awards (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  badge_key text NOT NULL,
  awarded_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  metadata jsonb,
  CONSTRAINT user_badge_awards_pkey PRIMARY KEY (id),
  CONSTRAINT user_badge_awards_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.users (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  role text NOT NULL DEFAULT 'user'::text CHECK (role = ANY (ARRAY['user'::text, 'moderator'::text])),
  minecraft_id uuid UNIQUE,
  minecraft_username text,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  discord_id text UNIQUE,
  discord_username text,
  invite_code text NOT NULL DEFAULT generate_invite_code() UNIQUE,
  invited_by uuid,
  CONSTRAINT users_pkey PRIMARY KEY (id),
  CONSTRAINT users_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES public.users(id)
);