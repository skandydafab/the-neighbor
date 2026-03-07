/**
 * =========================================================
 * SERVER.JS — BACKEND (RENDER + OPENAI + SUPABASE + RESEND)
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
 *        ┌───────────────┬────────────────┬──────────────┐
 *        |               |                |              |
 *   [ OpenAI API ]   [ Supabase DB ]   [ Supabase    [ Resend ]
 *        |               |              Storage ]        |
 *   Image generation   User records       |        Welcome emails
 *                                   Generated images
 *
 * WHAT THIS SERVER DOES
 * ---------------------
 * 1. Receives form submissions from Framer (name, email, optional image)
 * 2. If an image is provided:
 *      - sends it to OpenAI to generate a new image
 *      - uploads the generated image to Supabase Storage
 * 3. Stores name, email, and image URL in Supabase Database
 * 4. Sends a branded welcome email to the new member via Resend
 * 5. Exposes an endpoint to fetch all community members
 *
 * EMAIL (RESEND)
 * --------------
 * We use Resend (https://resend.com) for transactional email.
 * After a successful sign-up (database insert), the server sends
 * a branded HTML welcome email to the new member's address.
 *
 * - Email sending is NON-FATAL: if it fails, the sign-up still
 *   succeeds and the error is logged. The user is already saved.
 * - The HTML template lives in getWelcomeEmailHtml() below.
 *   Edit the copy variables at the top of that function to
 *   change wording without touching the HTML layout.
 * - Requires two env vars: RESEND_API_KEY and EMAIL_FROM.
 * - Free tier: 100 emails/day, 3,000/month.
 * - Custom sending domain must be verified in the Resend
 *   dashboard (DNS records: SPF, DKIM, and a TXT verification).
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
const { Resend } = require("resend")                     // Transactional email

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
 * RESEND EMAIL CLIENT
 * ============================
 *
 * Sends transactional welcome emails after successful sign-up.
 * Requires RESEND_API_KEY and EMAIL_FROM in .env.
 * Get your API key at: https://resend.com/api-keys
 * Verify your sending domain at: https://resend.com/domains
 */

const resend = new Resend(process.env.RESEND_API_KEY)
const EMAIL_FROM = process.env.EMAIL_FROM || "onboarding@resend.dev"

/**
 * ============================
 * IMAGE GENERATION PROMPT
 * ============================
 */

// Prompt function 
function getPrompt(activity) {
  if (!activity) {
    return `
Using the provided photo as reference, create an original baby character for the comic strip "Peanuts".

COMPOSITION RULES (CRITICAL):
- Full body visible from hair to feet
- Character appears small-to-medium scale in the canvas
- Clear empty space above the head and below the feet
- Draw clearly defined hair matching the style of the reference photo unless the subject in the reference photo is bald.
- Do not crop any part of the character
- Character centered with breathing room on all sides

STYLE RULES:
- Solid opaque skin color
- Clean cartoon shading
- No facial hair
- No background
`;
  } else {
    console.log(activity + " activity being played and fed to GPT");

    return `
Using the provided photo as reference, create an original baby character for the comic strip "Peanuts".

The character is clearly doing this activity:
${activity}

COMPOSITION RULES (CRITICAL):
- Full body visible from hair to feet
- Character appears small-to-medium scale in the canvas
- Clear empty space above the head and below the feet
- Draw clearly defined hair matching the style of the reference photo unless the subject in the reference photo is bald.
- Do not crop any part of the character
- Character centered with breathing room on all sides

STYLE RULES:
- Solid opaque skin
- Clean cartoon shading
- No facial hair
- No background
`;
  }
}

/**
 * ============================
 * WELCOME EMAIL TEMPLATE
 * ============================
 *
 * Branded HTML email sent after successful sign-up.
 * Edit the copy below to change wording — the layout and
 * styles are inline so they render in all email clients.
 */

function getWelcomeEmailHtml(firstname) {
  // ── Editable copy ──────────────────────────────────────
  const heading = `Welcome to the Neighborhood, ${firstname}!`
  const bodyText = `
    We are so happy to have you here. You are now officially
    part of The Neighborhood — a growing community of creative,
    kind, and curious people.
  `
  const ctaText = "Visit The Neighborhood"
  const ctaUrl = process.env.CORS_ORIGIN || "https://theneighborr.com"
  const signOff = "With love,"
  const signOffName = "The Neighbor Team"
  // ── End editable copy ──────────────────────────────────

  // ── Font URLs (hosted on Supabase Storage) ─────────────
  const FONT_DAVINCI = "https://wtifsgubcdnvwxwfqxuh.supabase.co/storage/v1/object/public/frontend/fonts/davinci"
  const FONT_GEIST   = "https://wtifsgubcdnvwxwfqxuh.supabase.co/storage/v1/object/public/frontend/fonts/geist-mono-regular"

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <style>
    /* Custom fonts loaded from Supabase Storage (woff2).
       Supported: Apple Mail, iOS Mail, Samsung Mail, Thunderbird.
       Gmail & Outlook strip @font-face and fall back to the
       web-safe fonts in each font-family stack. */
    @font-face {
      font-family: 'DaVinci';
      src: url('${FONT_DAVINCI}') format('woff2');
      font-weight: normal;
      font-style: normal;
    }
    @font-face {
      font-family: 'GeistMono';
      src: url('${FONT_GEIST}') format('woff2');
      font-weight: normal;
      font-style: normal;
    }
  </style>
</head>
<body style="margin:0;padding:0;background-color:#FBF5F2;font-family:'GeistMono','Courier New',Courier,monospace;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#FBF5F2;padding:40px 0;">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background-color:#FFFFFF;border:1.5px solid rgba(0,0,0,0.08);border-radius:20px;overflow:hidden;">
        <!-- Header band -->
        <tr><td style="background-color:#FFE0E0;padding:32px 40px;text-align:center;">
          <h1 style="margin:0;font-size:26px;line-height:32px;color:#1a1a1a;font-family:'DaVinci',Georgia,'Times New Roman',serif;">
            ${heading}
          </h1>
        </td></tr>
        <!-- Body -->
        <tr><td style="padding:32px 40px;">
          <p style="margin:0 0 20px;font-size:16px;line-height:26px;color:#3a3a3a;font-family:'GeistMono','Courier New',Courier,monospace;">
            ${bodyText.trim()}
          </p>
          <!-- CTA button -->
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;">
            <tr><td style="background-color:#FFE0E0;border:1.5px solid #1a1a1a;border-radius:12px;padding:12px 32px;text-align:center;">
              <a href="${ctaUrl}" style="font-size:15px;color:#1a1a1a;text-decoration:none;font-family:'GeistMono','Courier New',Courier,monospace;">
                ${ctaText}
              </a>
            </td></tr>
          </table>
          <!-- Sign-off -->
          <p style="margin:28px 0 0;font-size:15px;line-height:24px;color:#6a6a6a;font-family:'GeistMono','Courier New',Courier,monospace;">
            ${signOff}<br/><strong style="color:#1a1a1a;">${signOffName}</strong>
          </p>
        </td></tr>
        <!-- Footer -->
        <tr><td style="padding:16px 40px;text-align:center;border-top:1px solid rgba(0,0,0,0.06);">
          <p style="margin:0;font-size:11px;color:rgba(0,0,0,0.35);font-family:'GeistMono','Courier New',Courier,monospace;">
            You received this email because you signed up for The Neighborhood.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`
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

    // Check for duplicate email before proceeding
    const { data: existingMember, error: checkError } = await supabase
      .from("community_members")
      .select("email")
      .eq("email", email)
      .limit(1)

    if (checkError) {
      console.error("Email duplicate check failed:", checkError.message)
      return res.status(500).json({ error: "Database error during email check" })
    }

    if (existingMember && existingMember.length > 0) {
      console.log("Duplicate email rejected:", email)
      return res.status(409).json({ error: "This email is already registered" })
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
          size: "1024x1536",
          background: "transparent",
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

    /**
     * ============================
     * SEND WELCOME EMAIL
     * ============================
     *
     * Non-fatal: if the email fails, we log the error but
     * still return a successful response to the frontend.
     * The user is already registered at this point.
     */

    try {
      const { error: emailError } = await resend.emails.send({
        from: EMAIL_FROM,
        to: email,
        subject: "Welcome to The Neighborhood!",
        html: getWelcomeEmailHtml(firstname),
      })

      if (emailError) {
        console.error("Welcome email failed:", emailError.message)
      } else {
        console.log("Welcome email sent:", { email })
      }
    } catch (emailErr) {
      console.error("Welcome email error:", emailErr.message)
    }

    const imageStatus = imageUrl
      ? "success"
      : req.file
        ? "failed"
        : "none"

    /**
     * ============================
     * Send imageURL back to front-end
     * ============================
     */

    res.json({
      ok: true,
      image: {
        status: imageStatus,
        url: imageUrl || null,
      },
    })

  } catch (err) {
    console.error("Request failed:", err)
    res.status(500).json({
      error:'server error while processing submission',
    })
  }
})

/**
 * ======================================================
 * GET /check-email
 * ======================================================
 *
 * Checks whether an email is already registered.
 *
 * Request: ?email=user@example.com (query parameter)
 * Response:
 *   200 { exists: true }  — email already registered
 *   200 { exists: false } — email available
 *   400 { error: "..." }  — missing parameter
 */

app.get("/check-email", async (req, res) => {
  try {
    const email = req.query.email?.trim()?.toLowerCase()

    if (!email) {
      return res.status(400).json({ error: "Email query parameter is required" })
    }

    console.log("Checking email:", email)

    const { data, error } = await supabase
      .from("community_members")
      .select("email")
      .eq("email", email)
      .limit(1)

    if (error) {
      console.error("Email check query failed:", error.message)
      return res.status(500).json({ error: "Database error" })
    }

    const exists = data && data.length > 0

    console.log("Email check result:", { email, exists })

    res.json({ exists })
  } catch (err) {
    console.error("Email check failed:", err.message)
    res.status(500).json({ error: "Server error" })
  }
})

/**
 * ======================================================
 * POST /delete-member
 * ======================================================
 *
 * Removes a community member by email.
 */

app.post("/delete-member", async (req, res) => {
  try {
    const email = req.body.email?.trim()?.toLowerCase()

    if (!email) {
      return res.status(400).json({ error: "Email is required" })
    }

    console.log("Deleting member:", email)

    const { data, error } = await supabase
      .from("community_members")
      .delete()
      .eq("email", email)

    if (error) {
      console.error("Delete member failed:", error.message)
      return res.status(500).json({ error: "Database error" })
    }

    if (!data || data.length === 0) {
      console.log("No member found to delete for", email)
      return res.status(404).json({ error: "Member not found" })
    }

    console.log("Member deleted:", email)
    res.json({ ok: true })
  } catch (err) {
    console.error("Delete member endpoint failed:", err.message)
    res.status(500).json({ error: "Server error" })
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
