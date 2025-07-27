// DOM Elements
const signalingInput = document.getElementById("signaling-input");
const signalingSendButton = document.getElementById("signaling-send-button");
const signalingMessages = document.getElementById("signaling-messages");
const toggleBtn = document.getElementById('toggle-signaling');

// DOM elements for chat
const messageInput = document.getElementById("message-input");
const sendButton = document.getElementById("send-button");
const chatMessages = document.getElementById("chat-messages");
const fileInput    = document.getElementById('fileInput');
const sendFileBtn  = document.getElementById('sendFileBtn');

// Disable chat input by default
messageInput.disabled = true;
sendButton.disabled = true;

// WebRTC and Firebase state
let peerConnection;
let chatChannel, fileChannel;
let role = null;
let useFirebase = false;
let sessionId = null;

const servers = {
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};
const dbRef = firebase.database().ref();
const transfers = {};
const senders = {};
// How long to wait (ms) for an ACK before retransmitting
const RETRANSMIT_TIMEOUT = 5000;


//Remove only the `offer` and `answer` fields under the current session in Firebase.
function clearFirebase() {
    if (!useFirebase || !sessionId) return;
    const sessionRef = dbRef.child(`sessions/${sessionId}`);
    sessionRef.child('offer').remove();
    sessionRef.child('answer').remove();
    addSignalingMessage("🗑️ Cleared offer and answer from Firebase.", "received");
}


// UI for incoming file
/**
 * Display a placeholder in the chat UI for an incoming file transfer.
 * @param {string} fileId      Unique transfer ID
 * @param {string} fileName    Name of the incoming file
 * @param {number} totalChunks How many chunks we expect
 */
 function showIncomingFileUI(fileId, fileName, totalChunks) {
    // Create a container div to hold the incoming‐file UI
    const container = document.createElement('div');
    container.id = `incoming-${fileId}`;
    container.className = 'incoming-file';
  
    // File name label
    const nameLabel = document.createElement('div');
    nameLabel.textContent = `Incoming file: ${fileName}`;
    nameLabel.className = 'incoming-file-name';
    container.appendChild(nameLabel);
  
    // Progress text
    const progressText = document.createElement('div');
    progressText.textContent = `0 / ${totalChunks} chunks received`;
    progressText.className = 'incoming-file-progress';
    container.appendChild(progressText);
  
    // Append to your chat message area (or a dedicated sidebar)
    chatMessages.appendChild(container);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }


// update UI progress of incoming file
function updateIncomingFileProgress(fileId, receivedCount, totalChunks) {
    const container = document.getElementById(`incoming-${fileId}`);
    const progEl = container.querySelector('.incoming-file-progress');
    progEl.textContent = `${receivedCount} / ${totalChunks} chunks received`;
}


// Slice Blob array  
/**
 * Slice a File/Blob into fixed-size chunks.
 * Logs each chunk’s index and size.
 *
 * @param {File|Blob} file
 * @param {number} chunkSize
 * @returns {Blob[]} Array of chunk Blobs
 */
function sliceFile(file, chunkSize) {
    const chunks = [];
    let offset = 0;
    const total = Math.ceil(file.size / chunkSize);
  
    while (offset < file.size) {
        const chunk = file.slice(offset, offset + chunkSize);
        chunks.push(chunk);
        console.log(`Prepared chunk ${chunks.length}/${total}: ${chunk.size} bytes`);
        offset += chunkSize;
    }
  
    return chunks;
} 


// Read Blob array
/**
 * Read a Blob chunk into an ArrayBuffer.
 *
 * @param {Blob} chunk
 * @returns {Promise<ArrayBuffer>}
 */
function readChunk(chunk) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            resolve(reader.result);
        };
        reader.onerror = () => {
            reject(new Error('Failed to read chunk'));
        };
        reader.readAsArrayBuffer(chunk);
    });
}


//Build a single ArrayBuffer containing:
//[2 bytes BE headerLength][header JSON UTF-8][payload bytes]
function packChunk(headerObj, payloadBuffer) {
  const headerJson = JSON.stringify(headerObj);
  const headerBytes = new TextEncoder().encode(headerJson);
  const totalLen = 2 + headerBytes.byteLength + payloadBuffer.byteLength;
  const buf = new ArrayBuffer(totalLen);
  const view = new Uint8Array(buf);

  // 1) Write header length (2-byte big-endian)
  view[0] = (headerBytes.byteLength >> 8) & 0xff;
  view[1] = headerBytes.byteLength & 0xff;

  // 2) Copy header
  view.set(headerBytes, 2);

  // 3) Copy payload
  view.set(new Uint8Array(payloadBuffer), 2 + headerBytes.byteLength);

  return buf;
}


//Unpack our ArrayBuffer into { header: Object, payload: ArrayBuffer }.
function unpackChunk(buffer) {
    const view = new Uint8Array(buffer);
    // Read header length
    const headerLen = (view[0] << 8) | view[1];
    // Slice out header bytes, decode JSON
    const headerBytes = buffer.slice(2, 2 + headerLen);
    const headerJson = new TextDecoder().decode(headerBytes);
    const header = JSON.parse(headerJson);
    // The rest is payload
    const payload = buffer.slice(2 + headerLen);
    return { header, payload };
}


// Send a single chunk (reads it, then emits header + payload)
async function sendChunkData(fileId, chunkIndex) {
    const s = senders[fileId];
    const payload = await readChunk(s.chunks[chunkIndex]);

    // Build a single packet
    const packet = packChunk(
        { type: "chunk", fileId, chunkIndex },
        payload
    );
    // Send it atomically
    fileChannel.send(packet);

    console.log(`Sent chunk ${chunkIndex+1}/${s.totalChunks}`);

    // schedule retransmit if no ACK
    if (s.ackTimers[chunkIndex]) {
        clearTimeout(s.ackTimers[chunkIndex]);
    }
    s.ackTimers[chunkIndex] = setTimeout(() => {
        // only retransmit if still un-ACKed
        if (!s.ackedChunks.has(chunkIndex)) {
            console.warn(`Timeout, retransmitting chunk ${chunkIndex+1}`);
            sendChunkData(fileId, chunkIndex);
        }
    }, RETRANSMIT_TIMEOUT);
}


// Advance the sliding window, sending up to windowSize in-flight chunks
function sendWindow(fileId) {
    const s = senders[fileId];
    // send until either end of file or fill window
    while (
        s.nextToSend < s.totalChunks &&
        s.nextToSend < s.base + s.windowSize
    ) {
        sendChunkData(fileId, s.nextToSend);
        s.nextToSend++;
    }
}


// Once all chunks are here, reassemble and offer a download link
function finalizeFileTransfer(fileId) {
    const t = transfers[fileId];
    const blob = new Blob(t.chunks, { type: t.mimeType });
    const url  = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.href        = url;
    link.download    = t.fileName;
    link.textContent = `Download ${t.fileName}`;
    link.className   = 'incoming-file-download';

    const container = document.getElementById(`incoming-${fileId}`);
    container.appendChild(link);
}


// Handle control of the chat-only channel
function setupChatChannelEvents(channel) {
    channel.onopen = () => {
        addSignalingMessage("✅ Data channel is open. You can now chat!", "received");

        messageInput.disabled = false;
        sendButton.disabled  = false;
        messageInput.focus();
    };
    channel.onclose = () => {
        addSignalingMessage("⚠️ Data channel closed.", "received");

        messageInput.disabled = true;
        sendButton.disabled  = true;
        clearFirebase();
    };
    channel.onmessage = event => {
        const msgDiv = document.createElement("div");
        msgDiv.textContent = event.data;
        msgDiv.className   = "message received";
        chatMessages.appendChild(msgDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    };
}


// Handle control of the file-only channel.
function setupFileChannelEvents(channel) {
    channel.onopen = () => {
        addSignalingMessage("✅ File channel is open. You can now send files!", "received");

        fileInput.disabled   = false;
        sendFileBtn.disabled = false;
    };

    channel.onclose = () => {
        addSignalingMessage("⚠️ File channel closed.", "received");

        fileInput.disabled   = true;
        sendFileBtn.disabled = true;
        clearFirebase();
    };

    channel.onmessage = event => {
        // Parse JSON if it’s a string
        if (typeof event.data === 'string') {
            let msg;
            try {
                msg = JSON.parse(event.data);
            } catch {
                console.warn("fileChannel: unexpected non-JSON string", event.data);
                return;
            }

            // File-metadata handshake
            if (msg && msg.fileId && msg.totalChunks) {
                // initialize transfer state
                transfers[msg.fileId] = {
                    fileName:    msg.fileName,
                    mimeType:    msg.mimeType,
                    fileSize:    msg.fileSize,
                    chunkSize:   msg.chunkSize,
                    totalChunks: msg.totalChunks,
                    chunks:      new Array(msg.totalChunks),
                    receivedCount: 0
                };
                showIncomingFileUI(msg.fileId, msg.fileName, msg.totalChunks);
                return;
            }

            // Per‐chunk header
            if (msg && msg.type === "chunk") {
                // stash it until the next (binary) message arrives
                pendingChunkHeader = { fileId: msg.fileId, chunkIndex: msg.chunkIndex };
                return;
            }

            // ACK
            if (msg && msg.type === "ack") {
                const s = senders[msg.fileId];
                if (s) {
                    s.ackedChunks.add(msg.chunkIndex);

                    // clear any retransmit timer
                    if (s.ackTimers[msg.chunkIndex]) {
                        clearTimeout(s.ackTimers[msg.chunkIndex]);
                        delete s.ackTimers[msg.chunkIndex];
                    }

                    // If the ACK was for the base of the window, advance base
                    if (msg.chunkIndex === s.base) {
                        while (s.ackedChunks.has(s.base)) {
                            s.base++;
                        }
                    }

                    // Try to fill the window up again
                    sendWindow(msg.fileId);
                }
                return;
            }

            // no other JSON messages expected on fileChannel
            console.warn("fileChannel: unrecognized JSON", msg);
            return;
        }

        // Handle packed binary chunk
        if (event.data instanceof ArrayBuffer) {
            const { header, payload } = unpackChunk(event.data);
            
            // store the chunk
            const t = transfers[header.fileId];
            if (!t) {
                console.warn("fileChannel: chunk for unknown fileId", header.fileId);
                return;
            }
            t.chunks[header.chunkIndex] = payload;
            t.receivedCount++;

            // ACK back on this channel
            channel.send(JSON.stringify({
                type:       "ack",
                fileId:     header.fileId,
                chunkIndex: header.chunkIndex
            }));
            console.log(`ACK sent for chunk ${header.chunkIndex}`);

            // update UI
            updateIncomingFileProgress(
                header.fileId,
                t.receivedCount,
                t.totalChunks
            );

            // finalize if done
            if (t.receivedCount === t.totalChunks) {
                finalizeFileTransfer(header.fileId);
            }

            return;
        }

        console.warn("fileChannel: unknown message type", event.data);

    };
      
}


// Helper to add message to signaling panel
function addSignalingMessage(message, type = "system") {
    const msgDiv = document.createElement('div');
    msgDiv.textContent = message;
    msgDiv.className = `message ${type}`;
    signalingMessages.appendChild(msgDiv);
    signalingMessages.scrollTop = signalingMessages.scrollHeight;
}


// === Manual Caller ===
async function startCaller() {
    peerConnection = new RTCPeerConnection(servers);

    // Reliable, ordered chat channel
    chatChannel = peerConnection.createDataChannel("chat");
    setupChatChannelEvents(chatChannel);

    // Unordered, zero-retransmit file channel
    fileChannel = peerConnection.createDataChannel("file", {
        ordered: false,
        maxRetransmits: 0
    });
    setupFileChannelEvents(fileChannel);

    // Handle ICE candidates
    peerConnection.onicecandidate = (event) => {
        if (event.candidate === null) {
            // When gathering is complete, show offer
            const offerSDP = JSON.stringify(peerConnection.localDescription);
            addSignalingMessage("📤 Your Offer SDP (copy and send to callee):", "received");
            addSignalingMessage(offerSDP, "sent");
        }
    };

    // Create offer
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
}


// === Manual Callee ===
async function startCallee(offerSDP) {
    try {
        const offer = new RTCSessionDescription(JSON.parse(offerSDP));

        peerConnection = new RTCPeerConnection(servers);

        // Listen for data channel
        peerConnection.ondatachannel = (event) => {
            const channel = event.channel;
            if (channel.label === "chat") {
                chatChannel = channel;
                setupChatChannelEvents(chatChannel);
            } else if (channel.label === "file") {
                fileChannel = channel;
                setupFileChannelEvents(fileChannel);
            }
        };

        // Set the received offer as remote description
        await peerConnection.setRemoteDescription(offer);

        // When ICE gathering is done, send answer SDP
        peerConnection.onicecandidate = (event) => {
            if (event.candidate === null) {
                const answerSDP = JSON.stringify(peerConnection.localDescription);
                addSignalingMessage("📤 Your Answer SDP (copy and send to caller):", "received");
                addSignalingMessage(answerSDP, "sent");
            }
        };

        // Create and set local answer
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);

    } catch (err) {
        addSignalingMessage("❌ Failed to parse or use offer SDP. Make sure it's valid.", "received");
        console.error(err);
    }
}


// === Firebase Mode ===
async function handleFirebaseMode() {
    const offerRef = dbRef.child(`sessions/${sessionId}/offer`);
    const answerRef = dbRef.child(`sessions/${sessionId}/answer`);

    const offerSnapshot = await offerRef.get();

    if (offerSnapshot.exists()) {
        // Act as Callee
        role = "callee";
        const offerSDP = offerSnapshot.val();
        addSignalingMessage("📥 Offer found. Acting as Callee...", "received");
        await startCalleeFirebase(offerSDP);
    } else {
        // Act as Caller
        role = "caller";
        addSignalingMessage("📤 No offer found. Acting as Caller...", "received");
        await startCallerFirebase();
    }
}


async function startCallerFirebase() {
    peerConnection = new RTCPeerConnection(servers);
    
    // Reliable, ordered chat channel
    chatChannel = peerConnection.createDataChannel("chat");
    setupChatChannelEvents(chatChannel);

    // Unordered, zero-retransmit file channel
    fileChannel = peerConnection.createDataChannel("file", {
        ordered: false,
        maxRetransmits: 0
    });
    setupFileChannelEvents(fileChannel);

    peerConnection.onicecandidate = async (event) => {
        if (event.candidate === null) {
            const offerSDP = JSON.stringify(peerConnection.localDescription);
            await dbRef.child(`sessions/${sessionId}/offer`).set(offerSDP);
            addSignalingMessage("✅ Offer written to Firebase!", "received");

            dbRef.child(`sessions/${sessionId}/answer`).on("value", async (snapshot) => {
                const answerSDP = snapshot.val();
                if (answerSDP) {
                    await peerConnection.setRemoteDescription(new RTCSessionDescription(JSON.parse(answerSDP)));
                    addSignalingMessage("✅ Answer received from Firebase!", "received");
                }
            });
        }
    };

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
}


async function startCalleeFirebase(offerSDP) {
    peerConnection = new RTCPeerConnection(servers);

    peerConnection.ondatachannel = (event) => {
        const channel = event.channel;
        if (channel.label === "chat") {
            chatChannel = channel;
            setupChatChannelEvents(chatChannel);
        } else if (channel.label === "file") {
            fileChannel = channel;
            setupFileChannelEvents(fileChannel);
        }
    };

    await peerConnection.setRemoteDescription(new RTCSessionDescription(JSON.parse(offerSDP)));

    peerConnection.onicecandidate = async (event) => {
        if (event.candidate === null) {
            const answerSDP = JSON.stringify(peerConnection.localDescription);
            await dbRef.child(`sessions/${sessionId}/answer`).set(answerSDP);
            addSignalingMessage("✅ Answer written to Firebase!", "received");
        }
    };

    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
}


// === Signaling Input Listener ===
signalingSendButton.addEventListener("click", () => {
    const input = signalingInput.value;
    signalingInput.value = "";

    addSignalingMessage(input, "sent");

    // User requested to clear Firebase
    if (input.startsWith("clr firebase")) {
        clearFirebase();
        return;
    }

    if (input.startsWith("firebase")) {
        const parts = input.split(" ");
        sessionId = parts[1] || prompt("Enter session ID:");
        useFirebase = true;
        addSignalingMessage(`🛰️ Firebase mode enabled with session ID: ${sessionId}`, "received");
        handleFirebaseMode();
        return;
    }

    // Manual fallback mode
    if (role === null) {
        if (input === "caller" || input === "callee") {
            role = input;
            addSignalingMessage(`✅ ${role.charAt(0).toUpperCase() + role.slice(1)} role assigned.`, "received");
            if (role === "caller") {
                startCaller(); // 👈 Start caller logic
            } else {
                addSignalingMessage("📥 Waiting for offer SDP. Paste it here when received.", "received");
            }
        } else {
            addSignalingMessage("❌ Invalid role. Please type 'caller' or 'callee'.", "received");
        }
    } else {
        if (role === "callee") {
            // Assume this is an offer SDP and try to use it
            startCallee(input);
        } else if (role === "caller") {
            try {
                const answer = new RTCSessionDescription(JSON.parse(input));
                peerConnection.setRemoteDescription(answer).then(() => {
                    addSignalingMessage("✅ Answer received and connection established!", "received");
                });
            } catch (err) {
                addSignalingMessage("❌ Failed to parse or apply answer SDP. Make sure it's valid.", "received");
                console.error(err);
            }
        } else {
            addSignalingMessage(`Role already set as '${role}'. No action needed.`, "received");
        }
    }
});


// === Chat Message Send ===
sendButton.addEventListener("click", () => {
    const message = messageInput.value.trim();
    if (message === "") return;

    // Send through data channel
    chatChannel.send(message);

    // Display in UI
    const msgDiv = document.createElement("div");
    msgDiv.textContent = message;
    msgDiv.className = "message sent";
    chatMessages.appendChild(msgDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    messageInput.value = "";
});


// Enable “Send File” button
fileInput.addEventListener('change', () => {
    // fileInput.files is a FileList; we only allow one file for now
    if (fileInput.files.length > 0) {
      sendFileBtn.disabled = false;
    } else {
      sendFileBtn.disabled = true;
    }
  });


// On click, build and send the metadata object
sendFileBtn.addEventListener('click', () => {
    const file = fileInput.files[0];          // File API object
    const fileId = crypto.randomUUID();       // Unique transfer ID
  
    // Destructure the properties we need
    const { name: fileName, size: fileSize, type: mimeType } = file;
    const chunkSize   = 16 * 1024;            // e.g. 16 KiB for later chunking
    const totalChunks = Math.ceil(fileSize / chunkSize);
  
    // Build the metadata packet
    const metadata = {
      fileId,
      fileName,
      mimeType,
      fileSize,
      chunkSize,
      totalChunks
    };
  
    // Slice and log chunks
    const chunks = sliceFile(file, chunkSize);

    // Send the metadata packet first
    fileChannel.send(JSON.stringify(metadata));

    // Initialize sliding-window state for this transfer
    senders[fileId] = {
        chunks,                     // Array of Blob chunks
        totalChunks,                // how many
        windowSize: 4,              // up to 4 in flight
        base: 0,                    // lowest un-ACKed chunk index
        nextToSend: 0,              // next chunk index to push
        ackedChunks: new Set(),      // tracks which indexes got ACKs
        ackTimers: {}               // track per-chunk timers
    };

    // Kick off sending the first window
    sendWindow(fileId);

    // Disable UI to prevent double‐sends until next selection
    sendFileBtn.disabled = true;
    fileInput.value = '';  // clear selection for next time
  });


// Toggle the signaling pane open/closed
toggleBtn.addEventListener('click', () => {
document.getElementById('signaling-pane').classList.toggle('collapsed');
});


// === Carousel logic ===
const panelWrapper = document.querySelector('.carousel-panel-wrapper');
const panels       = Array.from(document.querySelectorAll('.carousel-panel'));
let activeIndex    = 0;

function updateCarousel() {
  // translate so that activeIndex-th panel is in view
  panelWrapper.style.transform = `translateX(-${activeIndex * 50}%)`;
}

document.getElementById('prev-pane').addEventListener('click', () => {
  activeIndex = (activeIndex - 1 + panels.length) % panels.length;
  updateCarousel();
});

document.getElementById('next-pane').addEventListener('click', () => {
  activeIndex = (activeIndex + 1) % panels.length;
  updateCarousel();
});

// start with chat panel
updateCarousel();
