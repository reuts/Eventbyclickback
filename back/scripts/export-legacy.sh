#!/bin/bash
# Export the Laravel tables the Strapi migration scripts read, as NDJSON.
#
# One JSON object per line via JSON_OBJECT, with --raw so the mysql client does
# not re-escape the backslashes JSON already uses. Column lists are built from
# information_schema so a schema drift shows up as a missing key rather than a
# query that fails halfway through.
set -euo pipefail

DB=eventbyclick
OUT=/tmp/ebc-export
mkdir -p "$OUT"
rm -f "$OUT"/*.ndjson

# Build a "'col', `col`, ..." list for JSON_OBJECT, minus any excluded columns.
cols() {
  local table=$1 excluded=${2:-__none__}
  sudo mysql -N -B --default-character-set=utf8mb4 -e "
    SET SESSION group_concat_max_len = 1000000;
    SELECT GROUP_CONCAT(CONCAT('''', column_name, ''', \`', column_name, '\`')
                        ORDER BY ordinal_position SEPARATOR ', ')
    FROM information_schema.columns
    WHERE table_schema = '$DB' AND table_name = '$table'
      AND FIND_IN_SET(column_name, '$excluded') = 0;"
}

dump_table() {
  local name=$1 table=$2 excluded=${3:-__none__} where=${4:-}
  local list
  list=$(cols "$table" "$excluded")
  sudo mysql -N -B --raw --default-character-set=utf8mb4 --max-allowed-packet=512M "$DB" -e "SELECT JSON_OBJECT($list) FROM \`$table\` $where" > "$OUT/$name.ndjson"
  printf '%-24s %s rows\n' "$name" "$(wc -l < "$OUT/$name.ndjson")"
}

dump_query() {  # explicit projection, for the two narrowed exports
  local name=$1 sql=$2
  sudo mysql -N -B --raw --default-character-set=utf8mb4 --max-allowed-packet=512M "$DB" -e "$sql" > "$OUT/$name.ndjson"
  printf '%-24s %s rows\n' "$name" "$(wc -l < "$OUT/$name.ndjson")"
}

# Payment-gateway credentials are deliberately excluded: the new app uses
# external links only, and they have no business leaving this host.
dump_table app_users            app_users
dump_table events_types         events_types
dump_table players              players            'yaad_masof,yaad_key,isracard_key,payment_gateway'
# `create_event_form` is the wizard's saved form state, and it embeds the cover
# image as base64: 897MB across 1456 rows, against 0.1MB for the image paths
# themselves. It is not in migrate-pages' column list, so it is left behind.
dump_table events               events             'create_event_form'
dump_table properties           properties
dump_table propertiesvalues     propertiesvalues
dump_table users_events         users_events
dump_table users_events_info    users_events_info
# `users.password` is not migrated — Strapi would hash the already-hashed value.
dump_table users                users              'password,otp'

dump_query event-properties "SELECT DISTINCT JSON_OBJECT('event_id', event_id, 'propertyID', propertyID) FROM userpropertiesvalues"
dump_query answers          "SELECT JSON_OBJECT('users_events_id', users_events_id, 'propertyID', propertyID, 'propertyValueID', propertyValueID) FROM userpropertiesvalues"

echo
echo "written to $OUT"
