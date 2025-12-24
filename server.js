/**
 * ============================
 * SERVER.JS — BACKEND OVERVIEW
 * ============================
 *
 * This file is the SERVER-SIDE of our application.
 *
 * It does NOT run in the browser and is NEVER visible to users.
 * Instead, it runs on a backend server (locally for now, later deployed).
 *
 * Its role in the overall system:
 *
 *   [ Framer Website (Frontend) ]
 *                |
 *                |  HTTP requests (form submission, data fetching)
 *                |
 *        [ THIS SERVER (Backend) ]
 *                |
 *        ┌───────┴────────┐
 *        |                |
 *   [ OpenAI API ]   [ Supabase ]
 *        |                |
 *   Image generation   Database + Storage
 *
 *
 * Concretely, this server:
 * 1. Receives form submissions from Framer (name, email, optional image)
 * 2. If an image is provided:
 *      - sends it to OpenAI to generate a new image
 *      - stores the generated image in Supabase Storage
 * 3. Stores the user’s name, email, and image URL in Supabase Database
 * 4. Exposes an endpoint to fetch all community members
 *
 * IMPORTANT:
 * - This server holds SECRET KEYS (OpenAI + Supabase service role)
 * - Those secrets must NEVER be placed in Framer or frontend code
 * - Framer will only ever talk to THIS server
 */



/**
 * ============================
 * ENVIRONMENT SETUP
 * ============================
 */

// Loads environment variables from the .env file into process.env
// This is how we safely store secrets (API keys, URLs, etc.)
require("dotenv").config()



/**
 * ============================
 * IMPORT DEPENDENCIES
 * ============================
 */

// Express: minimal web server framework
const express = require("express")

// Multer: middleware to handle file uploads (multipart/form-data)
const multer = require("multer")

// CORS: controls which websites are allowed to call this server
const cors = require("cors")

// OpenAI client (used to generate images)
const OpenAI = require("openai")
const { toFile } = require("openai")

// Supabase client (used for database + storage)
const { createClient } = require("@supabase/supabase-js")



/**
 * ============================
 * SERVER INITIALIZATION
 * ============================
 */

const app = express()

// Multer instance with in-memory storage
// Uploaded files will be available as buffers in req.file
const upload = multer()

// Allows this server to parse JSON bodies (not used for file uploads,
// but useful for other endpoints)
app.use(express.json())



/**
 * ============================
 * CORS CONFIGURATION
 * ============================
 *
 * This controls which frontend origins are allowed to send requests
 * to this server (e.g. your Framer site).
 *
 * For now, this value comes from the .env file.
 * Later, it will be your deployed Framer domain.
 */

app.use(
  cors({
    origin: process.env.CORS_ORIGIN,
  })
)



/**
 * ============================
 * OPENAI CLIENT SETUP
 * ============================
 *
 * This client is used ONLY on the server.
 * The API key is secret and never exposed to the browser.
 */

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
})



/**
 * ============================
 * SUPABASE CLIENT SETUP
 * ============================
 *
 * We use the SUPABASE SERVICE ROLE KEY here.
 *
 * Why?
 * - It allows unrestricted access to database + storage
 * - It bypasses Row Level Security
 * - It must NEVER be used in frontend code
 */

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)



/**
 * ============================
 * IMAGE GENERATION PROMPT
 * ============================
 *
 * This is the prompt sent to OpenAI when an image is uploaded.
 * It defines the visual style of the generated image.
 *
 * We can refine or replace this later without touching Framer.
 */

const PIXEL_PROMPT = `
Using the provided photo as reference, create an original baby character
for the comic strip "Peanuts". They are standing up, the background is white,
and they should not have facial hair.
`



/**
 * ======================================================
 * POST /submitMember
 * ======================================================
 *
 * This endpoint is called when the Framer form is submitted.
 *
 * It receives:
 * - name  (text)
 * - email (text)
 * - image (optional file)
 *
 * It performs the following steps:
 * 1. Validate name + email
 * 2. If an image is provided:
 *    - Send it to OpenAI
 *    - Upload the generated image to Supabase Storage
 * 3. Save name, email, and image URL to Supabase Database
 * 4. Return a success response
 */

app.post("/submitMember", upload.single("image"), async (req, res) => {
  try {
    // Extract and clean form fields
    const name = req.body.name?.trim()
    const email = req.body.email?.trim()

    // Basic validation
    if (!name || !email) {
      return res.status(400).json({ error: "Missing name or email" })
    }

    // This will hold the public URL of the generated image (if any)
    let imageUrl = null



    /**
     * ============================
     * IMAGE PROCESSING (OPTIONAL)
     * ============================
     *
     * This block only runs if a file was uploaded.
     * If no image is provided, we skip everything here.
     */

    if (req.file) {
      // Convert the uploaded image buffer into a format OpenAI expects
      const openaiFile = await toFile(
        req.file.buffer,
        req.file.originalname || "upload.png",
        { type: req.file.mimetype }
      )

      // Call OpenAI to generate a new image based on the uploaded photo
      const result = await openai.images.edit({
        model: process.env.OPENAI_IMAGE_MODEL,
        image: openaiFile,
        prompt: PIXEL_PROMPT,
        size: "1024x1024",
        background: "transparent",
      })

      // Extract the base64 image returned by OpenAI
      const base64 = result.data[0].b64_json
      const buffer = Buffer.from(base64, "base64")

      // Define where the image will live inside the storage bucket
      const filePath = `community/${Date.now()}-${name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")}.png`

      // Upload the image to Supabase Storage
      const { error: uploadError } = await supabase.storage
        .from("neighbors")
        .upload(filePath, buffer, {
          contentType: "image/png",
        })

      if (uploadError) {
        throw new Error(uploadError.message)
      }

      // Get a public URL for the uploaded image
      const { data } = supabase.storage
        .from("neighbors")
        .getPublicUrl(filePath)

      imageUrl = data.publicUrl
    }



    /**
     * ============================
     * DATABASE INSERT
     * ============================
     *
     * We now store the user in the community_members table.
     * image_url can be NULL if no image was uploaded.
     */

    const { error: dbError } = await supabase
      .from("community_members")
      .insert([{ name, email, image_url: imageUrl }])

    if (dbError) {
      throw new Error(dbError.message)
    }

    // Everything succeeded
    res.json({ ok: true })

  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})



/**
 * ======================================================
 * GET /community
 * ======================================================
 *
 * This endpoint returns ALL community members.
 *
 * It is used by:
 * - the Community page on the Framer website
 * - the future mobile app
 *
 * It simply reads from the database and returns JSON.
 */

app.get("/community", async (req, res) => {
  const { data, error } = await supabase
    .from("community_members")
    .select("name,email,image_url,created_at")
    .order("created_at", { ascending: false })

  if (error) {
    return res.status(500).json({ error: error.message })
  }

  res.json(data)
})



/**
 * ============================
 * HEALTH CHECK
 * ============================
 *
 * Simple endpoint to verify the server is running.
 * Useful for deployment monitoring.
 */

app.get("/health", (_, res) => {
  res.json({ ok: true })
})



/**
 * ============================
 * START SERVER
 * ============================
 *
 * The server listens on the port defined in .env.
 * Locally this is usually 3001.
 * In production, the hosting provider will set the port.
 */

app.listen(process.env.PORT, () => {
  console.log(`Server running on http://localhost:${process.env.PORT}`)
})
