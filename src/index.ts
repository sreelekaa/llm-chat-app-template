const MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const STT_MODEL = "@cf/openai/whisper-large-v3-turbo";

const SYSTEM_PROMPT =
  "You are a helpful, friendly voice assistant for Speedbot. " +
  "Give short, natural conversational answers. " +
  "Keep responses concise because they will be spoken aloud.";

export default {
  async fetch(request: Request, env: any) {

    const url = new URL(request.url);

    // CORS
    if (request.method === "OPTIONS") {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}
    

    // Homepage
    if (url.pathname === "/") {
      return new Response(HTML, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=UTF-8"
        }
      });
    }

    // Health check
    if (url.pathname === "/api/health") {
      return Response.json({
        status: "ok",
        service: "Speedbot Custom Voice Agent"
      });
    }

    // Voice API
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
            {
              status: 400,
              headers: {
                "Access-Control-Allow-Origin": "*"
              }
            }
          );
        }

        // Read audio
        const audioBuffer =
          await (audioFile as File).arrayBuffer();

        const bytes =
          new Uint8Array(audioBuffer);

        let binary = "";

        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }

        const audioBase64 = btoa(binary);

        // Whisper STT
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
            {
              status: 400,
              headers: {
                "Access-Control-Allow-Origin": "*"
              }
            }
          );
        }

        console.log("USER:", userText);

        // Llama
        const result =
          await env.AI.run(MODEL_ID, {
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
          });

        const aiText =
          result.response?.trim();

        console.log("AI:", aiText);

        // Chatterbox
        const ttsForm = new FormData();

        ttsForm.append(
          "text",
          aiText
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
            {
              status: 502,
              headers: {
                "Access-Control-Allow-Origin": "*"
              }
            }
          );
        }

        const audio =
          await ttsResponse.arrayBuffer();

        return new Response(audio, {
          status: 200,
          headers: {
            "Content-Type": "audio/wav",
            "Access-Control-Allow-Origin": "*",
            "X-User-Text":
              encodeURIComponent(userText),
            "X-AI-Response":
              encodeURIComponent(aiText)
          }
        });

      } catch (error: any) {

        console.error(
          "VOICE ERROR:",
          error
        );

        return Response.json(
          {
            success: false,
            error: error.message
          },
          {
            status: 500,
            headers: {
              "Access-Control-Allow-Origin": "*"
            }
          }
        );
      }
    }

    return new Response("Not Found", {
      status: 404
    });
  }
};


/*
 * Speedbot frontend
 */

const HTML = `

<!DOCTYPE html>

<html lang="en">

<head>

<meta charset="UTF-8">

<meta name="viewport"
content="width=device-width, initial-scale=1.0">

<title>Speedbot AI Voice Demo</title>

<style>

* {
    box-sizing: border-box;
}

body {
    margin: 0;
    min-height: 100vh;
    font-family: Arial, sans-serif;
    background: #f5f7fb;
    color: #1f2937;
}

header {
    text-align: center;
    padding: 60px 20px 30px;
}

.badge {
    display: inline-block;
    padding: 7px 14px;
    border-radius: 20px;
    background: #e8eefc;
    color: #3157c8;
    font-size: 12px;
    font-weight: bold;
    letter-spacing: 1px;
}

h1 {
    font-size: 42px;
    margin: 18px 0 10px;
}

header p {
    font-size: 22px;
    margin: 0 0 8px;
    color: #4b5563;
}

header span {
    color: #6b7280;
    font-size: 14px;
}

.voice-container {
    width: min(700px, 92%);
    margin: 20px auto 60px;
    padding: 30px;
    background: white;
    border-radius: 20px;
    box-shadow: 0 10px 35px rgba(0,0,0,.08);
}

.conversation {
    height: 330px;
    overflow-y: auto;
    padding: 10px;
    border: 1px solid #e5e7eb;
    border-radius: 14px;
    background: #fafafa;
}

.message {
    max-width: 85%;
    padding: 14px 16px;
    margin-bottom: 16px;
    border-radius: 14px;
    line-height: 1.5;
}

.message.user {
    margin-left: auto;
    background: #e8eefc;
}

.message.assistant {
    margin-right: auto;
    background: #eeeeee;
}

.label {
    font-size: 12px;
    font-weight: bold;
    color: #6b7280;
    margin-bottom: 5px;
}

.status {
    text-align: center;
    color: #6b7280;
    font-size: 14px;
    margin: 20px 0;
}

.mic-button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 90px;
    height: 90px;
    margin: auto;
    border: none;
    border-radius: 50%;
    background: #3157c8;
    color: white;
    font-size: 36px;
    cursor: pointer;
}

.mic-button.recording {
    background: #dc2626;
    animation: pulse 1.5s infinite;
}

@keyframes pulse {
    0% {
        box-shadow: 0 0 0 0 rgba(220,38,38,.4);
    }

    70% {
        box-shadow: 0 0 0 20px rgba(220,38,38,0);
    }

    100% {
        box-shadow: 0 0 0 0 rgba(220,38,38,0);
    }
}

.mic-hint {
    text-align: center;
    color: #9ca3af;
    font-size: 13px;
}

</style>

</head>

<body>

<header>

<div class="badge">
AI VOICE AGENT
</div>

<h1>
Speedbot AI Voice Demo
</h1>

<p>
Custom Voice Agent
</p>

<span>
Whisper • Llama 3.3 • Chatterbox V3
</span>

</header>


<div class="voice-container">

<div id="conversation"
class="conversation">

<div class="message assistant">

<div class="label">
Speedbot
</div>

<div>
Hello! I'm your Speedbot voice assistant.
How can I help you?
</div>

</div>

</div>


<div id="status"
class="status">

Click the microphone to start speaking.

</div>


<button
id="micButton"
class="mic-button">

🎙️

</button>


<p class="mic-hint">
Click to speak • Click again to stop
</p>

</div>


<script>

const micButton =
document.getElementById("micButton");

const status =
document.getElementById("status");

const conversation =
document.getElementById("conversation");

let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;


micButton.onclick = async () => {

    if (!isRecording) {

        try {

            const stream =
                await navigator.mediaDevices
                .getUserMedia({
                    audio: true
                });

            audioChunks = [];

            mediaRecorder =
                new MediaRecorder(stream);

            mediaRecorder.ondataavailable =
                event => {

                    if (event.data.size > 0) {
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
                "Listening... Speak now.";

        }

        catch (error) {

            console.error(error);

            status.textContent =
                "Please allow microphone access.";
        }

    } else {

        mediaRecorder.stop();

        mediaRecorder.stream
            .getTracks()
            .forEach(
                track => track.stop()
            );

        isRecording = false;

        micButton.classList.remove(
            "recording"
        );

        micButton.textContent =
            "🎙️";

        status.textContent =
            "Processing your voice...";
    }

};


async function processRecording() {

    try {

        const audioBlob =
            new Blob(
                audioChunks,
                {
                    type:
                        mediaRecorder.mimeType
                }
            );

        const formData =
            new FormData();

        formData.append(
            "audio",
            audioBlob,
            "voice.webm"
        );

        const response =
            await fetch(
                "/api/voice",
                {
                    method: "POST",
                    body: formData
                }
            );

if (!response.ok) {

    const errorText = await response.text();

    console.error("API ERROR:", errorText);

    throw new Error(
        `API ${response.status}: ${errorText}`
    );
}

        const userHeader =
            response.headers.get(
                "X-User-Text"
            );

        const aiHeader =
            response.headers.get(
                "X-AI-Response"
            );

        if (userHeader) {

            addMessage(
                "You",
                decodeURIComponent(
                    userHeader
                ),
                "user"
            );
        }

        if (aiHeader) {

            addMessage(
                "Speedbot",
                decodeURIComponent(
                    aiHeader
                ),
                "assistant"
            );
        }

        status.textContent =
            "Playing response...";

        const blob =
            await response.blob();

        const audio =
            new Audio(
                URL.createObjectURL(blob)
            );

        audio.onended = () => {

            status.textContent =
                "Click the microphone to speak again.";
        };

        await audio.play();

    }

catch (error) {

    console.error("VOICE ERROR:", error);

    status.textContent =
        "Error: " + error.message;
}

}


function addMessage(
    speaker,
    text,
    type
) {

    const message =
        document.createElement("div");

    message.className =
        "message " + type;

    const label =
        document.createElement("div");

    label.className =
        "label";

    label.textContent =
        speaker;

    const content =
        document.createElement("div");

    content.textContent =
        text;

    message.appendChild(label);

    message.appendChild(content);

    conversation.appendChild(message);

    conversation.scrollTop =
        conversation.scrollHeight;
}

</script>

</body>

</html>

`;
