import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { makeSpeech } from "./dubbing.js";

test("makeSpeech sends transcript as speech text and saves the complete WAV response", async () => {
  const originalFetch = globalThis.fetch;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tk-tts-test-"));
  const output = path.join(directory, "speech.wav");
  const wav = Buffer.alloc(2048);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24);
  wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(wav.length - 44, 40);

  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/interactions");
      assert.equal(options.headers["x-goog-api-key"], "test-key");
      const request = JSON.parse(options.body);
      assert.equal(request.model, "gemini-3.8-flash-tts");
      assert.equal(request.input[0].content[0].text, "សួស្តី");
      assert.equal(request.input[0].content[0].annotations[0].type, "speech_metadata");
      assert.equal(request.response_format.type, "audio");
      return new Response(JSON.stringify({ output_audio: { data: wav.toString("base64") } }), {
        status: 200, headers: { "Content-Type": "application/json" }
      });
    };

    await makeSpeech("សួស្តី", "test-key", output);
    const saved = await fs.readFile(output);
    assert.deepEqual(saved, wav);
    assert.equal(saved.subarray(0, 4).toString(), "RIFF");
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("makeSpeech reports Gemini API errors without creating an audio file", async () => {
  const originalFetch = globalThis.fetch;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tk-tts-error-"));
  const output = path.join(directory, "speech.wav");
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      error: { message: "Model unavailable" }
    }), { status: 404, headers: { "Content-Type": "application/json" } });
    await assert.rejects(() => makeSpeech("សួស្តី", "test-key", output), /Model unavailable/);
    await assert.rejects(() => fs.access(output));
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
