# Laravel MySQL → Strapi data migration

Working doc. Update in place as steps land.

`app_users` is **already migrated** (160 rows, 2026-08-11, `scripts/migrate-users.js`).
What follows is everything else.

## Source of truth

The live MySQL on the Lightsail box, database `eventbyclick`, credentials in
`~/app/.env` on that host. Query with `sudo mysql`.

**The repo's `gosociali.sql` is stale** — 1 player, 1 app_user, a handful of events —
and it predates three migrations (`type`, `spintowin_*`, `guide_pdf`). Use it to read
table *structure*, never for counts or data.

```bash
ssh -i "C:\Users\babay\Downloads\LightsailDefaultKey-eu-west-1.pem" ubuntu@34.247.244.34
```

## Convention

Every migrated row carries a private `legacy_id` holding its old MySQL id. That is what
makes the run idempotent and what lets relations be rebuilt in a second pass. It already
exists on `page`, `player`, `register` and the users-permissions user.

## Order

Dependencies force this order. Each step is a separate script so a failure does not
strand the ones before it.

| # | From | To | Depends on |
|---|---|---|---|
| 0 | `app_users` | users-permissions user | — (done) |
| 1 | `events_types` | `api::event-type` | — |
| 2 | `players` | `api::player` | step 0 (`owner`) |
| 3 | media files | Strapi media / Cloudinary | — |
| 4 | `events` | `api::page` | steps 1–3 |
| 5 | `properties` + `userpropertiesvalues` | `page.custom_fields` | step 4 |
| 6 | `users` + `users_events` | `api::register` | steps 2, 4, 5 |

## Step 1 — `events_types`, `event_categories`

Both are `(id, name)`. `events_types` → `api::event-type`. Categories have no Strapi
equivalent and the create wizard no longer asks for one — carry `category_id` into a
note field or drop it, but decide before step 4.

## Step 2 — `players`

| MySQL | Strapi | Notes |
|---|---|---|
| `name`, `description`, `email`, `email_2`, `address` | same | direct |
| `phone` | `phone` | **only one phone column exists.** `phone_2` was added to the Strapi schema from the Vue form, which showed two. Confirm against the live table before assuming it is unused. |
| `website`, `facebook`, `instagram` | `links[]` | fold each non-empty one into a `contact.social-link` with the matching `type` |
| `emails` (varchar, plural) | — | inspect the live values; if it is a comma-separated list it may hold addresses not in `email`/`email_2` |
| `image` | `logo` | see step 3 |
| `app_user_id` | `owner` | resolve via the user's `legacy_id` |
| `yaad_masof`, `yaad_key`, `isracard_key`, `payment_gateway` | — | **not migrated.** These are payment-gateway credentials; the new app uses external links only. Do not copy them. |

## Step 3 — media

The hard part, and the reason step 4 cannot be a straight SQL translation.

`events.image`, `events.image_2`, `events.logo`, `events.guide_pdf` and `players.image`
hold **URLs/filenames**, not ids. Files live on the Laravel host under
`public/storage/events/`; `EventService::coverImage` splits on `storage/` to reach them.

Each file has to be uploaded to Strapi's media library (which is Cloudinary-backed in
prod) and the returned numeric id written to the page. Plan:

1. Enumerate every distinct image path referenced by `events` and `players`.
2. Copy them off the host in one `tar`/`scp` rather than one request per file.
3. Upload via `POST /api/upload`, recording `old path → new media id` in a JSON map.
4. Steps 2 and 4 read that map.

Do this **before** step 4 so the page write is a single request per event. Missing files
are expected on old rows — log and continue with a null image rather than failing the
run.

## Step 4 — `events` → `api::page`

Mostly one-to-one; the fields below are not.

| MySQL | Strapi | Rule |
|---|---|---|
| `hash` | `hash` | **must be preserved verbatim** — every public URL in the wild is `/{hash}` |
| `type` | `page_type` | added 2025-03-23; values should be `save_spot` / `contact_me` / `guide_download`. Check the live distinct values — rows created before that migration are NULL and need a default (`save_spot`) |
| `payment_required` (tinyint 0/1/2) | `payment_display` | `1 → paid`, `0 → free`, `2 → hidden`. Also set the boolean `payment_required` mirror |
| `payment_type` | `payment_type` | already the Laravel set (`url`/`paybox`/`paybox_personal`/`bit`/`donation`); the enum was extended to accept it |
| `paid` | — | separate legacy flag; reconcile against `payment_required` before trusting either |
| `online` | `is_online` | tinyint → boolean |
| `meeting_pass` | — | **deliberately dropped** |
| `extra_description` | `extra_description` + `second_extra_description` | may hold a JSON string `{extra_description, second_extra_description}` — unpack it. The public route still has the fallback, but new rows should be clean |
| `visual_embed_type_1/2`, `visual_embed_1/2` | `visual_embeds[]` | fold into the repeatable component |
| `embed_type`, `embed_id`, `embed_type_2`, `embed_id_2` | same | `-1` is the empty sentinel → null |
| `chat_type`, `has_chat` | `has_chat` | two columns, one target; check which the app actually read |
| `spintowin_enabled/_token/_position` | same | direct |
| `player_id`, `event_type_id` | relations | resolve via `legacy_id` |
| `about_organizer_text`, `email_description`, `meeting_id` | — | no Strapi field; decide keep-or-drop before running |

## Step 5 — questions → `custom_fields`

`properties` is a **global** table with no `event_id`. Which questions belonged to an
event is only recoverable through `userpropertiesvalues.event_id`:

```sql
SELECT DISTINCT upv.event_id, p.id, p.name, p.name2, p.display_property, p.text_required
FROM userpropertiesvalues upv
JOIN properties p ON p.id = upv.propertyID;
```

Consequences to accept up front:

- **An event with no signups loses its question set.** There is no other link. Those
  pages migrate with `custom_fields: []`.
- `properties.name` / `name2` are the label pair — inspect which one is the Hebrew label.
- `display_property` decides the `type`; `propertiesvalues` holds the option list for
  dropdown-style questions and becomes `options[]`.
- The generated `key` must be **stable and recorded**, because step 6 writes answers
  keyed by it. Derive it once, store the `propertyID → key` map, reuse it.

## Step 6 — signups → `api::register`

The signup is spread over three tables:

- `users_events` — the signup itself (`user_id`, `event_id`, `date`)
- `users_events_info` — `first_name` / `last_name` for that signup
- `users` — the registrant (`email`, `password`, `gender`, `birthday`, `role`,
  `profile`, `player_source_id`)

Answers come from `userpropertiesvalues` (`users_events_id`, `propertyID`,
`propertyValueID` as text) and go into `register.extra_fields`, keyed by the map from
step 5.

Watch for:

- `users.password` is a Laravel hash. Registrants are not admin accounts; migrate the
  hash only if they can actually sign in anywhere, otherwise leave it null.
- The same person may appear as several `users` rows across events. Decide whether
  `register` is per-signup (simplest, matches the new model) or deduplicated by email.
  The new schema treats a register as **one signup**, so per-signup is the match.
- `pages` is a many relation on `register`; link it to the page from step 4.

## Not migrating

`transactions`, `user_orders` (no payment gateway in the new app), `chat`,
`user_drafts`, `password_resets`, `failed_jobs`, `terms_policy`, `user_contacts`,
`userpreferencesvalues`, `event_pages` (near-empty side table, not the event).

## Verification

Before declaring a step done:

```sql
-- counts to match against Strapi
SELECT COUNT(*) FROM players;
SELECT COUNT(*) FROM events;
SELECT COUNT(*) FROM users_events;
SELECT COUNT(DISTINCT hash) FROM events;   -- must equal COUNT(*)
```

Then in Strapi: every migrated row has a non-null `legacy_id`, no duplicate
`legacy_id` per content type, and every `hash` from MySQL resolves on the new site.

## Running it

Follow `scripts/migrate-users.js`: dry run by default, `--apply` to write, idempotent on
`legacy_id`, one transaction. It writes **straight to Postgres** rather than through
REST, because Strapi re-hashes any `password` it is handed — that reason applies to
users, not to pages, so steps 2–6 can use the REST API and should, to get validation and
lifecycle hooks for free.

**Claude's permission classifier blocks the `--apply` step** — the user runs that
command themselves.
