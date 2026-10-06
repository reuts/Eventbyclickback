/**
 * player controller
 */

import { factories } from '@strapi/strapi'

export default factories.createCoreController('api::player.player', ({ strapi }) => ({
  /**
   * A card created by a signed-in organizer belongs to that organizer.
   *
   * The client cannot send `owner` itself: it points at
   * `plugin::users-permissions.user`, and Strapi rejects a relation key in the
   * body when the caller may not read its target — the Authenticated role
   * cannot read users, so the wizard's card save failed with
   * `400 Invalid key owner`. Taking the owner from the session instead also
   * means nobody can create a card in someone else's name.
   *
   * Requests made with an API token (the migration) have no user, and keep the
   * core behaviour — including an explicit `owner` in the body.
   */
  async create(ctx) {
    const userId = ctx.state.user?.id;
    if (!userId) return super.create(ctx);

    await this.validateQuery(ctx);
    const sanitizedQuery = await this.sanitizeQuery(ctx);

    const { body = {} } = ctx.request;
    if (!body.data || typeof body.data !== 'object') {
      return ctx.badRequest('Missing "data" payload in the request body');
    }

    const { owner: _ignored, ...input } = body.data;
    await this.validateInput(input, ctx);
    const sanitizedInput = (await this.sanitizeInput(input, ctx)) as Record<string, unknown>;

    const entity = await strapi.service('api::player.player').create({
      ...sanitizedQuery,
      data: { ...sanitizedInput, owner: userId },
    });

    const sanitizedEntity = await this.sanitizeOutput(entity, ctx);
    ctx.status = 201;
    return this.transformResponse(sanitizedEntity);
  },
}));
