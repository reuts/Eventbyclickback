#!/usr/bin/env node
/**
 * Upload the Laravel site's images into Strapi's media library.
 *
 * Step 3 of docs/data-migration.md, and the dependency for steps 2 and 4:
 * `events.image` / `image_2` / `logo` / `guide_pdf` and `players.image` hold
 * URLs into the Laravel host's `public/storage/`, not ids. Every one has to
 * exist in the media library before a page or player can reference it.
 *
 * Output is a JSON map of `original path → numeric media id`, which the later
 * scripts read. Nothing else in the migration talks to the filesystem.
 *
 * Goes through the REST API rather than Postgres, unlike migrate-users.js:
 * the upload plugin is what pushes bytes to Cloudinary and fills in formats
 * and dimensions. Writing media rows directly would produce entries with no
 * file behind them.
 *
 * Usage:
 *   node scripts/migrate-media.js paths.json                  # dry run
 *   node scripts/migrate-media.js paths.json --apply          # uploads
 *   node scripts/migrate-media.js paths.json --apply --files ./storage
 *
 * `paths.json` is an array of strings — the raw column values, whatever shape
 * they are in. Produce it with:
 *
 *   SELECT image FROM events WHERE image IS NOT NULL AND image <> ''
 *   UNION SELECT image_2 FROM events WHERE image_2 IS NOT NULL AND image_2 <> ''
 *   UNION SELECT logo    FROM events WHERE logo    IS NOT NULL AND logo    <> ''
 *   UNION SELECT guide_pdf FROM events WHERE guide_pdf IS NOT NULL AND guide_pdf <> ''
 *   UNION SELECT image   FROM players WHERE image   IS NOT NULL AND image   <> '';
 *
 * With `--files <dir>`, bytes are read from a local copy of `public/storage`
 * (copy it off the host once with tar/scp — one request per file over the
 * public site is slow and fails on anything that was never public). Without
 * it, each file is fetched over HTTP from `--base`.
 *
 * Re-running is safe: the existing map is loaded first and known paths are
 * skipped, so an interrupted run resumes.
 */

const fs = require('fs');
const path = require('path');
// Shared with the steps that read the map back, so the two cannot drift apart.
const { toStoragePath } = require('./lib/media-map');

const args = process.argv.slice(2);
const inputPath = args.find((a) => !a.startsWith('--'));
const apply = args.includes('--apply');

function flag(name, fallback) {
	const index = args.indexOf(`--${name}`);
	return index !== -1 && args[index + 1] ? args[index + 1] : fallback;
}

const filesDir = flag('files', null);
const baseUrl = flag('base', 'https://app.eventbyclick.com').replace(/\/+$/, '');
const outPath = flag('out', 'media-map.json');
const strapiUrl = (process.env.STRAPI_API_URL || 'http://localhost:1337').replace(/\/+$/, '');
const strapiToken = process.env.STRAPI_API_TOKEN;

if (!inputPath) {
	console.error('usage: node scripts/migrate-media.js <paths.json> [--apply] [--files <dir>] [--base <url>] [--out <file>]');
	process.exit(1);
}

function contentType(filename) {
	const ext = path.extname(filename).toLowerCase();
	return (
		{
			'.jpg': 'image/jpeg',
			'.jpeg': 'image/jpeg',
			'.png': 'image/png',
			'.gif': 'image/gif',
			'.webp': 'image/webp',
			'.svg': 'image/svg+xml',
			'.pdf': 'application/pdf'
		}[ext] || 'application/octet-stream'
	);
}

/** Local copy first; the public site is the fallback. */
async function readBytes(storagePath) {
	if (filesDir) {
		const local = path.join(filesDir, storagePath);
		if (fs.existsSync(local)) return fs.readFileSync(local);
		// fall through — the file may exist only on the live site
	}

	const url = `${baseUrl}/storage/${storagePath}`;
	const response = await fetch(url);
	if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);

	return Buffer.from(await response.arrayBuffer());
}

async function upload(storagePath, bytes) {
	const filename = path.basename(storagePath);
	const form = new FormData();
	form.append('files', new Blob([bytes], { type: contentType(filename) }), filename);

	const response = await fetch(`${strapiUrl}/api/upload`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${strapiToken}` },
		body: form
	});

	if (!response.ok) {
		throw new Error(`upload failed ${response.status}: ${(await response.text()).slice(0, 200)}`);
	}

	const [file] = await response.json();
	return file.id;
}

async function main() {
	const values = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
	if (!Array.isArray(values)) throw new Error('input must be a JSON array of path strings');

	if (apply && !strapiToken) {
		throw new Error('STRAPI_API_TOKEN is required to upload');
	}

	// Distinct storage paths — the same image is referenced by several events.
	const wanted = new Map();
	let skippedInline = 0;

	for (const value of values) {
		const storagePath = toStoragePath(value);
		if (!storagePath) {
			if (String(value || '').startsWith('data:')) skippedInline++;
			continue;
		}
		// Keep the first original spelling; the map is keyed by it too.
		if (!wanted.has(storagePath)) wanted.set(storagePath, []);
		wanted.get(storagePath).push(String(value).trim());
	}

	const map = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, 'utf8')) : {};
	const alreadyDone = new Set(Object.values(map).length ? Object.keys(map) : []);

	console.log(`source values   : ${values.length}`);
	console.log(`distinct files  : ${wanted.size}`);
	console.log(`inline base64   : ${skippedInline} (no file to fetch)`);
	console.log(`already mapped  : ${[...wanted.keys()].filter((p) => alreadyDone.has(p)).length}`);
	console.log(`target          : ${strapiUrl}`);
	console.log(filesDir ? `reading from    : ${filesDir} (falling back to ${baseUrl})` : `reading from    : ${baseUrl}`);
	console.log('');

	const stats = { uploaded: 0, skipped: 0, missing: [], failed: [] };

	for (const [storagePath, originals] of wanted) {
		if (map[storagePath]) {
			stats.skipped++;
			continue;
		}

		try {
			const bytes = await readBytes(storagePath);

			if (!apply) {
				console.log(`  would upload ${storagePath} (${bytes.length} bytes)`);
				stats.uploaded++;
				continue;
			}

			const id = await upload(storagePath, bytes);
			map[storagePath] = id;

			// Every spelling the columns used points at the same id, so the
			// later scripts can look up the raw column value directly.
			for (const original of originals) map[original] = id;

			stats.uploaded++;
			fs.writeFileSync(outPath, JSON.stringify(map, null, 2));
			console.log(`  ${storagePath} → media ${id}`);
		} catch (err) {
			// A file referenced by an old row may simply be gone. That is not a
			// reason to abandon the run — the page migrates with a null image.
			const message = err.message || String(err);
			if (message.includes('HTTP 404') || message.includes('ENOENT')) {
				stats.missing.push(storagePath);
			} else {
				stats.failed.push(`${storagePath}: ${message}`);
			}
		}
	}

	if (apply) {
		fs.writeFileSync(outPath, JSON.stringify(map, null, 2));
		console.log(`\nWROTE ${outPath}`);
	} else {
		console.log('\nDRY RUN — nothing uploaded, no map written (pass --apply)');
	}

	console.log(`  uploaded     : ${stats.uploaded}`);
	console.log(`  already there: ${stats.skipped}`);
	console.log(`  missing files: ${stats.missing.length}`);
	console.log(`  failed       : ${stats.failed.length}`);

	for (const item of stats.missing.slice(0, 20)) console.log(`    - missing ${item}`);
	if (stats.missing.length > 20) console.log(`    … and ${stats.missing.length - 20} more`);
	for (const item of stats.failed) console.log(`    - ${item}`);
}

main().catch((err) => {
	console.error('media migration failed:', err.message);
	process.exit(1);
});
