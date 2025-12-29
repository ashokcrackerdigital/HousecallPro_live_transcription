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
let fullConversation = "";
let silenceTimer = null;
let decisionAlreadyMade = false;
let nonMeaningfulCount = 0;
const NON_MEANINGFUL_THRESHOLD = 3;
const FINAL_DECISION_DELAY = 4000;


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
      const transcript = response.text.trim();
      console.log("📝 CUSTOMER:", transcript);

      const meaningful = isMeaningfulText(transcript);

      if (meaningful) {
        fullConversation += " " + transcript;
        nonMeaningfulCount = 0; // reset on real speech
      } else {
        nonMeaningfulCount += 1;
      }

      // Clear previous timer
      if (silenceTimer) clearTimeout(silenceTimer);

      // Only consider final decision if:
      // - meaningful text already happened
      // - AND user is now quiet / meaningless repeatedly
      if (
        fullConversation.trim().length > 0 &&
        nonMeaningfulCount >= NON_MEANINGFUL_THRESHOLD &&
        !decisionAlreadyMade
      ) {
        silenceTimer = setTimeout(async () => {
          decisionAlreadyMade = true;

          console.log("\n⏳ CUSTOMER FINISHED — FINALIZING DECISION...\n");

          const decision = await getStructuredDecision(fullConversation);

          if (decision) {
            console.log("🤖 FINAL LLM DECISION:");
            console.log(JSON.stringify(decision, null, 2));
          }

          // OPTIONAL reset for next call
          // fullConversation = "";
          // nonMeaningfulCount = 0;
          // decisionAlreadyMade = false;

        }, FINAL_DECISION_DELAY);
      }
    }



  } catch (err) {
    console.error("❌ Transcription error:", err.message);
  } finally {
    // cleanup
    if (fs.existsSync(rawFile)) fs.unlinkSync(rawFile);
    if (fs.existsSync(wavFile)) fs.unlinkSync(wavFile);
  }
}

// async function getChatGPTReply(userText) {
//   try {
//     const response = await openai.responses.create({
//       model: "gpt-4.1-mini",
//       input: [
//         {
//           role: "system",
//           content:
//             "You are a helpful call assistant. Reply clearly and politely as if talking to a customer on a service call.",
//         },
//         {
//           role: "user",
//           content: userText,
//         },
//       ],
//     });

//     return response.output_text;
//   } catch (err) {
//     console.error("❌ ChatGPT error:", err.message);
//     return null;
//   }
// }


async function getStructuredDecision(conversationText) {
  try {
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content: `
You are a call intake assistant for an HVAC company.

Your task:
- Analyze the full customer call conversation
- Extract structured scheduling data
- Assign priority strictly using these rules:

Priority Rules:
P1 (Emergency): No heat in winter, gas smell, water leaks, dangerous conditions.
P2 (Urgent): No cooling in extreme heat, intermittent heat, noisy equipment, red-tag follow-up.
P3 (Standard): Regular diagnostics, minor issues.
P4 (Planned): Maintenance, tune-ups, quotes.

Rules:
- Do NOT invent information
- If info missing, use null
- Respond ONLY in valid JSON
- No explanations, no extra text
`
        },
        {
          role: "user",
          content: `
Customer conversation:
"${conversationText}"

Return output in this JSON format ONLY:

{
  "job_type": string | null,
  "priority": "P1" | "P2" | "P3" | "P4" | null,
  "issue_summary": string,
  "estimated_duration_minutes": number | null,
  "customer_constraints": {
    "same_day_preferred": boolean,
    "time_window": string | null
  },
  "location": {
    "address": string | null,
    "city": string | null
  },
  "recommended_action": string
}
`
        }
      ],
      temperature: 0.2
    });

    return JSON.parse(response.output_text);
  } catch (err) {
    console.error("❌ LLM error:", err.message);
    return null;
  }
}

function isMeaningfulText(text) {
  const cleaned = text
    .replace(/[^\w\s]/gi, "")
    .trim()
    .toLowerCase();

  if (!cleaned) return false;

  // Ignore fillers / acknowledgements
  const ignoreWords = ["ok", "okay", "thanks", "thank you", "yes", "no"];
  if (ignoreWords.includes(cleaned)) return false;

  return cleaned.length > 3;
}
