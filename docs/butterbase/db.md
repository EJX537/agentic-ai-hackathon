# Butterbase Database & Data API

> ⚠️ Everything in this doc has been tested against the live API.

Each app gets an **isolated PostgreSQL database** with `pgvector` (embeddings), `uuid-ossp`, RLS helpers, and migration tracking pre-installed.

---

## Schema Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/{app_id}/schema` | Read current schema |
| `POST` | `/v1/{app_id}/schema/apply` | Apply schema (use `dry_run: true` to preview) |
| `GET` | `/v1/{app_id}/migrations` | List applied migrations |

## Defining a Schema

The payload structure is:

```json
{
  "schema": {
    "tables": {
      "table_name": {
        "columns": {
          "column_name": { "type": "...", ... }
        }
      }
    }
  }
}
```

### Column Properties

| Property | Type | Required | Description |
|---|---|---|---|
| `type` | string | **Yes** | Column data type |
| `primaryKey` | boolean | No | Makes this column the primary key |
| `nullable` | boolean | No | Allow NULL (default: `true`) |
| `unique` | boolean | No | Unique constraint |
| `default` | string | No | Default value expression (`"now()"`, `"gen_random_uuid()"`) |
| `references` | string \| object | No | Foreign key — see below |

> **Note:** The property is `primaryKey` (camelCase), not `primary`. Using `primary` returns a validation error.

### Column Types

| Category | Types |
|---|---|
| Text | `text`, `varchar`, `varchar(N)`, `char`, `char(N)` |
| Numbers | `integer`, `bigint`, `smallint`, `real`, `float4`, `float8`, `decimal`, `numeric`, `numeric(P,S)` |
| Boolean | `boolean`, `bool` |
| UUID | `uuid` |
| Date/Time | `timestamp`, `timestamptz`, `date`, `time`, `timetz`, `interval` |
| JSON | `json`, `jsonb` |
| Binary | `bytea` |
| Vectors | `vector(N)` — for AI embeddings |
| Arrays | `text[]`, `integer[]`, etc. |

### Foreign Keys

Two forms — verified working:

```json
// String shorthand (defaults to NO ACTION)
"user_id": { "type": "uuid", "references": "users.id" }

// Object form with referential actions
"user_id": {
  "type": "uuid",
  "references": {
    "table": "users",
    "column": "id",
    "onDelete": "CASCADE",
    "onUpdate": "CASCADE"
  }
}
```

**Allowed actions:** `NO ACTION` (default), `RESTRICT`, `CASCADE`, `SET NULL`, `SET DEFAULT`

Generates SQL: `FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE`

## Adding Columns

Include the existing table with both old + new columns — the platform diffs:

```json
{
  "schema": {
    "tables": {
      "posts": {
        "columns": {
          "id":      { "type": "uuid", "primaryKey": true, "default": "gen_random_uuid()" },
          "title":   { "type": "text" },
          "tags":    { "type": "text[]" },          // new
          "view_count": { "type": "integer", "default": "0" }  // new
        }
      }
    }
  }
}
```

## Dropping Columns

Use `_dropColumns` inside the table definition:

```json
{
  "schema": {
    "tables": {
      "posts": {
        "_dropColumns": ["legacy_field", "temp_data"],
        "columns": {
          "id":    { "type": "uuid", "primaryKey": true, "default": "gen_random_uuid()" },
          "title": { "type": "text" }
        }
      }
    }
  }
}
```

> **Important:** `_dropColumns` removes columns from the schema diff. The table definition must still include all remaining columns.

## Dropping Tables

Use `_drop` at the **schema root level** (not inside the table). The dropped table is omitted from `tables`:

```json
{
  "schema": {
    "_drop": ["obsolete_table", "another_table"],
    "tables": {
      "remaining_table": {
        "columns": { ... }
      }
    }
  }
}
```

Generates: `DROP TABLE IF EXISTS "obsolete_table" CASCADE`

> **Gotcha:** The table being dropped must be **omitted** from `tables` and listed in `_drop[]`. Also, all remaining tables must still be present in `tables` — omitting one triggers a destructive-change error asking you to add it to `_drop[]`.

## Dry Run (Preview)

Always preview destructive changes first:

```bash
curl -X POST https://api.butterbase.ai/v1/app_9tisydf654vf/schema/apply \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"schema": { "tables": {...} }, "dry_run": true}'
```

The response includes the SQL statements without executing them.

## Example: Complete Workflow

```bash
# 1. Apply schema
curl -X POST https://api.butterbase.ai/v1/app_9tisydf654vf/schema/apply \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "schema": {
      "tables": {
        "users": {
          "columns": {
            "id":    { "type": "uuid", "primaryKey": true, "default": "gen_random_uuid()" },
            "email": { "type": "text", "unique": true, "nullable": false }
          }
        },
        "posts": {
          "columns": {
            "id":       { "type": "uuid", "primaryKey": true, "default": "gen_random_uuid()" },
            "title":    { "type": "text", "nullable": false },
            "user_id":  { "type": "uuid", "references": { "table": "users", "column": "id", "onDelete": "CASCADE" } },
            "created_at": { "type": "timestamptz", "default": "now()" }
          }
        }
      }
    }
  }'

# 2. Insert rows
curl -X POST https://api.butterbase.ai/v1/app_9tisydf654vf/users \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email": "alice@example.com"}'

curl -X POST https://api.butterbase.ai/v1/app_9tisydf654vf/posts \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title": "Hello World", "user_id": "<user-uuid-from-above>"}'

# 3. Query with filtering
curl "https://api.butterbase.ai/v1/app_9tisydf654vf/posts?order=created_at.desc&limit=10"
```

---

## Auto-Generated Data API (CRUD)

Once tables exist, full CRUD is available immediately at these endpoints:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/{app_id}/{table}` | List rows |
| `GET` | `/v1/{app_id}/{table}/{id}` | Read single row |
| `POST` | `/v1/{app_id}/{table}` | Create a row |
| `PATCH` | `/v1/{app_id}/{table}/{id}` | Update a row |
| `DELETE` | `/v1/{app_id}/{table}/{id}` | Delete a row |

### Filtering

Format: `column=operator.value`

| Operator | Example | SQL |
|---|---|---|
| `eq` | `status=eq.published` | `= 'published'` |
| `neq` | `status=neq.draft` | `!= 'draft'` |
| `gt` | `age=gt.18` | `> 18` |
| `gte` | `age=gte.18` | `>= 18` |
| `lt` | `price=lt.100` | `< 100` |
| `lte` | `price=lte.100` | `<= 100` |
| `like` | `title=like.%hello%` | `LIKE '%hello%'` |
| `ilike` | `title=ilike.%hello%` | `ILIKE '%hello%'` |
| `is` | `deleted_at=is.null` | `IS NULL` |
| `in` | `id=in.(1,2,3)` | `IN (1,2,3)` |
| `fts` | `title=fts.hello` | Full-text search |

### Sorting

```
GET /v1/{app_id}/posts?order=created_at.desc
```

### Pagination

```
GET /v1/{app_id}/posts?limit=20&offset=0
```

### Column Selection

```
GET /v1/{app_id}/posts?select=id,title,created_at
```

### Responses

- **List**: Returns a JSON array of row objects
- **Single**: Returns a JSON object
- **Create**: Returns the created row (with generated UUID, timestamps)

## Authentication & Row-Level Security

| Auth method | DB role | Access |
|---|---|---|
| None (anonymous) | `butterbase_anon` | Public data only |
| End-user JWT | `butterbase_user` | User-scoped data (RLS) |
| API key (`bb_sk_...`) | `butterbase_service` | All data (bypasses RLS) |

## Migration Tracking

Every schema change is tracked:

```json
{
  "migrations": [
    {
      "id": 1,
      "description": "schema_2026-06-05T19-08-52-218Z",
      "applied_sql": "CREATE TABLE \"documents\" (\"id\" uuid PRIMARY KEY DEFAULT gen_random_uuid(), ...)",
      "applied_at": "2026-06-05T19:08:52.256Z"
    }
  ]
}
```

## Safety

- **Destructive ops blocked by default** — must use `_drop[]` / `_dropColumns[]` explicitly
- **Max 50 tables** per schema definition
- **Idempotent** — re-applying the same schema does nothing
