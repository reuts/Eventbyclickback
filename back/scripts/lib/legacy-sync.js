/**
 * Shared machinery for the Laravel → Strapi migration scripts.
 *
 * The migration is not a one-shot cutover: the Laravel site keeps taking
 * signups and edits until the day it is switched off. So every step has to be
 * runnable again and again, and the last run has to be able to say "nothing
 * differs any more" rather than "160 rows skipped".
 *
 * That is what this file provides: a REST client, and an upsert that diffs a
 * freshly built payload against what is already in Strapi and reports the
 * fields that moved. `--apply` writes the difference; without it nothing is
 * written and the diff is the output.
 *
 * Laravel is the source of truth while both systems are live. An entry edited
 * in Strapi and then re-synced will be overwritten — which is the correct
 * direction until the cutover, and the reason the report names every changed
 * field instead of updating quietly.
 */

const fs = require('fs');

/** Reads `--name <value>`, with a fallback. */
function flag(args, name, fallback = null) {
	const index = args.indexOf(`--${name}`);
	const value = args[index + 1];
	return index !== -1 && value && !value.startsWith('--') ? value : fallback;
}

function createClient({ url, token }) {
	const base = (url || 'http://localhost:1337').replace(/\/+$/, '');

	async function request(pathname, init = {}) {
		const response = await fetch(`${base}${pathname}`, {
			...init,
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${token}`,
				...(init.headers || {})
			}
		});

		if (!response.ok) {
			const body = (await response.text()).slice(0, 400);
			throw new Error(`${init.method || 'GET'} ${pathname} → ${response.status}: ${body}`);
		}

		return response.status === 204 ? null : response.json();
	}

	/** Strapi caps page size well below these tables, so always page. */
	async function fetchAll(pathname) {
		const out = [];
		for (let page = 1; ; page++) {
			const sep = pathname.includes('?') ? '&' : '?';
			const body = await request(`${pathname}${sep}pagination[page]=${page}&pagination[pageSize]=100`);
			out.push(...(body.data ?? body ?? []));
			const pageCount = body.meta?.pagination?.pageCount ?? 1;
			if (page >= pageCount) break;
		}
		return out;
	}

	return { base, request, fetchAll };
}

/**
 * Reduce a value to something the two sides can be compared on.
 *
 * `kind` matters because a populated Strapi media object and a populated
 * relation both carry `id` and `documentId`: media is referenced by numeric
 * id, relations by document id, and picking the wrong one makes every row look
 * changed on every run.
 */
function normalise(value, kind) {
	if (value === undefined || value === null || value === '') return null;

	if (kind === 'media') {
		if (typeof value === 'object') return value.id ?? null;
		return Number(value);
	}

	if (kind === 'relation') {
		if (Array.isArray(value)) return value.map((v) => normalise(v, 'relation'));
		if (typeof value === 'object') return value.documentId ?? String(value.id ?? '');
		return String(value);
	}

	if (kind === 'component') {
		const strip = (item) => {
			if (!item || typeof item !== 'object') return item;
			const out = {};
			for (const [key, inner] of Object.entries(item)) {
				// Component ids are assigned by Strapi and differ on every write.
				if (key === 'id' || key === 'documentId' || key === '__component') continue;
				out[key] = inner && typeof inner === 'object' && 'id' in inner ? inner.id : inner;
			}
			return out;
		};
		const stripped = Array.isArray(value) ? value.map(strip) : strip(value);
		return JSON.stringify(stripped);
	}

	if (kind === 'json') return JSON.stringify(value);

	// Dates come back from Strapi in a different string form than they went in.
	if (kind === 'datetime') {
		const parsed = new Date(value);
		return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
	}

	if (typeof value === 'boolean' || typeof value === 'number') return value;

	return String(value).trim();
}

function sameValue(a, b, kind) {
	const left = normalise(a, kind);
	const right = normalise(b, kind);

	if (Array.isArray(left) && Array.isArray(right)) {
		return left.length === right.length && left.every((v, i) => v === right[i]);
	}

	return left === right;
}

/**
 * Which payload fields differ from the entry already in Strapi.
 *
 * Only fields present in the payload are compared: anything the migration does
 * not set is not the migration's business, so a value someone typed into a
 * Strapi-only field never shows up as drift.
 */
function changedFields(payload, existing, kinds = {}) {
	const changed = [];

	for (const [key, value] of Object.entries(payload)) {
		if (key === 'legacy_id') continue;
		if (!sameValue(value, existing?.[key], kinds[key])) changed.push(key);
	}

	return changed;
}

/**
 * Create-or-update a whole collection against its Laravel rows.
 *
 * `existingByLegacyId` is built by the caller, because the populate the diff
 * needs is collection-specific.
 */
async function syncCollection({
	client,
	collection,
	rows,
	build,
	kinds = {},
	existingByLegacyId,
	apply,
	limit = null,
	onRow = null
}) {
	const stats = { created: 0, updated: 0, unchanged: 0, failed: [], changes: [], orphans: [] };
	const seen = new Set();
	let processed = 0;

	for (const row of rows) {
		if (limit !== null && processed >= limit) break;
		processed++;

		const legacyId = Number(row.id);
		seen.add(legacyId);

		let payload;
		try {
			payload = build(row);
		} catch (err) {
			stats.failed.push(`legacy ${legacyId}: building payload: ${err.message}`);
			continue;
		}

		if (onRow) onRow(row, payload);

		const existing = existingByLegacyId.get(legacyId);

		if (!existing) {
			stats.created++;
			if (!apply) continue;

			try {
				await client.request(`/api/${collection}?status=published`, {
					method: 'POST',
					body: JSON.stringify({ data: payload })
				});
			} catch (err) {
				stats.created--;
				stats.failed.push(`legacy ${legacyId}: create: ${err.message}`);
			}
			continue;
		}

		const changed = changedFields(payload, existing, kinds);

		if (!changed.length) {
			stats.unchanged++;
			continue;
		}

		stats.updated++;
		stats.changes.push(`legacy ${legacyId}: ${changed.join(', ')}`);

		if (!apply) continue;

		try {
			// Only the fields that moved, so a partial payload cannot blank
			// something the build step deliberately left out.
			const patch = Object.fromEntries(changed.map((key) => [key, payload[key]]));
			await client.request(`/api/${collection}/${existing.documentId}?status=published`, {
				method: 'PUT',
				body: JSON.stringify({ data: patch })
			});
		} catch (err) {
			stats.updated--;
			stats.failed.push(`legacy ${legacyId}: update: ${err.message}`);
		}
	}

	// Entries in Strapi whose legacy row is not in the export. Never deleted
	// automatically: a missing row is as likely to be a narrowed export query
	// as a real deletion.
	if (limit === null) {
		for (const [legacyId, entry] of existingByLegacyId) {
			if (!seen.has(legacyId)) stats.orphans.push(`legacy ${legacyId} (${entry.documentId})`);
		}
	}

	return stats;
}

/** Index a fetched Strapi collection by its legacy_id. */
function indexByLegacyId(entries) {
	return new Map(
		entries
			.filter((e) => e.legacy_id !== null && e.legacy_id !== undefined)
			.map((e) => [Number(e.legacy_id), e])
	);
}

/**
 * Print the run summary. Returns true when the run is clean — which, in
 * `--verify`, means the two systems agree on every row.
 */
function report(stats, { apply, verify }) {
	console.log('');
	console.log(apply ? 'APPLIED' : verify ? 'VERIFY — nothing written' : 'DRY RUN — nothing written (pass --apply)');
	console.log(`  created  : ${stats.created}`);
	console.log(`  updated  : ${stats.updated}`);
	console.log(`  unchanged: ${stats.unchanged}`);
	console.log(`  failed   : ${stats.failed.length}`);
	console.log(`  in Strapi, not in the export: ${stats.orphans.length}`);

	for (const [label, items] of [
		['changed', stats.changes],
		['failed', stats.failed],
		['orphan', stats.orphans]
	]) {
		for (const item of items.slice(0, 20)) console.log(`    ${label}: ${item}`);
		if (items.length > 20) console.log(`    … and ${items.length - 20} more ${label}`);
	}

	return stats.failed.length === 0 && (!verify || (stats.created === 0 && stats.updated === 0));
}

function readJson(pathname, fallback = undefined) {
	if (!fs.existsSync(pathname)) {
		if (fallback !== undefined) return fallback;
		throw new Error(`missing file: ${pathname}`);
	}
	return JSON.parse(fs.readFileSync(pathname, 'utf8'));
}

module.exports = {
	flag,
	createClient,
	normalise,
	sameValue,
	changedFields,
	syncCollection,
	indexByLegacyId,
	report,
	readJson
};
