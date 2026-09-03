const MODEL_ID =
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const STT_MODEL =
  "@cf/openai/whisper-large-v3-turbo";

const SYSTEM_PROMPT =
  "You are Speedbot, a friendly and natural voice assistant. " +
  "Have a real conversation with the user, like a helpful human assistant. " +
  "Keep answers concise and easy to speak aloud. " +
  "Do not use headings, bullet points, markdown, or unnecessary explanations. " +
  "Do not repeat the user's question. " +
  "Use natural conversational language. " +
  "Remember and use the previous conversation when answering follow-up questions. " +
  "Ask a short follow-up question when it helps continue the conversation.";

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
    // CONFIG CHECK
    // ============================================================

    if (url.pathname === "/api/config-check") {

      return Response.json({
        chatterbox_configured:
          Boolean(env.CHATTERBOX_URL),

        chatterbox_url_valid:
          Boolean(
            env.CHATTERBOX_URL &&
            /^https?:\/\//.test(
              env.CHATTERBOX_URL
            )
          )
      });

    }

    // ============================================================
    // VOICE API
    //
    // Browser audio
    //       ↓
    // Whisper
    //       ↓
    // Llama
    //       ↓
    // Chatterbox
    //       ↓
    // WAV
    // ============================================================

    if (
      url.pathname === "/api/voice" &&
      request.method === "POST"
    ) {

      try {

        // --------------------------------------------------------
        // READ FORM DATA
        // --------------------------------------------------------

        const formData =
          await request.formData();

        const audioFile =
          formData.get("audio");

        if (!audioFile) {

          return Response.json(
            {
              success: false,
              error: "audio is required"
            },
            {
              status: 400
            }
          );

        }

        // --------------------------------------------------------
        // CONVERSATION HISTORY
        // --------------------------------------------------------

        let history: any[] = [];

        try {

          const historyText =
            formData.get("history");

          if (
            historyText &&
            typeof historyText === "string"
          ) {

            const parsed =
              JSON.parse(historyText);

            if (Array.isArray(parsed)) {

              history = parsed
                .filter(
                  (message) =>
                    message &&
                    (
                      message.role === "user" ||
                      message.role === "assistant"
                    ) &&
                    typeof message.content === "string"
                )
                .slice(-10);

            }

          }

        } catch (error) {

          console.log(
            "Could not parse conversation history"
          );

        }

        // --------------------------------------------------------
        // AUDIO → BASE64
        // --------------------------------------------------------

        const audioBuffer =
          await (audioFile as File)
            .arrayBuffer();

        const bytes =
          new Uint8Array(
            audioBuffer
          );

        let binary = "";

        for (
          let i = 0;
          i < bytes.length;
          i++
        ) {

          binary +=
            String.fromCharCode(
              bytes[i]
            );

        }

        const audioBase64 =
          btoa(binary);

        // --------------------------------------------------------
        // SPEECH TO TEXT
        // --------------------------------------------------------

        const transcription =
          await env.AI.run(
            STT_MODEL,
            {
              audio: audioBase64,
              task: "transcribe",
              language: "en"
            }
          );

        const userText =
          transcription.text?.trim();

        if (!userText) {

          return Response.json(
            {
              success: false,
              error:
                "Could not understand the audio"
            },
            {
              status: 400
            }
          );

        }

        console.log(
          "USER:",
          userText
        );

        // --------------------------------------------------------
        // BUILD CONVERSATION
        // --------------------------------------------------------

        const messages = [

          {
            role: "system",
            content: SYSTEM_PROMPT
          },

          ...history,

          {
            role: "user",
            content: userText
          }

        ];

        // --------------------------------------------------------
        // LLM
        // --------------------------------------------------------

        const result =
          await env.AI.run(
            MODEL_ID,
            {
              messages,

              max_tokens: 120,

              temperature: 0.7
            }
          );

        const aiText =
          result.response?.trim();

        if (!aiText) {

          return Response.json(
            {
              success: false,
              error:
                "The AI did not return a response"
            },
            {
              status: 500
            }
          );

        }

        console.log(
          "AI:",
          aiText
        );

        // --------------------------------------------------------
        // SPLIT RESPONSE INTO SENTENCES
        // --------------------------------------------------------

        const sentences =
          aiText
            .match(
              /[^.!?]+[.!?]+|[^.!?]+$/g
            )
            ?.map(
              (sentence: string) =>
                sentence.trim()
            )
            .filter(Boolean)
            ||
            [aiText];

        console.log(
          "TTS chunks:",
          sentences
        );

        // --------------------------------------------------------
        // FIRST SENTENCE → CHATTERBOX
        // --------------------------------------------------------

        const firstSentence =
          sentences[0];

        const ttsForm =
          new FormData();

        ttsForm.append(
          "text",
          firstSentence
        );

        if (!env.CHATTERBOX_URL) {

          return Response.json(
            {
              success: false,
              error:
                "CHATTERBOX_URL is not configured"
            },
            {
              status: 500
            }
          );

        }

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
              error:
                "Chatterbox TTS failed",
              details:
                errorText
            },
            {
              status: 502
            }
          );

        }

        const audio =
          await ttsResponse.arrayBuffer();

        // --------------------------------------------------------
        // RETURN AUDIO + TEXT
        // --------------------------------------------------------

        return new Response(
          audio,
          {
            status: 200,

            headers: {

              "Content-Type":
                "audio/wav",

              "X-User-Text":
                encodeURIComponent(
                  userText
                ),

              "X-AI-Response":
                encodeURIComponent(
                  aiText
                ),

              "X-TTS-Chunks":
                encodeURIComponent(
                  JSON.stringify(
                    sentences
                  )
                ),

              "Access-Control-Allow-Origin":
                "*"

            }
          }
        );

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
          {
            status: 500
          }
        );

      }

    }

    // ============================================================
    // TEXT → TTS
    //
    // Used for:
    // - Remaining sentences
    // - Voice greeting
    // ============================================================

    if (
      url.pathname === "/api/tts" &&
      request.method === "POST"
    ) {

      try {

        const body =
          await request.json();

        const text =
          body.text?.trim();

        if (!text) {

          return Response.json(
            {
              success: false,
              error: "text is required"
            },
            {
              status: 400
            }
          );

        }

        if (!env.CHATTERBOX_URL) {

          return Response.json(
            {
              success: false,
              error:
                "CHATTERBOX_URL is not configured"
            },
            {
              status: 500
            }
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

          const errorText =
            await response.text();

          return Response.json(
            {
              success: false,
              error:
                "Chatterbox TTS failed",
              details:
                errorText
            },
            {
              status: 502
            }
          );

        }

        const audio =
          await response.arrayBuffer();

        return new Response(
          audio,
          {
            status: 200,

            headers: {
              "Content-Type":
                "audio/wav",

              "Access-Control-Allow-Origin":
                "*"
            }
          }
        );

      } catch (error) {

        console.error(
          "TTS ERROR:",
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
          {
            status: 500
          }
        );

      }

    }

    // ============================================================
    // VOICE ASSISTANT UI
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

  margin-bottom: 20px;

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

  width: 88px;

  height: 88px;

  border: none;

  border-radius: 50%;

  background: #111827;

  color: white;

  font-size: 32px;

  cursor: pointer;

  transition:
    transform 0.2s,
    box-shadow 0.2s;

}

.mic-button:hover {

  transform:
    scale(1.05);

}

.mic-button.voice-mode {

  background: #16a34a;

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
    Click the microphone to start Voice Mode
  </div>


  <div
    id="conversation"
    class="conversation"
  >

    <div class="message ai">
      <strong>Speedbot:</strong><br>
      Hi! I'm Speedbot. Click the microphone and let's talk.
    </div>

  </div>


  <div class="mic-container">

    <button
      id="micButton"
      class="mic-button"
      title="Start Voice Mode"
    >
      🎙️
    </button>

  </div>


  <div class="footer">
    Click once to start continuous Voice Mode.
    Click again to stop.
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


// ============================================================
// STATE
// ============================================================

let mediaRecorder = null;

let audioChunks = [];

let isRecording = false;

let voiceModeActive = false;

let conversationHistory = [];

let currentAudio = null;

let processing = false;


// ============================================================
// MICROPHONE BUTTON
// ============================================================

micButton.onclick =
  async () => {

    // --------------------------------------------------------
    // START VOICE MODE
    // --------------------------------------------------------

    if (!voiceModeActive) {

      voiceModeActive = true;

      micButton.classList.add(
        "voice-mode"
      );

      micButton.textContent =
        "⏹️";

      status.textContent =
        "Starting Voice Mode...";

      await playGreeting();

      if (voiceModeActive) {

        await startListening();

      }

      return;

    }


    // --------------------------------------------------------
    // STOP VOICE MODE
    // --------------------------------------------------------

    voiceModeActive = false;

    stopVoice();

    if (currentAudio) {

      currentAudio.pause();

      currentAudio.currentTime = 0;

    }

    micButton.classList.remove(
      "voice-mode"
    );

    micButton.classList.remove(
      "recording"
    );

    micButton.textContent =
      "🎙️";

    status.textContent =
      "Voice Mode stopped.";

  };


// ============================================================
// GREETING
// ============================================================

async function playGreeting() {

  try {

    status.textContent =
      "Starting Voice Mode...";

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
            text:
              "Hi! I'm Speedbot. How can I help you today?"
          })
        }
      );

    if (!response.ok) {

      throw new Error(
        "Greeting failed"
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

    const audio =
      new Audio(url);

    currentAudio =
      audio;

    await playAudio(
      audio
    );

    URL.revokeObjectURL(
      url
    );

    currentAudio = null;

  } catch (error) {

    console.error(
      "GREETING ERROR:",
      error
    );

    // If greeting fails,
    // still allow Voice Mode
    // to continue.

  }

}


// ============================================================
// START LISTENING
// ============================================================

async function startListening() {

  if (
    !voiceModeActive ||
    isRecording ||
    processing
  ) {

    return;

  }


  try {

    const stream =
      await navigator.mediaDevices
        .getUserMedia({
          audio: true
        });


    audioChunks = [];


    let options = {};

    if (
      MediaRecorder.isTypeSupported(
        "audio/webm;codecs=opus"
      )
    ) {

      options = {
        mimeType:
          "audio/webm;codecs=opus"
      };

    }


    mediaRecorder =
      new MediaRecorder(
        stream,
        options
      );


    mediaRecorder.ondataavailable =
      event => {

        if (
          event.data.size > 0
        ) {

          audioChunks.push(
            event.data
          );

        }

      };


    mediaRecorder.onstop =
      processRecording;


    mediaRecorder.start();


    isRecording = true;


    micButton.classList.add(
      "recording"
    );

    micButton.textContent =
      "⏹️";


    status.textContent =
      "Listening...";


    detectSilence(
      stream
    );


  } catch (error) {

    console.error(
      "MIC ERROR:",
      error
    );

    voiceModeActive = false;

    micButton.classList.remove(
      "voice-mode"
    );

    micButton.classList.remove(
      "recording"
    );

    micButton.textContent =
      "🎙️";

    status.textContent =
      "Please allow microphone access.";

  }

}


// ============================================================
// SILENCE DETECTION
// ============================================================

function detectSilence(
  stream
) {

  const AudioContext =
    window.AudioContext ||
    window.webkitAudioContext;

  const audioContext =
    new AudioContext();


  const source =
    audioContext
      .createMediaStreamSource(
        stream
      );


  const analyser =
    audioContext
      .createAnalyser();


  analyser.fftSize =
    512;


  source.connect(
    analyser
  );


  const data =
    new Uint8Array(
      analyser.fftSize
    );


  let silenceStart = null;

  const recordingStarted =
    Date.now();


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


    // --------------------------------------------------------
    // SILENCE THRESHOLD
    // --------------------------------------------------------

    if (
      volume < 0.02
    ) {

      if (
        !silenceStart
      ) {

        silenceStart =
          Date.now();

      }


      // Don't stop during
      // the first 700ms.

      const recordingDuration =
        Date.now() -
        recordingStarted;


      // Stop after
      // 1200ms silence.

      if (
        recordingDuration > 700 &&
        Date.now() -
          silenceStart >
          1200
      ) {

        stopVoice();

        audioContext.close();

        return;

      }

    } else {

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


  micButton.classList.remove(
    "recording"
  );


  if (
    voiceModeActive
  ) {

    micButton.classList.add(
      "voice-mode"
    );

    micButton.textContent =
      "⏳";

    status.textContent =
      "Thinking...";

  }

}


// ============================================================
// PROCESS RECORDING
// ============================================================

async function processRecording() {

  processing = true;


  try {

    const audioBlob =
      new Blob(
        audioChunks,
        {
          type: "audio/webm"
        }
      );


    if (
      audioBlob.size === 0
    ) {

      processing = false;

      if (
        voiceModeActive
      ) {

        await startListening();

      }

      return;

    }


    const formData =
      new FormData();


    formData.append(
      "audio",
      audioBlob,
      "voice.webm"
    );


    // --------------------------------------------------------
    // SEND CONVERSATION HISTORY
    // --------------------------------------------------------

    formData.append(
      "history",
      JSON.stringify(
        conversationHistory
          .slice(-10)
      )
    );


    status.textContent =
      "Thinking...";


    // --------------------------------------------------------
    // STT → LLM → FIRST TTS
    // --------------------------------------------------------

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

      } catch (_) {}

      throw new Error(
        errorText
      );

    }


    // --------------------------------------------------------
    // USER TEXT
    // --------------------------------------------------------

    const userHeader =
      response.headers.get(
        "X-User-Text"
      );


    let userText = "";


    if (userHeader) {

      userText =
        decodeURIComponent(
          userHeader
        );


      addMessage(
        "You",
        userText
      );


      conversationHistory.push({
        role: "user",
        content: userText
      });

    }


    // --------------------------------------------------------
    // AI TEXT
    // --------------------------------------------------------

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


      conversationHistory.push({
        role: "assistant",
        content: aiText
      });

    }


    // Keep memory manageable.

    conversationHistory =
      conversationHistory
        .slice(-10);


    // --------------------------------------------------------
    // TTS CHUNKS
    // --------------------------------------------------------

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

      } catch (error) {

        console.error(
          "Could not parse TTS chunks:",
          error
        );

      }

    }


    if (
      !chunks.length &&
      aiText
    ) {

      chunks =
        splitText(
          aiText
        );

    }


    if (
      !chunks.length
    ) {

      chunks = [
        aiText
      ];

    }


    // --------------------------------------------------------
    // FIRST AUDIO
    // --------------------------------------------------------

    status.textContent =
      "Speaking...";


    const firstBuffer =
      await response
        .arrayBuffer();


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


    currentAudio =
      firstAudio;


    // --------------------------------------------------------
    // PREFETCH SECOND SENTENCE
    // --------------------------------------------------------

    let nextAudioPromise =
      null;


    if (
      chunks.length > 1
    ) {

      nextAudioPromise =
        fetchTTS(
          chunks[1]
        );

    }


    // --------------------------------------------------------
    // PLAY FIRST SENTENCE
    // --------------------------------------------------------

    await playAudio(
      firstAudio
    );


    // --------------------------------------------------------
    // PLAY REMAINING SENTENCES
    // --------------------------------------------------------

    for (
      let i = 1;
      i < chunks.length;
      i++
    ) {

      if (
        !voiceModeActive
      ) {

        break;

      }


      status.textContent =
        "Speaking...";


      let audio;


      if (
        i === 1 &&
        nextAudioPromise
      ) {

        audio =
          await nextAudioPromise;

      } else {

        audio =
          await fetchTTS(
            chunks[i]
          );

      }


      currentAudio =
        audio;


      // Prefetch next sentence.

      if (
        i + 1 <
        chunks.length
      ) {

        nextAudioPromise =
          fetchTTS(
            chunks[i + 1]
          );

      } else {

        nextAudioPromise =
          null;

      }


      await playAudio(
        audio
      );

    }


    URL.revokeObjectURL(
      firstUrl
    );


    currentAudio = null;


    // --------------------------------------------------------
    // AUTOMATICALLY LISTEN AGAIN
    // --------------------------------------------------------

    if (
      voiceModeActive
    ) {

      status.textContent =
        "Listening...";


      setTimeout(
        () => {

          if (
            voiceModeActive
          ) {

            startListening();

          }

        },
        300
      );

    }


  } catch (error) {

    console.error(
      "VOICE ERROR:",
      error
    );


    if (
      voiceModeActive
    ) {

      status.textContent =
        "Something went wrong. Listening again...";


      setTimeout(
        () => {

          if (
            voiceModeActive
          ) {

            startListening();

          }

        },
        1000
      );

    } else {

      status.textContent =
        "Voice Mode stopped.";

    }

  }


  processing = false;

}


// ============================================================
// FETCH TTS
// ============================================================

async function fetchTTS(
  text
) {

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
    await response
      .arrayBuffer();


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


  const audio =
    new Audio(url);


  audio.onended =
    () => {

      URL.revokeObjectURL(
        url
      );

    };


  return audio;

}


// ============================================================
// PLAY AUDIO
// ============================================================

function playAudio(
  audio
) {

  return new Promise(
    (
      resolve,
      reject
    ) => {

      audio.onended =
        () => {

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
        s =>
          s.trim()
      )
      .filter(Boolean)
    ||
    [text]
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
    escapeHtml(sender) +
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
    // NOT FOUND
    // ============================================================

    return new Response(
      "Not Found",
      {
        status: 404
      }
    );

  }

};
