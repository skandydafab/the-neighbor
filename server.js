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
 *      - converts the result to WebP via sharp (smaller file, faster loads)
 *      - uploads the WebP to Supabase Storage
 * 3. Stores name, email, and image URL in Supabase Database
 * 4. Sends a branded welcome email to the new member via Resend
 *    - if the member uploaded a photo, their baby token appears in the email
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
 * - Requires two env vars: RESEND_API_KEY and EMAIL_FROM.
 * - Free tier: 100 emails/day, 3,000/month.
 * - Custom sending domain must be verified in the Resend
 *   dashboard (DNS records: SPF, DKIM, and a TXT verification).
 *
 * IMAGE OPTIMISATION (SHARP + PUBLIC URL)
 * ----------------------------------------
 * The OpenAI PNG is converted to WebP (quality 85) via sharp before upload.
 * We then expose the raw public URL of the WebP file so the link ends in
 * `.webp` with no Supabase render/query-string extras.

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
const { Resend } = require("resend")        // Transactional email
const sharp = require("sharp")              // Image conversion & resizing (WebP)

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
 * IMAGE OPTIMISATION
 * ============================
 *
 * sharp converts the OpenAI PNG into WebP (quality 85) before upload.
 */

const WEBP_QUALITY = 85

/**
 * ============================
 * HELPER: getPublicWebpUrl
 * ============================
 *
 * Returns the plain Supabase public URL for the uploaded `.webp` file.
 * There is no `/render/image/` segment or query string — the link ends
 * directly with `.webp`.
 *
 * @param {string} filePath  - path inside the bucket, e.g. "community/123-john-doe.webp"
 * @returns {string}         - public URL
 */

function getTransformedUrl(filePath) {
  const { data } = supabase.storage
    .from("neighbors")
    .getPublicUrl(filePath)
  return data.publicUrl
}

/**
 * ============================
 * IMAGE GENERATION PROMPT
 * ============================
 */

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
`
  } else {
    console.log(activity + " activity being played and fed to GPT")

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
`
  }
}

/**
 * ============================
 * WELCOME EMAIL TEMPLATE
 * ============================
 *
 * Sends a branded welcome email after successful sign-up.
 *
 * @param {string}      firstname  — the new member's first name
 * @param {string|null} imageUrl   — public URL of the AI-generated baby token,
 *                                   or null if the user did not upload a selfie.
 *                                   When provided, the baby token is rendered
 *                                   between the two body paragraphs at 68px wide.
 */

function getWelcomeEmailHtml(firstname, imageUrl = null) {

  const FONT_DAVINCI = "https://wtifsgubcdnvwxwfqxuh.supabase.co/storage/v1/object/public/frontend/fonts/davinci"
  const FONT_GEIST   = "https://wtifsgubcdnvwxwfqxuh.supabase.co/storage/v1/object/public/frontend/fonts/geist-mono-regular"
  const ctaUrl       = process.env.CORS_ORIGIN || "https://theneighborr.com"

  // Rendered only when the user generated a baby token
  const babyTokenBlock = imageUrl
    ? `<img
        src="${imageUrl}"
        alt="Your Baby Token"
        width="68"
        style="
          display: block;
          width: 68px;
          height: auto;
          background: transparent;
          margin: 0 0 22px 0;
        "
      />`
    : ""

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Welcome to The Neighbor Magazine!</title>
  <style>
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

    /* =============================================
       PADDING CONTROL — edit this one value only
       ============================================= */
    :root {
      --email-padding: 32px;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    html, body {
      width: 100%;
      height: 100%;
      background-color: #FFFFF2;
      font-family: 'GeistMono', 'Courier New', Courier, monospace;
      -webkit-text-size-adjust: 100%;
      -ms-text-size-adjust: 100%;
    }

    .email-outer {
      width: 100%;
      background-color: #FFFFF2;
      padding: var(--email-padding);
    }

    .wrapper {
      max-width: 560px;
    }

    .greeting {
      font-family: 'DaVinci', Georgia, 'Times New Roman', serif;
      font-size: 28px;
      line-height: 1.25;
      color: #1a1a1a;
      font-weight: normal;
      margin-bottom: 28px;
    }

    .body-text {
      font-family: 'GeistMono', 'Courier New', Courier, monospace;
      font-size: 14px;
      line-height: 1.80;
      color: #3a3a3a;
      margin-bottom: 22px;
    }

    .cta {
      display: inline-block;
      margin: 8px 0 16px;
      font-family: 'GeistMono', 'Courier New', Courier, monospace;
      font-size: 13px;
      color: #1a1a1a;
      text-decoration: underline;
      letter-spacing: 0.04em;
    }

    .footer {
      margin-top: 20px;
      padding-top: 20px;
      border-top: 1px solid rgba(0,0,0,0.5);
    }

    .footer-legal {
      font-family: 'GeistMono', 'Courier New', Courier, monospace;
      font-size: 10px;
      color: black;
    }

    @media only screen and (max-width: 480px) {
      .greeting { font-size: 23px; }
      .body-text { font-size: 13px; }
    }
  </style>
</head>
<body>
  <div class="email-outer">
    <div class="wrapper">

      <h1 class="greeting">Welcome to the Neighbor Magazine, ${firstname} !</h1>

      <p class="body-text">
        We are so happy to have you here. You are now officially part of
        The Neighborhood, a growing community of creative and
        curious people. We hope you will enjoy our collection.
      </p>

      ${babyTokenBlock}

      <p class="body-text">
        Every once in a while, you will receive our newsletter
        from the playground, The Local Lunatic, so keep an eye
        on your inbox. You can say hello to your new friends here:
      </p>

      <a href="${ctaUrl}" class="cta">
        Visit The Neighborhood
      </a>

      <p class="body-text">
        With love,<br>Ska &amp; Paul
      </p>

      <div class="footer">
        <p class="footer-legal">
          You received this because you signed up for The Neighborhood.
        </p>
      </div>

    </div>
  </div>
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
 *    - Convert PNG buffer to WebP via sharp
 *    - Upload WebP to Supabase Storage
 *    - Return a Supabase transform URL (resized on CDN, cached)
 * 3. Save user record to Supabase Database
 * 4. Send welcome email — includes baby token image if one was generated
 */

app.post("/submitMember", upload.single("image"), async (req, res) => {
  try {
    console.log("----- NEW SUBMISSION -----")

    const firstname = req.body.firstname?.trim()
    const lastname  = req.body.lastname?.trim()
    const email     = req.body.email?.trim()
    const location  = req.body.location?.trim() || null
    const activity  = req.body.activity?.trim() || null

    if (!firstname || !lastname || !email) {
      console.log("Validation failed: missing firstname, lastname, or email")
      return res.status(400).json({ error: "Missing firstname, lastname, or email" })
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

    console.log("Incoming Neighbor:", { firstname, lastname, email, location, activity })

    let imageUrl         = null
    let originalImageUrl = null

    /**
     * ============================
     * IMAGE PROCESSING (OPTIONAL)
     * ============================
     */

    if (req.file) {
      console.log("Image received:", {
        filename: req.file.originalname,
        type:     req.file.mimetype,
        size:     req.file.size,
      })

      try {
        /**
         * ============================
         * STORE ORIGINAL IMAGE
         * ============================
         *
         * Store the raw upload in original_image_url/ as a permanent
         * backup before we do any processing.
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
          console.error("Original image upload failed:", originalUploadError.message)
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
          model:      process.env.OPENAI_IMAGE_MODEL,
          image:      openaiFile,
          prompt:     PROMPT,
          size:       "1024x1536",
          background: "transparent",
        })

        console.log("OpenAI image generation completed")

        const base64 = result.data?.[0]?.b64_json
        if (!base64) {
          throw new Error("OpenAI returned no image data")
        }

        // OpenAI returns a PNG buffer. Convert it to WebP before uploading.
        // This reduces file size by ~60-80%, meaning faster loads and less egress.
        const pngBuffer = Buffer.from(base64, "base64")
        console.log("Converting OpenAI PNG to WebP via sharp...")
        const webpBuffer = await sharp(pngBuffer)
          .webp({ quality: WEBP_QUALITY })
          .toBuffer()
        console.log(`WebP conversion complete — PNG: ${pngBuffer.length} bytes → WebP: ${webpBuffer.length} bytes`)

        // File is now .webp — use that extension so Content-Type is correct
        const filePath = `community/${Date.now()}-${safeNameSlug}.webp`

        console.log("Uploading WebP image to Supabase:", filePath)

        const { error: uploadError } = await supabase.storage
          .from("neighbors")
          .upload(filePath, webpBuffer, {
            contentType:  "image/webp",
            // Cache this image at the CDN edge for 1 year.
            // Community member images never change after upload, so this is safe.
            cacheControl: "31536000",
          })

        if (uploadError) {
          throw uploadError
        }

        // Return a Supabase Image Transform URL — 200px wide, height auto-scales.
        // Supabase resizes on the first request then serves from CDN cache forever.
        imageUrl = getTransformedUrl(filePath)

        console.log("Image successfully stored and transform URL generated:", imageUrl)

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
      .insert([{
        firstname,
        lastname,
        email,
        location,
        activity,
        image_url:          imageUrl,
        original_image_url: originalImageUrl,
      }])

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
     *
     * imageUrl is passed so the baby token appears in the email
     * when the member uploaded a photo. If no photo was uploaded,
     * imageUrl is null and the token block is simply omitted.
     */

    try {
      const { error: emailError } = await resend.emails.send({
        from:    EMAIL_FROM,
        to:      email,
        subject: "Welcome to The Neighborhood!",
        html:    getWelcomeEmailHtml(firstname, imageUrl),
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
        url:    imageUrl || null,
      },
    })

  } catch (err) {
    console.error("Request failed:", err)
    res.status(500).json({ error: "server error while processing submission" })
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
