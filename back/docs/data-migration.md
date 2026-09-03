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

## This runs more than once

Laravel keeps taking signups and edits until the day it is switched off, so no step is a
one-shot import. Every script is an **upsert with a diff**: it rebuilds the payload from
MySQL, compares it to what is in Strapi, and names the fields that moved.

```bash
node scripts/migrate-pages.js events.json            # diff only, nothing written
node scripts/migrate-pages.js events.json --apply    # create the new, update the changed
node scripts/migrate-pages.js events.json --verify   # exits 1 if anything still differs
```

`--verify` is the cutover check: export fresh from MySQL, run it, and a run reporting
`created 0 / updated 0 / failed 0` is the proof that nothing was left behind. It also
lists entries in Strapi whose legacy row is gone from the export — those are never
deleted automatically, because a missing row is as likely to be a narrowed export query
as a real deletion.

**Laravel is the source of truth until the cutover.** A page edited in Strapi and then
re-synced is overwritten, which is the right direction while both are live — and the
reason the report names every changed field instead of updating quietly.

The shared machinery lives in `scripts/lib/legacy-sync.js` (client, diff, upsert) and
`scripts/lib/media-map.js` (what the image columns actually contain). The diff normalises
per field kind, because a populated media object and a populated relation both carry `id`
and `documentId` — comparing the wrong one makes every row look changed on every run.

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

All six are scripted. Two schema fields were added for them and need a Strapi deploy
before steps 1 and 6 run: `event-type.legacy_id` and `register.signed_up_at`.

## Step 1 — `events_types`  ·  `scripts/migrate-event-types.js`

`(id, name)`, so the mapping is the whole story. Two things worth knowing before reading
the row count:

**Every event the modern wizard created shares one type.** `GoSociali::__construct`
resolves it by `env('EVENT_TYPE_NAME')` and `saveOrPublishEvent` pins
`$event->event_type_id` to it. The table's ~45 rows are almost all historical. They are
migrated anyway — old rows still point at them, and a dangling relation is worse than an
unused entry.

**`event-type` had no `legacy_id`.** Added in this branch, along with
`register.signed_up_at`; both need a Strapi deploy before step 1 or step 6 can run.

The script also adopts an entry created by hand in the admin: if a name matches and the
entry has no `legacy_id`, it claims that entry instead of creating a duplicate.

```bash
node scripts/migrate-event-types.js events_types.json --apply
```

`event_categories` has no Strapi equivalent and the wizard no longer asks for one.
`category_id` is **dropped**, and step 4 reports every row that had one.

## Step 2 — `players`  ·  `scripts/migrate-players.js`

| MySQL | Strapi | Notes |
|---|---|---|
| `name`, `description`, `email`, `email_2`, `address` | same | direct |
| `phone` | `phone` | **only one phone column exists.** `phone_2` was added to the Strapi schema from the Vue form, which showed two. Confirm against the live table before assuming it is unused. |
| `website`, `facebook`, `instagram` | `links[]` | fold each non-empty one into a `contact.social-link` with the matching `type` |
| `emails` (varchar, plural) | — | inspect the live values; if it is a comma-separated list it may hold addresses not in `email`/`email_2` |
| `image` | `logo` | see step 3 |
| `app_user_id` | `owner` | resolve via the user's `legacy_id` |
| `yaad_masof`, `yaad_key`, `isracard_key`, `payment_gateway` | — | **not migrated.** These are payment-gateway credentials; the new app uses external links only. Do not copy them. |

```bash
node scripts/migrate-players.js players.json --dump review.json   # dry run
node scripts/migrate-players.js players.json --apply
node scripts/migrate-players.js players.json --verify
```

`--dump` writes the payloads for review before anything is written. A dry run works
without `STRAPI_API_TOKEN`, which is how the mapping gets checked before there is
anywhere to write to.

Two shapes the script handles that a naive translation gets wrong: a bare social handle
(`@danastudio`) resolves against its platform rather than becoming
`https://@danastudio`, and an `email_2` identical to `email` is dropped instead of
carried through as a duplicate.

**Run it after step 3**, so logos resolve.

## Step 3 — media  ·  `scripts/migrate-media.js`

The hard part, and the reason step 4 cannot be a straight SQL translation.

`events.image`, `events.image_2`, `events.logo` (the lecturer image — see step 4),
`events.visual_embed_2`, `events.visual_embed_3`, `events.guide_pdf`,
`events.additional_file` and `players.image`
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

Include `visual_embed_2`, `visual_embed_3`, `logo` and `additional_file` in the export
query as well — the shape given above predates the discovery that those hold images too.

```bash
# review what would be uploaded, reading from a local copy of public/storage
node scripts/migrate-media.js paths.json --files ./storage
# upload; writes media-map.json incrementally so an interrupted run resumes
node scripts/migrate-media.js paths.json --files ./storage --apply
```

Re-running it later picks up only what is new: known paths are skipped, so the run
before the cutover uploads exactly the images added since the first one.

The script normalises whatever the columns hold — a full URL, a `storage/...`
fragment, or a bare filename — down to one path per file, so the same image
referenced by several events uploads once. Inline `data:` values are skipped: there is
no file behind them. The map is keyed by both the normalised path and every original
spelling, so later steps can look up the raw column value.

## Step 4 — `events` → `api::page`  ·  `scripts/migrate-pages.js`

The largest step. Mostly one-to-one; the fields below are not.

**The column names lie about three of them.** `EventService::saveOrPublishEvent` is the
authority, not the schema:

| MySQL | Strapi | Why |
|---|---|---|
| `logo` | `lecturer_image` | `$event->logo = uploadImage($details['lecturer_image'])`. It is **not** the organizer logo — that lives on the player, from step 2. `page.logo` is left alone. |
| `visual_embed_2` | `image2` + `show_middle_image` | written with `visual_embed_type_2 = 'image'`; the middle image, not a video |
| `visual_embed_3` | `bottom_image` + `show_bottom_image` | same, for the bottom image |

`visual_embed_1` is fillable but no current code writes it. Anything found there is
reported, not guessed at.

The rest:

| MySQL | Strapi | Rule |
|---|---|---|
| `hash` | `hash` | **preserved verbatim** — every public URL in the wild is `/{hash}`. The script also reports duplicate hashes, which would collide on the uid column |
| `type` | `page_type` | added 2025-03-23. Rows older than that are NULL → `save_spot`, **except** when `guide_pdf` is set, which gives the type away |
| `payment_required` (tinyint 0/1/2) | `payment_display` | `1 → paid`, `0 → free`, `2 → hidden`; the boolean `payment_required` is its mirror |
| `payment_type`, `payment_url` | same | carried only when the display is `paid`, as Laravel did |
| `paid` | — | separate legacy flag, always 1 by default; `payment_required` is what the wizard wrote |
| `image`, `image_2` | `image` | Laravel writes the cover into both. A row where they differ predates that and is reported |
| `time`, `end_time` | same | `varchar(45)` free text → a real time column; anything unparseable becomes null and is reported |
| `event_date`, `event_end_date` | same | `date` → `datetime` at midnight **UTC**: Israel is UTC+3, so the calendar day survives local rendering |
| `online` | `is_online` | tinyint → boolean |
| `extra_description` | `extra_description` + `second_extra_description` | may hold a JSON envelope — unpacked exactly as `Event::getFirstDescriptionAttribute` does |
| `embed_type`, `embed_id`, `embed_type_2`, `embed_id_2` | `embed_type`, `embed_id`, `embed_type2`, `embed_id2` | `-1` and `1` are empty sentinels → null; a value outside the enum is dropped and reported |
| `chat_type`, `has_chat` | `has_chat` | two columns, one target; `has_chat` is what the app read |
| `name_position` | same | empty resolves the way Laravel's form loader did: `center` when the cover came from Pixabay, else the schema default |
| `player_id`, `event_type_id` | relations | resolved via `legacy_id` |
| `category_id`, `meeting_pass`, `meeting_id`, `about_organizer_text`, `email_description` | — | **dropped.** Each is reported per row when non-empty, so the list can be reviewed before the cutover rather than after |

**Page-type rules are applied.** The script mirrors `FEATURE_FIELDS` from the SvelteKit
app's `src/lib/event-wizard/page-types.ts`, so a migrated page is indistinguishable from
one the new wizard produced — a `contact_me` page cannot arrive carrying a payment link
the new form has no way to show, edit or clear. Every field this clears is reported.
The matrix is duplicated across the two repos because the back end cannot import from the
front end; a change there needs the same change here.

```bash
node scripts/migrate-pages.js events.json --dump review.json
node scripts/migrate-pages.js events.json --apply
node scripts/migrate-pages.js events.json --verify
```

Run it **after** steps 1–3, or every image and relation comes back reported as missing.

## Step 5 — questions → `custom_fields`  ·  `scripts/migrate-questions.js`

**Three property ids are not custom fields at all.** Both `EventController`s hardcode
them as the standard signup fields:

| id | Laravel | page | register |
|---|---|---|---|
| 39 | phone | `field_phone` | `phone` |
| 24 | profession | `field_profession` | `profession` |
| 41 | newsletter | `field_newsletter` | `newsletter` |

They are skipped here and mapped onto real columns in step 6. Step 4 already carried the
`field_*` booleans.

`properties` is otherwise a **global** table. It has an `eventTypeID`, but that cannot
say which questions an event asked — every modern event shares one event type (step 1).
Only `userpropertiesvalues.event_id` links a question to an event, and it only knows
about questions somebody actually answered.

**That is less lossy than it sounds.** An event with no signups keeps its standard
fields, because those are page columns. Only a genuinely custom question on a
zero-signup event is unrecoverable — and the wizard never offered a way to create one, so
in practice `custom_fields` comes out empty for most pages.

Run `--inspect` against the live export **before the first apply**: it prints the
distinct `display_property` / `commandType` shapes with counts, examples and what each
maps to. The type table in the script was built from the stale dump; extend it with
whatever shows up.

```bash
node scripts/migrate-questions.js --inspect
node scripts/migrate-questions.js --apply
```

- `key` is **`prop_<id>`** — derived from the numeric id, not the label. Labels are Hebrew
  free text, they collide, and renaming a question must not orphan every answer already
  recorded under it. Step 6 reads this from `question-map.json`, which is written even on
  a dry run.
- `label` prefers `name` over `name2` (`name` is what the signup listing GROUP_CONCATs);
  a row where they differ is reported.
- `propertiesvalues` becomes `options[]`, and its presence forces `type: select`.

## Step 6 — signups → `api::register`  ·  `scripts/migrate-registers.js`

The signup is spread over three tables:

- `users_events` — the signup itself (`user_id`, `event_id`, `date`)
- `users_events_info` — `first_name` / `last_name` for that signup
- `users` — the registrant (`email`, `password`, `gender`, `birthday`, `role`,
  `profile`, `player_source_id`)

Answers come from `userpropertiesvalues` and go into `register.extra_fields`, keyed by
the map from step 5.

**`legacy_id` holds the `users_events.id`, not the `users.id`.** A register is one
signup, not one person: the same person signing up to three events is three rows in
Laravel and three registers here, which is what the new model means. Keying on the user
id would silently collapse them.

**`propertyValueID` is a `text` column doing two jobs** — it holds either the id of a row
in `propertiesvalues` or the answer itself. `EventController` resolves it with
`IFNULL(propertiesvalues.propertyValue, propertyValueID)`, and so does the script.

**`users.password` is deliberately not migrated.** Strapi hashes anything handed to a
password column, so copying the Laravel hash through REST stores a hash of a hash —
unusable, and worse than empty because it looks like a working credential. (This is the
mirror image of the users step, which had to bypass REST for exactly that reason.)
Registrants are signup records; nothing in the new app logs in as one.

Names come from `users`, which is what the app's own listing reads. `users_events_info`
is the older per-signup copy: used when the user row has no name, and reported when the
two disagree — that is a person whose name changed between signups.

```bash
node scripts/migrate-registers.js --dump review.json
node scripts/migrate-registers.js --apply
```

## Not migrating

`transactions`, `user_orders` (no payment gateway in the new app), `chat`,
`user_drafts`, `password_resets`, `failed_jobs`, `terms_policy`, `user_contacts`,
`userpreferencesvalues`, `event_pages` (near-empty side table, not the event).

## The cutover run

Export fresh from MySQL, then run the whole chain in order with `--verify`. A clean pass
on all six is the sign-off:

```bash
node scripts/migrate-event-types.js events_types.json --verify
node scripts/migrate-media.js paths.json --files ./storage          # additive; re-run --apply
node scripts/migrate-players.js players.json --verify
node scripts/migrate-pages.js events.json --verify
node scripts/migrate-questions.js --verify
node scripts/migrate-registers.js --verify
```

Each exits 1 while anything differs, so the sequence can be a single `&&` chain in a
shell script. Media is the exception: it has nothing to diff, it just uploads whatever is
new, so run it with `--apply` before the four that depend on it.

Independent checks worth running once alongside:

```sql
SELECT COUNT(*) FROM players;
SELECT COUNT(*) FROM events;
SELECT COUNT(*) FROM users_events;
SELECT COUNT(DISTINCT hash) FROM events;   -- must equal COUNT(*)
```

Then in Strapi: no duplicate `legacy_id` per content type, and every `hash` from MySQL
resolves on the new site.

## Running it

Dry run by default, `--apply` to write, `--verify` to assert agreement, keyed on
`legacy_id` throughout — see **This runs more than once** above.

`migrate-users.js` is the odd one out: it writes **straight to Postgres** rather than
through REST, because Strapi re-hashes any `password` it is handed and every account
would be locked out. That reason applies to users only, so steps 2–6 go through the REST
API and get validation, component wiring and lifecycle hooks for free.

**Claude's permission classifier blocks the `--apply` step** — the user runs that
command themselves.
