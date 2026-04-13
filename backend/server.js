const express = require('express');
const { OAuth2Client } = require('google-auth-library');
const cors = require('cors');
const { google } = require("googleapis");

const app = express();
const path = require("path");
const fs = require("fs");
const axios = require("axios");

app.use(cors());
app.use(express.json());
app.use("/galleries", express.static(path.join(__dirname, "galleries")));

const CLIENT_ID = '971008334675-8vos5giv60opfnbaeh1oaqjljm121tel.apps.googleusercontent.com';


const oauth2Client = new OAuth2Client(CLIENT_ID);

app.post('/api/auth/google', async(req, res) => {
    const { token } = req.body;
    try {
        const ticket = await oauth2Client.verifyIdToken({
            idToken: token,
            audience: CLIENT_ID,
        });
        const payload = ticket.getPayload();
        const user = {
            name: payload.name,
            email: payload.email,
            picture: payload.picture,
        };

        console.log("User logged in: ", user);
        res.json({ 
            success: true,
            user: user
        });
    } catch (error) {
        console.error("Error verifying Google ID token: ", error);
        res.status(401).json({
            success: false,
            message: "Unauthorized"
        });
    }
});



app.post("/api/save-metadata", (req, res) => {

    const newPhotos = req.body;
    metadataFile = "./photos.json";
  
    let existingPhotos = [];
  
    // 🔹 Read existing metadata if file exists
    if (fs.existsSync(metadataFile)) {
      const data = fs.readFileSync(metadataFile, "utf8");
      existingPhotos = JSON.parse(data);
    }
    
  
    // 🔹 Append new metadata
    const updatedPhotos = [...existingPhotos, ...newPhotos];

    console.log("existingPhotos", existingPhotos);
    console.log("newPhotos", newPhotos);
    console.log("updatedPhotos", updatedPhotos);
    console.log("length of updatedPhotos", updatedPhotos.length);
  
    // 🔹 Save back to file
    fs.writeFileSync(
      metadataFile,
      JSON.stringify(updatedPhotos, null, 2)
    );
  
    res.json({
      status: "success",
      totalPhotos: updatedPhotos.length
    });
  
  });

 // ✅ GET metadata
app.post("/api/get-metadata", (req, res) => {

  console.log("i am in get-metadata");

  const { subdomain } = req.body;
  metadataFile = `./${subdomain}/${subdomain}.json`;
  
  try {
    // 🔹 If file doesn't exist, return empty array
    if (!fs.existsSync(metadataFile)) {
      return res.json({
        status: "success",
        data: [],
        totalPhotos: 0
      });
    }

    // 🔹 Read file
    const data = fs.readFileSync(metadataFile, "utf8");

    // 🔹 Parse JSON safely
    const photos = data ? JSON.parse(data) : [];

    res.json({
      status: "success",
      data: photos,
      totalPhotos: photos.length
    });

  } catch (error) {
    console.error("Error reading metadata:", error);

    res.status(500).json({
      status: "error",
      message: "Failed to fetch metadata"
    });
  }
});


  app.post("/api/download-photos", async (req, res) => {
    try {
      const { subdomain, mediaItems } = req.body;
  
      const folder = path.join(__dirname, "galleries", subdomain);
  
      if (!fs.existsSync(folder)) {
        fs.mkdirSync(folder, { recursive: true });
      }
  
      const results = await Promise.all(
        mediaItems.map((item) =>
          downloadPhoto({ item, folder })
        )
      );
  
      res.send({ status: "download complete", files: results });
  
    } catch (err) {
      console.error(err);
      res.status(500).send({ error: err.message });
    }
  });


async function downloadPhoto({ item, folder }) {
  try {
    // ✅ Use correct URL format
    const url = item.baseUrl + "=d"; 
    const accessToken = item.accessToken
    console.log("accessToken: ", accessToken)
    // "=d" can be unreliable → use size instead

    const filename = `${item.id}.jpg`; // safer naming
    const filepath = path.join(folder, filename);

    console.log("Downloading:", url);

    const response = await axios({
      url,
      method: "GET",
      responseType: "stream",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      timeout: 20000,
    });

    // ✅ Ensure folder exists
    if (!fs.existsSync(folder)) {
      fs.mkdirSync(folder, { recursive: true });
    }

    const writer = fs.createWriteStream(filepath);

    // Pipe stream
    response.data.pipe(writer);

    // ✅ Proper stream handling
    await new Promise((resolve, reject) => {
      writer.on("finish", () => {
        console.log("Saved:", filename);
        resolve();
      });
      writer.on("error", (err) => {
        console.error("Write error:", err);
        reject(err);
      });
      response.data.on("error", (err) => {
        console.error("Stream error:", err);
        reject(err);
      });
    });

    return { filename, success: true };

  } catch (err) {
    console.error("Download failed:", err.message);
    return { filename: item.id, success: false };
  }
}


  app.get("/api/gallery", (req, res) => {

    const subdomain = req.query.subdomain;

    console.log(`gallery subdomain: ${subdomain}`);
  
    if (!subdomain) {
      return res.send("No gallery found");
    }
  
    const galleryFile = path.join(__dirname, "galleries", `${subdomain}.json`);
  
    if (!fs.existsSync(galleryFile)) {
      return res.send("Gallery not found");
    }
  
    const photos = JSON.parse(fs.readFileSync(galleryFile));
  
    res.json(photos);
  });

  app.post("/publish-album", async (req, res) => {
    try {
      const { subdomain, accessToken } = req.body;
  
      const photosFile = path.join(__dirname, "photos.json");
      const galleryFolder = path.join(__dirname, "galleries", subdomain);
      const galleryFile = path.join(galleryFolder, `${subdomain}.json`);
  
      // ❌ No photos file
      if (!fs.existsSync(photosFile)) {
        return res.json({ success: false, error: "No photos found" });
      }
  
      // ✅ Read selected photos
      const photos = JSON.parse(fs.readFileSync(photosFile, "utf8"));
  
      // ✅ Ensure folder exists (FIXED ORDER)
      if (!fs.existsSync(galleryFolder)) {
        fs.mkdirSync(galleryFolder, { recursive: true });
      }
  
      // ✅ Save metadata per subdomain
      fs.writeFileSync(
        galleryFile,
        JSON.stringify(photos, null, 2)
      );
  
      // 🔥 DELETE photos.json after successful publish
      try {
        fs.unlinkSync(photosFile);
        console.log("photos.json deleted after publish");
      } catch (deleteErr) {
        console.error("Failed to delete photos.json:", deleteErr);
        // Not blocking response — publish already succeeded
      }
  
      // 🚀 Response
      res.json({
        success: true,
        url: `${subdomain}.photospotco.com`
      });
  
    } catch (err) {
      console.error("Publish error:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post("/api/view-album", async (req, res) => {
    try {
      const { subdomain, accessToken } = req.body;

      const galleryFolder = path.join(__dirname, "galleries", subdomain);
      const galleryFile = path.join(galleryFolder, `${subdomain}.json`);

  
      // ✅ Ensure folder exists
      if (!fs.existsSync(galleryFolder)) {
        fs.mkdirSync(galleryFolder, { recursive: true });
      }
  
      // 🔥 Download all photos
      const galleryPhotos = JSON.parse(fs.readFileSync(galleryFile));
      const results = await Promise.all(
        galleryPhotos.map(item =>
          downloadPhoto({
            item,
            folder: galleryFolder
          })
        )
      );
  
      // 🚀 Response
      res.json({
        success: true,
        url: `${subdomain}.photospotco.com`,
        filesDownloaded: results.length
      });
  
    } catch (err) {
      console.error("View Album error:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get("/api/list-photos", (req, res) => {
    try {
      const subdomain = req.query.subdomain;
  
      if (!subdomain) {
        return res.status(400).json({ error: "Missing subdomain" });
      }
  
      const dir = path.join(__dirname, "galleries", subdomain);
  
      // ❌ Folder doesn't exist
      if (!fs.existsSync(dir)) {
        return res.json([]);
      }
  
      const files = fs.readdirSync(dir);
  
      // ✅ Filter only images (optional but recommended)
      const photos = files
        .filter(file => /\.(jpg|jpeg|png|webp)$/i.test(file))
        .map(file => ({
          filename: file,
          url: `backend/galleries/${subdomain}/${file}`,
        }));
  
      res.json(photos);
  
    } catch (err) {
      console.error("list-photos error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  
app.listen(3001, () => {
    console.log("Server is running on port 3001");
});
