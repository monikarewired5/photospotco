const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { GetObjectCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const jwt = require("jsonwebtoken");
const dotenv = require('dotenv');


const express = require('express');
const { OAuth2Client } = require('google-auth-library');
const cors = require('cors');
const { randomUUID } = require("crypto");



const app = express();
const path = require("path");
const fs = require("fs");
const axios = require("axios");
dotenv.config();


app.use(cors());
app.use(express.json());
app.use("/galleries", express.static(path.join(__dirname, "galleries")));

app.use((req, res, next) => {
  req.requestId = req.headers["x-request-id"] || randomUUID();
  res.setHeader("X-Request-ID", req.requestId);
  next();
});

app.use((req, res, next) => {
  const authHeader = req.headers.authorization;
  console.log("auth header in request: ", authHeader);

  if (authHeader?.startsWith("Bearer ")) {
    const appToken = authHeader.split(" ")[1];

    try {
      const decoded = jwt.verify(appToken, process.env.JWT_SECRET);
      console.log("decoded request: ", decoded);
      req.userId = decoded.userId;
    } catch {
      req.userId = null;
    }
  }

  next();
});

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

const oauth2Client = new OAuth2Client(CLIENT_ID);

const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_KEY,
  },
});

app.post('/api/auth/google', async(req, res) => {
    const { token } = req.body;
    try {
        const ticket = await oauth2Client.verifyIdToken({
            idToken: token,
            audience: CLIENT_ID,
        });
        const payload = ticket.getPayload();
        // ⚡ Your user identity
        const userId = payload.sub;

        const user = {
            name: payload.name,
            email: payload.email,
            picture: payload.picture,
        };

        console.log("User logged in: ", user);

        const appToken = jwt.sign(
          { userId },
          process.env.JWT_SECRET,
          { expiresIn: "7d" }
        );

        console.log("application token:", appToken);

        res.json({ 
            success: true,
            user: user,
            appToken: appToken 
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

    if (!req.userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }


    const publishId = randomUUID();

    const dir = path.join("galleries", req.userId, "publish");
    //✅ Ensure folder exists (FIXED ORDER)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

    const newPhotos = req.body;
    metadataFile = path.join(dir, `${publishId}.json`);
  
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

  const galleryFolder = path.join("galleries", req.userId, "publish");
  const files = fs.readdirSync(galleryFolder);
  const jsonFiles = files.filter(file => file.endsWith(".json"));

  const photos = [];

  try {

    for (const metadataFile of jsonFiles) {
      const metadataFilePath = path.join(galleryFolder, metadataFile);
      const data = fs.readFileSync(metadataFilePath, "utf8");
      console.log("metadataFile: ", metadataFilePath)
      const photoData = data ? JSON.parse(data) : [];
      photos.push(...photoData);

      // ✅ delete AFTER successful processing
      fs.unlinkSync(metadataFilePath);
    }
    console.log("total photos read: ", photos.length)
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
      console.log("mediaItems : " , mediaItems)
      
      console.log("type of mediaItem: ", typeof(mediaItems));
  
      const folder = path.join(__dirname, "galleries", subdomain);
  
      if (!fs.existsSync(folder)) {
        fs.mkdirSync(folder, { recursive: true });
      }
  
      const results = await Promise.all(
        mediaItems.map((item) =>
          downloadPhoto({ item, folder , subdomain})
        )
      );
  
      res.send({ status: "download complete", files: results });
  
    } catch (err) {
      console.error(err);
      res.status(500).send({ error: err.message });
    }
  });


async function downloadPhoto({ item, folder, subdomain}) {
  try {
    // ✅ Use correct URL format
    const url = item.baseUrl + "=d"; 
    const accessToken = item.accessToken
    console.log("subdomain: ", subdomain)
    // "=d" can be unreliable → use size instead

    const filename = `${item.id}.jpg`; // safer naming
    const filepath = path.join(folder, filename);

    console.log("Downloading photo");

    const response = await axios({
      url,
      method: "GET",
      responseType: "arraybuffer",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      timeout: 20000,
    });

    console.log("Uploading to R2");
    console.log("end-point: ", process.env.R2_ENDPOINT)

    const buffer = Buffer.from(response.data);

    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: `albums/${subdomain}/${Date.now()}_${filename}`,
      Body: buffer, // 👈 stream directly
      ContentType: response.headers.get("content-type"),
    });
    
    console.log("Uploaded to R2");

    await s3.send(command);

    // // ✅ Ensure folder exists
    // if (!fs.existsSync(folder)) {
    //   fs.mkdirSync(folder, { recursive: true });
    // }

    // const writer = fs.createWriteStream(filepath);

    // // Pipe stream
    // response.data.pipe(writer);

    // ✅ Proper stream handling
    // await new Promise((resolve, reject) => {
    //   writer.on("finish", () => {
    //     console.log("Saved:", filename);
    //     resolve();
    //   });
    //   writer.on("error", (err) => {
    //     console.error("Write error:", err);
    //     reject(err);
    //   });
    //   response.data.on("error", (err) => {
    //     console.error("Stream error:", err);
    //     reject(err);
    //   });
    // });

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

  // app.post("/api/publish-album", async (req, res) => {
  //   try {
  //     if (!req.userId) {
  //       return res.status(401).json({ message: "Unauthorized" });
  //     }

  //     const { subdomain, accessToken } = req.body;

  //     const galleryFolder = path.join(__dirname, "galleries", req.userId,"publish");
  //     // ✅ Ensure folder exists (FIXED ORDER)
  //     if (!fs.existsSync(galleryFolder)) {
  //       fs.mkdirSync(galleryFolder, { recursive: true });
  //     }
  //     const gallerySubdomainFolder = path.join(__dirname, "galleries", req.userId,`${subdomain}`);
  //     // ✅ Ensure folder exists (FIXED ORDER)
  //     if (!fs.existsSync(gallerySubdomainFolder)) {
  //       fs.mkdirSync(gallerySubdomainFolder, { recursive: true });
  //     }
  //     const files = await fs.readdir(galleryFolder);
  //     const jsonFiles = files.filter(file => file.endsWith(".json"));

  //     const galleryFile = path.join(gallerySubdomainFolder, `${subdomain}.json`);
  
  //     // ❌ No photos file
  //     if (jsonFiles.length <= 0) {
  //       return res.json({ success: false, error: "No photos found" });
  //     }
  
  //     const photos = [];

  //     // ✅ Read selected photos
  //     for (const file of jsonFiles) {
  //       const filePath = path.join(galleryFolder, file);
  //       const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  //       photos.push(data);
  //       // 🔥 DELETE publishId.json after successful publish
  //     try {
  //       fs.unlinkSync(filePath);
  //       console.log(`${filePath} deleted after publish`);
  //     } catch (deleteErr) {
  //       console.error(`Failed to delete ${filePath}`, deleteErr);
  //       // Not blocking response — publish already succeeded
  //     }
  //   }
  
  //     // ✅ Save metadata per subdomain
  //     fs.writeFileSync(
  //       galleryFile,
  //       JSON.stringify(photos, null, 2)
  //     );      
  //     // 🚀 Response
  //     res.json({
  //       success: true,
  //       url: `${subdomain}.photospotco.com`
  //     });
  
  //   } catch (err) {
  //     console.error("Publish error:", err);
  //     res.status(500).json({ success: false, error: err.message });
  //   }
  // });

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
            folder: galleryFolder,
            subdomain
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


  app.get("/api/list-photos-r2", async (req, res) => {
    try {
      const subdomain = req.query.subdomain;
  
      if (!subdomain) {
        return res.status(400).json({ error: "Missing subdomain" });
      }

      // 1️⃣ List all objects in bucket
      const listCommand = new ListObjectsV2Command({
        Bucket: process.env.R2_BUCKET,
            Prefix: `albums/${subdomain}/`
      });

      const listResponse = await s3.send(listCommand);

      const files = listResponse.Contents || [];

      // 2️⃣ Generate signed URLs for each file
      const photos = await Promise.all(
        files.map(async (obj) => {
          const getCommand = new GetObjectCommand({
            Bucket: process.env.R2_BUCKET,
            Key: obj.Key,
          });

          const signedUrl = await getSignedUrl(s3, getCommand, {
            expiresIn: 300, // 5 minutes
          });

          return {
            key: obj.Key,
            url: signedUrl, // 👈 this is what you wanted
          };
        })
      );
  
      res.json(photos);
  
    } catch (err) {
      console.error("list-photos-r2 error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  
app.listen(3001, () => {
    console.log("Server is running on port 3001");
});
