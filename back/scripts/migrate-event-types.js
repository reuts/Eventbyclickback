#!/usr/bin/env node
/**
 * Migrate Laravel `events_types` into `api::event-type`.
 *
 * Step 1 of docs/data-migration.md, and the smallest: the table is `(id, name)`.
 *
 * Worth knowing before reading the numbers: `GoSociali::__construct` resolves a
 * single type by `env('EVENT_TYPE_NAME')` and `saveOrPublishEvent` pins every
 * event to it. So the table's ~45 rows are almost all historical, and nearly
 * every page will point at one of them. They are all migrated anyway, because
 * old rows still reference them and a dangling relation is worse than an
 * unused entry.
 *
 * Usage:
 *   node scripts/migrate-event-types.js events_types.json
 *   node scripts/migrate-event-types.js events_types.json --apply
 *   node scripts/migrate-event-types.js events_types.json --verify
 *
 *   SELECT id, name FROM events_types;
 *
 * Run this before migrate-pages.js, which resolves `event_type` through the
 * `legacy_id` this writes.
 */

const {
	createClient,
	syncCollection,
	indexByLegacyId,
	report,
	readJson
} = require('./lib/legacy-sync');

const args = process.argv.slice(2);
const inputPath = args.find((a) => !a.startsWith('--'));
const apply = args.includes('--apply');
const verify = args.includes('--verify');

const client = createClient({
	url: process.env.STRAPI_API_URL,
	token: process.env.STRAPI_API_TOKEN
});

if (!inputPath) {
	console.error('usage: node scripts/migrate-event-types.js <events_types.json> [--apply|--verify]');
	process.exit(1);
}

async function main() {
	const rows = readJson(inputPath);
	if (!Array.isArray(rows)) throw new Error('input must be a JSON array of `events_types` rows');

	if (apply && !process.env.STRAPI_API_TOKEN) throw new Error('STRAPI_API_TOKEN is required to write');

	const existing = await client.fetchAll('/api/event-types?status=published&fields[0]=name&fields[1]=legacy_id');
	const existingByLegacyId = indexByLegacyId(existing);

	// Entries that predate `legacy_id` — created by hand in the admin, or by an
	// earlier run — would otherwise be duplicated under a new id.
	const unclaimedByName = new Map(
		existing
			.filter((e) => e.legacy_id === null || e.legacy_id === undefined)
			.map((e) => [String(e.name).trim(), e])
	);

	const adopted = [];
	for (const row of rows) {
		const name = String(row.name ?? '').trim();
		const match = unclaimedByName.get(name);
		if (!name || !match || existingByLegacyId.has(Number(row.id))) continue;

		adopted.push(`"${name}" → legacy ${row.id} (${match.documentId})`);
		unclaimedByName.delete(name);

		if (apply) {
			await client.request(`/api/event-types/${match.documentId}?status=published`, {
				method: 'PUT',
				body: JSON.stringify({ data: { legacy_id: Number(row.id) } })
			});
			existingByLegacyId.set(Number(row.id), { ...match, legacy_id: Number(row.id) });
		}
	}

	console.log(`source rows      : ${rows.length}`);
	console.log(`already in Strapi: ${existingByLegacyId.size}`);
	console.log(`target           : ${client.base}`);

	if (adopted.length) {
		console.log(`\n  matched by name to entries with no legacy_id: ${adopted.length}`);
		for (const item of adopted) console.log(`    - ${item}`);
		if (!apply) console.log('    (not written — these are counted as changes below)');
	}

	const stats = await syncCollection({
		client,
		collection: 'event-types',
		rows,
		build: (row) => ({
			legacy_id: Number(row.id),
			name: String(row.name ?? '').trim() || `סוג ${row.id}`
		}),
		existingByLegacyId,
		apply
	});

	const clean = report(stats, { apply, verify });

	if (verify && !clean) process.exit(1);
}

main().catch((err) => {
	console.error('event type migration failed:', err.message);
	process.exit(1);
});
