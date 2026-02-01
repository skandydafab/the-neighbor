// Import dependencies
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const OpenAI = require("openai");
const { toFile } = require("openai");
const { createClient } = require("@supabase/supabase-js");

// Initialize server
const app = express();

// Set up middlewares
app.use(express.json());
app.use(cors({origin: process.env.CORS_ORIGIN}));
const upload = multer();

// Load .env variables 
require("dotenv").config();

// Set up clients
const openai = new OpenAI({apiKey: process.env.OPENAI_API_KEY});
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Prompt function 
function getPrompt(activity) {
  if (!activity) {
    return "Using the provided photo as reference, create an original baby character for the comic strip \
  'Peanuts'. They are standing up, the background is white, and they should not have facial hair.";
  } else {
    return `Using the provided photo as reference, create an original baby character for the comic strip 'Peanuts'. They are \
  standing up, the background is white, and they should not have facial hair. They are doing the following activity: ${activity}.`;
  }
}

/* -- Set up POST /submitMember endpoint -- */
app.post("/submitMember", upload.single("image"), async (req, res) => {
  try {
    console.log("----- NEW SUBMISSION -----");

    // ---------------------------------
    // Step 1. Get name, email, location
    const name = req.body.name?.trim();
    const email = req.body.email?.trim();
    const location = req.body.location?.trim();
    console.log("Incoming Neighbor:", {name, email, location});

    // ----------------------
    // Step 2. Get baby token
    let imageStatus = "none";
    let imageUrl = null;

    if (req.file) {
      imageStatus = "processing";

      // Log start
      console.log("Image received:", {
        type: req.file.mimetype, 
        size: req.file.size,
      });

      try {
        // -------------------------------------------------------
        /* -- Image Request 1: Convert Buffer to OpenAI file -- */
        const openaiFile = await toFile(
          req.file.buffer,
          req.file.originalname || "upload.png",
          { type: req.file.mimetype }
        );
        // ----------------------------------------------------
        /* -- Image Request 2: Get baby token from OpenAI -- */
        const activity = req.body.activity?.trim();
        const PROMPT = getPrompt(activity);

        // Log Start 
        console.log("Sending input to OpenAI.");

        const result = await openai.images.edit({
          model: process.env.OPENAI_IMAGE_MODEL,
          image: openaiFile,
          prompt: PROMPT,
          size: "1024x1024",
          background: "transparent",
        });

        // Log End 
        console.log("Output received from OpenAI.");

        // -------------------------------------------------
        /* -- Image Request 3: Store image in Supabase -- */ 
        
        const base64 = result.data?.[0]?.b64_json;
        
        if (!base64) {
          throw new Error(
            "OpenAI returned no image data."
          );
        }

        // Get buffer from OpenAI 
        const buffer = Buffer.from(base64, "base64");

        // Create the filePath 
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        const id = Math.random().toString(36).slice(2, 6);
        const filePath = `community/${slug}-${id}.png`;

        // Log start 
        console.log("Uploading image in storage:", filePath);

        const { error: uploadError } = await supabase.storage
          .from("neighbors").upload(filePath, buffer, {contentType: "image/png"});

        if (uploadError) {
          throw uploadError
        }
        
        // Get imageUrl 
        const { data } = supabase.storage
          .from("neighbors").getPublicUrl(filePath);

        imageUrl = data.publicUrl;
        imageStatus = "ready";

        // Log end 
        console.log("Image successfully stored:", imageUrl);

      } catch (imageError) {
        console.error("Image processing failed:", imageError.message);
        imageStatus = "failed";
        imageUrl = null;
      }

    } else {
      console.log("No image uploaded.");
    }

    // -------------------------------------
    // Step 3. Insert neighbor profile in DB 
    console.log("Inserting neighbor in DB.");

    const { error: dbError } = await supabase.from("community_members")
      .insert([{ name, email, image_url: imageUrl }]);

    if (dbError) {throw dbError}

    console.log("User saved successfully");

    // -------------------------------
    // Step 4. Respond to the frontend 
    res.json({
      ok: true,
      image: {
        status: imageStatus,
        url: imageUrl,
      }
    });

  } catch (err) {
    console.error("[/submitMember]", err.message);
    res.status(500).json({error:'Internal Server Error.'});
  }
})

/* -- Set up GET /community endpoint -- */
app.get("/community", async (req, res) => {
  const { data, error } = await supabase
    .from("community_members")
    .select("name,email,image_url,created_at")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Failed to fetch community:", error);
    return res.status(500).json({ error: error.message });
  }
  res.json(data);
})

/* -- Set up GET /health endpoint -- */
app.get("/health", (_, res) => {res.json({ ok: true })});

/* -- Start Server -- */
app.listen(process.env.PORT, () => {
  console.log(`Server running on port ${process.env.PORT}`);
});
