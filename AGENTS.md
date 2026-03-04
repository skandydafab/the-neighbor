# AGENTS.md — Agent Coding Guidelines for The Neighbor Backend

## Overview

Node.js Express 5 backend: receives community member sign-ups, generates Peanuts-style baby avatars via OpenAI, sends a branded welcome email via Resend, and stores data in Supabase (DB + Storage). Single-file architecture in `server.js`. Deployed on Render.

## Project Structure

```
the-neighbor/
├── server.js          # All endpoints + email logic
├── package.json       # Dependencies (express, multer, cors, openai, @supabase/supabase-js, resend)
├── AGENTS.md          # This file
└── .env               # Environment variables (never commit)
```

## Commands

```bash
npm install                          # Install dependencies
node server.js                       # Start server
npx nodemon server.js                # Start with auto-reload
```

No test framework, linter, or type checker is configured. If added:

```bash
npm install --save-dev jest          # Install Jest
npx jest                             # Run all tests
npx jest path/to/file.test.js        # Run a single test file
npx jest --testNamePattern="name"    # Run a single test by name
npx eslint .                         # Lint (if eslint is installed)
```

## Environment Variables

All required in `.env` (and on Render):

| Variable | Purpose |
|----------|---------|
| `PORT` | Server listen port |
| `CORS_ORIGIN` | Allowed frontend origin for CORS (also used as CTA link in emails) |
| `OPENAI_API_KEY` | OpenAI API key |
| `OPENAI_IMAGE_MODEL` | Model name for `openai.images.edit()` |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (bypasses RLS) |
| `RESEND_API_KEY` | Resend API key (https://resend.com/api-keys) |
| `EMAIL_FROM` | Sender address, e.g. `The Neighbor <hello@theneighbor.com>` |

## Database Schema

### Table: `community_members`

| Column | Type | Nullable | Notes |
|--------|------|----------|-------|
| `firstname` | text | NO | Trimmed on input |
| `lastname` | text | NO | Trimmed on input |
| `email` | text | NO | Unique; used for duplicate checking |
| `location` | text | YES | Optional |
| `activity` | text | YES | Optional |
| `image_url` | text | YES | Public URL of AI-generated image |
| `original_image_url` | text | YES | Public URL of uploaded selfie |
| `created_at` | timestamp | NO | Auto-generated, used for ordering |

### Supabase Storage Bucket: `neighbors`

- `original_image_url/` — raw uploaded photos
- `community/` — AI-generated character images

## Code Style

### General

- **CommonJS** modules (`require`, not `import`)
- 2-space indentation
- Double quotes for strings
- Semicolons at end of statements
- Max line length: 100 characters

### Imports

```javascript
// Order: built-in Node -> external packages -> internal modules
const express = require("express")
const multer = require("multer")
const { createClient } = require("@supabase/supabase-js")
const { Resend } = require("resend")
```

### Naming

- Variables/functions: `camelCase`
- Constants: `SCREAMING_SNAKE_CASE`
- Files: `kebab-case` or `camelCase`
- Classes: `PascalCase`

### Error Handling

```javascript
app.post("/endpoint", async (req, res) => {
  try {
    if (!requiredField) {
      return res.status(400).json({ error: "Descriptive message" })
    }
    const result = await doSomething()
    res.json({ ok: true, data: result })
  } catch (err) {
    console.error("Operation failed:", err.message)
    res.status(500).json({ error: "Internal server error" })
  }
})
```

### Supabase Queries

```javascript
const { data, error } = await supabase
  .from("table")
  .select("columns")
  .eq("field", value)

if (error) {
  console.error("Database error:", error.message)
  throw error
}
```

### Logging

- `console.log` for operational events; `console.error` for errors
- Include context: `console.log("Processing:", { firstname, email })`
- Never log secrets (API keys, passwords, service role keys)

## Adding New Endpoints

```javascript
/**
 * ======================================================
 * METHOD /endpoint
 * ======================================================
 *
 * Description of what this endpoint does.
 *
 * Request: - param1 (type): description
 * Response: 200 success, 400 validation, 500 server error
 */
app.method("/endpoint", async (req, res) => {
  try {
    const { param1 } = req.body
    if (!param1) return res.status(400).json({ error: "param1 is required" })
    const result = await doWork(param1)
    res.json({ ok: true, data: result })
  } catch (err) {
    console.error("Endpoint error:", err)
    res.status(500).json({ error: "Server error" })
  }
})
```

## Security

- Never expose `SUPABASE_SERVICE_ROLE_KEY` or `RESEND_API_KEY` to the frontend
- Validate all user inputs server-side
- Sanitize file names before storage (see `safeNameSlug` in `/submitMember`)
- Use specific CORS origins (never `*` in production)
- Check for duplicate emails before inserting (409 Conflict)

## Key Design Decisions

- Image processing failure is **non-fatal**: user record is saved with `null` image URLs
- Email sending failure is **non-fatal**: user is registered even if the welcome email fails
- The `GET /community` endpoint returns all members (privacy note: includes emails)
- Welcome email is sent **after** successful DB insert, **before** the HTTP response
- The email template lives in `getWelcomeEmailHtml()` in `server.js` — edit the copy variables at the top of the function to change wording
