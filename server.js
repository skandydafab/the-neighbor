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
 *      - also uploads a #FFFFF2-background PNG to Supabase for use in email
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
 * IMAGE PIPELINE
 * ----------------------------------------
 * Three versions of every image are produced and stored:
 *
 *   1. original_image_url/  — raw user upload (backup, never touched again)
 *   2. community/           — WebP (quality 85) — used on the website
 *   3. email/               — PNG flattened onto #FFFFF2 — used in the email
 *
 * Email clients (Gmail, Outlook, Apple Mail) do not support transparency.
 * Transparent pixels are rendered as black or stripped entirely. The only
 * reliable fix is to flatten the alpha channel onto a solid colour before
 * the image is used in email.
 *
 * We flatten onto #FFFFF2 (r:255, g:255, b:242) — the same colour as the
 * email card background — so the image blends in seamlessly with no visible
 * box or border around it.
 *
 * The email version is uploaded to Supabase as a real public URL — NOT
 * embedded as a base64 data URI. Many email clients silently drop inline
 * base64 images above ~100 KB. Hosting the image as a URL has no such limit.
 *
 * SUPABASE STORAGE REQUIREMENTS
 * ----------------------------------------
 * The `neighbors` bucket must have three publicly readable folders:
 *   - original_image_url/
 *   - community/
 *   - email/              ← required for email images to load
 *
 * To make the email/ folder public in Supabase:
 *   SQL Editor → New query → run:
 *
 *   CREATE POLICY "Public read email folder"
 *   ON storage.objects
 *   FOR SELECT
 *   TO anon
 *   USING (
 *     bucket_id = 'neighbors'
 *     AND (storage.foldername(name))[1] = 'email'
 *   );
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
const express          = require("express")          // Web server framework
const multer           = require("multer")           // Handles file uploads
const cors             = require("cors")             // Cross-origin requests
const OpenAI           = require("openai")           // OpenAI API client
const { toFile }       = require("openai")           // Converts buffers to files
const { createClient } = require("@supabase/supabase-js") // Supabase client
const { Resend }       = require("resend")           // Transactional email
const sharp            = require("sharp")            // Image conversion & resizing (WebP)

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
const resend     = new Resend(process.env.RESEND_API_KEY)
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
 * EMAIL FLATTEN BACKGROUND
 * ============================
 *
 * The background colour used when flattening the transparent baby token PNG
 * for email. Must exactly match the email card background (#FFFFF2) so the
 * image blends in seamlessly — no white box, no visible border.
 *
 * #FFFFF2 = rgb(255, 255, 242)
 */
const EMAIL_FLATTEN_BG = { r: 255, g: 255, b: 242 }

/**
 * ============================
 * HELPER: getPublicUrl
 * ============================
 *
 * Returns the plain Supabase public URL for any uploaded file.
 * There is no `/render/image/` segment or query string.
 *
 * @param {string} filePath  - path inside the bucket, e.g. "community/123-john-doe.webp"
 * @returns {string}         - public URL
 */
function getPublicUrl(filePath) {
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

The character is clearly doing this activity: ${activity}

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
 * DESIGN NOTES:
 * - Outer background: #ffffff (white)
 * - Card background: #FFFFF2 (warm off-white) — matches the flattened image bg
 * - Title font: Playfair Display (serif, imported via Google Fonts)
 * - Body font: Roboto (sans-serif, imported via Google Fonts)
 * - No decorative dividers or coloured header bands
 * - All content centred
 * - Baby token image blends seamlessly — no visible box because the image
 *   flatten bg (#FFFFF2) matches the card bg (#FFFFF2) exactly
 * - CTA is a clean dark pill button, centred
 *
 * @param {string}      firstname  — the new member's first name
 * @param {string|null} imageSrc   — Public URL of the #FFFFF2-background PNG.
 *                                   Must be a real https:// URL — NOT a data URI.
 *                                   When absent, the token block is omitted.
 */
function getWelcomeEmailHtml(firstname, imageSrc = null) {
  const heading      = `Welcome to the Neighborhood, ${firstname}!`
  const bodyText     = `We are so happy to have you here. You are now officially part of The Neighborhood — a growing community of creative, kind, and curious people.`
  const bodyContinue = `Every once in a while, you will receive our newsletter from the playground, The Local Lunatic, so keep an eye on your inbox. Say hello to your new friends here:`
  const ctaText      = "Visit The Neighborhood"
  const ctaUrl       = "https://theneighborr.com/neighborhood/en"
  const signOff      = "With love,"
  const signOffName  = "The Neighbor Team"

  const babyTokenSection = imageSrc
    ? `<tr>
        <td align="center" style="padding: 12px 48px 36px;">
          <p style="margin: 0 0 16px; font-size: 12px; line-height: 20px; color: #aaaaaa; font-family: 'Roboto', sans-serif; text-align: center; letter-spacing: 0.1em; text-transform: uppercase; font-weight: 500;">Your baby token</p>
          <img src="${imageSrc}" alt="Your baby token" width="220" style="width: 220px; height: auto; display: block; margin: 0 auto;" />
        </td>
      </tr>`
    : ""

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Welcome to the Neighborhood!</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&family=Roboto:wght@400;500&display=swap');
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: #ffffff; font-family: 'Roboto', 'Helvetica Neue', sans-serif; color: #1a1a1a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #ffffff; padding: 48px 16px;">
    <tr>
      <td align="center">

        <!-- Outer card — background #FFFFF2, light border -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 580px; background: #FFFFF2; border-radius: 20px; border: 1px solid #e8e8d8; overflow: hidden;">

          <!-- Top padding -->
          <tr><td style="height: 52px; font-size: 0; line-height: 0;">&nbsp;</td></tr>

          <!-- Heading -->
          <tr>
            <td align="center" style="padding: 0 48px 28px;">
              <h1 style="margin: 0; font-family: 'Playfair Display', Georgia, serif; font-size: 30px; line-height: 40px; font-weight: 700; color: #1a1a1a; text-align: center;">${heading}</h1>
            </td>
          </tr>

          <!-- Body text -->
          <tr>
            <td align="center" style="padding: 0 52px ${imageSrc ? "32px" : "28px"};">
              <p style="margin: 0; font-size: 16px; line-height: 28px; color: #555555; font-family: 'Roboto', sans-serif; text-align: center;">${bodyText}</p>
            </td>
          </tr>

          <!-- Baby token (conditional).
               No border-radius or background on the img tag — the image
               is already flattened onto #FFFFF2 so it blends into the card. -->
          ${babyTokenSection}

          <!-- Body continuation -->
          <tr>
            <td align="center" style="padding: 0 52px 32px;">
              <p style="margin: 0; font-size: 15px; line-height: 26px; color: #555555; font-family: 'Roboto', sans-serif; text-align: center;">${bodyContinue}</p>
            </td>
          </tr>

          <!-- CTA button -->
          <tr>
            <td align="center" style="padding: 0 48px 40px;">
              <a href="${ctaUrl}" style="display: inline-block; font-family: 'Roboto', sans-serif; font-size: 14px; font-weight: 500; letter-spacing: 0.06em; color: #FFFFF2; background-color: #1a1a1a; text-decoration: none; padding: 14px 32px; border-radius: 100px;">${ctaText}</a>
            </td>
          </tr>

          <!-- Sign off -->
          <tr>
            <td align="center" style="padding: 0 48px 48px;">
              <p style="margin: 0; font-size: 15px; line-height: 26px; color: #555555; font-family: 'Roboto', sans-serif; text-align: center;">
                ${signOff}<br />
                <span style="font-weight: 500; color: #1a1a1a;">${signOffName}</span>
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding: 20px 48px; border-top: 1px solid #e8e8d8; font-size: 11px; line-height: 18px; color: #bbbbaa; font-family: 'Roboto', sans-serif; text-align: center;">
              You received this email because you signed up for The Neighborhood.
            </td>
          </tr>

        </table>
        <!-- End card -->

      </td>
    </tr>
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
 *    - Convert PNG buffer to WebP via sharp → upload to community/
 *    - Flatten PNG onto #FFFFF2 background → upload to email/
 *    - Return the community/ WebP public URL for the database
 * 3. Save user record to Supabase Database
 * 4. Send welcome email — uses the email/ PNG URL if available
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

    let imageUrl             = null   // WebP URL stored in DB and shown on site
    let originalImageUrl     = null   // Raw upload backup
    let welcomeEmailImageSrc = null   // #FFFFF2-background PNG URL used in email

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
          originalImageUrl = getPublicUrl(originalFilePath)
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

        /**
         * ============================
         * UPLOAD EMAIL PNG
         * ============================
         *
         * Email clients do not render transparency — transparent pixels
         * are either shown as black or stripped entirely.
         *
         * Fix: use sharp's .flatten() to composite the alpha channel onto
         * EMAIL_FLATTEN_BG (#FFFFF2, rgb 255/255/242) before encoding as PNG.
         *
         * Critically, this colour exactly matches the email card background.
         * This means the image has no visible box or border around it —
         * it simply appears to float on the card.
         *
         * .flatten() is the correct sharp method — it merges the alpha
         * channel onto the colour. The .png({ background: ... }) option
         * only sets metadata and does NOT fill transparency.
         *
         * We upload this as a real public URL rather than embedding it as
         * a base64 data URI. Many email clients silently drop inline base64
         * images above ~100 KB. A hosted URL has no such size limit and
         * works reliably across Gmail, Outlook, and Apple Mail.
         *
         * This file lives in the email/ folder of the neighbors bucket.
         * That folder must have a public SELECT policy in Supabase Storage.
         * See deployment notes at the top of this file for the exact SQL.
         */

        console.log("Creating #FFFFF2-background PNG for email...")
        const emailPngBuffer = await sharp(webpBuffer)
          .flatten({ background: EMAIL_FLATTEN_BG })
          .png()
          .toBuffer()
        console.log(`Email PNG created — size: ${emailPngBuffer.length} bytes`)

        const emailFilePath = `email/${Date.now()}-${safeNameSlug}-email.png`
        console.log("Uploading email PNG to Supabase:", emailFilePath)

        const { error: emailUploadError } = await supabase.storage
          .from("neighbors")
          .upload(emailFilePath, emailPngBuffer, {
            contentType:  "image/png",
            cacheControl: "31536000",
          })

        if (emailUploadError) {
          // Non-fatal: email will send without image rather than crashing
          console.error("Email PNG upload failed:", emailUploadError.message)
        } else {
          welcomeEmailImageSrc = getPublicUrl(emailFilePath)
          console.log("Email PNG ready at:", welcomeEmailImageSrc)
        }

        /**
         * ============================
         * UPLOAD WEBSITE WEBP
         * ============================
         *
         * The website version stays as WebP with full transparency intact.
         * Browsers handle alpha channels correctly — no flattening needed here.
         */

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

        imageUrl = getPublicUrl(filePath)

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
     * welcomeEmailImageSrc is the hosted #FFFFF2-background PNG URL.
     * If the email upload failed, we pass null so the token block
     * is cleanly omitted rather than showing a broken image.
     * If no photo was uploaded at all, the block is also omitted.
     */

    try {
      const welcomeSubject = `Welcome to the Neighborhood, ${firstname}!`
      const emailImageSrc  = welcomeEmailImageSrc || null
      const { error: emailError } = await resend.emails.send({
        from:    EMAIL_FROM,
        to:      email,
        subject: welcomeSubject,
        html:    getWelcomeEmailHtml(firstname, emailImageSrc),
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
