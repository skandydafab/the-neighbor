/**
 * =========================================================
 * SERVER.JS — BACKEND (RENDER + OPENAI + SUPABASE)
 * =========================================================
 *
 * This file is the SERVER-SIDE of the application.
 *
 * It does NOT run in the browser and is NEVER visible to users.
 * It runs on a backend server (locally or deployed on Render).
 *
 * ARCHITECTURE OVERVIEW
 * ---------------------
 *
 *   [ Framer Website (Frontend) ]
 *                |
 *                |  HTTP requests (multipart/form-data, JSON)
 *                |
 *        [ THIS SERVER (Backend) ]
 *                |
 *        ┌───────────────┬────────────────┐
 *        |               |                |
 *   [ OpenAI API ]   [ Supabase DB ]   [ Supabase Storage ]
 *        |               |                |
 *   Image generation   User records    Generated images
 *
 * WHAT THIS SERVER DOES
 * ---------------------
 * 1. Receives form submissions from Framer (name, email, optional image)
 * 2. If an image is provided:
 *      - sends it to OpenAI to generate a new image
 *      - uploads the generated image to Supabase Storage
 * 3. Stores name, email, and image URL in Supabase Database
 * 4. Exposes an endpoint to fetch all community members
 *
 * DEPLOYMENT NOTES (RENDER)
 * ------------------------
 * - Render free instances have limited CPU
 * - Long requests (OpenAI image generation) may be slow or fail
 * - We log EVERY critical step so failures are visible in Render Logs
 */

require("dotenv").config()

/**
 * ============================
 * IMPORT DEPENDENCIES
 * ============================
 */

const express = require("express")          // Web server framework
const multer = require("multer")            // Handles file uploads
const cors = require("cors")                // Cross-origin requests
const OpenAI = require("openai")            // OpenAI API client
const { toFile } = require("openai")        // Converts buffers to files
const { createClient } = require("@supabase/supabase-js") // Supabase client

/**
 * ============================
 * SERVER INITIALIZATION
 * ============================
 */

const app = express()

// Multer with in-memory storage (files available as req.file.buffer)
const upload = multer()

// Allow JSON parsing (useful for non-file endpoints)
app.use(express.json())

/**
 * ============================
 * CORS CONFIGURATION
 * ============================
 *
 * Controls which frontend origins may call this server.
 * Example: https://your-site.framer.website
 */

app.use(
  cors({
    origin: process.env.CORS_ORIGIN,
  })
)

/**
 * ============================
 * OPENAI CLIENT
 * ============================
 */

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
})

/**
 * ============================
 * SUPABASE CLIENT
 * ============================
 *
 * Uses SERVICE ROLE KEY:
 * - full access to database + storage
 * - bypasses Row Level Security
 * - NEVER expose this key to frontend
 */

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

/**
 * ============================
 * IMAGE GENERATION PROMPT
 * ============================
 */

// Prompt function 
function getPrompt(activity) {
  if (!activity) {
    return "Using the provided photo as reference, create an original baby character for the comic strip \
  'Peanuts'. They are standing up (from hair to toe in frame), no background, and they should not have facial hair. Leave clear margin around the character's silhouette, with at least 20 pixels from the highest-point of their hair, and 20 below the lowest point of their feet. Make sure that their skin color is solid \
      COMPOSITION RULES (CRITICAL):\
- Full body visible with generous empty space around the character\
- Character appears small-to-medium scale in the canvas\
- Clear space above the head and below the feet\
- Do not zoom in\
- Do not crop any part of the character\
- Character centered with visible breathing room on all sides\
STYLE RULES:\
- Solid opaque skin color\
- Clean cartoon shading\
- No facial hair";
  } else {
    console.log(activity + "activity being played and fed to GPT")
    return `Using the provided photo as reference, create an original baby character for the comic strip 'Peanuts'. They are \
  standing up (from head to toe in frame), with no background, and they should not have facial hair. They should clearly be doing the following activity: ${activity}. Leave clear margin around the character's silhouette (including top of hair and bottom of feet).`;
  }
}

/**
 * ======================================================
 * POST /submitMember
 * ======================================================
 *
 * Receives multipart/form-data:
 * - firstname (string)
 * - lastname  (string)
 * - email     (string)
 * - location  (string, optional)
 * - activity  (string, optional)
 * - image     (optional file)
 *
 * FLOW:
 * 1. Validate firstname + lastname + email
 * 2. If image exists:
 *    - Generate image via OpenAI
 *    - Upload generated image to Supabase Storage
 * 3. Save user record to Supabase Database
 */

app.post("/submitMember", upload.single("image"), async (req, res) => {
  try {
    console.log("----- NEW SUBMISSION -----")

    const firstname = req.body.firstname?.trim()
    const lastname = req.body.lastname?.trim()
    const email = req.body.email?.trim()
    const location = req.body.location?.trim() || null
    const activity = req.body.activity?.trim() || null

    if (!firstname || !lastname || !email) {
      console.log("Validation failed: missing firstname, lastname, or email")
      return res
        .status(400)
        .json({ error: "Missing firstname, lastname, or email" })
    }

    console.log("Incoming Neighbor:", {
      firstname,
      lastname,
      email,
      location,
      activity,
    })

    let imageUrl = null
    let originalImageUrl = null

    /**
     * ============================
     * IMAGE PROCESSING (OPTIONAL)
     * ============================
     */

    if (req.file) {
      console.log("Image received:", {
        filename: req.file.originalname,
        type: req.file.mimetype,
        size: req.file.size,
      })

      try {
        /**
         * ============================
         * STORE ORIGINAL IMAGE
         * ============================
         *
         * We first store the original uploaded image in the
         * "original_image_url" folder within the same Supabase
         * bucket as the "community" folder.
         */

        const safeNameSlug = `${firstname}-${lastname}`
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")

        const originalFilePath = `original_image_url/${Date.now()}-${safeNameSlug}.png`

        console.log("Uploading original image to Supabase:", originalFilePath)

        const { error: originalUploadError } = await supabase.storage
          .from("neighbors")
          .upload(originalFilePath, req.file.buffer, {
            contentType: req.file.mimetype,
          })

        if (originalUploadError) {
          console.error(
            "Original image upload failed:",
            originalUploadError.message
          )
        } else {
          const { data: originalData } = supabase.storage
            .from("neighbors")
            .getPublicUrl(originalFilePath)

          originalImageUrl = originalData.publicUrl
          console.log("Original image successfully stored:", originalImageUrl)
        }

        // Convert uploaded image buffer to OpenAI file
        const openaiFile = await toFile(
          req.file.buffer,
          req.file.originalname || "upload.png",
          { type: req.file.mimetype }
        )

        console.log("Sending image to OpenAI...")

        const PROMPT = getPrompt(activity)

        const result = await openai.images.edit({
          model: process.env.OPENAI_IMAGE_MODEL,
          image: openaiFile,
          prompt: PROMPT,
          size: "1024x1024",
          background: 'transparent',
        })

        console.log("OpenAI image generation completed")

        const base64 = result.data?.[0]?.b64_json
        if (!base64) {
          throw new Error("OpenAI returned no image data")
        }

        const buffer = Buffer.from(base64, "base64")

        const filePath = `community/${Date.now()}-${safeNameSlug}.png`

        console.log("Uploading image to Supabase:", filePath)

        const { error: uploadError } = await supabase.storage
          .from("neighbors")
          .upload(filePath, buffer, {
            contentType: "image/png",
          })

        if (uploadError) {
          throw uploadError
        }

        const { data } = supabase.storage
          .from("neighbors")
          .getPublicUrl(filePath)

        imageUrl = data.publicUrl

        console.log("Image successfully stored:", imageUrl)

      } catch (imageError) {
        // IMPORTANT: image failure does NOT crash the whole request
        console.error("Image processing failed:", imageError.message)
        imageUrl = null
      }

    } else {
      console.log("No image uploaded")
    }

    /**
     * ============================
     * DATABASE INSERT
     * ============================
     */

    console.log("Saving user to database")

    const { error: dbError } = await supabase
      .from("community_members")
      .insert([
        {
          firstname,
          lastname,
          email,
          location,
          activity,
          image_url: imageUrl,
          original_image_url: originalImageUrl,
        },
      ])

    if (dbError) {
      throw dbError
    }

    console.log("User saved successfully")
    res.json({ ok: true })

  } catch (err) {
    console.error("Request failed:", err)
    res.status(500).json({
      error:'server error while processing submission',
    })
  }
})

/**
 * ======================================================
 * GET /community
 * ======================================================
 *
 * Returns all community members.
 * Used by:
 * - Framer Community page
 * - Future app
 */

app.get("/community", async (req, res) => {
  const { data, error } = await supabase
    .from("community_members")
    .select(
      "firstname,lastname,email,location,activity,image_url,original_image_url,created_at"
    )
    .order("created_at", { ascending: false })

  if (error) {
    console.error("Failed to fetch community:", error)
    return res.status(500).json({ error: error.message })
  }

  res.json(data)
})

/**
 * ============================
 * HEALTH CHECK
 * ============================
 */

app.get("/health", (_, res) => {
  res.json({ ok: true })
})

/**
 * ============================
 * START SERVER
 * ============================
 */

app.listen(process.env.PORT, () => {
  console.log(`Server running on port ${process.env.PORT}`)
})
