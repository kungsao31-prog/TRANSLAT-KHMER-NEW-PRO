import express from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const router = express.Router();
const jobs = new Map();
const TTS_MODEL = process.env.GEMINI_TTS_MODEL || "gemini-3.8-flash-lite-tts";
const TTS_VOICE = process.env.GEMINI_TTS_VOICE || "Kore";
const MAX_SEGMENTS = 100;
const JOB_TTL_MS = 30 * 60 * 1000;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error((stderr || command + " failed").slice(-1800)));
    });
  });
}

function setJob(job, progress, stage, extra = {}) {
  Object.assign(job, { progress, stage, updatedAt: Date.now(), ...extra });
}

async function synthesizeKhmer(text, apiKey, outputPath) {
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: TTS_MODEL,
      input: [{
        type: "user_input",
        content: [{
          type: "text",
          text,
          annotations: [{ type: "speech_metadata", style: "Natural, clear Khmer narration at a steady conversational pace." }]
        }]
      }],
      response_format: { type: "audio" },
      generation_config: { speech_config: [{ voice: TTS_VOICE }] }
    }),
    signal: AbortSignal.timeout(120000)
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload.error?.message || payload.message || "Gemini TTS request failed";
    throw new Error("Gemini TTS: " + detail);
  }

  const audio = payload.output_audio?.data ||
    (payload.steps || [])
      .filter(step => step.type === "model_output")
      .flatMap(step => step.content || [])
      .find(item => item.type === "audio" && item.data)?.data;

  if (!audio) throw new Error("Gemini TTS មិនបានផ្ញើទិន្នន័យសំឡេងត្រឡប់មកទេ។");
  const bytes = Buffer.from(audio, "base64");
  if (bytes.length < 44 || bytes.subarray(0, 4).toString() !== "RIFF") {
    throw new Error("ទម្រង់សំឡេងពី Gemini មិនមែនជា WAV ត្រឹមត្រូវទេ។");
  }
  await fs.writeFile(outputPath, bytes);
}

async function processDubJob(job, videoBuffer, segments, apiKey) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "tk-dub-"));
  const inputPath = path.join(workDir, "source-video");
  const outputPath = path.join(workDir, "TRANSLAT-KHMER-DUBBED.mp4");
  try {
    await fs.writeFile(inputPath, videoBuffer);
    const probe = await run("ffprobe", [
      "-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", inputPath
    ]);
    const duration = Number(probe.stdout.trim());
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("មិនអាចអានរយៈពេលវីដេអូបានទេ។");

    const normalized = segments.map(segment => ({
      start: Math.max(0, Math.min(duration, Number(segment.start) || 0)),
      text: String(segment.translation || segment.khmer || "").trim()
    })).filter(segment => segment.text && segment.start < duration);

    if (!normalized.length) throw new Error("មិនមានឃ្លាខ្មែរដែលអាចបង្កើតសំឡេងបានទេ។");

    const audioPaths = [];
    for (let i = 0; i < normalized.length; i++) {
      const audioPath = path.join(workDir, "speech-" + String(i).padStart(3, "0") + ".wav");
      await synthesizeKhmer(normalized[i].text, apiKey, audioPath);
      audioPaths.push(audioPath);
      const progress = 8 + Math.round(((i + 1) / normalized.length) * 72);
      setJob(job, progress, `កំពុងបង្កើតសំឡេងខ្មែរ ${i + 1}/${normalized.length}`);
    }

    setJob(job, 84, "កំពុងរៀបចំពេលវេលាសំឡេង និងបញ្ចូលទៅក្នុងវីដេអូ");
    const args = ["-y", "-i", inputPath];
    for (const audioPath of audioPaths) args.push("-i", audioPath);

    const filters = audioPaths.map((_, i) => {
      const delay = Math.round(normalized[i].start * 1000);
      return `[${i + 1}:a]adelay=${delay}:all=1,aresample=48000[a${i}]`;
    });
    const mixInputs = audioPaths.map((_, i) => `[a${i}]`).join("");
    filters.push(`${mixInputs}amix=inputs=${audioPaths.length}:duration=longest:dropout_transition=0:normalize=0,apad,atrim=duration=${duration.toFixed(3)}[aout]`);

    args.push(
      "-filter_complex", filters.join(";"),
      "-map", "0:v:0", "-map", "[aout]",
      "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
      "-t", duration.toFixed(3), "-movflags", "+faststart",
      "-f", "mp4", outputPath
    );
    await run("ffmpeg", args);
    const stat = await fs.stat(outputPath);
    if (stat.size < 1024) throw new Error("ឯកសារ MP4 ដែលបានបង្កើតមានទំហំមិនត្រឹមត្រូវទេ។");

    setJob(job, 100, "រួចរាល់", { status: "completed", outputPath, outputSize: stat.size });
    // Keep the output available briefly so the phone can download it after polling.
    job.cleanupTimer = setTimeout(async () => {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
      jobs.delete(job.id);
    }, JOB_TTL_MS);
  } catch (error) {
    setJob(job, 100, "បរាជ័យ", { status: "failed", error: error.message || "បង្កើតវីដេអូមិនបានទេ។" });
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

router.post("/api/dub", (req, res, next) => {
  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({ ok: false, error: "Backend មិនទាន់កំណត់ GEMINI_API_KEY នៅ Render Environment ទេ។" });
  }
  next();
}, (req, res, next) => {
  // The upload middleware is attached by the parent server to preserve its configured file-size limit.
  next();
});

export function createDubbingRouter(upload) {
  router.post("/api/dub", upload.single("video"), (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ ok: false, error: "សូមជ្រើសរើសវីដេអូ។" });
      let segments;
      try { segments = JSON.parse(req.body.segments || "[]"); }
      catch { return res.status(400).json({ ok: false, error: "ទិន្នន័យ Subtitle មិនត្រឹមត្រូវទេ។" }); }
      if (!Array.isArray(segments) || !segments.length || segments.length > MAX_SEGMENTS) {
        return res.status(400).json({ ok: false, error: `ចំនួនឃ្លាត្រូវមានពី 1 ដល់ ${MAX_SEGMENTS}។` });
      }
      const id = crypto.randomUUID();
      const job = { id, status: "processing", progress: 3, stage: "បានទទួលវីដេអូ និងកំពុងចាប់ផ្ដើម", createdAt: Date.now(), updatedAt: Date.now() };
      jobs.set(id, job);
      const buffer = req.file.buffer;
      processDubJob(job, buffer, segments, process.env.GEMINI_API_KEY).catch(error => {
        setJob(job, 100, "បរាជ័យ", { status: "failed", error: error.message });
      });
      res.status(202).json({ ok: true, jobId: id, statusUrl: `/api/dub/${id}` });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message || "មិនអាចចាប់ផ្ដើមការងារ Dubbing បានទេ។" });
    }
  });

  router.get("/api/dub/:jobId", (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ ok: false, error: "រកមិនឃើញការងារនេះ ឬវាបានផុតកំណត់។" });
    res.json({
      ok: true,
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      stage: job.stage,
      error: job.error || undefined,
      downloadUrl: job.status === "completed" ? `/api/dub/${job.id}/download` : undefined
    });
  });

  router.get("/api/dub/:jobId/download", async (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job || job.status !== "completed" || !job.outputPath) {
      return res.status(404).json({ ok: false, error: "វីដេអូមិនទាន់រួចរាល់ ឬការងារបានផុតកំណត់។" });
    }
    res.download(job.outputPath, "TRANSLAT-KHMER-DUBBED.mp4");
  });

  return router;
}
