const MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const FLUX_MODEL = "@cf/deepgram/flux";

const SYSTEM_PROMPT =
  "You are Speedbot, an extroverted, energetic and friendly voice assistant. " +
  "Speak naturally and confidently, like a real person having a conversation. " +
  "Keep the conversation flowing and proactively engage the user. " +
  "Give concise but complete answers, usually 1-2 short sentences. " +
  "When appropriate, add a brief follow-up question or comment to keep the conversation going. " +
  "Do not explain your reasoning. " +
  "Do not repeat the user's question. " +
  "Do not use headings, bullet points, markdown, or unnecessary details.";

const MAX_HISTORY = 6;

function json(data: any, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

function splitSentences(text: string): string[] {
  return (
    text
      .match(/[^.!?]+[.!?]+|[^.!?]+$/g)
      ?.map((s) => s.trim())
      .filter(Boolean) || [text]
  );
}

async function callChatterbox(env: any, text: string): Promise<ArrayBuffer> {
  if (!env.CHATTERBOX_URL) {
    throw new Error("CHATTERBOX_URL is not configured");
  }

  const form = new FormData();
  form.append("text", text);

  const response = await fetch(`${env.CHATTERBOX_URL}/tts`, {
    method: "POST",
    body: form,
  });

  if (!response.ok) {
    throw new Error(
      `Chatterbox TTS failed: ${await response.text()}`
    );
  }

  return response.arrayBuffer();
}

async function generateReply(
  env: any,
  userText: string,
  history: any[]
) {
  const safeHistory = Array.isArray(history)
    ? history
        .filter(
          (m) =>
            m &&
            (m.role === "user" || m.role === "assistant") &&
            typeof m.content === "string"
        )
        .slice(-MAX_HISTORY)
    : [];

  const result = await env.AI.run(MODEL_ID, {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      ...safeHistory,
      { role: "user", content: userText },
    ],
    max_tokens: 55,
    temperature: 0.7,
  });

  const aiText = result.response?.trim();

  if (!aiText) {
    throw new Error("The AI did not return a response");
  }

  const sentences = splitSentences(aiText);

  return {
    aiText,
    sentences,
    firstSentence: sentences[0],
  };
}

async function handleVoiceTurn(
  env: any,
  ws: WebSocket,
  userText: string,
  history: any[]
) {
  if (!userText.trim()) return;

  try {
    ws.send(
      JSON.stringify({
        type: "user_final",
        text: userText,
      })
    );

    ws.send(
      JSON.stringify({
        type: "status",
        value: "thinking",
      })
    );

    const reply = await generateReply(env, userText, history);

    const newHistory = [
      ...(Array.isArray(history) ? history : []),
      { role: "user", content: userText },
      { role: "assistant", content: reply.aiText },
    ].slice(-MAX_HISTORY);

    const audio = await callChatterbox(env, reply.firstSentence);

    ws.send(
      JSON.stringify({
        type: "assistant_text",
        text: reply.aiText,
        chunks: reply.sentences,
        history: newHistory,
      })
    );

    ws.send(
      JSON.stringify({
        type: "status",
        value: "speaking",
      })
    );

    ws.send(audio);

    ws.send(
      JSON.stringify({
        type: "audio_end",
      })
    );

    // IMPORTANT: do NOT await each later sentence one-by-one.
    // The old sequential loop caused a long silence between sentences
    // because every Chatterbox request had to finish before the next
    // request even started. Start the remaining requests together while
    // the browser is already playing sentence #1.
    if (reply.sentences.length > 1) {
      const remaining = reply.sentences.slice(1).map(async (sentence, offset) => {
        const index = offset + 1;

        try {
          const nextAudio = await callChatterbox(env, sentence);

          ws.send(
            JSON.stringify({
              type: "audio_chunk",
              index,
              text: sentence,
            })
          );

          ws.send(nextAudio);
        } catch (error) {
          console.error("Additional TTS error:", error);
        }
      });

      // Keep the WebSocket turn alive until all generated audio has
      // been delivered, but don't delay the first sentence.
      await Promise.allSettled(remaining);
    }

    ws.send(
      JSON.stringify({
        type: "status",
        value: "listening",
      })
    );
  } catch (error) {
    console.error("VOICE TURN ERROR:", error);

    ws.send(
      JSON.stringify({
        type: "error",
        message:
          error instanceof Error
            ? error.message
            : "Voice processing failed",
      })
    );

    ws.send(
      JSON.stringify({
        type: "status",
        value: "listening",
      })
    );
  }
}

async function handleFluxMessage(
  env: any,
  ws: WebSocket,
  data: string | ArrayBuffer,
  state: {
    history: any[];
    processingTurn: boolean;
  }
) {
  if (typeof data !== "string") return;

  let event: any;

  try {
    event = JSON.parse(data);
  } catch {
    return;
  }

  const eventType = event.event;

  const transcript =
    event.transcript ??
    event.channel?.alternatives?.[0]?.transcript ??
    "";

  if (eventType === "Update") {
    if (transcript) {
      ws.send(
        JSON.stringify({
          type: "interim",
          text: transcript,
        })
      );
    }
    return;
  }

  if (eventType === "StartOfTurn") {
    ws.send(
      JSON.stringify({
        type: "status",
        value: "listening",
      })
    );
    return;
  }

  if (eventType === "TurnResumed") {
    ws.send(
      JSON.stringify({
        type: "status",
        value: "listening",
      })
    );
    return;
  }

  if (eventType === "EagerEndOfTurn") {
    if (transcript) {
      ws.send(
        JSON.stringify({
          type: "eager_final",
          text: transcript,
        })
      );
    }
    return;
  }

  if (eventType === "EndOfTurn") {
    if (!transcript || state.processingTurn) return;

    state.processingTurn = true;

    // Process the current turn without closing the Flux connection.
    await handleVoiceTurn(
      env,
      ws,
      transcript.trim(),
      state.history
    );

    // The browser sends the updated history back with the next
    // config message. Keep the local copy updated too.
    state.history = [
      ...state.history,
      { role: "user", content: transcript.trim() },
    ].slice(-MAX_HISTORY);

    state.processingTurn = false;
  }
}

function voiceWebSocket(request: Request, env: any): Promise<Response> | Response {
  const upgrade = request.headers.get("Upgrade");

  if (upgrade?.toLowerCase() !== "websocket") {
    return json(
      {
        success: false,
        error: "WebSocket upgrade required",
      },
      426
    );
  }

  const [client, server] = Object.values(new WebSocketPair());

  server.accept({ allowHalfOpen: true });

  const state = {
    history: [] as any[],
    processingTurn: false,
    upstream: null as WebSocket | null,
  };

  // Connect this client to Cloudflare Workers AI Deepgram Flux.
  (async () => {
    try {
      const fluxResponse = await env.AI.run(
        FLUX_MODEL,
        {
          encoding: "linear16",
          sample_rate: "16000",
          eager_eot_threshold: "0.45",
          eot_threshold: "0.55",
          eot_timeout_ms: "700",
          keyterm: "Speedbot",
          keyterm: "Cloudflare",
          keyterm: "Chatterbox",
        },
        {
          websocket: true,
        }
      );

      const upstream = fluxResponse.webSocket;

      if (!upstream) {
        throw new Error("Flux WebSocket was not created");
      }

      state.upstream = upstream;
      upstream.accept({ allowHalfOpen: true });

      upstream.addEventListener("open", () => {
        server.send(
          JSON.stringify({
            type: "ready",
          })
        );
      });

      upstream.addEventListener("message", async (event) => {
        try {
          await handleFluxMessage(
            env,
            server,
            event.data,
            state
          );
        } catch (error) {
          console.error("Flux message error:", error);
        }
      });

      upstream.addEventListener("error", (event) => {
        console.error("Flux WebSocket error:", event);

        try {
          server.send(
            JSON.stringify({
              type: "error",
              message: "Streaming speech recognition error",
            })
          );
        } catch {}
      });

      upstream.addEventListener("close", () => {
        try {
          if (server.readyState !== WebSocket.CLOSED) {
            server.close(1000, "Flux connection closed");
          }
        } catch {}
      });
    } catch (error) {
      console.error("Could not connect to Flux:", error);

      try {
        server.send(
          JSON.stringify({
            type: "error",
            message:
              error instanceof Error
                ? error.message
                : "Could not start streaming speech recognition",
          })
        );
        server.close(1011, "Flux connection failed");
      } catch {}
    }
  })();

  server.addEventListener("message", async (event) => {
    try {
      // JSON messages are control/configuration messages.
      if (typeof event.data === "string") {
        let message: any;

        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }

        if (message.type === "config") {
          if (Array.isArray(message.history)) {
            state.history = message.history
              .filter(
                (m: any) =>
                  m &&
                  (m.role === "user" || m.role === "assistant") &&
                  typeof m.content === "string"
              )
              .slice(-MAX_HISTORY);
          }

          if (state.upstream) {
            try {
              state.upstream.send(
                JSON.stringify({
                  type: "config",
                  language: "en",
                })
              );
            } catch {}
          }

          return;
        }

        if (message.type === "ping") {
          server.send(JSON.stringify({ type: "pong" }));
          return;
        }

        if (message.type === "close") {
          try {
            state.upstream?.close(1000, "Client closed");
          } catch {}

          try {
            server.close(1000, "Client closed");
          } catch {}

          return;
        }

        return;
      }

      // Raw binary audio is forwarded directly to Flux.
      if (state.upstream?.readyState === WebSocket.OPEN) {
        state.upstream.send(event.data);
      }
    } catch (error) {
      console.error("Client WebSocket message error:", error);
    }
  });

  server.addEventListener("close", () => {
    try {
      state.upstream?.close(1000, "Client disconnected");
    } catch {}
  });

  server.addEventListener("error", (error) => {
    console.error("Client WebSocket error:", error);

    try {
      state.upstream?.close(1011, "Client socket error");
    } catch {}
  });

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}

function html() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Speedbot Voice Assistant</title>
<style>
*{box-sizing:border-box}
body{
  margin:0;
  min-height:100vh;
  font-family:Inter,Arial,sans-serif;
  background:linear-gradient(135deg,#f8fafc,#eef2ff);
  display:flex;
  justify-content:center;
  align-items:center;
  color:#111827;
}
.container{
  width:92%;
  max-width:700px;
  background:#fff;
  border-radius:24px;
  padding:32px;
  box-shadow:0 20px 60px rgba(0,0,0,.12);
}
.header{text-align:center;margin-bottom:20px}
.logo{font-size:42px;margin-bottom:8px}
h1{margin:0;font-size:30px}
.subtitle{margin-top:8px;color:#6b7280;font-size:15px}
.status{
  text-align:center;
  margin:20px 0;
  padding:12px;
  border-radius:12px;
  background:#f3f4f6;
  color:#4b5563;
  font-size:14px;
}
.conversation{
  height:300px;
  overflow-y:auto;
  padding:15px;
  border-radius:16px;
  background:#f9fafb;
  margin-bottom:25px;
}
.message{
  margin-bottom:15px;
  padding:12px 15px;
  border-radius:14px;
  max-width:85%;
  line-height:1.5;
  font-size:14px;
}
.user{margin-left:auto;background:#e0e7ff;text-align:right}
.ai{margin-right:auto;background:#f3f4f6}
.interim{
  margin:8px auto;
  padding:8px 12px;
  color:#6b7280;
  font-size:13px;
  text-align:center;
  font-style:italic;
}
.mic-container{
  display:flex;
  justify-content:center;
  align-items:center;
}
.mic-button{
  width:88px;
  height:88px;
  border:none;
  border-radius:50%;
  background:#111827;
  color:#fff;
  font-size:32px;
  cursor:pointer;
  transition:transform .2s,box-shadow .2s;
}
.mic-button:hover{transform:scale(1.05)}
.mic-button.voice-mode{background:#16a34a}
.mic-button.recording{
  background:#dc2626;
  box-shadow:0 0 0 12px rgba(220,38,38,.15);
  animation:pulse 1.2s infinite;
}
@keyframes pulse{
  0%{transform:scale(1)}
  50%{transform:scale(1.08)}
  100%{transform:scale(1)}
}
.footer{
  text-align:center;
  margin-top:20px;
  font-size:12px;
  color:#9ca3af;
}
.small{
  text-align:center;
  margin-top:10px;
  color:#9ca3af;
  font-size:11px;
}
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <div class="logo">🎙️</div>
    <h1>Speedbot Voice Assistant</h1>
    <div class="subtitle">Real-time STT + Llama + Chatterbox V3</div>
  </div>

  <div id="status" class="status">
    Click the microphone to start Voice Mode
  </div>

  <div id="conversation" class="conversation">
    <div class="message ai">
      <strong>Speedbot:</strong><br>
      Hi! I'm Speedbot. Click the microphone and let's talk.
    </div>
  </div>

  <div class="mic-container">
    <button id="micButton" class="mic-button" title="Start Voice Mode">
      🎙️
    </button>
  </div>

  <div class="footer">
    Click once to start continuous Voice Mode. Click again to stop.
  </div>
  <div class="small">
    Streaming speech recognition powered by Deepgram Flux on Cloudflare Workers AI.
  </div>
</div>

<script>
const micButton=document.getElementById("micButton");
const status=document.getElementById("status");
const conversation=document.getElementById("conversation");

let ws=null;
let audioContext=null;
let source=null;
let processor=null;
let mediaStream=null;
let voiceModeActive=false;
let conversationHistory=[];
let currentAudio=null;
let audioQueue=[];
let playingQueue=false;
let currentInterim=null;
let pendingUserText="";
let pendingAssistantText="";

function setStatus(text){
  status.textContent=text;
}

function addMessage(role,text){
  const div=document.createElement("div");
  div.className="message "+role;
  div.innerHTML="<strong>"+(role==="user"?"You":"Speedbot")+":</strong><br>"+
    escapeHtml(text).replace(/\\n/g,"<br>");
  conversation.appendChild(div);
  conversation.scrollTop=conversation.scrollHeight;
}

function escapeHtml(text){
  const el=document.createElement("div");
  el.textContent=text;
  return el.innerHTML;
}

function showInterim(text){
  if(!currentInterim){
    currentInterim=document.createElement("div");
    currentInterim.className="interim";
    conversation.appendChild(currentInterim);
  }
  currentInterim.textContent=text;
  conversation.scrollTop=conversation.scrollHeight;
}

function clearInterim(){
  if(currentInterim){
    currentInterim.remove();
    currentInterim=null;
  }
}

function downsampleBuffer(buffer,inputRate,outputRate){
  if(outputRate===inputRate) return buffer;

  const ratio=inputRate/outputRate;
  const newLength=Math.round(buffer.length/ratio);
  const result=new Float32Array(newLength);

  let offsetResult=0;
  let offsetBuffer=0;

  while(offsetResult<result.length){
    const nextOffsetBuffer=Math.round((offsetResult+1)*ratio);
    let accum=0;
    let count=0;

    for(
      let i=offsetBuffer;
      i<nextOffsetBuffer && i<buffer.length;
      i++
    ){
      accum+=buffer[i];
      count++;
    }

    result[offsetResult]=count?accum/count:0;
    offsetResult++;
    offsetBuffer=nextOffsetBuffer;
  }

  return result;
}

function floatTo16BitPCM(float32){
  const output=new Int16Array(float32.length);

  for(let i=0;i<float32.length;i++){
    const s=Math.max(-1,Math.min(1,float32[i]));
    output[i]=s<0?s*0x8000:s*0x7fff;
  }

  return output.buffer;
}

async function startMicrophone(){
  mediaStream=await navigator.mediaDevices.getUserMedia({
    audio:{
      channelCount:1,
      echoCancellation:true,
      noiseSuppression:true,
      autoGainControl:true
    }
  });

  audioContext=new (window.AudioContext||window.webkitAudioContext)();

  source=audioContext.createMediaStreamSource(mediaStream);

  // ScriptProcessor is intentionally used here to keep this demo
  // dependency-free. It converts browser mic audio to raw 16-bit
  // mono PCM at 16 kHz, which Flux accepts.
  processor=audioContext.createScriptProcessor(4096,1,1);

  processor.onaudioprocess=function(event){
    if(!ws || ws.readyState!==WebSocket.OPEN) return;

    const input=event.inputBuffer.getChannelData(0);
    const downsampled=downsampleBuffer(
      input,
      audioContext.sampleRate,
      16000
    );

    const pcm=floatTo16BitPCM(downsampled);

    try{
      ws.send(pcm);
    }catch(e){}
  };

  source.connect(processor);
  processor.connect(audioContext.destination);

  setStatus("Listening...");
  micButton.classList.add("recording");
}

function stopMicrophone(){
  try{
    processor?.disconnect();
    source?.disconnect();
  }catch(e){}

  try{
    audioContext?.close();
  }catch(e){}

  try{
    mediaStream?.getTracks().forEach(t=>t.stop());
  }catch(e){}

  processor=null;
  source=null;
  audioContext=null;
  mediaStream=null;

  micButton.classList.remove("recording");
}

function connectWebSocket(){
  return new Promise((resolve,reject)=>{
    const protocol=location.protocol==="https:"?"wss:":"ws:";
    ws=new WebSocket(
      protocol+"//"+location.host+"/api/voice-stream"
    );

    ws.binaryType="arraybuffer";

    ws.onopen=()=>{
      ws.send(JSON.stringify({
        type:"config",
        history:conversationHistory
      }));
      resolve();
    };

    ws.onmessage=async(event)=>{
      if(typeof event.data==="string"){
        let message;

        try{
          message=JSON.parse(event.data);
        }catch(e){
          return;
        }

        if(message.type==="ready"){
          setStatus("Listening...");
          return;
        }

        if(message.type==="interim"){
          showInterim(message.text||"");
          return;
        }

        if(message.type==="eager_final"){
          showInterim(message.text||"");
          return;
        }

        if(message.type==="user_final"){
          clearInterim();
          pendingUserText=message.text||"";
          if(pendingUserText){
            addMessage("user",pendingUserText);
          }
          return;
        }

        if(message.type==="assistant_text"){
          pendingAssistantText=message.text||"";
          if(pendingAssistantText){
            addMessage("ai",pendingAssistantText);
          }

          conversationHistory=Array.isArray(message.history)
            ? message.history
            : conversationHistory;

          return;
        }

        if(message.type==="status"){
          if(message.value==="thinking"){
            setStatus("Thinking...");
          }else if(message.value==="speaking"){
            setStatus("Speaking...");
          }else if(message.value==="listening"){
            setStatus("Listening...");
          }
          return;
        }

        if(message.type==="audio_chunk"){
          return;
        }

        if(message.type==="audio_end"){
          return;
        }

        if(message.type==="error"){
          setStatus("Error: "+(message.message||"Unknown error"));
          return;
        }

        return;
      }

      if(event.data instanceof ArrayBuffer){
        queueAudio(event.data);
      }else if(event.data instanceof Blob){
        queueAudio(await event.data.arrayBuffer());
      }
    };

    ws.onerror=()=>{
      reject(new Error("Voice WebSocket connection failed"));
    };

    ws.onclose=()=>{
      if(voiceModeActive){
        setStatus("Connection closed. Click the microphone to restart.");
        stopMicrophone();
        micButton.classList.remove("voice-mode");
        micButton.textContent="🎙️";
        voiceModeActive=false;
      }
    };
  });
}

function queueAudio(arrayBuffer){
  audioQueue.push(arrayBuffer);
  playNextAudio();
}

async function playNextAudio(){
  if(playingQueue || audioQueue.length===0) return;

  playingQueue=true;
  const buffer=audioQueue.shift();

  try{
    const blob=new Blob([buffer],{type:"audio/wav"});
    const url=URL.createObjectURL(blob);

    currentAudio=new Audio(url);
    currentAudio.preload="auto";

    await currentAudio.play();

    await new Promise(resolve=>{
      currentAudio.onended=resolve;
      currentAudio.onerror=resolve;
    });

    URL.revokeObjectURL(url);
    currentAudio=null;
  }catch(e){
    console.error("Audio playback error",e);
  }

  playingQueue=false;

  if(audioQueue.length){
    playNextAudio();
  }else if(voiceModeActive){
    setStatus("Listening...");
  }
}

function closeEverything(){
  voiceModeActive=false;
  stopMicrophone();

  if(currentAudio){
    try{
      currentAudio.pause();
      currentAudio.currentTime=0;
    }catch(e){}
  }

  audioQueue=[];

  if(ws){
    try{
      ws.send(JSON.stringify({type:"close"}));
    }catch(e){}

    try{
      ws.close();
    }catch(e){}
  }

  ws=null;
  clearInterim();

  micButton.classList.remove("voice-mode");
  micButton.classList.remove("recording");
  micButton.textContent="🎙️";
  setStatus("Voice Mode stopped.");
}

micButton.onclick=async()=>{
  if(voiceModeActive){
    closeEverything();
    return;
  }

  try{
    voiceModeActive=true;
    micButton.classList.add("voice-mode");
    micButton.textContent="⏹️";
    setStatus("Connecting...");

    await connectWebSocket();

    if(!voiceModeActive) return;

    await startMicrophone();
  }catch(error){
    console.error(error);
    setStatus(
      "Could not start voice mode: "+
      (error.message||"unknown error")
    );
    closeEverything();
  }
};

window.addEventListener("beforeunload",()=>{
  try{
    ws?.close();
  }catch(e){}
});
</script>
</body>
</html>`;
}

export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return json({});
    }

    if (url.pathname === "/api/health") {
      return json({
        status: "ok",
        service: "Speedbot Custom Voice Agent",
        stt: "Deepgram Flux streaming",
        llm: MODEL_ID,
        tts: "Chatterbox V3",
      });
    }

    if (url.pathname === "/api/config-check") {
      return json({
        chatterbox_configured: Boolean(env.CHATTERBOX_URL),
        chatterbox_url_valid: Boolean(
          env.CHATTERBOX_URL &&
          /^https?:\/\//.test(env.CHATTERBOX_URL)
        ),
        streaming_stt: FLUX_MODEL,
      });
    }

    if (
      url.pathname === "/api/voice-stream" &&
      request.headers.get("Upgrade")?.toLowerCase() === "websocket"
    ) {
      return voiceWebSocket(request, env);
    }

    if (url.pathname === "/") {
      return new Response(html(), {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=UTF-8",
          "Cache-Control": "no-store",
        },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};
