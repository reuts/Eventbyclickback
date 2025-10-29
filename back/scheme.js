const fs = require('fs');
const path = require('path');

// הסכמות שלך
const schemas = {
  'src/api/page/content-types/page/schema.json': {
    "kind": "collectionType",
    "collectionName": "pages",
    "info": {
      "singularName": "page",
      "pluralName": "pages",
      "displayName": "Page",
      "description": "Event pages with all configurations"
    },
    "options": {
      "draftAndPublish": true
    },
    "pluginOptions": {},
    "attributes": {
      "name": {
        "type": "string",
        "required": true
      },
      "hash": {
        "type": "uid",
        "targetField": "name"
      },
      "event_type": {
        "type": "relation",
        "relation": "manyToOne",
        "target": "api::event-type.event-type",
        "inversedBy": "pages"
      },
      "name_position": {
        "type": "enumeration",
        "enum": ["top", "bottom", "center"],
        "default": "bottom"
      },
      "field_profession": {
        "type": "boolean",
        "default": false
      },
      "field_phone": {
        "type": "boolean",
        "default": true
      },
      "field_newsletter": {
        "type": "boolean",
        "default": false
      },
      "is_event_type": {
        "type": "boolean",
        "default": true
      },
      "is_online": {
        "type": "boolean",
        "default": false
      },
      "meeting_url": {
        "type": "string"
      },
      "payment_required": {
        "type": "boolean",
        "default": false
      },
      "payment_url": {
        "type": "string"
      },
      "payment_type": {
        "type": "enumeration",
        "enum": ["bit", "paypal", "credit_card", "bank_transfer", "other"]
      },
      "player": {
        "type": "relation",
        "relation": "manyToOne",
        "target": "api::player.player",
        "inversedBy": "pages"
      },
      "goalID": {
        "type": "string"
      },
      "image": {
        "type": "media",
        "multiple": false,
        "required": false,
        "allowedTypes": ["images"]
      },
      "image_seo": {
        "type": "media",
        "multiple": false,
        "required": false,
        "allowedTypes": ["images"]
      },
      "image2": {
        "type": "media",
        "multiple": false,
        "required": false,
        "allowedTypes": ["images"]
      },
      "language": {
        "type": "enumeration",
        "enum": ["ltr", "rtl"],
        "default": "rtl"
      },
      "footer_desc": {
        "type": "richtext"
      },
      "event_date": {
        "type": "datetime"
      },
      "event_date_i18": {
        "type": "boolean",
        "default": false
      },
      "time": {
        "type": "time"
      },
      "end_time": {
        "type": "time"
      },
      "time_text": {
        "type": "string"
      },
      "event_end_date": {
        "type": "datetime"
      },
      "ticket_link": {
        "type": "string"
      },
      "special_msg": {
        "type": "text"
      },
      "special_msg_colour": {
        "type": "string",
        "default": "#000000"
      },
      "background_color": {
        "type": "string",
        "default": "#e3a68b"
      },
      "special_msg_bg": {
        "type": "string"
      },
      "desc_bg": {
        "type": "string",
        "default": "#fef8f6"
      },
      "extra_desc_bg": {
        "type": "string"
      },
      "abstract_bg": {
        "type": "string"
      },
      "description": {
        "type": "richtext"
      },
      "extra_description": {
        "type": "richtext"
      },
      "abstract": {
        "type": "richtext"
      },
      "text_color": {
        "type": "string",
        "default": "#ffffff"
      },
      "type_of_registration": {
        "type": "string"
      },
      "get_tickets_text": {
        "type": "string"
},
      "send_email_registration": {
        "type": "boolean",
        "default": true
      },
      "display_last_name": {
        "type": "boolean",
        "default": true
      },
      "branded": {
        "type": "boolean",
        "default": true
      },
      "has_chat": {
        "type": "boolean",
        "default": true
      },
      "logo": {
        "type": "media",
        "multiple": false,
        "required": false,
        "allowedTypes": ["images"]
      },
      "location": {
        "type": "string"
      },
      "show_strip": {
        "type": "boolean",
        "default": true
      },
      "upper_strip": {
        "type": "boolean",
        "default": true
      },
      "has_register": {
        "type": "boolean",
        "default": false
      },
      "disable_user_creation": {
        "type": "boolean",
        "default": false
      },
      "separate_event": {
        "type": "boolean",
        "default": false
      },
      "consolidated": {
        "type": "boolean",
        "default": true
      },
      "submit_btn_text": {
        "type": "string"
      },
      "embed_type": {
        "type": "enumeration",
        "enum": ["one", "youtube", "facebook", "vimeo"]
      },
      "embed_id": {
        "type": "string"
      },
      "embed_type2": {
        "type": "enumeration",
        "enum": ["one", "youtube", "facebook", "vimeo"]
      },
      "embed_id2": {
        "type": "string"
      },
      "visual_embeds": {
        "type": "component",
        "repeatable": true,
        "component": "embeds.visual-embed"
      },
      "facebook_pixel_id": {
        "type": "string"
      },
      "avatar_on_register": {
        "type": "boolean",
        "default": true
      },
      "has_tickets_page": {
        "type": "boolean",
        "default": false
      },
      "file_description": {
        "type": "text"
      },
      "additional_file": {
        "type": "media",
        "multiple": false,
        "required": false,
        "allowedTypes": ["files"]
      },
      "has_lecturer": {
        "type": "boolean",
        "default": true
      },
      "lecturer_name": {
        "type": "string"
      },
      "lecturer_desc": {
        "type": "text"
      },
      "pixabay_cover_image": {
        "type": "boolean",
        "default": false
      },
      "speaker": {
        "type": "component",
        "repeatable": false,
        "component": "content.speaker"
      },
      "speaker_tickets_page": {
        "type": "component",
        "repeatable": false,
        "component": "content.speaker"
      }
    }
  },

  'src/api/event-type/content-types/event-type/schema.json': {
    "kind": "collectionType",
    "collectionName": "event_types",
    "info": {
      "singularName": "event-type",
      "pluralName": "event-types",
      "displayName": "Event Type",
      "description": "Types of events"
    },
    "options": {
      "draftAndPublish": true
    },
    "pluginOptions": {},
    "attributes": {
      "name": {
        "type": "string",
        "required": true
      },
      "description": {
        "type": "text"
      },
      "pages": {
        "type": "relation",
        "relation": "oneToMany",
        "target": "api::page.page",
        "mappedBy": "event_type"
      }
    }
  },

  'src/api/player/content-types/player/schema.json': {
    "kind": "collectionType",
    "collectionName": "players",
    "info": {
      "singularName": "player",
      "pluralName": "players",
      "displayName": "Player",
      "description": "Event organizers/players"
    },
    "options": {
      "draftAndPublish": true
    },
    "pluginOptions": {},
    "attributes": {
      "name": {
        "type": "string",
        "required": true
      },
      "email": {
        "type": "email"
},
      "phone": {
        "type": "string"
      },
      "logo": {
        "type": "media",
        "multiple": false,
        "required": false,
        "allowedTypes": ["images"]
      },
      "pages": {
        "type": "relation",
        "relation": "oneToMany",
        "target": "api::page.page",
        "mappedBy": "player"
      }
    }
  },

  'src/components/embeds/visual-embed.json': {
    "collectionName": "components_embeds_visual_embeds",
    "info": {
      "displayName": "Visual Embed",
      "description": "Video embed configurations"
    },
    "options": {},
    "attributes": {
      "embed_type": {
        "type": "enumeration",
        "enum": ["youtube", "facebook", "vimeo", "custom"],
        "required": true
      },
      "embed_code": {
        "type": "text"
      },
      "video_url": {
        "type": "string"
      },
      "autoplay": {
        "type": "boolean",
        "default": false
      }
    }
  },

  'src/components/content/speaker.json': {
    "collectionName": "components_content_speakers",
    "info": {
      "displayName": "Speaker",
      "description": "Speaker/Lecturer information"
    },
    "options": {},
    "attributes": {
      "name": {
        "type": "string",
        "required": true
      },
      "description": {
        "type": "text"
      },
      "image": {
        "type": "media",
        "multiple": false,
        "required": false,
        "allowedTypes": ["images"]
      }
    }
  }
};

// יצירת התיקיות והקבצים
function createSchemas() {
  console.log('🚀 Starting schema generation...\n');

  Object.entries(schemas).forEach(([filePath, schema]) => {
    const fullPath = path.join(process.cwd(), filePath);
    const dir = path.dirname(fullPath);

    // יצירת התיקייה אם לא קיימת
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`✅ Created directory: ${dir}`);
    }

    // כתיבת הקובץ
    fs.writeFileSync(fullPath, JSON.stringify(schema, null, 2));
    console.log('✅ Created schema: ${filePath}');
  });

  console.log('\n✨ All schemas created successfully!');
  console.log('\n📝 Next steps:');
  console.log('1. Run: npm run develop');
  console.log('2. Strapi will rebuild the admin panel');
  console.log('3. Your new content types will be available!\n');
}

// הרצה
try {
  createSchemas();
} catch (error) {
  console.error('❌ Error:', error.message);
  process.exit(1);
}