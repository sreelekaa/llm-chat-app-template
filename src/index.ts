const MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const STT_MODEL = "@cf/openai/whisper-large-v3-turbo";

const SYSTEM_PROMPT =
  "You are a helpful, friendly voice assistant for Speedbot. " +
  "Give short, natural conversational answers. " +
  "Keep responses concise because they will be spoken aloud.";

export default {
  async fetch(request: Request, env: any) {
    const url = new URL(request.url);

    // ============================================================
    // HEALTH CHECK
    // ============================================================

    if (url.pathname === "/api/health") {
      return Response.json({
        status: "ok",
        service: "Speedbot Custom Voice Agent"
      });
    }

    // ============================================================
    // VOICE API
    // ============================================================

  if (
  url.pathname === "/api/voice" &&
  request.method === "POST"
) {
  try {
    const formData = await request.formData();
    const audioFile = formData.get("audio");

    if (!audioFile) {
      return Response.json(
        {
          success: false,
          error: "audio is required"
        },
        { status: 400 }
      );
    }

    // ----------------------------------------------------
    // 1. SPEECH → TEXT
    // ----------------------------------------------------

    const audioBuffer =
      await (audioFile as File).arrayBuffer();

    const bytes =
      new Uint8Array(audioBuffer);

    let binary = "";

    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }

    const audioBase64 = btoa(binary);

    const transcription =
      await env.AI.run(STT_MODEL, {
        audio: audioBase64,
        task: "transcribe",
        language: "en"
      });

    const userText =
      transcription.text?.trim();

    if (!userText) {
      return Response.json(
        {
          success: false,
          error: "Could not understand the audio"
        },
        { status: 400 }
      );
    }

    console.log("USER:", userText);

    // ----------------------------------------------------
    // 2. LLM
    // ----------------------------------------------------

    const result =
      await env.AI.run(
        MODEL_ID,
        {
          messages: [
            {
              role: "system",
              content: SYSTEM_PROMPT
            },
            {
              role: "user",
              content: userText
            }
          ],
          max_tokens: 100,
          temperature: 0.6
        }
      );

    const aiText =
      result.response?.trim();

    console.log("AI:", aiText);

    // ----------------------------------------------------
    // 3. SPLIT RESPONSE INTO SHORT SENTENCES
    // ----------------------------------------------------

    const sentences =
      aiText
        .match(/[^.!?]+[.!?]+|[^.!?]+$/g)
        ?.map((s: string) => s.trim())
        .filter(Boolean) || [aiText];

    console.log(
      "TTS chunks:",
      sentences
    );

    // ----------------------------------------------------
    // 4. GENERATE FIRST CHUNK
    // ----------------------------------------------------

    const firstSentence =
      sentences[0];

    const ttsForm =
      new FormData();

    ttsForm.append(
      "text",
      firstSentence
    );

    const ttsResponse =
      await fetch(
        `${env.CHATTERBOX_URL}/tts`,
        {
          method: "POST",
          body: ttsForm
        }
      );

    if (!ttsResponse.ok) {
      const errorText =
        await ttsResponse.text();

      return Response.json(
        {
          success: false,
          error: "Chatterbox TTS failed",
          details: errorText
        },
        { status: 502 }
      );
    }

    const audio =
      await ttsResponse.arrayBuffer();

    // ----------------------------------------------------
    // 5. RETURN FIRST AUDIO IMMEDIATELY
    // ----------------------------------------------------

    return new Response(audio, {
      status: 200,
      headers: {
        "Content-Type": "audio/wav",

        "X-User-Text":
          encodeURIComponent(userText),

        "X-AI-Response":
          encodeURIComponent(aiText),

        "X-TTS-Chunks":
          encodeURIComponent(
            JSON.stringify(sentences)
          ),

        "Access-Control-Allow-Origin": "*"
      }
    });

  } catch (error) {

    console.error(
      "VOICE ERROR:",
      error
    );

    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unknown error"
      },
      { status: 500 }
    );
  }
}
    //=============================================================
   // /api/tts
    //=============================================================

    if (
  url.pathname === "/api/tts" &&
  request.method === "POST"
) {
  try {
    const body = await request.json();

    const text =
      body.text?.trim();

    if (!text) {
      return Response.json(
        {
          success: false,
          error: "text is required"
        },
        { status: 400 }
      );
    }

    const formData =
      new FormData();

    formData.append(
      "text",
      text
    );

    const response =
      await fetch(
        `${env.CHATTERBOX_URL}/tts`,
        {
          method: "POST",
          body: formData
        }
      );

    if (!response.ok) {
      return Response.json(
        {
          success: false,
          error: "Chatterbox TTS failed"
        },
        { status: 502 }
      );
    }

    const audio =
      await response.arrayBuffer();

    return new Response(audio, {
      status: 200,
      headers: {
        "Content-Type": "audio/wav",
        "Access-Control-Allow-Origin": "*"
      }
    });

  } catch (error) {

    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unknown error"
      },
      { status: 500 }
    );
  }
}
    // ============================================================
    // SPEEDBOT FRONTEND
    // ============================================================

    if (url.pathname === "/") {

      return new Response(
        `<!DOCTYPE html>

<html lang="en">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0"
/>

<title>
Speedbot Voice Assistant
</title>

<style>

* {
  box-sizing: border-box;
}

body {

  margin: 0;

  min-height: 100vh;

  font-family:
    Inter,
    Arial,
    sans-serif;

  background:
    linear-gradient(
      135deg,
      #f8fafc,
      #eef2ff
    );

  display: flex;

  justify-content: center;

  align-items: center;

  color: #111827;
}

.container {

  width: 92%;

  max-width: 700px;

  background: white;

  border-radius: 24px;

  padding: 32px;

  box-shadow:
    0 20px 60px
    rgba(0,0,0,0.12);
}

.header {

  text-align: center;

  margin-bottom: 25px;
}

.logo {

  font-size: 42px;

  margin-bottom: 8px;
}

h1 {

  margin: 0;

  font-size: 30px;
}

.subtitle {

  margin-top: 8px;

  color: #6b7280;

  font-size: 15px;
}

.status {

  text-align: center;

  margin: 20px 0;

  padding: 12px;

  border-radius: 12px;

  background: #f3f4f6;

  color: #4b5563;

  font-size: 14px;
}

.conversation {

  height: 300px;

  overflow-y: auto;

  padding: 15px;

  border-radius: 16px;

  background: #f9fafb;

  margin-bottom: 25px;
}

.message {

  margin-bottom: 15px;

  padding: 12px 15px;

  border-radius: 14px;

  max-width: 85%;

  line-height: 1.5;

  font-size: 14px;
}

.user {

  margin-left: auto;

  background: #e0e7ff;

  text-align: right;
}

.ai {

  margin-right: auto;

  background: #f3f4f6;
}

.mic-container {

  display: flex;

  justify-content: center;

  align-items: center;
}

.mic-button {

  width: 80px;

  height: 80px;

  border: none;

  border-radius: 50%;

  background: #111827;

  color: white;

  font-size: 30px;

  cursor: pointer;

  transition:
    transform 0.2s,
    box-shadow 0.2s;
}

.mic-button:hover {

  transform: scale(1.05);
}

.mic-button.recording {

  background: #dc2626;

  box-shadow:
    0 0 0 12px
    rgba(220,38,38,0.15);

  animation:
    pulse 1.2s infinite;
}

@keyframes pulse {

  0% {
    transform: scale(1);
  }

  50% {
    transform: scale(1.08);
  }

  100% {
    transform: scale(1);
  }

}

.footer {

  text-align: center;

  margin-top: 20px;

  font-size: 12px;

  color: #9ca3af;
}

</style>

</head>

<body>

<div class="container">

  <div class="header">

    <div class="logo">
      🎙️
    </div>

    <h1>
      Speedbot Voice Assistant
    </h1>

    <div class="subtitle">
      Custom AI voice powered by Chatterbox V3
    </div>

  </div>


  <div
    id="status"
    class="status"
  >
    Click the microphone and speak
  </div>


  <div
    id="conversation"
    class="conversation"
  >

    <div class="message ai">
      Hello! How can I help you today?
    </div>

  </div>


  <div class="mic-container">

    <button
      id="micButton"
      class="mic-button"
    >
      🎙️
    </button>

  </div>


  <div class="footer">

    Speak naturally. The recording will
    automatically stop when you finish speaking.

  </div>

</div>


<script>

const micButton =
  document.getElementById(
    "micButton"
  );

const status =
  document.getElementById(
    "status"
  );

const conversation =
  document.getElementById(
    "conversation"
  );


let mediaRecorder = null;

let audioChunks = [];

let isRecording = false;


// ============================================================
// MICROPHONE BUTTON
// ============================================================

micButton.onclick =
  async () => {

    // --------------------------------------------------------
    // START RECORDING
    // --------------------------------------------------------

    if (!isRecording) {

      try {

        const stream =
          await navigator.mediaDevices
            .getUserMedia({
              audio: true
            });


        audioChunks = [];


        mediaRecorder =
          new MediaRecorder(
            stream
          );


        mediaRecorder
          .ondataavailable =
          event => {

            if (
              event.data.size > 0
            ) {

              audioChunks.push(
                event.data
              );

            }

          };


        mediaRecorder
          .onstop =
          processRecording;


        mediaRecorder.start();


        isRecording = true;


        micButton
          .classList
          .add("recording");


        micButton.textContent =
          "⏹️";


        status.textContent =
          "Listening... Speak now.";


        // Start silence detection

        detectSilence(
          stream
        );

      }

      catch (error) {

        console.error(
          error
        );

        status.textContent =
          "Please allow microphone access.";

      }

    }

    // --------------------------------------------------------
    // MANUAL STOP
    // --------------------------------------------------------

    else {

      stopVoice();

    }

  };


// ============================================================
// AUTOMATIC SILENCE DETECTION
// ============================================================

function detectSilence(
  stream
) {

  const audioContext =
    new (
      window.AudioContext ||
      window.webkitAudioContext
    )();


  const source =
    audioContext
      .createMediaStreamSource(
        stream
      );


  const analyser =
    audioContext
      .createAnalyser();


  analyser.fftSize = 512;


  source.connect(
    analyser
  );


  const data =
    new Uint8Array(
      analyser.fftSize
    );


  let silenceStart =
    null;


  function checkAudio() {

    if (!isRecording) {

      audioContext.close();

      return;

    }


    analyser
      .getByteTimeDomainData(
        data
      );


    let sum = 0;


    for (
      let i = 0;
      i < data.length;
      i++
    ) {

      const value =
        (
          data[i] - 128
        ) / 128;


      sum +=
        value * value;

    }


    const volume =
      Math.sqrt(
        sum / data.length
      );


    // ------------------------------------------------------
    // SILENCE THRESHOLD
    // ------------------------------------------------------

    if (
      volume < 0.02
    ) {

      if (
        !silenceStart
      ) {

        silenceStart =
          Date.now();

      }


      // Stop after 800ms silence

      if (
        Date.now() -
        silenceStart >
        800
      ) {

        stopVoice();

        audioContext.close();

        return;

      }

    }

    else {

      silenceStart =
        null;

    }


    requestAnimationFrame(
      checkAudio
    );

  }


  checkAudio();

}


// ============================================================
// STOP RECORDING
// ============================================================

function stopVoice() {

  if (!isRecording) {

    return;

  }


  isRecording = false;


  if (
    mediaRecorder &&
    mediaRecorder.state !==
      "inactive"
  ) {

    mediaRecorder.stop();

  }


  if (
    mediaRecorder &&
    mediaRecorder.stream
  ) {

    mediaRecorder.stream
      .getTracks()
      .forEach(
        track =>
          track.stop()
      );

  }


  micButton
    .classList
    .remove(
      "recording"
    );


  micButton.textContent =
    "🎙️";


  status.textContent =
    "Processing your voice...";

}


// ============================================================
// PROCESS RECORDING
// ============================================================

async function processRecording() {

  try {

    const audioBlob =
      new Blob(
        audioChunks,
        {
          type: "audio/webm"
        }
      );

    if (audioBlob.size === 0) {

      status.textContent =
        "No audio detected.";

      return;
    }

    const formData =
      new FormData();

    formData.append(
      "audio",
      audioBlob,
      "voice.webm"
    );

    status.textContent =
      "Thinking...";

    // ============================================================
    // STT → LLM → FIRST TTS
    // ============================================================

    const response =
      await fetch(
        "/api/voice",
        {
          method: "POST",
          body: formData
        }
      );

    if (!response.ok) {

      let errorText =
        "Voice request failed.";

      try {

        const errorData =
          await response.json();

        errorText =
          errorData.error ||
          errorText;

      }

      catch (_) {}

      throw new Error(
        errorText
      );
    }

    // ============================================================
    // USER TEXT
    // ============================================================

    const userHeader =
      response.headers.get(
        "X-User-Text"
      );

    if (userHeader) {

      const userText =
        decodeURIComponent(
          userHeader
        );

      addMessage(
        "You",
        userText
      );
    }

    // ============================================================
    // AI TEXT
    // ============================================================

    const aiHeader =
      response.headers.get(
        "X-AI-Response"
      );

    let aiText = "";

    if (aiHeader) {

      aiText =
        decodeURIComponent(
          aiHeader
        );

      addMessage(
        "Speedbot",
        aiText
      );
    }

    // ============================================================
    // GET TTS CHUNKS
    // ============================================================

    const chunksHeader =
      response.headers.get(
        "X-TTS-Chunks"
      );

    let chunks = [];

    if (chunksHeader) {

      try {

        chunks =
          JSON.parse(
            decodeURIComponent(
              chunksHeader
            )
          );

      }

      catch (error) {

        console.error(
          "Could not parse TTS chunks:",
          error
        );

      }
    }

    if (!chunks.length && aiText) {

      chunks =
        splitText(
          aiText
        );
    }

    if (!chunks.length) {

      chunks = [
        aiText
      ];
    }

    console.log(
      "TTS chunks:",
      chunks
    );

    // ============================================================
    // FIRST AUDIO
    // Already generated by /api/voice
    // ============================================================

    status.textContent =
      "Speaking...";

    const firstBuffer =
      await response.arrayBuffer();

    const firstBlob =
      new Blob(
        [firstBuffer],
        {
          type: "audio/wav"
        }
      );

    const firstUrl =
      URL.createObjectURL(
        firstBlob
      );

    const firstAudio =
      new Audio(
        firstUrl
      );

    // ============================================================
    // PREFETCH CHUNK 2 WHILE CHUNK 1 IS READY/PLAYING
    // ============================================================

    let nextAudioPromise =
      null;

    if (chunks.length > 1) {

      console.log(
        "Prefetching chunk 2..."
      );

      nextAudioPromise =
        fetchTTS(
          chunks[1]
        );
    }

    // ============================================================
    // PLAY FIRST CHUNK
    // ============================================================

    await playAudio(
      firstAudio
    );

    // ============================================================
    // PLAY REMAINING CHUNKS
    // ============================================================

    for (
      let i = 1;
      i < chunks.length;
      i++
    ) {

      status.textContent =
        "Speaking...";

      let currentAudio;

      // ----------------------------------------------------------
      // Use already-prefetched audio
      // ----------------------------------------------------------

      if (
        i === 1 &&
        nextAudioPromise
      ) {

        currentAudio =
          await nextAudioPromise;

      }

      else {

        currentAudio =
          await fetchTTS(
            chunks[i]
          );
      }

      // ----------------------------------------------------------
      // Start generating the next chunk immediately
      // while the current chunk is being played
      // ----------------------------------------------------------

      if (
        i + 1 < chunks.length
      ) {

        console.log(
          "Prefetching chunk:",
          i + 2
        );

        nextAudioPromise =
          fetchTTS(
            chunks[i + 1]
          );

      }

      else {

        nextAudioPromise =
          null;
      }

      // ----------------------------------------------------------
      // Play current chunk
      // ----------------------------------------------------------

      await playAudio(
        currentAudio
      );
    }

    URL.revokeObjectURL(
      firstUrl
    );

    status.textContent =
      "Click the microphone and speak.";

  }

  catch (error) {

    console.error(
      "VOICE ERROR:",
      error
    );

    status.textContent =
      "Error: " +
      (
        error.message ||
        "Voice request failed"
      );
  }
}


// ============================================================
// FETCH TTS AUDIO
// ============================================================

async function fetchTTS(
  text
) {

  console.log(
    "Generating TTS:",
    text
  );

  const response =
    await fetch(
      "/api/tts",
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body: JSON.stringify({
          text: text
        })
      }
    );

  if (!response.ok) {

    throw new Error(
      "TTS request failed"
    );
  }

  const buffer =
    await response.arrayBuffer();

  const blob =
    new Blob(
      [buffer],
      {
        type: "audio/wav"
      }
    );

  const url =
    URL.createObjectURL(
      blob
    );

  return new Audio(
    url
  );
}


// ============================================================
// PLAY AUDIO
// ============================================================

function playAudio(
  audio
) {

  return new Promise(
    (resolve, reject) => {

      audio.onended =
        () => {

          if (audio.src) {

            URL.revokeObjectURL(
              audio.src
            );
          }

          resolve();
        };

      audio.onerror =
        () => {

          reject(
            new Error(
              "Audio playback failed"
            )
          );
        };

      audio.play()
        .catch(
          reject
        );
    }
  );
}


// ============================================================
// TEXT SPLITTER
// ============================================================

function splitText(
  text
) {

  if (!text) {

    return [];
  }

  return (
    text
      .match(
        /[^.!?]+[.!?]+|[^.!?]+$/g
      )
      ?.map(
        (s) => s.trim()
      )
      .filter(Boolean)
    || [text]
  );
}


// ============================================================
// ADD MESSAGE
// ============================================================

function addMessage(
  sender,
  text
) {

  const message =
    document.createElement(
      "div"
    );


  message.className =
    "message " +
    (
      sender === "You"
        ? "user"
        : "ai"
    );


  message.innerHTML =
    "<strong>" +
    sender +
    ":</strong><br>" +
    escapeHtml(text);


  conversation.appendChild(
    message
  );


  conversation.scrollTop =
    conversation.scrollHeight;

}


// ============================================================
// ESCAPE HTML
// ============================================================

function escapeHtml(
  text
) {

  const div =
    document.createElement(
      "div"
    );

  div.textContent =
    text;

  return div.innerHTML;

}

</script>

</body>

</html>`,

        {
          headers: {
            "Content-Type":
              "text/html; charset=UTF-8"
          }
        }
      );
    }

    // ============================================================
    // FALLBACK
    // ============================================================

    return new Response(
      "Not Found",
      {
        status: 404
      }
    );
  }
};
