import express from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import ffprobe from "ffprobe-static";

const jobs = new Map();
const MODEL = process.env.GEMINI_TTS_MODEL || "gemini-3.8-flash-tts";
const FALLBACK_VOICE = process.env.GEMINI_TTS_VOICE || "Kore";
const FEMALE_VOICES = ["Kore", "Aoede", "Callirrhoe", "Leda", "Zephyr", "Despina"];
const MALE_VOICES = ["Puck", "Charon", "Fenrir", "Orus", "Achird", "Iapetus"];
const MAX_SEGMENTS = 80;
const JOB_TTL_MS = 30 * 60 * 1000;

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error((stderr || command + " failed").slice(-1800))));
  });
}

function update(job, values) { Object.assign(job, values, { updatedAt: Date.now() }); }

export function chooseCharacterVoices(segments) {
  const assignments = new Map();
  let femaleIndex = 0;
  let maleIndex = 0;
  for (const segment of segments) {
    const speakerId = String(segment.speakerId || segment.speaker || "speaker_1");
    if (assignments.has(speakerId)) continue;
    const gender = String(segment.gender || "").toLowerCase();
    let voice = FALLBACK_VOICE;
    if (gender === "female") {
      voice = FEMALE_VOICES[femaleIndex % FEMALE_VOICES.length];
      femaleIndex++;
    } else if (gender === "male") {
      voice = MALE_VOICES[maleIndex % MALE_VOICES.length];
      maleIndex++;
    }
    assignments.set(speakerId, { gender, voice });
  }
  return assignments;
}

export async function makeSpeech(text, apiKey, outputPath, voiceName = FALLBACK_VOICE) {
  const transcript = String(text || "").trim();
  if (!transcript) throw new Error("មិនមានអត្ថបទខ្មែរសម្រាប់បង្កើតសំឡេងទេ។");
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{
        text: transcript,
        speechMetadata: { style: "Speak naturally in clear conversational Khmer, with a steady pace and expressive delivery appropriate to the character." }
      }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName } }
        }
      }
    }),
    signal: AbortSignal.timeout(120000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error("Gemini TTS (" + response.status + "): " +
      (data.error?.message || "មិនអាចបង្កើតសំឡេងបានទេ។"));
  }
  const encoded = data.candidates?.[0]?.content?.parts?.find(part => part.inlineData?.data)?.inlineData?.data;
  if (!encoded) throw new Error("Gemini មិនបានផ្ញើសំឡេងត្រឡប់មកទេ។");
  const wav = Buffer.from(encoded, "base64");
  if (wav.length < 100 || wav.subarray(0, 4).toString() !== "RIFF" ||
      wav.subarray(8, 12).toString() !== "WAVE") {
    throw new Error("Gemini TTS មិនបានផ្ញើឯកសារ WAV ពេញលេញត្រឹមត្រូវទេ។");
  }
  await fs.writeFile(outputPath, wav);
}

async function runJob(job, videoBuffer, segments, apiKey) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "translat-khmer-dub-"));
  try {
    const input = path.join(dir, "input-video");
    const output = path.join(dir, "TRANSLAT-KHMER-DUBBED.mp4");
    await fs.writeFile(input, videoBuffer);
    const probeResult = await run(ffprobe.path, ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", input]);
    const probe = JSON.parse(probeResult.stdout);
    const duration = Number(probe.format?.duration);
    if (!Number.isFinite(duration) || duration <= 0 || !probe.streams?.some(s => s.codec_type === "video")) {
      throw new Error("មិនអាចអានរយៈពេល ឬ Video Stream របស់វីដេអូនេះបានទេ។");
    }

    const clean = segments.map(s => ({
      start: Math.max(0, Math.min(duration, Number(s.start) || 0)),
      end: Math.max(0, Math.min(duration, Number(s.end) || 0)),
      speakerId: String(s.speakerId || s.speaker || "speaker_1"),
      gender: String(s.gender || "unknown").toLowerCase(),
      text: String(s.translation || s.khmer || "").trim()
    })).filter(s => s.text && s.start < duration);
    if (!clean.length) throw new Error("មិនមានឃ្លាខ្មែរដែលអាចបង្កើតសំឡេងបានទេ。");

    const voices = chooseCharacterVoices(clean);
    const audioFiles = [];
    for (let i = 0; i < clean.length; i++) {
      const audioFile = path.join(dir, "voice-" + i + ".wav");
      const assignment = voices.get(clean[i].speakerId) || { voice: FALLBACK_VOICE };
      await makeSpeech(clean[i].text, apiKey, audioFile, assignment.voice);
      audioFiles.push(audioFile);
      update(job, {
        progress: 5 + Math.round(((i + 1) / clean.length) * 75),
        stage: "កំពុងបង្កើតសំឡេងខ្មែរ " + (i + 1) + "/" + clean.length
      });
    }

    update(job, { progress: 84, stage: "កំពុងបញ្ចូលសំឡេងខ្មែរតែប៉ុណ្ណោះទៅក្នុង MP4" });
    const args = ["-y", "-i", input];
    for (const file of audioFiles) args.push("-i", file);
    const filters = [];
    const labels = [];
    audioFiles.forEach((_, i) => {
      const label = "kh" + i;
      filters.push("[" + (i + 1) + ":a]adelay=" + Math.round(clean[i].start * 1000) + ":all=1,aresample=48000[" + label + "]");
      labels.push("[" + label + "]");
    });
    filters.push(labels.join("") + "amix=inputs=" + labels.length +
      ":duration=longest:dropout_transition=0:normalize=0,apad,atrim=duration=" +
      duration.toFixed(3) + "[aout]");
    args.push(
      "-filter_complex", filters.join(";"),
      "-map", "0:v:0",
      "-map", "[aout]",
      "-c:v", "copy",
      "-c:a", "aac",
      "-b:a", "192k",
      "-t", duration.toFixed(3),
      "-map_metadata", "-1",
      "-movflags", "+faststart",
      "-f", "mp4",
      output
    );
    // Only the newly generated Khmer tracks are mapped. Original Chinese dialogue,
    // music, and other source audio tracks are intentionally excluded.
    await run(ffmpegPath, args);
    const stat = await fs.stat(output);
    if (stat.size < 1024) throw new Error("ឯកសារ MP4 ដែលបានបង្កើតមិនត្រឹមត្រូវទេ។");
    update(job, { status: "completed", progress: 100, stage: "រួចរាល់", outputPath: output, outputSize: stat.size });
    job.cleanupTimer = setTimeout(async () => {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      jobs.delete(job.id);
    }, JOB_TTL_MS);
  } catch (error) {
    update(job, { status: "failed", progress: 100, stage: "បរាជ័យ", error: error.message || "បង្កើតវីដេអូមិនបានទេ។" });
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export function createDubbingRouter(upload) {
  const router = express.Router();
  router.post("/api/dub", (req, res, next) => {
    if (!process.env.GEMINI_API_KEY) return res.status(503).json({ ok: false, error: "Backend មិនទាន់កំណត់ GEMINI_API_KEY នៅ Render Environment ទេ។" });
    next();
  }, upload.single("video"), (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, error: "សូមជ្រើសរើសវីដេអូ។" });
    let segments;
    try { segments = JSON.parse(req.body.segments || "[]"); }
    catch { return res.status(400).json({ ok: false, error: "ទិន្នន័យ Subtitle មិនត្រឹមត្រូវទេ។" }); }
    if (!Array.isArray(segments) || !segments.length || segments.length > MAX_SEGMENTS) {
      return res.status(400).json({ ok: false, error: "ចំនួនឃ្លាត្រូវមានពី 1 ដល់ " + MAX_SEGMENTS + "។" });
    }
    const id = crypto.randomUUID();
    const job = { id, status: "processing", progress: 2, stage: "បានទទួលវីដេអូ", createdAt: Date.now(), updatedAt: Date.now() };
    jobs.set(id, job);
    runJob(job, req.file.buffer, segments, process.env.GEMINI_API_KEY)
      .catch(error => update(job, { status: "failed", progress: 100, stage: "បរាជ័យ", error: error.message }));
    res.status(202).json({ ok: true, jobId: id });
  });
  router.get("/api/dub/:jobId", (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ ok: false, error: "រកមិនឃើញការងារនេះ ឬវាបានផុតកំណត់។" });
    res.json({
      ok: true, jobId: job.id, status: job.status, progress: job.progress, stage: job.stage,
      error: job.error || undefined,
      downloadUrl: job.status === "completed" ? "/api/dub/" + job.id + "/download" : undefined
    });
  });
  router.get("/api/dub/:jobId/download", (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job || job.status !== "completed" || !job.outputPath) {
      return res.status(404).json({ ok: false, error: "វីដេអូមិនទាន់រួចរាល់ ឬការងារបានផុតកំណត់។" });
    }
    res.download(job.outputPath, "TRANSLAT-KHMER-DUBBED.mp4");
  });
  return router;
}
