/**
 * =========================================================
 * migrate-images-to-webp.js — ONE-OFF BACKFILL SCRIPT
 * =========================================================
 *
 * PURPOSE
 * -------
 * Converts all existing community member images from PNG to WebP,
 * re-uploads them to Supabase Storage, and updates the image_url
 * in the database to point to the new Supabase transform URL.
 *
 * This is a one-time migration. After running it, all members —
 * old and new — will have fast-loading optimised image URLs.
 *
 * HOW TO RUN
 * ----------
 * 1. Make sure your .env file is present and correct in the same
 *    folder as this script. It needs:
 *      SUPABASE_URL=your_supabase_url
 *      SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
 * 2. From your project root, run:
 *
 *      node migrate-images-to-webp.js
 *
 * 3. Watch the logs. Each member is processed one at a time.
 *    If one fails it is skipped and logged — it will NOT crash
 *    the whole migration.
 *
 * SAFETY
 * ------
 * - Original PNG files in Supabase Storage are NOT deleted.
 *   They stay in the "community/" folder as a backup.
 * - The new WebP files are uploaded alongside them with a
 *   "-migrated" suffix so there is no risk of collision.
 * - Only rows where image_url contains "/object/public/neighbors/"
 *   and does NOT already end in .webp are processed.
 *   Running this script twice is safe — already-migrated rows
 *   are skipped automatically.
 *
 * AFTER RUNNING
 * -------------
 * You can optionally delete the old PNG files from Supabase
 * Storage manually via the dashboard once you've confirmed
 * everything looks correct. There's no rush — they won't be
 * served to users anymore once the DB URLs are updated.
 */

require("dotenv").config()

const { createClient } = require("@supabase/supabase-js")
const sharp = require("sharp")

/**
 * ============================
 * CONFIG
 * ============================
 *
 * TRANSFORM_W : the width in px that Supabase will serve to your site.
 *               Height is intentionally omitted so Supabase scales it
 *               automatically, preserving the original aspect ratio.
 * TRANSFORM_Q : WebP quality for the transformed output (1–100).
 *               80 is a good balance between quality and file size.
 * WEBP_QUALITY: WebP quality for the file that gets stored in Supabase.
 *               85 keeps the stored master looking sharp.
 */

const TRANSFORM_W = 200   // serve at 200px wide, height auto-scales
const TRANSFORM_Q = 80    // quality of the CDN-served transformed image
const WEBP_QUALITY = 85   // quality of the WebP file stored in Supabase

/**
 * ============================
 * SUPABASE CLIENT
 * ============================
 */

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

/**
 * ============================
 * HELPER: getTransformedUrl
 * ============================
 *
 * Generates a Supabase Image Transform URL for a given file path.
 * Only width is passed — no height — so Supabase scales proportionally.
 * Supabase generates and caches each unique size automatically on first
 * request; every subsequent request is served instantly from CDN.
 *
 * @param {string} filePath  - path inside the bucket, e.g. "community/123-john-doe-migrated.webp"
 * @returns {string}         - transformed public URL
 */

function getTransformedUrl(filePath) {
  const { data } = supabase.storage
    .from("neighbors")
    .getPublicUrl(filePath)
  return data.publicUrl
}

/**
 * ============================
 * HELPER: extractFilePath
 * ============================
 *
 * Extracts the storage path from a full Supabase public URL.
 *
 * Example input:
 *   https://xxx.supabase.co/storage/v1/object/public/neighbors/community/123-john.png
 * Example output:
 *   community/123-john.png
 */

function extractFilePath(publicUrl) {
  // Split on the bucket name "neighbors/" to isolate the path within the bucket
  const marker = "/object/public/neighbors/"
  const idx = publicUrl.indexOf(marker)
  if (idx === -1) return null
  // Also strip any query string (e.g. transform params) from the path
  return publicUrl.slice(idx + marker.length).split("?")[0]
}

/**
 * ============================
 * MAIN MIGRATION
 * ============================
 */

async function migrate() {
  console.log("========================================")
  console.log("  IMAGE MIGRATION: PNG → WebP")
  console.log("========================================\n")

  // Fetch all members that have an image_url
  const { data: members, error } = await supabase
    .from("community_members")
    .select("email, firstname, lastname, image_url")
    .not("image_url", "is", null)

  if (error) {
    console.error("Failed to fetch members:", error.message)
    process.exit(1)
  }

  // Filter to only rows that still point to a raw PNG (not already migrated).
  // Transformed URLs contain "/render/image/" — raw uploads contain "/object/public/".
  // We check for .webp in the URL to skip any already converted rows.
  const toMigrate = members.filter((m) => {
    const url = m.image_url || ""
    return (
      url.includes("/object/public/neighbors/") &&
      !url.includes(".webp")
    )
  })

  console.log(`Total members with images : ${members.length}`)
  console.log(`Already migrated (skipped): ${members.length - toMigrate.length}`)
  console.log(`To migrate now            : ${toMigrate.length}\n`)

  if (toMigrate.length === 0) {
    console.log("Nothing to do — all images are already migrated.")
    process.exit(0)
  }

  let success = 0
  let failed = 0

  for (const member of toMigrate) {
    const label = `${member.firstname} ${member.lastname} (${member.email})`
    console.log(`→ Processing: ${label}`)

    try {
      // ── Step 1: Download the existing PNG from Supabase Storage ──
      const pngFilePath = extractFilePath(member.image_url)
      if (!pngFilePath) {
        console.warn(`  ⚠ Could not extract file path from URL, skipping: ${member.image_url}`)
        failed++
        continue
      }

      console.log(`  Downloading: ${pngFilePath}`)

      const { data: fileData, error: downloadError } = await supabase.storage
        .from("neighbors")
        .download(pngFilePath)

      if (downloadError) {
        console.error(`  ✗ Download failed: ${downloadError.message}`)
        failed++
        continue
      }

      // Supabase returns a Blob — convert to Node.js Buffer for sharp
      const arrayBuffer = await fileData.arrayBuffer()
      const pngBuffer = Buffer.from(arrayBuffer)

      // ── Step 2: Convert PNG → WebP via sharp ──
      console.log(`  Converting to WebP (quality: ${WEBP_QUALITY})...`)
      const webpBuffer = await sharp(pngBuffer)
        .webp({ quality: WEBP_QUALITY })
        .toBuffer()

      console.log(`  PNG: ${pngBuffer.length} bytes → WebP: ${webpBuffer.length} bytes`)

      // ── Step 3: Upload the new WebP to Supabase Storage ──
      // Placed in the same "community/" folder with a "-migrated" suffix.
      // This ensures no collision with the original PNG file.
      const webpFilePath = pngFilePath
        .replace(/\/([^/]+)$/, (_, filename) => {
          const base = filename.replace(/\.[^.]+$/, "") // strip extension
          return `/${base}-migrated.webp`
        })

      console.log(`  Uploading WebP to: ${webpFilePath}`)

      const { error: uploadError } = await supabase.storage
        .from("neighbors")
        .upload(webpFilePath, webpBuffer, {
          contentType: "image/webp",
          cacheControl: "31536000", // 1 year — these images never change
          upsert: false,            // don't accidentally overwrite anything
        })

      if (uploadError) {
        console.error(`  ✗ Upload failed: ${uploadError.message}`)
        failed++
        continue
      }

      // ── Step 4: Generate the 200px-wide transform URL for the new WebP ──
      // This is what gets saved to the DB and served to your website.
      // Supabase serves 200px wide, height auto-scales to preserve aspect ratio.
      const newImageUrl = getTransformedUrl(webpFilePath)

      // ── Step 5: Update the image_url in community_members for this member ──
      // Matched by email to ensure the right row is updated.
      console.log(`  Updating DB image_url for ${member.email}...`)

      const { error: updateError } = await supabase
        .from("community_members")
        .update({ image_url: newImageUrl })
        .eq("email", member.email)

      if (updateError) {
        console.error(`  ✗ DB update failed: ${updateError.message}`)
        failed++
        continue
      }

      console.log(`  ✓ Done — new URL: ${newImageUrl}`)
      success++

    } catch (err) {
      // Catch-all so one bad row never stops the whole migration
      console.error(`  ✗ Unexpected error for ${label}: ${err.message}`)
      failed++
    }

    console.log("") // blank line between members for readability
  }

  // ── Final summary ──
  console.log("========================================")
  console.log("  MIGRATION COMPLETE")
  console.log("========================================")
  console.log(`  ✓ Succeeded : ${success}`)
  console.log(`  ✗ Failed    : ${failed}`)
  console.log("")

  if (failed > 0) {
    console.log("Some rows failed — check the logs above.")
    console.log("Re-running the script is safe: failed rows will be retried,")
    console.log("already-migrated rows will be skipped automatically.\n")
  } else {
    console.log("All done! You can optionally delete the old PNG files from")
    console.log("Supabase Storage > neighbors > community/ once you've verified")
    console.log("the new images look correct on your site.\n")
  }
}

migrate()
