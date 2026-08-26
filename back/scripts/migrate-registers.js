#!/usr/bin/env node
/**
 * Migrate Laravel signups into `api::register`.
 *
 * Step 6 of docs/data-migration.md, and the last. Depends on step 2 (the
 * `player_source` relation), step 4 (the page each signup belongs to) and step
 * 5 (`question-map.json`, which decides the keys answers are stored under).
 *
 * Usage:
 *   node scripts/migrate-registers.js                 # diff only
 *   node scripts/migrate-registers.js --apply
 *   node scripts/migrate-registers.js --verify
 *   node scripts/migrate-registers.js --dump out.json
 *
 * Reads four exports, by default from the working directory:
 *
 *   SELECT id, user_id, event_id, date FROM users_events;      -> users_events.json
 *   SELECT id, first_name, last_name, email, player_source_id,
 *          gender, birthday, role, profile FROM users;         -> users.json
 *   SELECT users_events_id, first_name, last_name
 *     FROM users_events_info;                                  -> users_events_info.json
 *   SELECT users_events_id, propertyID, propertyValueID
 *     FROM userpropertiesvalues;                               -> answers.json
 *   SELECT id, propertyValue FROM propertiesvalues;            -> propertiesvalues.json
 *
 * ── The three things this step turns on ──
 *
 * **A register is one signup, not one person.** `legacy_id` holds the
 * `users_events.id`, not the `users.id`: the same person signing up to three
 * events is three rows in Laravel and three registers here, which is what the
 * new model means. Keying on the user id instead would silently collapse them.
 *
 * **`users.password` is deliberately not migrated.** Strapi hashes anything it
 * receives for a password column, so copying the Laravel hash through the REST
 * API would store a hash of a hash — unusable, and worse than empty because it
 * looks like a working credential. Registrants are signup records, not
 * accounts; nothing in the new app logs in as one.
 *
 * **`propertyValueID` is a text column doing two jobs.** It holds either the id
 * of a row in `propertiesvalues` or the answer itself. `EventController`
 * resolves it with `IFNULL(propertiesvalues.propertyValue, propertyValueID)`
 * and so does this.
 */

const fs = require('fs');
const { flag, createClient, changedFields, report, readJson } = require('./lib/legacy-sync');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const verify = args.includes('--verify');
const dumpPath = flag(args, 'dump');

const signupsPath = flag(args, 'signups', 'users_events.json');
const usersPath = flag(args, 'users', 'users.json');
const infoPath = flag(args, 'info', 'users_events_info.json');
const answersPath = flag(args, 'answers', 'answers.json');
const valuesPath = flag(args, 'values', 'propertiesvalues.json');
const questionMapPath = flag(args, 'questions', 'question-map.json');

const client = createClient({
	url: process.env.STRAPI_API_URL,
	token: process.env.STRAPI_API_TOKEN
});

/** Same three ids as step 5; here they land on real columns. */
const BUILT_IN_PROPERTIES = { 39: 'phone', 24: 'profession', 41: 'newsletter' };

const KINDS = { pages: 'relation', player_source: 'relation', extra_fields: 'json', signed_up_at: 'datetime' };

function text(value) {
	const trimmed = String(value ?? '').trim();
	return trimmed === '' ? null : trimmed;
}

function date(value) {
	const raw = text(value);
	if (!raw || raw.startsWith('0000-00-00')) return null;
	const parsed = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z');
	return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** `birthday` is a date column in both systems; keep it date-only. */
function dateOnly(value) {
	const iso = date(value);
	return iso ? iso.slice(0, 10) : null;
}

/**
 * The newsletter answer is free text in a column that means yes/no. Anything
 * that is plainly a "no" is false; an empty answer is false; everything else
 * counts as opting in, because the question was only asked when it was ticked.
 */
const NEGATIVE = new Set(['0', 'no', 'false', 'off', 'לא']);

function toNewsletter(value) {
	const raw = text(value);
	if (!raw) return false;
	return !NEGATIVE.has(raw.toLowerCase());
}

function buildRegister(signup, context) {
	const { usersById, infoBySignupId, answersBySignupId, valueById, questions, pageByLegacyId, playerByLegacyId, notes } =
		context;

	const signupId = Number(signup.id);
	const note = (message) => notes.push(`signup ${signupId}: ${message}`);

	const user = usersById.get(Number(signup.user_id));
	if (!user) note(`user ${signup.user_id} not found in users.json`);

	const info = infoBySignupId.get(signupId);

	// The app reads names off `users`; `users_events_info` is the older
	// per-signup copy. Prefer the app's source and fall back, but say so when
	// the two disagree — that is a person whose name changed between signups.
	let first_name = text(user?.first_name);
	let last_name = text(user?.last_name);

	if (info) {
		if (!first_name && !last_name) {
			first_name = text(info.first_name);
			last_name = text(info.last_name);
		} else if (
			(text(info.first_name) && text(info.first_name) !== first_name) ||
			(text(info.last_name) && text(info.last_name) !== last_name)
		) {
			note(
				`users_events_info says "${text(info.first_name)} ${text(info.last_name)}", users says "${first_name} ${last_name}" — users used`
			);
		}
	}

	const answers = answersBySignupId.get(signupId) ?? [];
	const extra_fields = {};
	const standard = { phone: null, profession: null, newsletter: false };

	for (const answer of answers) {
		const propertyId = Number(answer.propertyID);

		// Either an option id or the answer itself — see the header.
		const raw = text(answer.propertyValueID);
		const resolved = raw && valueById.has(raw) ? valueById.get(raw) : raw;

		const builtIn = BUILT_IN_PROPERTIES[propertyId];
		if (builtIn) {
			standard[builtIn] = builtIn === 'newsletter' ? toNewsletter(resolved) : resolved;
			continue;
		}

		const question = questions[propertyId];
		if (!question || question.builtin) {
			note(`answer to property ${propertyId} has no question in the map — dropped: ${String(resolved).slice(0, 40)}`);
			continue;
		}

		extra_fields[question.key] = resolved;
	}

	if (user?.password) note('password not migrated (Strapi would hash the hash)');

	const page = pageByLegacyId.get(Number(signup.event_id));
	if (!page) note(`event ${signup.event_id} has no page — run migrate-pages.js first`);

	const playerSource = user?.player_source_id ? playerByLegacyId.get(Number(user.player_source_id)) : null;
	if (user?.player_source_id && !playerSource) note(`player_source ${user.player_source_id} not found`);

	const fullName = [first_name, last_name].filter(Boolean).join(' ');

	return {
		legacy_id: signupId,
		name: fullName || null,
		first_name,
		last_name,
		email: text(user?.email),
		phone: standard.phone,
		profession: standard.profession,
		newsletter: standard.newsletter,
		extra_fields: Object.keys(extra_fields).length ? extra_fields : null,
		gender: text(user?.gender),
		birthday: dateOnly(user?.birthday),
		role: text(user?.role) === 'admin' ? 'admin' : 'user',
		profile: text(user?.profile),
		signed_up_at: date(signup.date),
		player_source: playerSource ?? null,
		pages: page ? [page] : []
	};
}

async function main() {
	if (apply && !process.env.STRAPI_API_TOKEN) throw new Error('STRAPI_API_TOKEN is required to write');

	const signups = readJson(signupsPath);
	if (!Array.isArray(signups)) throw new Error('users_events.json must be a JSON array');

	const usersById = new Map(readJson(usersPath, []).map((u) => [Number(u.id), u]));
	const infoBySignupId = new Map(
		readJson(infoPath, []).map((i) => [Number(i.users_events_id), i])
	);
	const valueById = new Map(
		readJson(valuesPath, []).map((v) => [String(v.id), text(v.propertyValue)])
	);
	const questions = readJson(questionMapPath, {});

	if (!Object.keys(questions).length) {
		console.warn(`no question map at ${questionMapPath} — custom answers will be dropped (run migrate-questions.js first)\n`);
	}

	const answersBySignupId = new Map();
	for (const answer of readJson(answersPath, [])) {
		const signupId = Number(answer.users_events_id);
		if (!signupId) continue;
		if (!answersBySignupId.has(signupId)) answersBySignupId.set(signupId, []);
		answersBySignupId.get(signupId).push(answer);
	}

	const pages = await client.fetchAll('/api/pages?status=published&fields[0]=legacy_id');
	const players = await client.fetchAll('/api/players?status=published&fields[0]=legacy_id');

	const pageByLegacyId = new Map(
		pages.filter((p) => p.legacy_id != null).map((p) => [Number(p.legacy_id), p.documentId])
	);
	const playerByLegacyId = new Map(
		players.filter((p) => p.legacy_id != null).map((p) => [Number(p.legacy_id), p.documentId])
	);

	const existing = await client.fetchAll('/api/registers?status=published&populate[0]=pages&populate[1]=player_source');
	const existingByLegacyId = new Map(
		existing.filter((r) => r.legacy_id != null).map((r) => [Number(r.legacy_id), r])
	);

	console.log(`signups          : ${signups.length}`);
	console.log(`registrants      : ${usersById.size}`);
	console.log(`answers          : ${answersBySignupId.size} signups have some`);
	console.log(`already in Strapi: ${existingByLegacyId.size}`);
	console.log(`pages / players  : ${pageByLegacyId.size} / ${playerByLegacyId.size}`);
	console.log(`target           : ${client.base}`);
	console.log('');

	const notes = [];
	const dumped = [];
	const context = {
		usersById,
		infoBySignupId,
		answersBySignupId,
		valueById,
		questions,
		pageByLegacyId,
		playerByLegacyId,
		notes
	};

	const stats = { created: 0, updated: 0, unchanged: 0, failed: [], changes: [], orphans: [] };
	const seen = new Set();

	for (const signup of signups) {
		const legacyId = Number(signup.id);
		seen.add(legacyId);

		const payload = buildRegister(signup, context);
		if (dumpPath) dumped.push(payload);

		const entry = existingByLegacyId.get(legacyId);

		if (!entry) {
			stats.created++;
			if (!apply) continue;
			try {
				await client.request('/api/registers?status=published', {
					method: 'POST',
					body: JSON.stringify({ data: payload })
				});
			} catch (err) {
				stats.created--;
				stats.failed.push(`signup ${legacyId}: create: ${err.message}`);
			}
			continue;
		}

		const changed = changedFields(payload, entry, KINDS);
		if (!changed.length) {
			stats.unchanged++;
			continue;
		}

		stats.updated++;
		stats.changes.push(`legacy ${legacyId}: ${changed.join(', ')}`);

		if (!apply) continue;

		try {
			const patch = Object.fromEntries(changed.map((key) => [key, payload[key]]));
			await client.request(`/api/registers/${entry.documentId}?status=published`, {
				method: 'PUT',
				body: JSON.stringify({ data: patch })
			});
		} catch (err) {
			stats.updated--;
			stats.failed.push(`signup ${legacyId}: update: ${err.message}`);
		}
	}

	for (const [legacyId, entry] of existingByLegacyId) {
		if (!seen.has(legacyId)) stats.orphans.push(`legacy ${legacyId} (${entry.documentId})`);
	}

	if (dumpPath && dumped.length) {
		fs.writeFileSync(dumpPath, JSON.stringify(dumped, null, 2));
		console.log(`wrote ${dumped.length} payloads to ${dumpPath} for review`);
	}

	const clean = report(stats, { apply, verify });

	console.log(`\n  notes: ${notes.length}`);
	for (const note of notes.slice(0, 30)) console.log(`    - ${note}`);
	if (notes.length > 30) console.log(`    … and ${notes.length - 30} more`);

	if (verify && !clean) process.exit(1);
}

main().catch((err) => {
	console.error('register migration failed:', err.message);
	process.exit(1);
});
