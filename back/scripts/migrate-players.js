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
 * Usage:
 *   node scripts/migrate-players.js players.json                  # dry run
 *   node scripts/migrate-players.js players.json --dump out.json  # review payloads
 *   node scripts/migrate-players.js players.json --apply
 *
 * Export the source with:
 *
 *   SELECT id, app_user_id, name, description, emails, image,
 *          facebook, instagram, website, email, email_2, phone, address
 *   FROM players;
 *
 * Re-running is safe: existing rows are matched on `legacy_id` and skipped.
 *
 * NOTE: `players` has a single `phone` column, but the Strapi schema also has
 * `phone_2` because the Vue form collected a business number and a second one.
 * If the live table turns out to have a second column, add it to the query and
 * to `toPlayer` — this script leaves `phone_2` null rather than guessing.
 */

const fs = require('fs');

const args = process.argv.slice(2);
const inputPath = args.find((a) => !a.startsWith('--'));
const apply = args.includes('--apply');

function flag(name, fallback) {
	const index = args.indexOf(`--${name}`);
	return index !== -1 && args[index + 1] ? args[index + 1] : fallback;
}

const mediaMapPath = flag('media', 'media-map.json');
/** Dry run only: write the payloads out so the mapping can be reviewed. */
const dumpPath = flag('dump', null);
const strapiUrl = (process.env.STRAPI_API_URL || 'http://localhost:1337').replace(/\/+$/, '');
const strapiToken = process.env.STRAPI_API_TOKEN;

if (!inputPath) {
	console.error('usage: node scripts/migrate-players.js <players.json> [--apply] [--media <map.json>]');
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

/**
 * Fold the three fixed columns into the repeatable `links` component.
 */
function toLinks(row) {
	const links = [];

	for (const [column, type] of [
		['website', 'website'],
		['facebook', 'facebook'],
		['instagram', 'instagram']
	]) {
		const raw = text(row[column]);
		if (!raw) continue;

		links.push({ type, url: toUrl(raw, type) });
	}

	return links;
}

/**
 * `emails` is a separate varchar from `email`/`email_2` and may hold a list.
 * Anything it contains that is not already captured is reported rather than
 * dropped silently — there is nowhere in the new schema for a third address.
 */
function strayEmails(row) {
	const known = new Set([email(row.email), email(row.email_2)].filter(Boolean).map((e) => e.toLowerCase()));

	return String(row.emails ?? '')
		.split(/[,;\s]+/)
		.map((e) => email(e))
		.filter((e) => e && !known.has(e.toLowerCase()));
}

function toPlayer(row, mediaMap, ownerByLegacyId) {
	const logo = row.image ? (mediaMap[String(row.image).trim()] ?? null) : null;

	const primary = email(row.email);
	const secondary = email(row.email_2);

	return {
		name: text(row.name) ?? `מארגן ${row.id}`,
		description: text(row.description),
		email: primary,
		// Some rows repeat the same address in both columns; carrying it twice
		// would show the organizer a duplicate to delete on first edit.
		email_2: secondary && secondary.toLowerCase() !== primary?.toLowerCase() ? secondary : null,
		phone: text(row.phone),
		// No source column — see the note at the top of this file.
		phone_2: null,
		address: text(row.address),
		links: toLinks(row),
		logo,
		owner: ownerByLegacyId.get(Number(row.app_user_id)) ?? null,
		legacy_id: row.id
	};
}

async function strapi(pathname, init = {}) {
	const response = await fetch(`${strapiUrl}${pathname}`, {
		...init,
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${strapiToken}`,
			...(init.headers || {})
		}
	});

	if (!response.ok) {
		throw new Error(`${init.method || 'GET'} ${pathname} → ${response.status}: ${(await response.text()).slice(0, 300)}`);
	}

	return response.json();
}

/** Page through a collection; Strapi caps page size well below these tables. */
async function fetchAll(pathname) {
	const out = [];
	for (let page = 1; ; page++) {
		const url = `${pathname}${pathname.includes('?') ? '&' : '?'}pagination[page]=${page}&pagination[pageSize]=100`;
		const body = await strapi(url);
		out.push(...(body.data ?? []));
		const pageCount = body.meta?.pagination?.pageCount ?? 1;
		if (page >= pageCount) break;
	}
	return out;
}

async function main() {
	const rows = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
	if (!Array.isArray(rows)) throw new Error('input must be a JSON array of players rows');

	// A dry run is useful before there is anywhere to write to: it is how the
	// mapping gets reviewed. Only --apply truly needs a token.
	if (apply && !strapiToken) throw new Error('STRAPI_API_TOKEN is required to write');
	const offline = !strapiToken;

	const mediaMap = fs.existsSync(mediaMapPath)
		? JSON.parse(fs.readFileSync(mediaMapPath, 'utf8'))
		: {};

	if (!Object.keys(mediaMap).length) {
		console.warn(`no media map at ${mediaMapPath} — logos will be left empty (run migrate-media.js first)\n`);
	}

	// owner: legacy app_user id → Strapi user documentId
	const users = offline
		? []
		: await fetchAll('/api/users?fields[0]=id&fields[1]=documentId&fields[2]=legacy_id');
	const ownerByLegacyId = new Map(
		users.filter((u) => u.legacy_id != null).map((u) => [Number(u.legacy_id), u.documentId ?? u.id])
	);

	const existing = offline ? [] : await fetchAll('/api/players?fields[0]=legacy_id');
	const migrated = new Set(existing.map((p) => p.legacy_id).filter((v) => v != null).map(Number));

	if (offline) {
		console.warn('no STRAPI_API_TOKEN — reviewing the mapping only; owners and');
		console.warn('already-migrated rows cannot be resolved without one.\n');
	}

	console.log(`source rows     : ${rows.length}`);
	console.log(`already migrated: ${rows.filter((r) => migrated.has(Number(r.id))).length}`);
	console.log(`users available : ${ownerByLegacyId.size}`);
	console.log(`target          : ${strapiUrl}`);
	console.log('');

	const stats = { created: 0, skipped: 0, noOwner: [], noLogo: [], strayEmails: [], failed: [] };
	const dumped = [];

	for (const row of rows) {
		if (migrated.has(Number(row.id))) {
			stats.skipped++;
			continue;
		}

		const payload = toPlayer(row, mediaMap, ownerByLegacyId);

		if (!payload.owner && row.app_user_id) {
			stats.noOwner.push(`player ${row.id} → app_user ${row.app_user_id} not found`);
		}
		if (row.image && !payload.logo) {
			stats.noLogo.push(`player ${row.id}: ${String(row.image).slice(0, 80)}`);
		}

		const stray = strayEmails(row);
		if (stray.length) {
			stats.strayEmails.push(`player ${row.id}: ${stray.join(', ')}`);
		}

		if (!apply) {
			if (dumpPath) dumped.push(payload);
			stats.created++;
			continue;
		}

		try {
			await strapi('/api/players?status=published', {
				method: 'POST',
				body: JSON.stringify({ data: payload })
			});
			stats.created++;
		} catch (err) {
			stats.failed.push(`player ${row.id}: ${err.message}`);
		}
	}

	if (dumpPath && dumped.length) {
		fs.writeFileSync(dumpPath, JSON.stringify(dumped, null, 2));
		console.log(`wrote ${dumped.length} payloads to ${dumpPath} for review
`);
	}

	console.log(apply ? 'APPLIED' : 'DRY RUN — nothing written (pass --apply)');
	console.log(`  created      : ${stats.created}`);
	console.log(`  already there: ${stats.skipped}`);
	console.log(`  failed       : ${stats.failed.length}`);
	console.log(`  missing owner: ${stats.noOwner.length}`);
	console.log(`  missing logo : ${stats.noLogo.length}`);
	console.log(`  stray emails : ${stats.strayEmails.length} (no field for a third address)`);

	for (const group of [stats.failed, stats.noOwner, stats.noLogo, stats.strayEmails]) {
		for (const item of group.slice(0, 15)) console.log(`    - ${item}`);
		if (group.length > 15) console.log(`    … and ${group.length - 15} more`);
	}
}

main().catch((err) => {
	console.error('player migration failed:', err.message);
	process.exit(1);
});
