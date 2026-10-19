#!/usr/bin/env node
/**
 * Fill image fields that are still empty on migrated pages and players, and
 * touch nothing else.
 *
 * Re-running migrate-pages / migrate-players after migrate-media would also
 * fill them, but by then customers were editing in the new admin: a re-run
 * pushes every field that differs from the Laravel export, overwriting their
 * edits, and recreates pages they deleted. This writes only image fields that
 * are empty in Strapi and that the media map can now resolve.
 *
 * A page with an unsaved draft is skipped: `PUT ?status=published` publishes
 * the draft along with the patch, which would put the customer's half-done
 * edits live.
 *
 * Usage (from back/):
 *   node scripts/fill-missing-images.js migration-data/events.json migration-data/players.json           # dry run
 *   node scripts/fill-missing-images.js migration-data/events.json migration-data/players.json --apply
 */

const { createClient, readJson } = require('./lib/legacy-sync');
const { mediaId } = require('./lib/media-map');

const args = process.argv.slice(2);
const [eventsPath, playersPath] = args.filter((a) => !a.startsWith('--'));
const apply = args.includes('--apply');

if (!eventsPath || !playersPath) {
	console.error('usage: node scripts/fill-missing-images.js <events.json> <players.json> [--apply]');
	process.exit(1);
}

const client = createClient({ url: process.env.STRAPI_API_URL, token: process.env.STRAPI_API_TOKEN });
const mediaMap = readJson('media-map.json', {});

const text = (value) => String(value ?? '').trim();

/** Page field ← legacy column; see the header of migrate-pages.js for why `logo` is the lecturer. */
function pageImages(row) {
	return {
		image: mediaId(mediaMap, row.image),
		image2: row.visual_embed_type_2 === 'image' ? mediaId(mediaMap, row.visual_embed_2) : null,
		bottom_image: row.visual_embed_type_3 === 'image' ? mediaId(mediaMap, row.visual_embed_3) : null,
		lecturer_image: mediaId(mediaMap, row.logo)
	};
}

// The flag that has to turn on with the image, as migrate-pages sets it.
const SHOW_FLAG = { image2: 'show_middle_image', bottom_image: 'show_bottom_image' };

/** Drafts saved again after their last publish, by documentId. */
async function pendingDrafts(collection, published) {
	const drafts = await client.fetchAll(`/api/${collection}?status=draft&fields[0]=updatedAt`);
	const publishedAt = new Map(published.map((entry) => [entry.documentId, Date.parse(entry.updatedAt)]));
	// Publishing writes both rows in the same request; a gap of more than a few
	// seconds means the draft was saved again afterwards.
	return new Set(
		drafts
			.filter((d) => publishedAt.has(d.documentId) && Date.parse(d.updatedAt) - publishedAt.get(d.documentId) > 5000)
			.map((d) => d.documentId)
	);
}

async function fill({ collection, rows, existingQuery, build }) {
	const existing = await client.fetchAll(existingQuery);
	const byLegacyId = new Map(existing.filter((e) => e.legacy_id).map((e) => [e.legacy_id, e]));
	const drafts = await pendingDrafts(collection, existing);

	const stats = { patched: 0, fields: {}, skippedDraft: [], failed: [] };

	for (const row of rows) {
		const entry = byLegacyId.get(row.id);
		if (!entry) continue; // not migrated, or deleted since — never recreated here

		const patch = {};
		for (const [field, id] of Object.entries(build(row))) {
			if (!id || entry[field]) continue;
			patch[field] = id;
			if (SHOW_FLAG[field]) patch[SHOW_FLAG[field]] = true;
		}
		if (!Object.keys(patch).length) continue;

		if (drafts.has(entry.documentId)) {
			stats.skippedDraft.push(`legacy ${row.id} (${entry.documentId}): ${Object.keys(patch).join(', ')}`);
			continue;
		}

		for (const field of Object.keys(patch)) stats.fields[field] = (stats.fields[field] || 0) + 1;
		stats.patched++;
		if (!apply) continue;

		try {
			await client.request(`/api/${collection}/${entry.documentId}?status=published`, {
				method: 'PUT',
				body: JSON.stringify({ data: patch })
			});
		} catch (err) {
			stats.patched--;
			stats.failed.push(`legacy ${row.id}: ${err.message}`);
		}
	}

	console.log(`${collection}: ${apply ? 'patched' : 'would patch'} ${stats.patched}`);
	console.log('  fields:', stats.fields);
	console.log(`  skipped, unsaved draft: ${stats.skippedDraft.length}`);
	for (const item of stats.skippedDraft) console.log(`    - ${item}`);
	console.log(`  failed: ${stats.failed.length}`);
	for (const item of stats.failed) console.log(`    - ${item}`);
}

async function main() {
	if (!process.env.STRAPI_API_URL || !process.env.STRAPI_API_TOKEN) {
		throw new Error('STRAPI_API_URL and STRAPI_API_TOKEN are required');
	}
	console.log(`media entries: ${Object.keys(mediaMap).length}`);
	console.log(apply ? 'APPLY\n' : 'DRY RUN — nothing written (pass --apply)\n');

	await fill({
		collection: 'players',
		rows: readJson(playersPath),
		existingQuery: '/api/players?status=published&fields[0]=legacy_id&fields[1]=updatedAt&populate[logo][fields][0]=id',
		build: (row) => ({ logo: text(row.image) ? mediaId(mediaMap, row.image, 'players') : null })
	});

	await fill({
		collection: 'pages',
		rows: readJson(eventsPath),
		existingQuery:
			'/api/pages?status=published&fields[0]=legacy_id&fields[1]=updatedAt' +
			'&populate[image][fields][0]=id&populate[image2][fields][0]=id' +
			'&populate[bottom_image][fields][0]=id&populate[lecturer_image][fields][0]=id',
		build: pageImages
	});
}

main().catch((err) => {
	console.error('fill-missing-images failed:', err.message);
	process.exit(1);
});
