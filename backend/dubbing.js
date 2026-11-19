import express from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import { pathToFileURL } from "node:url";

const jobs = new Map();
const MODEL = process.env.GEMINI_TTS_MODEL || "gemini-3.8-flash-tts";
const FALLBACK_VOICE = process.env.GEMINI_TTS_VOICE || "Kore";
const FEMALE_VOICES = ["Kore", "Aoede", "Callirrhoe", "Leda", "Zephyr", "Despina"];
const MALE_VOICES = ["Puck", "Charon", "Fenrir", "Orus", "Achird", "Iapetus"];
const MAX_SEGMENTS = 80;
const JOB_TTL_MS = 30 * 60 * 1000;
const KHMER_FONT = process.env.KHMER_FONT_PATH || "/usr/share/fonts/truetype/noto/NotoSansKhmer-Regular.ttf";

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
  const audioPart = data.candidates?.[0]?.content?.parts?.find(part => part.inlineData?.data);
  if (!audioPart) throw new Error("Gemini មិនបានផ្ញើសំឡេងត្រឡប់មកទេ។");
  const audio = Buffer.from(audioPart.inlineData.data, "base64");
  if (audio.length < 100) throw new Error("សំឡេងដែល Gemini បង្កើតមានទំហំមិនត្រឹមត្រូវទេ។");
  let wav = audio;
  if (audio.subarray(0, 4).toString() !== "RIFF" || audio.subarray(8, 12).toString() !== "WAVE") {
    // Gemini TTS commonly returns raw 16-bit little-endian PCM at 24 kHz mono.
    const mime = String(audioPart.inlineData.mimeType || "");
    const rateMatch = mime.match(/rate=(\d+)/i);
    const sampleRate = rateMatch ? Number(rateMatch[1]) : 24000;
    const header = Buffer.alloc(44);
    header.write("RIFF", 0); header.writeUInt32LE(36 + audio.length, 4);
    header.write("WAVE", 8); header.write("fmt ", 12); header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
    header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28);
    header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
    header.write("data", 36); header.writeUInt32LE(audio.length, 40);
    wav = Buffer.concat([header, audio]);
  }
  await fs.writeFile(outputPath, wav);
}

async function runJob(job, videoBuffer, segments, visualTexts, apiKey) {
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
    const visual = (Array.isArray(visualTexts) ? visualTexts : []).map(v => ({
      start: Math.max(0, Math.min(duration, Number(v.start) || 0)),
      end: Math.max(0, Math.min(duration, Number(v.end) || 0)),
      x: Math.max(0, Math.min(1, Number(v.x) || 0)),
      y: Math.max(0, Math.min(1, Number(v.y) || 0)),
      width: Math.max(0, Math.min(1, Number(v.width) || 0)),
      height: Math.max(0, Math.min(1, Number(v.height) || 0)),
      text: String(v.translation || "").trim()
    })).filter(v => v.text && v.end > v.start && v.width > 0 && v.height > 0).slice(0, 120);
    const videoFilters = [];
    if (visual.length) {
      const fontExists = await fs.access(KHMER_FONT).then(() => true).catch(() => false);
      if (!fontExists) throw new Error("មិនទាន់មានពុម្ពអក្សរខ្មែរនៅលើ Render ទេ។ សូមដំឡើង Noto Sans Khmer ឬកំណត់ KHMER_FONT_PATH។");
      const esc = value => String(value).replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'").replace(/%/g, "\\%");
      for (let i = 0; i < visual.length; i++) {
        const v = visual[i];
        const textFile = path.join(dir, "visual-" + i + ".txt");
        await fs.writeFile(textFile, v.text, "utf8");
        const x = "trunc(iw*" + v.x + ")";
        const y = "trunc(ih*" + v.y + ")";
        const w = "trunc(iw*" + v.width + ")";
        const h = "trunc(ih*" + v.height + ")";
        videoFilters.push("drawbox=x=" + x + ":y=" + y + ":w=" + w + ":h=" + h + ":color=black:t=fill:enable='between(t," + v.start.toFixed(3) + "," + v.end.toFixed(3) + ")'");
        videoFilters.push("drawtext=fontfile='" + esc(KHMER_FONT) + "':textfile='" + esc(textFile) + "':fontcolor=white:fontsize='max(16,ih*0.035)':x=" + x + "+8:y=" + y + "+max(0,(" + h + "-text_h)/2):box=0:enable='between(t," + v.start.toFixed(3) + "," + v.end.toFixed(3) + ")'");
      }
      filters.push("[0:v]" + videoFilters.join(",") + "[vout]");
    }
    args.push(
      "-filter_complex", filters.join(";"),
      "-map", visual.length ? "[vout]" : "0:v:0",
      "-map", "[aout]",
      "-c:v", visual.length ? "libx264" : "copy",
      ...(visual.length ? ["-preset", "veryfast", "-crf", "22"] : []),
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

export function createDubbingRouter(upload, aiRateLimit) {
  const router = express.Router();
  router.post("/api/dub", aiRateLimit, (req, res, next) => {
    if (!process.env.GEMINI_API_KEY) return res.status(503).json({ ok: false, error: "Backend មិនទាន់កំណត់ GEMINI_API_KEY នៅ Render Environment ទេ។" });
    next();
  }, upload.single("video"), (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, error: "សូមជ្រើសរើសវីដេអូ។" });
    let segments, visualTexts;
    try { segments = JSON.parse(req.body.segments || "[]"); visualTexts = JSON.parse(req.body.visualTexts || "[]"); }
    catch { return res.status(400).json({ ok: false, error: "ទិន្នន័យ Subtitle មិនត្រឹមត្រូវទេ។" }); }
    if (!Array.isArray(segments) || !segments.length || segments.length > MAX_SEGMENTS || !Array.isArray(visualTexts) || visualTexts.length > 120) {
      return res.status(400).json({ ok: false, error: "ចំនួនឃ្លាត្រូវមានពី 1 ដល់ " + MAX_SEGMENTS + "។" });
    }
    const id = crypto.randomUUID();
    const job = { id, status: "processing", progress: 2, stage: "បានទទួលវីដេអូ", createdAt: Date.now(), updatedAt: Date.now() };
    jobs.set(id, job);
    runJob(job, req.file.buffer, segments, visualTexts, process.env.GEMINI_API_KEY)
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
