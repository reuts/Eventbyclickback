// import type { Core } from '@strapi/strapi';

/**
 * Content-API permissions the SvelteKit admin needs.
 *
 * These used to be set by hand in the admin panel, which is how production
 * ended up with an API token that could read the mailing-list collections but
 * not upload a file or read `registers` — every image in the event wizard came
 * back 403, and the leads table came back empty. Declaring them here makes the
 * grant part of a deploy instead of something that has to be remembered.
 */
const AUTHENTICATED_ACTIONS = [
  // Landing pages
  'api::page.page.find',
  'api::page.page.findOne',
  'api::page.page.create',
  'api::page.page.update',
  'api::page.page.delete',

  // Organizers
  'api::player.player.find',
  'api::player.player.findOne',
  'api::player.player.create',
  'api::player.player.update',

  // Leads captured by landing pages
  'api::register.register.find',
  'api::register.register.findOne',
  'api::register.register.create',

  'api::event-type.event-type.find',
  'api::event-type.event-type.findOne',

  // Email marketing
  'api::mailing-list.mailing-list.find',
  'api::mailing-list.mailing-list.findOne',
  'api::mailing-list.mailing-list.create',
  'api::mailing-list.mailing-list.update',
  'api::mailing-list.mailing-list.delete',
  'api::campaign.campaign.find',
  'api::campaign.campaign.findOne',
  'api::campaign.campaign.create',
  'api::campaign.campaign.update',
  'api::campaign.campaign.delete',
  'api::email-template.email-template.find',
  'api::email-template.email-template.findOne',
  'api::email-template.email-template.create',
  'api::email-template.email-template.update',
  'api::email-template.email-template.delete',

  // Media library — the fix for the 403 on every wizard image upload.
  'plugin::upload.content-api.upload',
  'plugin::upload.content-api.find',
  'plugin::upload.content-api.findOne',
  'plugin::upload.content-api.destroy',
];

/**
 * Public visitors only ever read a published landing page. Writes stay off:
 * signups are posted by the SvelteKit server, not by the browser.
 */
const PUBLIC_ACTIONS = [
  'api::page.page.find',
  'api::page.page.findOne',
  'api::event-type.event-type.find',
];

/** Add any missing permission rows for a role. Existing rows are left alone. */
async function grant(strapi: any, roleType: string, actions: string[]) {
  const role = await strapi.db
    .query('plugin::users-permissions.role')
    .findOne({ where: { type: roleType } });

  if (!role) {
    strapi.log.warn(`[permissions] role "${roleType}" not found — skipping`);
    return;
  }

  const existing = await strapi.db.query('plugin::users-permissions.permission').findMany({
    where: { role: role.id },
  });
  const have = new Set(existing.map((permission: any) => permission.action));

  const missing = actions.filter((action) => !have.has(action));

  for (const action of missing) {
    await strapi.db
      .query('plugin::users-permissions.permission')
      .create({ data: { action, role: role.id } });
  }

  if (missing.length > 0) {
    strapi.log.info(`[permissions] ${roleType}: granted ${missing.length} action(s)`);
  }
}

export default {
  /**
   * An asynchronous register function that runs before
   * your application is initialized.
   *
   * This gives you an opportunity to extend code.
   */
  register(/* { strapi }: { strapi: Core.Strapi } */) {},

  /**
   * An asynchronous bootstrap function that runs before
   * your application gets started.
   *
   * This gives you an opportunity to set up your data model,
   * run jobs, or perform some special logic.
   */
  async bootstrap({ strapi }: { strapi: any }) {
    try {
      await grant(strapi, 'authenticated', AUTHENTICATED_ACTIONS);
      await grant(strapi, 'public', PUBLIC_ACTIONS);
    } catch (error) {
      // A permissions hiccup must not stop the server from booting.
      strapi.log.error(`[permissions] bootstrap failed: ${(error as Error).message}`);
    }
  },
};
