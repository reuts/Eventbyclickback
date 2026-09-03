import type { Schema, Struct } from '@strapi/strapi';

export interface ContactSocialLink extends Struct.ComponentSchema {
  collectionName: 'components_contact_social_links';
  info: {
    description: 'A single labelled link on an organizer profile';
    displayName: 'Social Link';
  };
  attributes: {
    type: Schema.Attribute.Enumeration<
      [
        'website',
        'facebook',
        'instagram',
        'linkedin',
        'youtube',
        'tiktok',
        'whatsapp',
        'other',
      ]
    > &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<'website'>;
    url: Schema.Attribute.String & Schema.Attribute.Required;
  };
}

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

export interface FormsCustomField extends Struct.ComponentSchema {
  collectionName: 'components_forms_custom_fields';
  info: {
    description: 'A per-event registration question beyond the standard fields';
    displayName: 'Custom Field';
  };
  attributes: {
    key: Schema.Attribute.String & Schema.Attribute.Required;
    label: Schema.Attribute.String & Schema.Attribute.Required;
    options: Schema.Attribute.JSON;
    required: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    type: Schema.Attribute.Enumeration<
      [
        'text',
        'textarea',
        'email',
        'tel',
        'number',
        'date',
        'select',
        'checkbox',
      ]
    > &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<'text'>;
  };
}

declare module '@strapi/strapi' {
  export module Public {
    export interface ComponentSchemas {
      'contact.social-link': ContactSocialLink;
      'content.speaker': ContentSpeaker;
      'embeds.visual-embed': EmbedsVisualEmbed;
      'forms.custom-field': FormsCustomField;
    }
  }
}
