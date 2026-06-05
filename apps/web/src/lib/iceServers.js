// ICE servers for WebRTC (PeerJS).

async function decrypt(key, iv, ciphertext) {
  function hexToBytes(hex) {
    return Uint8Array.from(hex.match(/.{2}/g).map((b) => parseInt(b, 16)));
  }

  function base64ToBytes(base64) {
    return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  }

  const keyBytes = hexToBytes(key);
  const ivBytes = hexToBytes(iv);
  const ciphertextBytes = base64ToBytes(ciphertext);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-CBC" },
    false,
    ["decrypt"],
  );

  const plaintextBuffer = await crypto.subtle.decrypt(
    {
      name: "AES-CBC",
      iv: ivBytes,
    },
    cryptoKey,
    ciphertextBytes,
  );

  const plaintext = new TextDecoder().decode(plaintextBuffer);

  return plaintext;
}

export const iceServers = [
  {
    urls: "turn:free.expressturn.com:3478",
    username: import.meta.resolve.VITE_TURN_USER,
    credential: decrypt(
      window.prompt(
        "Turn server password (ADMIN USE ONLY, DECLINE IF NOT ADMIN)",
      ),
      window.prompt("Turn server IV (ADMIN USE ONLY, DECLINE IF NOT ADMIN)"),
      import.meta.resolve.VITE_TURN_PASS,
    ),
  },
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  { urls: "stun:stun3.l.google.com:19302" },
  { urls: "stun:stun4.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:stun.nextcloud.com:443" },
];
