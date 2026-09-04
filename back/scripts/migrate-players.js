#!/usr/bin/env node
/**
 * Migrate Laravel `players` into `api::player`.
 *
 * Step 2 of docs/data-migration.md. Depends on step 0 (the users are already
 * in `up_users`, and `app_user_id` becomes the `owner` relation) and on step 3
 * (`media-map.json`, since `players.image` is a path, not an id).
 *
 * Goes through the REST API rather than Postgres: unlike the users step there
 * is no hashing hazard here, and the API gives validation, the `links`
 * component wiring and lifecycle hooks for free.
 *
 * Laravel keeps taking edits until it is switched off, so this is an upsert,
 * not an import: it diffs each row against Strapi and names the fields that
 * moved. `--verify` after the cutover exits non-zero if anything still differs.
 *
 * Usage:
 *   node scripts/migrate-players.js players.json                  # dry run + diff
 *   node scripts/migrate-players.js players.json --dump out.json  # review payloads
 *   node scripts/migrate-players.js players.json --apply          # create + update
 *   node scripts/migrate-players.js players.json --verify         # exit 1 on drift
 *
 * Export the source with:
 *
 *   SELECT id, app_user_id, name, description, emails, image,
 *          facebook, instagram, website, email, email_2, phone, address
 *   FROM players;
 *
 * NOTE: `players` has a single `phone` column, but the Strapi schema also has
 * `phone_2` because the Vue form collected a business number and a second one.
 * If the live table turns out to have a second column, add it to the query and
 * to `toPlayer` — this script leaves `phone_2` out rather than guessing, so it
 * never overwrites a value typed into Strapi.
 */

const fs = require('fs');
const {
	flag,
	createClient,
	syncCollection,
	indexByLegacyId,
	report,
	readJson
} = require('./lib/legacy-sync');
const { mediaId } = require('./lib/media-map');

const args = process.argv.slice(2);
const inputPath = args.find((a) => !a.startsWith('--'));
const apply = args.includes('--apply');
const verify = args.includes('--verify');
const dumpPath = flag(args, 'dump');
const mediaMapPath = flag(args, 'media', 'media-map.json');

const client = createClient({
	url: process.env.STRAPI_API_URL,
	token: process.env.STRAPI_API_TOKEN
});

if (!inputPath) {
	console.error('usage: node scripts/migrate-players.js <players.json> [--apply|--verify] [--media <map.json>]');
	process.exit(1);
}

function text(value) {
	const trimmed = String(value ?? '').trim();
	return trimmed === '' ? null : trimmed;
}

/** Loose check; the point is to drop obvious junk, not to police addresses. */
function email(value) {
	const cleaned = text(value);
	return cleaned && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned) ? cleaned : null;
}

/** Where a bare handle lives, per platform. */
const HANDLE_BASE = {
	facebook: 'https://facebook.com/',
	instagram: 'https://instagram.com/'
};

/**
 * Turn whatever the column holds into a usable URL.
 *
 * Laravel accepted a full URL, a domain without a scheme, or a bare handle —
 * "@danastudio" is common in the instagram column. Prefixing a handle with
 * https:// alone produces `https://@danastudio`, which is not a link, so a
 * value that is clearly a handle is resolved against its platform instead.
 */
function toUrl(raw, type) {
	if (/^https?:\/\//i.test(raw)) return raw;

	const base = HANDLE_BASE[type];
	const handle = raw.replace(/^@+/, '').replace(/^\/+/, '');

	// A handle has no dot and no path; anything else is a domain.
	const looksLikeHandle = base && !handle.includes('.') && !handle.includes('/');
	if (looksLikeHandle) return `${base}${handle}`;

	return `https://${handle}`;
}

/** Fold the three fixed columns into the repeatable `links` component. */
function toLinks(row) {
	const links = [];

	for (const column of ['website', 'facebook', 'instagram']) {
		const raw = text(row[column]);
		if (!raw) continue;

		links.push({ type: column, url: toUrl(raw, column) });
	}

	return links;
}

/**
 * `emails` is a separate varchar from `email`/`email_2` and may hold a list.
 * Anything it contains that is not already captured is reported rather than
 * dropped silently — there is nowhere in the new schema for a third address.
 */
function strayEmails(row) {
	const known = new Set(
		[email(row.email), email(row.email_2)].filter(Boolean).map((e) => e.toLowerCase())
	);

	return String(row.emails ?? '')
		.split(/[,;\s]+/)
		.map((e) => email(e))
		.filter((e) => e && !known.has(e.toLowerCase()));
}

/** How each field is compared; anything absent is compared as a scalar. */
const KINDS = { logo: 'media', owner: 'relation', links: 'component' };

function toPlayer(row, context) {
	const { mediaMap, ownerByLegacyId, notes } = context;
	const note = (message) => notes.push(`player ${row.id}: ${message}`);

	let logo = null;
	if (text(row.image)) {
		logo = mediaId(mediaMap, row.image);
		if (!logo) note(`logo not in the media map: ${String(row.image).slice(0, 80)}`);
	}

	const primary = email(row.email);
	const secondary = email(row.email_2);

	const owner = ownerByLegacyId.get(Number(row.app_user_id)) ?? null;
	if (row.app_user_id && !owner) note(`app_user ${row.app_user_id} not found`);

	const stray = strayEmails(row);
	if (stray.length) note(`no field for a third address: ${stray.join(', ')}`);

	return {
		legacy_id: Number(row.id),
		name: text(row.name) ?? `מארגן ${row.id}`,
		description: text(row.description),
		email: primary,
		// Some rows repeat the same address in both columns; carrying it twice
		// would show the organizer a duplicate to delete on first edit.
		email_2: secondary && secondary.toLowerCase() !== primary?.toLowerCase() ? secondary : null,
		phone: text(row.phone),
		address: text(row.address),
		links: toLinks(row),
		logo,
		owner
	};
}

async function main() {
	const rows = readJson(inputPath);
	if (!Array.isArray(rows)) throw new Error('input must be a JSON array of `players` rows');

	if (apply && !process.env.STRAPI_API_TOKEN) throw new Error('STRAPI_API_TOKEN is required to write');

	// A dry run is useful before there is anywhere to write to: it is how the
	// mapping gets reviewed. Only --apply truly needs a token.
	const offline = !process.env.STRAPI_API_TOKEN;
	if (offline) {
		console.warn('no STRAPI_API_TOKEN — reviewing the mapping only; owners and');
		console.warn('already-migrated rows cannot be resolved without one.\n');
	}

	const mediaMap = readJson(mediaMapPath, {});
	if (!Object.keys(mediaMap).length) {
		console.warn(`no media map at ${mediaMapPath} — logos will be left empty (run migrate-media.js first)\n`);
	}

	const users = offline
		? []
		: await client.fetchAll('/api/users?fields[0]=id&fields[1]=documentId&fields[2]=legacy_id');
	// The numeric id, not the documentId. `plugin::users-permissions.user` is
	// not a draft-and-publish content type, and Strapi resolves relations to it
	// by numeric id only — a documentId is rejected outright with
	// "Invalid relations", which is what stopped 101 of the 154 owned players.
	const ownerByLegacyId = new Map(
		[...indexByLegacyId(users)].map(([id, u]) => [id, u.id])
	);

	// The diff compares logo and owner, so both have to come back populated.
	const existing = offline
		? []
		: await client.fetchAll('/api/players?status=published&populate[0]=logo&populate[1]=owner&populate[2]=links');
	const existingByLegacyId = indexByLegacyId(existing);

	console.log(`source rows      : ${rows.length}`);
	console.log(`already in Strapi: ${existingByLegacyId.size}`);
	console.log(`users available  : ${ownerByLegacyId.size}`);
	console.log(`target           : ${client.base}`);
	console.log('');

	const notes = [];
	const dumped = [];
	const context = { mediaMap, ownerByLegacyId, notes };

	const stats = await syncCollection({
		client,
		collection: 'players',
		rows,
		build: (row) => toPlayer(row, context),
		kinds: KINDS,
		existingByLegacyId,
		apply,
		onRow: dumpPath ? (_row, payload) => dumped.push(payload) : null
	});

	if (dumpPath && dumped.length) {
		fs.writeFileSync(dumpPath, JSON.stringify(dumped, null, 2));
		console.log(`wrote ${dumped.length} payloads to ${dumpPath} for review`);
	}

	const clean = report(stats, { apply, verify });

	console.log(`\n  notes: ${notes.length}`);
	for (const item of notes.slice(0, 30)) console.log(`    - ${item}`);
	if (notes.length > 30) console.log(`    … and ${notes.length - 30} more`);

	if (verify && !clean) process.exit(1);
}

main().catch((err) => {
	console.error('player migration failed:', err.message);
	process.exit(1);
});
