#!/usr/bin/env node
/**
 * Migrate Laravel `events` into `api::page`.
 *
 * Step 4 of docs/data-migration.md, and the largest one. Depends on step 1
 * (event types), step 2 (players) and step 3 (media), all of which are
 * resolved through `legacy_id` or through `media-map.json`.
 *
 * Laravel keeps taking edits until it is switched off, so this is an upsert,
 * not an import: it diffs each row against what is already in Strapi and
 * reports the fields that moved. Run it again after the cutover with
 * `--verify` — a clean run there is the proof that nothing was left behind.
 *
 * Usage:
 *   node scripts/migrate-pages.js events.json                    # dry run + diff
 *   node scripts/migrate-pages.js events.json --dump review.json # payloads to a file
 *   node scripts/migrate-pages.js events.json --apply            # create + update
 *   node scripts/migrate-pages.js events.json --verify           # exit 1 on any drift
 *
 * Export the source with — note the columns the stale repo dump does not have:
 *
 *   SELECT id, name, hash, type, name_position, player_id, event_type_id,
 *          category_id, goalID, language, description, extra_description,
 *          abstract, special_msg, special_msg_colour, special_msg_bg,
 *          background_color, text_color, desc_bg, extra_desc_bg, abstract_bg,
 *          image, image_2, logo, guide_pdf, additional_file, file_description,
 *          visual_embed_type_1, visual_embed_1, visual_embed_type_2,
 *          visual_embed_2, visual_embed_type_3, visual_embed_3,
 *          embed_type, embed_id, embed_type_2, embed_id_2,
 *          event_date, event_end_date, time, end_time, location,
 *          online, meeting_url, meeting_id, meeting_pass,
 *          payment_required, payment_type, payment_url, paid,
 *          type_of_registration, submit_btn_text, get_tickets_text,
 *          ticket_link, facebook_pixel_id, send_email_registration,
 *          display_last_name, avatar_on_register, branded, has_chat,
 *          chat_type, consolidated, separate_event, has_register,
 *          disable_user_creation, upper_strip, field_phone, field_profession,
 *          field_newsletter, pixabay_cover_image, has_lecturer, lecturer_name,
 *          lecturer_desc, about_organizer_text, email_description,
 *          spintowin_enabled, spintowin_token, spintowin_position
 *   FROM events;
 *
 * Three mappings that a column-name-matching translation gets wrong, all
 * established from `EventService::saveOrPublishEvent`:
 *
 *   events.logo           is the LECTURER image, not the organizer logo
 *   events.visual_embed_2 is the middle image when its type is 'image'
 *   events.visual_embed_3 is the bottom image, likewise
 *
 * The organizer logo lives on the player (step 2); `page.logo` is left alone.
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
const limit = flag(args, 'limit') ? Number(flag(args, 'limit')) : null;

const client = createClient({
	url: process.env.STRAPI_API_URL,
	token: process.env.STRAPI_API_TOKEN
});

if (!inputPath) {
	console.error('usage: node scripts/migrate-pages.js <events.json> [--apply|--verify] [--media <map.json>]');
	process.exit(1);
}

// --- value coercion -------------------------------------------------------

function text(value) {
	const trimmed = String(value ?? '').trim();
	return trimmed === '' ? null : trimmed;
}

/** MySQL tinyint(1), which arrives as 0/1, "0"/"1" or a real boolean. */
function bool(value, fallback = false) {
	if (value === null || value === undefined || value === '') return fallback;
	if (typeof value === 'boolean') return value;
	return Number(value) === 1;
}

/**
 * `date` in MySQL, `datetime` in Strapi.
 *
 * Midnight UTC is deliberate: Israel is UTC+3, so a date-only value stays on
 * the same calendar day when it is rendered locally.
 */
function date(value) {
	const raw = text(value);
	if (!raw || raw.startsWith('0000-00-00')) return null;

	const parsed = new Date(raw.includes('T') ? raw : `${raw.slice(0, 10)}T00:00:00.000Z`);
	return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * `time` is varchar(45) in MySQL — free text that usually holds "19:00" but is
 * not guaranteed to. Strapi's time column rejects anything else, so an
 * unparseable value becomes null and is reported rather than failing the row.
 */
function time(value) {
	const raw = text(value);
	if (!raw) return null;

	const match = raw.match(/(\d{1,2}):(\d{2})/);
	if (!match) return null;

	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	if (hours > 23 || minutes > 59) return null;

	return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00.000`;
}

function enumOr(value, allowed, fallback = null) {
	const raw = text(value)?.toLowerCase();
	return raw && allowed.includes(raw) ? raw : fallback;
}

// --- the mappings that are not one-to-one ---------------------------------

const PAGE_TYPES = ['save_spot', 'contact_me', 'guide_download'];
const NAME_POSITIONS = ['top', 'bottom', 'center', 'left', 'right', 'none'];
const EMBED_TYPES = ['one', 'youtube', 'facebook', 'vimeo'];
const PAYMENT_TYPES = ['url', 'paybox', 'paybox_personal', 'bit', 'donation'];
const SPINTOWIN_POSITIONS = ['top1', 'top2', 'bottom'];

/** The tri-state the Vue wizard wrote into a tinyint. */
const PAYMENT_DISPLAY = { 0: 'free', 1: 'paid', 2: 'hidden' };

/**
 * `-1` is the legacy "unset" sentinel for the video embed columns.
 * Anything outside the enum is dropped and reported.
 */
function embedType(value) {
	const raw = text(value);
	if (!raw || raw === '-1' || raw === '1') return null;
	return enumOr(raw, EMBED_TYPES);
}

/**
 * `extra_description` holds either plain HTML or a JSON envelope carrying two
 * descriptions. `Event::getFirstDescriptionAttribute` decides the same way.
 */
function splitExtraDescription(value) {
	const raw = text(value);
	if (!raw) return { extra_description: null, second_extra_description: null };

	if (!raw.startsWith('{') && !raw.startsWith('[')) {
		return { extra_description: raw, second_extra_description: null };
	}

	try {
		const parsed = JSON.parse(raw);
		return {
			extra_description: text(parsed.extra_description),
			second_extra_description: text(parsed.second_extra_description)
		};
	} catch {
		// A description that merely starts with a brace.
		return { extra_description: raw, second_extra_description: null };
	}
}

/**
 * Mirror of `src/lib/event-wizard/page-types.ts` in the SvelteKit app.
 *
 * Duplicated across repos on purpose — the back end cannot import from the
 * front end — so a change there needs the same change here. Applying it keeps
 * a migrated page indistinguishable from one the new wizard produced: a
 * `contact_me` page cannot arrive carrying a payment link the new form has no
 * way to show, edit or clear.
 */
const FEATURES = {
	save_spot: ['schedule', 'venue', 'payment'],
	contact_me: [],
	guide_download: ['payment', 'guideFile']
};

const FEATURE_FIELDS = {
	schedule: ['event_date', 'event_end_date', 'time', 'end_time'],
	venue: ['is_online', 'meeting_url', 'location'],
	payment: ['payment_required', 'payment_type', 'payment_url', 'payment_display'],
	guideFile: ['guide_pdf', 'additional_file', 'file_description']
};

/** Cleared fields need a value the column accepts, not just null. */
const CLEARED_TO = { payment_display: 'free' };

function applyPageTypeRules(payload, cleared) {
	const features = FEATURES[payload.page_type] ?? FEATURES.save_spot;

	for (const [feature, fields] of Object.entries(FEATURE_FIELDS)) {
		if (features.includes(feature)) continue;

		for (const field of fields) {
			const empty = CLEARED_TO[field] ?? (typeof payload[field] === 'boolean' ? false : null);
			if (payload[field] !== empty && payload[field] !== null && payload[field] !== false) {
				cleared.push(`${field} on ${payload.page_type}`);
			}
			payload[field] = empty;
		}
	}

	return payload;
}

// --- payload --------------------------------------------------------------

/** How each field is compared; anything absent is compared as a scalar. */
const KINDS = {
	image: 'media',
	image2: 'media',
	bottom_image: 'media',
	lecturer_image: 'media',
	guide_pdf: 'media',
	additional_file: 'media',
	player: 'relation',
	event_type: 'relation',
	event_date: 'datetime',
	event_end_date: 'datetime',
	visual_embeds: 'component'
};

function buildPage(row, context) {
	const { mediaMap, playerByLegacyId, eventTypeByLegacyId, notes } = context;

	const legacyId = Number(row.id);
	const note = (message) => notes.push(`event ${legacyId}: ${message}`);

	const media = (value, label) => {
		const raw = text(value);
		if (!raw) return null;

		// An inline base64 value has no file behind it, so migrate-media.js
		// never uploaded one. Saying so beats "not in the media map".
		if (raw.startsWith('data:')) {
			note(`${label} was stored inline as base64 and has no file to migrate`);
			return null;
		}

		const id = mediaId(mediaMap, raw);
		if (!id) note(`${label} not in the media map: ${raw.slice(0, 80)}`);
		return id;
	};

	let pageType = enumOr(row.type, PAGE_TYPES, null);
	if (!pageType && text(row.type)) note(`unknown type "${row.type}" — defaulting to save_spot`);

	// Rows created before the 2025-03-23 `type` migration have none. Defaulting
	// them all to save_spot would clear the guide file off a page that plainly
	// is a guide download, so the one column that gives the type away is used.
	if (!pageType && text(row.guide_pdf)) {
		pageType = 'guide_download';
		note('no type, but guide_pdf is set — treated as guide_download');
	}

	const descriptions = splitExtraDescription(row.extra_description);

	// Laravel writes the cover into both columns; a row where they differ
	// predates that and is worth a look before it is silently reduced to one.
	if (text(row.image_2) && text(row.image_2) !== text(row.image)) {
		note('image_2 differs from image — only image is migrated');
	}

	// `visual_embed_2/3` are images when the wizard wrote them, and their
	// presence is what "show middle/bottom image" meant.
	const middleImage = row.visual_embed_type_2 === 'image' ? media(row.visual_embed_2, 'middle image') : null;
	const bottomImage = row.visual_embed_type_3 === 'image' ? media(row.visual_embed_3, 'bottom image') : null;

	if (text(row.visual_embed_1)) {
		note(`visual_embed_1 (${row.visual_embed_type_1}) has no target in the new schema: ${String(row.visual_embed_1).slice(0, 60)}`);
	}

	for (const [column, label] of [
		['about_organizer_text', 'about_organizer_text'],
		['email_description', 'email_description'],
		['meeting_id', 'meeting_id'],
		['meeting_pass', 'meeting_pass'],
		['category_id', 'category_id']
	]) {
		if (text(row[column])) note(`${label} is set but is not migrated`);
	}

	const display = PAYMENT_DISPLAY[Number(row.payment_required)] ?? 'free';
	if (row.payment_required !== null && !(Number(row.payment_required) in PAYMENT_DISPLAY)) {
		note(`unexpected payment_required "${row.payment_required}" — treated as free`);
	}

	const startTime = time(row.time);
	if (text(row.time) && !startTime) note(`unparseable time "${row.time}"`);
	const endTime = time(row.end_time);
	if (text(row.end_time) && !endTime) note(`unparseable end_time "${row.end_time}"`);

	const hash = text(row.hash);
	if (!hash) throw new Error('no hash — every public URL in the wild is /{hash}');

	const payload = {
		legacy_id: legacyId,
		name: text(row.name) ?? `דף ${legacyId}`,
		hash,
		page_type: pageType ?? 'save_spot',

		// Laravel put the display-position fallback in the form loader, not the
		// column, so an empty value has to resolve the same way here.
		name_position: enumOr(row.name_position, NAME_POSITIONS, bool(row.pixabay_cover_image) ? 'center' : 'bottom'),
		language: enumOr(row.language, ['ltr', 'rtl'], 'rtl'),

		description: text(row.description),
		abstract: text(row.abstract),
		extra_description: descriptions.extra_description,
		second_extra_description: descriptions.second_extra_description,
		special_msg: text(row.special_msg),

		// colours
		special_msg_colour: text(row.special_msg_colour) ?? '#000000',
		special_msg_bg: text(row.special_msg_bg),
		background_color: text(row.background_color) ?? '#e3a68b',
		text_color: text(row.text_color) ?? '#ffffff',
		desc_bg: text(row.desc_bg) ?? '#fef8f6',
		extra_desc_bg: text(row.extra_desc_bg),
		abstract_bg: text(row.abstract_bg),

		// media — see the header for why `logo` becomes the lecturer image
		image: media(row.image, 'cover image'),
		image2: middleImage,
		show_middle_image: middleImage !== null,
		bottom_image: bottomImage,
		show_bottom_image: bottomImage !== null,
		lecturer_image: media(row.logo, 'lecturer image'),
		guide_pdf: media(row.guide_pdf, 'guide pdf'),
		additional_file: media(row.additional_file, 'additional file'),
		file_description: text(row.file_description),
		pixabay_cover_image: bool(row.pixabay_cover_image),

		// schedule and venue
		event_date: date(row.event_date),
		event_end_date: date(row.event_end_date),
		time: startTime,
		end_time: endTime,
		location: text(row.location),
		is_online: bool(row.online),
		meeting_url: text(row.meeting_url),

		// payment — `payment_required` is the boolean mirror of the tri-state
		payment_display: display,
		payment_required: display === 'paid',
		payment_type: display === 'paid' ? enumOr(row.payment_type, PAYMENT_TYPES) : null,
		payment_url: display === 'paid' ? text(row.payment_url) : null,

		// registration form
		type_of_registration: text(row.type_of_registration),
		submit_btn_text: text(row.submit_btn_text),
		get_tickets_text: text(row.get_tickets_text),
		ticket_link: text(row.ticket_link),
		field_phone: bool(row.field_phone, true),
		field_profession: bool(row.field_profession),
		field_newsletter: bool(row.field_newsletter),
		display_last_name: bool(row.display_last_name, true),
		avatar_on_register: bool(row.avatar_on_register, true),
		send_email_registration: bool(row.send_email_registration, true),
		disable_user_creation: bool(row.disable_user_creation),
		has_register: bool(row.has_register),

		// lecturer / business block
		has_lecturer: bool(row.has_lecturer, true),
		lecturer_name: text(row.lecturer_name),
		lecturer_desc: text(row.lecturer_desc),

		// video embeds
		embed_type: embedType(row.embed_type),
		embed_id: embedType(row.embed_type) ? text(row.embed_id) : null,
		embed_type2: embedType(row.embed_type_2),
		embed_id2: embedType(row.embed_type_2) ? text(row.embed_id_2) : null,

		// flags
		branded: bool(row.branded, true),
		// two columns, one target: `has_chat` is what the app read.
		has_chat: bool(row.has_chat, true),
		consolidated: bool(row.consolidated, true),
		separate_event: bool(row.separate_event),
		upper_strip: bool(row.upper_strip, true),
		facebook_pixel_id: text(row.facebook_pixel_id),
		goalID: text(row.goalID),

		spintowin_enabled: bool(row.spintowin_enabled),
		spintowin_token: text(row.spintowin_token),
		spintowin_position: enumOr(row.spintowin_position, SPINTOWIN_POSITIONS),

		player: playerByLegacyId.get(Number(row.player_id)) ?? null,
		event_type: eventTypeByLegacyId.get(Number(row.event_type_id)) ?? null
	};

	if (row.player_id && !payload.player) note(`player ${row.player_id} not found — run migrate-players.js first`);
	if (row.event_type_id && !payload.event_type) note(`event type ${row.event_type_id} not found`);

	const cleared = [];
	applyPageTypeRules(payload, cleared);
	for (const item of cleared) note(`cleared ${item}`);

	return payload;
}

// --- run ------------------------------------------------------------------

async function main() {
	const rows = readJson(inputPath);
	if (!Array.isArray(rows)) throw new Error('input must be a JSON array of `events` rows');

	if (apply && !process.env.STRAPI_API_TOKEN) throw new Error('STRAPI_API_TOKEN is required to write');

	// A dry run without a token still checks the mapping, which is how the
	// payloads get reviewed before there is anywhere to write them.
	const offline = !process.env.STRAPI_API_TOKEN;
	if (offline) {
		console.warn('no STRAPI_API_TOKEN — reviewing the mapping only; relations and');
		console.warn('already-migrated rows cannot be resolved without one.\n');
	}

	const mediaMap = readJson(mediaMapPath, {});
	if (!Object.keys(mediaMap).length) {
		console.warn(`no media map at ${mediaMapPath} — every image will be reported missing (run migrate-media.js first)\n`);
	}

	const players = offline ? [] : await client.fetchAll('/api/players?fields[0]=documentId&fields[1]=legacy_id');
	const eventTypes = offline ? [] : await client.fetchAll('/api/event-types?fields[0]=documentId&fields[1]=legacy_id');

	const playerByLegacyId = new Map([...indexByLegacyId(players)].map(([id, p]) => [id, p.documentId]));
	const eventTypeByLegacyId = new Map([...indexByLegacyId(eventTypes)].map(([id, t]) => [id, t.documentId]));

	// Everything the diff touches has to be populated, or an unchanged row
	// reads as changed on every run.
	const populate = [
		'image',
		'image2',
		'bottom_image',
		'lecturer_image',
		'guide_pdf',
		'additional_file',
		'player',
		'event_type'
	]
		.map((field, i) => `populate[${i}]=${field}`)
		.join('&');

	const existing = offline
		? []
		: await client.fetchAll(`/api/pages?status=published&${populate}`);
	const existingByLegacyId = indexByLegacyId(existing);

	console.log(`source rows    : ${rows.length}`);
	console.log(`already in Strapi: ${existingByLegacyId.size}`);
	console.log(`players / types: ${playerByLegacyId.size} / ${eventTypeByLegacyId.size}`);
	console.log(`media entries  : ${Object.keys(mediaMap).length}`);
	console.log(`target         : ${client.base}`);
	console.log('');

	const notes = [];
	const dumped = [];
	const context = { mediaMap, playerByLegacyId, eventTypeByLegacyId, notes };

	const stats = await syncCollection({
		client,
		collection: 'pages',
		rows,
		build: (row) => buildPage(row, context),
		kinds: KINDS,
		existingByLegacyId,
		apply,
		limit,
		onRow: dumpPath ? (_row, payload) => dumped.push(payload) : null
	});

	if (dumpPath && dumped.length) {
		fs.writeFileSync(dumpPath, JSON.stringify(dumped, null, 2));
		console.log(`wrote ${dumped.length} payloads to ${dumpPath} for review`);
	}

	const clean = report(stats, { apply, verify });

	// Everything the mapping could not carry across, in one place: this is the
	// list to read before the cutover, not after.
	console.log(`\n  notes: ${notes.length}`);
	for (const item of notes.slice(0, 40)) console.log(`    - ${item}`);
	if (notes.length > 40) console.log(`    … and ${notes.length - 40} more`);

	// Duplicate hashes would collide on the uid column and silently lose a page.
	const hashes = new Map();
	for (const row of rows) {
		const hash = text(row.hash);
		if (!hash) continue;
		hashes.set(hash, (hashes.get(hash) ?? 0) + 1);
	}
	const duplicates = [...hashes].filter(([, count]) => count > 1);
	if (duplicates.length) {
		console.log(`\n  DUPLICATE HASHES: ${duplicates.length} — these collide on the uid column`);
		for (const [hash, count] of duplicates.slice(0, 10)) console.log(`    - ${hash} ×${count}`);
	}

	if (verify && !clean) process.exit(1);
}

main().catch((err) => {
	console.error('page migration failed:', err.message);
	process.exit(1);
});
