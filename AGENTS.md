# AGENTS.md — Agent Coding Guidelines for The Neighbor Backend

## Overview

This is a Node.js Express backend server that handles community member submissions, integrates with OpenAI for image generation, and uses Supabase for database and storage.

## Project Structure

```
the-neighbor/
├── server.js          # Main Express server (all endpoints)
├── package.json       # Dependencies and scripts
└── .env               # Environment variables (never commit)
```

## Commands

### Running the Server

```bash
# Install dependencies
npm install

# Start development server
npm start

# Run server with nodemon (auto-reload on changes)
npx nodemon server.js
```

### Testing

Currently there are no tests configured. To add testing:

```bash
# Install jest for testing
npm install --save-dev jest

# Run all tests
npm test

# Run a single test file
npx jest testfilename.test.js

# Run a single test (using --testNamePattern)
npm test -- --testNamePattern="test name"
```

### Linting

No linter is currently configured. Recommended setup:

```bash
# Install ESLint
npm install --save-dev eslint

# Run ESLint
npx eslint .
```

### Type Checking

This is a plain JavaScript project (CommonJS). No type checking is configured. Consider adding JSDoc annotations for type hints if needed.

## Code Style Guidelines

### General Principles

- Use **CommonJS** module syntax (`require`, not ES modules)
- Use 2 spaces for indentation
- Use double quotes for strings
- Use semicolons at the end of statements
- Maximum line length: 100 characters

### Imports

```javascript
// Group imports by category (external, internal)
// Order: built-in Node modules -> external packages -> internal requires

const express = require("express")
const multer = require("multer")
const cors = require("cors")
const OpenAI = require("openai")
const { toFile } = require("openai")
const { createClient } = require("@supabase/supabase-js")
```

### Naming Conventions

- **Variables/functions**: camelCase (`imageUrl`, `getPrompt`)
- **Constants**: SCREAMING_SNAKE_CASE (e.g., `MAX_FILE_SIZE`)
- **File names**: camelCase or kebab-case (e.g., `server.js`, `auth-helper.js`)
- **Classes**: PascalCase (e.g., `ImageProcessor`)

### Error Handling

```javascript
// Always wrap async route handlers in try-catch
app.post("/endpoint", async (req, res) => {
  try {
    // validation first
    if (!requiredField) {
      return res.status(400).json({ error: "Descriptive error message" })
    }

    // core logic
    const result = await doSomething()

    // log success for debugging
    console.log("Operation completed:", { someVar: result })

    res.json({ ok: true, data: result })
  } catch (err) {
    console.error("Operation failed:", err.message)
    res.status(500).json({ error: "Internal server error" })
  }
})
```

### Database Operations

- Always handle Supabase errors explicitly
- Log all database operations for debugging
- Use parameterized queries via Supabase client

```javascript
const { data, error } = await supabase
  .from("table")
  .select("columns")
  .filter("field", "eq", value)

if (error) {
  console.error("Database error:", error.message)
  throw error
}
```

### File Uploads

- Use Multer for multipart/form-data
- Validate file type and size before processing
- Log file metadata for debugging

### Environment Variables

- Never hardcode secrets
- Use `process.env.VARIABLE_NAME`
- All required env vars should be documented in a `.env.example` file
- Required variables:
  - `PORT` - Server port
  - `CORS_ORIGIN` - Allowed frontend origin
  - `OPENAI_API_KEY` - OpenAI API key
  - `SUPABASE_URL` - Supabase project URL
  - `SUPABASE_SERVICE_ROLE_KEY` - Supabase service role key

### Logging

- Use `console.log` for operational events
- Use `console.error` for errors
- Include relevant context in log messages
- Never log sensitive data (passwords, API keys)

```javascript
console.log("Processing user:", { firstname, email })
console.error("Upload failed:", error.message)
```

### Comments

- Use comments to explain *why*, not *what*
- Document complex business logic
- Use JSDoc for functions with parameters and return values
- Keep comments up to date with code changes

### Security

- Never expose service role keys to frontend
- Validate all user inputs
- Use parameterized queries (Supabase handles this)
- Sanitize file names before storage
- Set appropriate CORS origins (not `*` in production)

## Adding New Endpoints

Follow this pattern:

```javascript
/**
 * ======================================================
 * METHOD /endpoint
 * ======================================================
 *
 * Description of what this endpoint does.
 *
 * Request:
 * - param1 (type): description
 * - param2 (type): description
 *
 * Response:
 * - 200: success
 * - 400: validation error
 * - 500: server error
 */

app.method("/endpoint", async (req, res) => {
  try {
    // 1. Extract and validate input
    const { param1, param2 } = req.body

    if (!param1) {
      return res.status(400).json({ error: "param1 is required" })
    }

    // 2. Process
    const result = await doWork(param1, param2)

    // 3. Respond
    res.json({ ok: true, data: result })
  } catch (err) {
    console.error("Endpoint error:", err)
    res.status(500).json({ error: "Server error" })
  }
})
```

## Recommended Improvements

1. **Add ESLint + Prettier** for consistent code style
2. **Add Jest** for unit/integration tests
3. **Add .env.example** documenting required environment variables
4. **Add input validation** library (e.g., Joi or express-validator)
5. **Add rate limiting** to prevent abuse
6. **Split server.js** into route handlers, services, and utilities
