import type { Schema, Struct } from '@strapi/strapi';

export interface ContentSpeaker extends Struct.ComponentSchema {
  collectionName: 'components_content_speakers';
  info: {
    description: 'Speaker/Lecturer information';
    displayName: 'Speaker';
  };
  attributes: {
    description: Schema.Attribute.Text;
    image: Schema.Attribute.Media<'images'>;
    name: Schema.Attribute.String & Schema.Attribute.Required;
  };
}

export interface EmbedsVisualEmbed extends Struct.ComponentSchema {
  collectionName: 'components_embeds_visual_embeds';
  info: {
    description: 'Video embed configurations';
    displayName: 'Visual Embed';
  };
  attributes: {
    autoplay: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    embed_code: Schema.Attribute.Text;
    embed_type: Schema.Attribute.Enumeration<
      ['youtube', 'facebook', 'vimeo', 'custom']
    > &
      Schema.Attribute.Required;
    video_url: Schema.Attribute.String;
  };
}

declare module '@strapi/strapi' {
  export module Public {
    export interface ComponentSchemas {
      'content.speaker': ContentSpeaker;
      'embeds.visual-embed': EmbedsVisualEmbed;
    }
  }
}
