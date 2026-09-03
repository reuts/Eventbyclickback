#!/usr/bin/env node
/**
 * Migrate the per-event registration questions into `page.custom_fields`.
 *
 * Step 5 of docs/data-migration.md. Depends on step 4 — it updates pages that
 * already exist — and step 6 depends on this one, because signup answers are
 * written keyed by the `key` this derives.
 *
 * Usage:
 *   node scripts/migrate-questions.js --inspect     # distinct types, before anything else
 *   node scripts/migrate-questions.js               # diff only
 *   node scripts/migrate-questions.js --apply
 *   node scripts/migrate-questions.js --verify
 *
 * Reads three exports, by default from the working directory:
 *
 *   SELECT * FROM properties;                                  -> properties.json
 *   SELECT id, propertyID, propertyValue FROM propertiesvalues; -> propertiesvalues.json
 *   SELECT DISTINCT event_id, propertyID FROM userpropertiesvalues;
 *                                                              -> event-properties.json
 *
 * ── Two things about this table that decide the whole step ──
 *
 * `properties` is GLOBAL: it has an `eventTypeID` but no `event_id`, and every
 * event the modern wizard created shares one event type (`GoSociali` resolves
 * it from `env('EVENT_TYPE_NAME')`). So `eventTypeID` cannot say which
 * questions an event asked — only `userpropertiesvalues.event_id` can, and it
 * only knows about questions somebody actually answered.
 *
 * The consequence sounds worse than it is: **an event with no signups keeps its
 * standard fields anyway**, because phone / profession / newsletter are the
 * `field_*` booleans on the page and step 4 already carried them. Only a
 * genuinely custom question on a zero-signup event is unrecoverable, and the
 * wizard never offered a way to create one.
 *
 * Which brings up the second thing: three property ids are hardcoded in
 * `EventController` as the standard fields, and they are NOT custom fields.
 * They are skipped here and mapped onto real columns in step 6.
 */

const fs = require('fs');
const { flag, createClient, changedFields, report, readJson } = require('./lib/legacy-sync');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const verify = args.includes('--verify');
const inspect = args.includes('--inspect');

const propertiesPath = flag(args, 'properties', 'properties.json');
const valuesPath = flag(args, 'values', 'propertiesvalues.json');
const usagePath = flag(args, 'usage', 'event-properties.json');
const outPath = flag(args, 'out', 'question-map.json');

const client = createClient({
	url: process.env.STRAPI_API_URL,
	token: process.env.STRAPI_API_TOKEN
});

/**
 * The standard fields, hardcoded by id in both EventControllers:
 *
 *   ->where('phone_values.propertyID', '=', 39);       // Phone field ID
 *   ->where('profession_values.propertyID', '=', 24);  // Profession field ID
 *   ->where('newsletter_values.propertyID', '=', 41);  // Newsletter field ID
 *
 * On the page these are `field_phone` / `field_profession` / `field_newsletter`;
 * on a register they are real columns. Never custom fields.
 */
const BUILT_IN_PROPERTIES = { 39: 'phone', 24: 'profession', 41: 'newsletter' };

/**
 * `display_property` is a varchar and `commandType` an int, and the two overlap.
 * The int codes are named in `App\EventType`: TYPE_DROPDOWN = 1, TYPE_TEL = 9,
 * TYPE_TEXTAREA = 11 — the same numbers the wizard put in `event_fields`.
 *
 * Anything not listed here is reported with its raw value rather than guessed
 * at; run `--inspect` against the live export before the first apply and add
 * what turns up.
 */
const DISPLAY_TO_TYPE = {
	text: 'text',
	textbox: 'text',
	string: 'text',
	textarea: 'textarea',
	longtext: 'textarea',
	email: 'email',
	mail: 'email',
	tel: 'tel',
	phone: 'tel',
	number: 'number',
	numeric: 'number',
	date: 'date',
	dropdown: 'select',
	select: 'select',
	list: 'select',
	radio: 'select',
	checkbox: 'checkbox',
	boolean: 'checkbox'
};

const COMMAND_TYPE_TO_TYPE = { 1: 'select', 9: 'tel', 11: 'textarea' };

function text(value) {
	const trimmed = String(value ?? '').trim();
	return trimmed === '' ? null : trimmed;
}

/** MySQL's enum('0','1') arrives as the string "1". */
function enumBool(value) {
	return String(value ?? '') === '1';
}

/**
 * The key signup answers are stored under, in step 6 and forever after.
 *
 * Derived from the numeric id rather than the label: labels are Hebrew free
 * text, they collide, and an organizer renaming a question must not orphan
 * every answer already recorded under it.
 */
function questionKey(propertyId) {
	return `prop_${propertyId}`;
}

function questionType(property, hasOptions, notes) {
	if (hasOptions) return 'select';

	const display = text(property.display_property)?.toLowerCase();
	if (display && DISPLAY_TO_TYPE[display]) return DISPLAY_TO_TYPE[display];

	const command = COMMAND_TYPE_TO_TYPE[Number(property.commandType)];
	if (command) return command;

	if (display || property.commandType !== null) {
		notes.push(
			`property ${property.id}: unrecognised display_property "${property.display_property}" / commandType "${property.commandType}" — using text`
		);
	}

	return 'text';
}

function buildQuestions(properties, valuesByProperty, notes) {
	const questions = new Map();

	for (const property of properties) {
		const id = Number(property.id);
		if (BUILT_IN_PROPERTIES[id]) continue;

		const options = (valuesByProperty.get(id) ?? []).map((v) => text(v.propertyValue)).filter(Boolean);

		// `name` and `name2` are a label pair with no documented meaning.
		// `name` is what the signup listing GROUP_CONCATs, so it wins.
		const label = text(property.name) ?? text(property.name2);
		if (!label) {
			notes.push(`property ${id}: no label in either name or name2 — using the key`);
		}
		if (text(property.name2) && text(property.name2) !== text(property.name)) {
			notes.push(`property ${id}: name "${property.name}" and name2 "${property.name2}" differ — name used`);
		}

		questions.set(id, {
			label: label ?? questionKey(id),
			key: questionKey(id),
			type: questionType(property, options.length > 0, notes),
			required: enumBool(property.text_required),
			options: options.length ? options : null,
			// Not part of the component; used only to order the list.
			_order: Number(property.order_properties ?? id)
		});
	}

	return questions;
}

function toComponent(question) {
	const { _order, ...rest } = question;
	return rest;
}

async function main() {
	if (apply && !process.env.STRAPI_API_TOKEN) throw new Error('STRAPI_API_TOKEN is required to write');

	const properties = readJson(propertiesPath);
	const values = readJson(valuesPath, []);
	const usage = readJson(usagePath, []);

	const valuesByProperty = new Map();
	for (const value of values) {
		const id = Number(value.propertyID);
		if (!valuesByProperty.has(id)) valuesByProperty.set(id, []);
		valuesByProperty.get(id).push(value);
	}

	const notes = [];
	const questions = buildQuestions(properties, valuesByProperty, notes);

	if (inspect) {
		const shapes = new Map();
		for (const property of properties) {
			const key = `display_property="${property.display_property}" commandType=${property.commandType}`;
			if (!shapes.has(key)) shapes.set(key, { count: 0, examples: [], mapped: null });
			const shape = shapes.get(key);
			shape.count++;
			if (shape.examples.length < 3) {
				shape.examples.push(`${property.id}:${text(property.name) ?? '(no label)'}`);
			}
			// A shape can hold both standard fields and custom ones — property
			// 41 and 50 are both dropdowns. Report what the custom ones become,
			// since those are the rows this step actually writes.
			shape.mapped ??= questions.get(Number(property.id))?.type ?? null;
		}

		console.log(`properties: ${properties.length}  (${Object.keys(BUILT_IN_PROPERTIES).length} are standard fields)\n`);
		for (const [shape, { count, examples, mapped }] of [...shapes].sort((a, b) => b[1].count - a[1].count)) {
			console.log(`  ${String(count).padStart(3)} × ${shape}`);
			console.log(`        → ${mapped ?? '(standard fields only)'}   e.g. ${examples.join(', ')}`);
		}

		console.log(`\nnotes: ${notes.length}`);
		for (const note of notes) console.log(`  - ${note}`);
		return;
	}

	// Which questions each event actually asked. Nothing else links them.
	const questionsByEvent = new Map();
	const unknownProperties = new Set();

	for (const row of usage) {
		const eventId = Number(row.event_id);
		const propertyId = Number(row.propertyID);

		if (BUILT_IN_PROPERTIES[propertyId]) continue;

		const question = questions.get(propertyId);
		if (!question) {
			unknownProperties.add(propertyId);
			continue;
		}

		if (!questionsByEvent.has(eventId)) questionsByEvent.set(eventId, new Map());
		questionsByEvent.get(eventId).set(propertyId, question);
	}

	for (const propertyId of unknownProperties) {
		notes.push(`answers reference property ${propertyId}, which is not in properties.json — skipped`);
	}

	// The map step 6 reads. Written even on a dry run: it is derived from the
	// exports alone, and having it early is what lets step 6 be reviewed.
	const map = Object.fromEntries(
		[...questions].map(([id, question]) => [id, toComponent(question)])
	);
	for (const [id, field] of Object.entries(BUILT_IN_PROPERTIES)) {
		map[id] = { builtin: field };
	}
	fs.writeFileSync(outPath, JSON.stringify(map, null, 2));

	const pages = await client.fetchAll('/api/pages?status=published&fields[0]=name&fields[1]=legacy_id&populate[0]=custom_fields');
	const pageByLegacyId = new Map(
		pages.filter((p) => p.legacy_id != null).map((p) => [Number(p.legacy_id), p])
	);

	console.log(`properties        : ${properties.length} (${questions.size} custom, ${Object.keys(BUILT_IN_PROPERTIES).length} standard)`);
	console.log(`events with usage : ${questionsByEvent.size}`);
	console.log(`pages in Strapi   : ${pageByLegacyId.size}`);
	console.log(`wrote             : ${outPath}`);
	console.log(`target            : ${client.base}`);

	const stats = { created: 0, updated: 0, unchanged: 0, failed: [], changes: [], orphans: [] };

	for (const [eventId, eventQuestions] of questionsByEvent) {
		const page = pageByLegacyId.get(eventId);
		if (!page) {
			notes.push(`event ${eventId} has questions but no page — run migrate-pages.js first`);
			continue;
		}

		const custom_fields = [...eventQuestions.values()]
			.sort((a, b) => a._order - b._order)
			.map(toComponent);

		if (!changedFields({ custom_fields }, page, { custom_fields: 'component' }).length) {
			stats.unchanged++;
			continue;
		}

		stats.updated++;
		stats.changes.push(`legacy ${eventId}: ${custom_fields.length} question(s) → ${page.name}`);

		if (!apply) continue;

		try {
			await client.request(`/api/pages/${page.documentId}?status=published`, {
				method: 'PUT',
				body: JSON.stringify({ data: { custom_fields } })
			});
		} catch (err) {
			stats.updated--;
			stats.failed.push(`legacy ${eventId}: ${err.message}`);
		}
	}

	const clean = report(stats, { apply, verify });

	console.log(`\n  notes: ${notes.length}`);
	for (const note of notes.slice(0, 30)) console.log(`    - ${note}`);
	if (notes.length > 30) console.log(`    … and ${notes.length - 30} more`);

	if (verify && !clean) process.exit(1);
}

main().catch((err) => {
	console.error('question migration failed:', err.message);
	process.exit(1);
});
