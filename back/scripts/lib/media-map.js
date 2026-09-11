/**
 * The one place that knows what the Laravel image columns actually contain.
 *
 * `migrate-media.js` uses it to decide what to upload; every later step uses it
 * to turn a stored column value back into the media id that upload produced.
 * They have to agree exactly, or a page ends up with no image even though the
 * file was uploaded — hence one module rather than a copy in each script.
 */

/**
 * Reduce a stored value to its path under `storage/`.
 *
 * The column holds whatever the app wrote over the years: a full URL, a
 * `storage/...` fragment, or a bare filename. `EventService::coverImage`
 * splits on `storage/` for the same reason.
 *
 * A bare filename carries no folder, and the folder depends on the column:
 * the CodeIgniter admin kept event images in `assets/images/events/` and
 * player logos in `assets/images/players/`. Assuming `events/` for both is
 * what left all 151 player logos unresolved on the first run.
 */
function toStoragePath(value, folder = 'events') {
	const raw = String(value || '').trim();
	if (!raw) return null;

	// A base64 data URL is inline content, not a file — nothing to fetch.
	if (raw.startsWith('data:')) return null;

	const afterStorage = raw.split('storage/')[1];
	if (afterStorage) return afterStorage.replace(/^\/+/, '').split('?')[0];

	// A bare filename, from before paths were stored in full.
	if (!raw.includes('/')) return `${folder}/${raw}`;

	return raw.replace(/^\/+/, '').split('?')[0];
}

/**
 * Look a column value up in the map produced by `migrate-media.js`.
 *
 * The map is keyed by both the normalised path and every original spelling, so
 * the raw value usually hits directly; the normalised form is the fallback for
 * a spelling that appeared only after the map was written.
 *
 * Except a bare filename: the same name can exist in both folders, so it is
 * resolved only through the folder the caller names, never the raw key.
 */
function mediaId(map, value, folder = 'events') {
	const raw = String(value || '').trim();
	if (!raw) return null;

	if (raw.includes('/') && map[raw]) return map[raw];

	const storagePath = toStoragePath(raw, folder);
	return (storagePath && map[storagePath]) || null;
}

module.exports = { toStoragePath, mediaId };
