#!/usr/bin/env node
/**
 * Migrate Laravel `app_users` into Strapi's users-permissions `up_users`.
 *
 * Writes straight to Postgres rather than going through the REST API on
 * purpose: Strapi hashes any `password` it receives, which would re-hash the
 * already-hashed Laravel value and lock every account out. Inserting directly
 * preserves the bcrypt hash, so nobody has to reset a password.
 *
 * Laravel stores PHP's `$2y$` variant. bcryptjs — what users-permissions uses
 * to check passwords — accepts `$2y$` as-is, so the hashes are copied verbatim.
 *
 * Accounts with a NULL password are social-only logins (Google/Facebook). They
 * are migrated without a password: they cannot sign in until the Google
 * provider is configured, which is expected.
 *
 * Usage (inside the strapi container, which has `pg` and the DATABASE_* env):
 *   node scripts/migrate-users.js users.json           # dry run, changes nothing
 *   node scripts/migrate-users.js users.json --apply   # writes
 *
 * Re-running is safe: rows are matched on `legacy_id` and skipped if present.
 */

const fs = require('fs');
const crypto = require('crypto');
const { Client } = require('pg');

const AUTHENTICATED_ROLE_TYPE = 'authenticated';

const [, , inputPath, ...flags] = process.argv;
const apply = flags.includes('--apply');

if (!inputPath) {
	console.error('usage: node scripts/migrate-users.js <app_users.json> [--apply]');
	process.exit(1);
}

/** Strapi 5 identifies entries by a random document id alongside the numeric id. */
function documentId() {
	return crypto.randomBytes(12).toString('hex');
}

/** MySQL hands back dates as strings; keep them, fall back to now. */
function timestamp(value) {
	if (!value) return new Date();
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

/** `create_event_form` is JSON in MySQL and jsonb in Postgres. */
function jsonOrNull(value) {
	if (value === null || value === undefined || value === '') return null;
	if (typeof value === 'object') return JSON.stringify(value);
	try {
		JSON.parse(value);
		return value;
	} catch {
		return null;
	}
}

async function main() {
	const rows = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

	if (!Array.isArray(rows)) {
		throw new Error('input must be a JSON array of app_users rows');
	}

	console.log(`source rows: ${rows.length}`);

	const client = new Client({
		host: process.env.DATABASE_HOST || 'postgres-db',
		port: Number(process.env.DATABASE_PORT || 5432),
		database: process.env.DATABASE_NAME || 'strapidb',
		user: process.env.DATABASE_USERNAME || 'strapi',
		password: process.env.DATABASE_PASSWORD
	});

	await client.connect();

	try {
		const role = await client.query('SELECT id FROM up_roles WHERE type = $1 LIMIT 1', [
			AUTHENTICATED_ROLE_TYPE
		]);

		if (role.rowCount === 0) {
			throw new Error(`no "${AUTHENTICATED_ROLE_TYPE}" role found in up_roles`);
		}

		const roleId = role.rows[0].id;
		console.log(`target role: ${AUTHENTICATED_ROLE_TYPE} (id ${roleId})`);

		const existing = await client.query(
			'SELECT legacy_id, email FROM up_users WHERE legacy_id IS NOT NULL'
		);
		const migrated = new Set(existing.rows.map((row) => row.legacy_id));

		const takenEmails = new Set(
			(await client.query('SELECT LOWER(email) AS email FROM up_users')).rows.map((r) => r.email)
		);

		const stats = { inserted: 0, skipped: 0, withPassword: 0, socialOnly: 0, conflicts: [] };

		await client.query('BEGIN');

		for (const row of rows) {
			if (migrated.has(row.id)) {
				stats.skipped++;
				continue;
			}

			const email = (row.email || '').trim();

			if (!email) {
				stats.conflicts.push(`id ${row.id}: no email`);
				continue;
			}

			// An email already present without a legacy_id would mean two accounts
			// competing for the same login, so leave it for a human to resolve.
			if (takenEmails.has(email.toLowerCase())) {
				stats.conflicts.push(`id ${row.id}: email already in up_users (${email})`);
				continue;
			}

			const created = timestamp(row.created_at);
			const updated = timestamp(row.updated_at);

			const inserted = await client.query(
				`INSERT INTO up_users
					(document_id, username, email, provider, password, confirmed, blocked,
					 created_at, updated_at, published_at,
					 first_name, last_name, date_of_birth, gender, create_event_form, legacy_id)
				 VALUES ($1,$2,$3,'local',$4,true,false,$5,$6,$7,$8,$9,$10,$11,$12,$13)
				 RETURNING id`,
				[
					documentId(),
					email, // Laravel had no usernames; the email is unique and satisfies Strapi
					email,
					row.password || null,
					created,
					updated,
					created,
					row.first_name || null,
					row.last_name || null,
					row.date_of_birth || null,
					row.gender === null || row.gender === undefined ? null : Number(row.gender),
					jsonOrNull(row.create_event_form),
					row.id
				]
			);

			const userId = inserted.rows[0].id;

			await client.query(
				'INSERT INTO up_users_role_lnk (user_id, role_id, user_ord) VALUES ($1, $2, $3)',
				[userId, roleId, 1]
			);

			takenEmails.add(email.toLowerCase());
			stats.inserted++;
			row.password ? stats.withPassword++ : stats.socialOnly++;
		}

		if (apply) {
			await client.query('COMMIT');
			console.log('\nCOMMITTED');
		} else {
			await client.query('ROLLBACK');
			console.log('\nDRY RUN — rolled back, nothing was written (pass --apply to commit)');
		}

		console.log(`  inserted     : ${stats.inserted}`);
		console.log(`    with password : ${stats.withPassword}`);
		console.log(`    social-only   : ${stats.socialOnly} (need Google/Facebook to sign in)`);
		console.log(`  already there: ${stats.skipped}`);
		console.log(`  conflicts    : ${stats.conflicts.length}`);

		for (const conflict of stats.conflicts) {
			console.log(`    - ${conflict}`);
		}
	} catch (err) {
		await client.query('ROLLBACK').catch(() => {});
		throw err;
	} finally {
		await client.end();
	}
}

main().catch((err) => {
	console.error('migration failed:', err.message);
	process.exit(1);
});
