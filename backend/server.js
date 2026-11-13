import express from "express";
import cors from "cors";
import multer from "multer";
import rateLimit from "express-rate-limit";
import { GoogleGenAI, createPartFromUri } from "@google/genai";
import { fileTypeFromBuffer } from "file-type";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const app = express();
const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const MAX_VIDEO_MB = Number(process.env.MAX_VIDEO_MB || 80);
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "").split(",").map(x => x.trim()).filter(Boolean);

app.disable("x-powered-by");
app.use(cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error("Origin not allowed"));
  }
}));
app.use(express.json({ limit: "1mb" }));
app.use(rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false }));
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_VIDEO_MB * 1024 * 1024, files: 1 }
});

const ai = () => {
  if (!API_KEY) throw new Error("Backend មិនទាន់កំណត់ GEMINI_API_KEY នៅ Environment ទេ។");
  return new GoogleGenAI({ apiKey: API_KEY });
};

app.get("/health", (_req, res) => res.json({ ok: true, app: "TRANSLAT-KHMER-NEW-PRO", service: "new-independent-backend" }));

app.post("/api/video/translate", upload.single("video"), async (req, res) => {
  let uploadedName;
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "សូមជ្រើសរើសឯកសារវីដេអូ។" });
    const detected = await fileTypeFromBuffer(req.file.buffer);
    if (!detected || !detected.mime.startsWith("video/")) {
      return res.status(400).json({ ok: false, error: "ឯកសារដែលបានជ្រើសរើសមិនមែនជាវីដេអូត្រឹមត្រូវទេ។" });
    }
    const tempPath = path.join(os.tmpdir(), `tk-new-${crypto.randomUUID()}.${detected.ext}`);
    await fs.writeFile(tempPath, req.file.buffer);
    try {
      const client = ai();
      const uploaded = await client.files.upload({
        file: tempPath,
        config: { mimeType: detected.mime, displayName: "TRANSLAT-KHMER-NEW-PRO video" }
      });
      uploadedName = uploaded.name;
      let state = uploaded.state;
      let current = uploaded;
      for (let i = 0; state === "PROCESSING" && i < 30; i++) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        current = await client.files.get({ name: uploaded.name });
        state = current.state;
      }
      if (state !== "ACTIVE") throw new Error("Gemini មិនអាចត្រៀមឯកសារវីដេអូបានទេ។ សូមសាកល្បងវីដេអូខ្លីជាងនេះ។");
      const language = String(req.body.sourceLanguage || "auto").slice(0, 30);
      const prompt = `Listen to the spoken dialogue in this video. Source language: ${language}. Transcribe and translate every spoken segment into natural Khmer. Return ONLY valid JSON with this exact shape: {"ok":true,"segments":[{"start":0.0,"end":2.5,"original":"spoken words","translation":"អត្ថបទខ្មែរ"}]}. Use seconds for start/end, preserve chronological order, do not invent dialogue, and keep segments short and time-aligned. If there is no speech return {"ok":true,"segments":[]}.`;
      const result = await client.models.generateContent({
        model: MODEL,
        contents: [createPartFromUri(current.uri, current.mimeType), prompt],
        config: { responseMimeType: "application/json", temperature: 0.1 }
      });
      const raw = result.text || "";
      const parsed = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, "").trim());
      const segments = Array.isArray(parsed.segments) ? parsed.segments.map(s => ({
        start: Math.max(0, Number(s.start) || 0),
        end: Math.max(0, Number(s.end) || 0),
        original: String(s.original || ""),
        translation: String(s.translation || s.khmer || "").trim()
      })).filter(s => s.translation && s.end >= s.start) : [];
      res.json({ ok: true, segments });
    } finally {
      await fs.rm(tempPath, { force: true }).catch(() => {});
      if (uploadedName) await ai().files.delete({ name: uploadedName }).catch(() => {});
    }
  } catch (error) {
    console.error("video translate failed:", error);
    res.status(500).json({ ok: false, error: error.message || "បកប្រែវីដេអូមិនបានទេ។" });
  }
});

// Audio dubbing is intentionally not faked: the separate speech-generation pipeline
// must be configured before this endpoint can return a dubbed MP4.
app.post("/api/dub", upload.single("video"), async (_req, res) => {
  res.status(501).json({
    ok: false,
    error: "មុខងារបង្កើតសំឡេងខ្មែរដាក់ចូលវីដេអូកំពុងត្រូវរៀបចំ។ ពេលនេះអាចបង្កើតអត្ថបទបកប្រែ និង Subtitle ជាមុនសិន។"
  });
});

app.use((err, _req, res, _next) => {
  const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
  res.status(status).json({ ok: false, error: err.message || "សំណើមិនត្រឹមត្រូវទេ។" });
});

app.listen(PORT, () => console.log(`TRANSLAT-KHMER-NEW-PRO backend listening on ${PORT}`));
