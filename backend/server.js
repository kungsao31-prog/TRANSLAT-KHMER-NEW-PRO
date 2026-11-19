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
import { createDubbingRouter } from "./dubbing.js";

const app = express();
const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
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
// Apply rate limits only to expensive AI generation endpoints; do not throttle job polling or MP4 downloads.
const aiRateLimit = rateLimit({ windowMs: 60_000, limit: 8, standardHeaders: true, legacyHeaders: false });
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_VIDEO_MB * 1024 * 1024, files: 1 }
});

const ai = () => {
  if (!API_KEY) throw new Error("Backend មិនទាន់កំណត់ GEMINI_API_KEY នៅ Environment ទេ។");
  return new GoogleGenAI({ apiKey: API_KEY });
};

function isTemporaryAiError(error) {
  const status = Number(error?.status || error?.code || error?.response?.status);
  const message = String(error?.message || "").toLowerCase();
  return [408, 429, 500, 502, 503, 504].includes(status) ||
    /high demand|temporarily unavailable|unavailable|resource exhausted|overloaded|rate.?limit|try again later/.test(message);
}

async function withAiRetry(operation, label) {
  const delays = [3000, 6000, 12000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!isTemporaryAiError(error) || attempt >= delays.length) throw error;
      const waitMs = delays[attempt];
      console.warn(`${label} temporarily unavailable; retry ${attempt + 1}/3 in ${waitMs}ms`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  }
}

app.get("/health", (_req, res) => res.json({ ok: true, app: "TRANSLAT-KHMER-NEW-PRO", service: "new-independent-backend" }));

app.post("/api/video/translate", aiRateLimit, upload.single("video"), async (req, res) => {
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
      const uploaded = await withAiRetry(() => client.files.upload({
        file: tempPath,
        config: { mimeType: detected.mime, displayName: "TRANSLAT-KHMER-NEW-PRO video" }
      }), "Gemini video upload");
      uploadedName = uploaded.name;
      let state = uploaded.state;
      let current = uploaded;
      for (let i = 0; state === "PROCESSING" && i < 30; i++) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        current = await withAiRetry(() => client.files.get({ name: uploaded.name }), "Gemini file status");
        state = current.state;
      }
      if (state !== "ACTIVE") throw new Error("Gemini មិនអាចត្រៀមឯកសារវីដេអូបានទេ។ សូមសាកល្បងវីដេអូខ្លីជាងនេះ។");
      const language = String(req.body.sourceLanguage || "auto").slice(0, 30);
      const prompt = `Listen carefully to the dialogue in this video. Source language: ${language}.
Transcribe every spoken line and translate it into natural, complete, conversational Khmer.
Identify speakers by their audible voice, not by names or visual appearance. Assign a stable speakerId ("speaker_1", "speaker_2", etc.) to each distinct voice and reuse that ID whenever the same person speaks again.
For each speaker, classify the audible voice gender as exactly "female", "male", or "unknown". Do not guess when the voice is genuinely unclear.
Also inspect visible on-screen Chinese text (burned-in subtitles, labels, signs). For each visible text region, detect its time range and bounding box as normalized x,y,width,height coordinates from 0 to 1 relative to the full frame, and translate it into Khmer. Do not confuse scene objects or spoken dialogue with visible text.
Return ONLY valid JSON in this shape:
{"ok":true,"segments":[{"start":0.0,"end":2.5,"speakerId":"speaker_1","gender":"female","original":"spoken words","translation":"អត្ថបទខ្មែរ"}],"visualTexts":[{"start":0.0,"end":2.5,"x":0.1,"y":0.82,"width":0.8,"height":0.1,"original":"中文","translation":"អត្ថបទខ្មែរ"}]}.
Use seconds for timing. Preserve speaker IDs. Visual text boxes must tightly cover Chinese text and only while visible. Use concise natural Khmer. Return empty arrays when absent.`;
      const result = await withAiRetry(() => client.models.generateContent({
        model: MODEL,
        contents: [createPartFromUri(current.uri, current.mimeType), prompt],
        config: { responseMimeType: "application/json" }
      }), "Gemini video translation");
      const raw = result.text || "";
      const parsed = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, "").trim());
      const segments = Array.isArray(parsed.segments) ? parsed.segments.map(s => ({
        start: Math.max(0, Number(s.start) || 0),
        end: Math.max(0, Number(s.end) || 0),
        speakerId: String(s.speakerId || s.speaker || "speaker_1").slice(0, 40),
        gender: ["female", "male"].includes(String(s.gender || "").toLowerCase()) ? String(s.gender).toLowerCase() : "unknown",
        original: String(s.original || ""),
        translation: String(s.translation || s.khmer || "").trim()
      })).filter(s => s.translation && s.end >= s.start) : [];
      const visualTexts = Array.isArray(parsed.visualTexts) ? parsed.visualTexts.map(v => ({
        start: Math.max(0, Number(v.start) || 0),
        end: Math.max(0, Number(v.end) || 0),
        x: Math.max(0, Math.min(1, Number(v.x) || 0)),
        y: Math.max(0, Math.min(1, Number(v.y) || 0)),
        width: Math.max(0, Math.min(1, Number(v.width) || 0)),
        height: Math.max(0, Math.min(1, Number(v.height) || 0)),
        original: String(v.original || ""),
        translation: String(v.translation || "").trim()
      })).filter(v => v.translation && v.end > v.start && v.width > 0 && v.height > 0).slice(0, 120) : [];
      res.json({ ok: true, segments, visualTexts });
    } finally {
      await fs.rm(tempPath, { force: true }).catch(() => {});
      if (uploadedName) await ai().files.delete({ name: uploadedName }).catch(() => {});
    }
  } catch (error) {
    console.error("video translate failed:", error);
    const temporary = isTemporaryAiError(error);
    res.status(temporary ? 503 : 500).json({
      ok: false,
      code: temporary ? "AI_TEMPORARILY_UNAVAILABLE" : "VIDEO_TRANSLATION_FAILED",
      retryable: temporary,
      error: temporary
        ? "ប្រព័ន្ធ AI កំពុងមានអ្នកប្រើប្រាស់ច្រើន។ សូមរង់ចាំបន្តិច ហើយចុចសាកល្បងម្ដងទៀត។"
        : (error.message || "បកប្រែវីដេអូមិនបានទេ។")
    });
  }
});

app.use(createDubbingRouter(upload, aiRateLimit));

app.use((err, _req, res, _next) => {
  const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
  res.status(status).json({ ok: false, error: err.message || "សំណើមិនត្រឹមត្រូវទេ។" });
});

app.listen(PORT, () => console.log(`TRANSLAT-KHMER-NEW-PRO backend listening on ${PORT}`));
