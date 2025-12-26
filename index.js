require("dotenv").config();

const record = require("node-record-lpcm16");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

console.log("🎧 Listening to customer voice (BlackHole)...");

const SAMPLE_RATE = 16000;
const CHUNK_SECONDS = 5;
const BYTES_PER_SAMPLE = 2;

let audioChunks = [];

const recording = record.record({
  sampleRateHertz: SAMPLE_RATE,
  threshold: 0,
  device: "BlackHole 2ch", // 👈 exact name
  verbose: false,
});

recording.stream().on("data", (chunk) => {
  audioChunks.push(chunk);

  const totalBytes = audioChunks.reduce(
    (sum, b) => sum + b.length,
    0
  );

  if (totalBytes >= SAMPLE_RATE * BYTES_PER_SAMPLE * CHUNK_SECONDS) {
    const buffer = Buffer.concat(audioChunks);
    audioChunks = [];
    transcribe(buffer);
  }
});

async function transcribe(buffer) {
    const rawFile = "temp_audio.raw";
    const wavFile = "temp_audio.wav";
  
    try {
      // 1. Save raw PCM
      fs.writeFileSync(rawFile, buffer);
  
      // 2. Convert RAW PCM → WAV using SoX
      execSync(
        `sox -t raw -r 16000 -e signed-integer -b 16 -c 1 ${rawFile} ${wavFile}`
      );
  
      // 3. Send WAV to OpenAI
      const response = await openai.audio.transcriptions.create({
        file: fs.createReadStream(wavFile),
        model: "whisper-1",
      });
  
      if (response.text?.trim()) {
        console.log("📝", response.text);
      }
    } catch (err) {
      console.error("❌ Transcription error:", err.message);
    } finally {
      // cleanup
      if (fs.existsSync(rawFile)) fs.unlinkSync(rawFile);
      if (fs.existsSync(wavFile)) fs.unlinkSync(wavFile);
    }
  }
  
  