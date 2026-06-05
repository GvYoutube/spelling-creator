// ICE servers for WebRTC (PeerJS).
//
// The ExpressTURN relay needs credentials, but they're optional: most peer
// connections succeed over STUN alone, and TURN is only a fallback for networks
// that block direct connections. Users can enter credentials in the Collaborate
// dialog; we persist them here in localStorage and fold them into the ICE list
// only when present.

const STORAGE_KEY = "spelling.turnCreds";

// STUN servers are always usable — no credentials required.
const stunServers = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  { urls: "stun:stun3.l.google.com:19302" },
  { urls: "stun:stun4.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:stun.nextcloud.com:443" },
];

// A sensible default the user can keep or replace. Bring-your-own-domain is
// supported — see the recommended providers in the Collaborate dialog.
export const DEFAULT_TURN_URL = "turn:free.expressturn.com:3478";

// Read the saved TURN credentials (if any) from localStorage.
export function getTurnCreds() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return {
      url: parsed.url || "",
      username: parsed.username || "",
      credential: parsed.credential || "",
    };
  } catch {
    return { url: "", username: "", credential: "" };
  }
}

// Save TURN credentials to localStorage, or clear them when all are blank.
export function setTurnCreds({ url, username, credential }) {
  const next = {
    url: (url || "").trim(),
    username: (username || "").trim(),
    credential: (credential || "").trim(),
  };
  try {
    if (!next.url && !next.username && !next.credential) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    }
  } catch {
    /* localStorage unavailable — credentials just won't persist */
  }
}

// Build the ICE server list for a new connection. A TURN relay is included only
// when the user has supplied a username and credential (the URL falls back to
// the default); otherwise we rely on STUN alone, which is enough for most
// networks.
export function getIceServers() {
  const { url, username, credential } = getTurnCreds();
  if (username && credential) {
    return [
      { urls: url || DEFAULT_TURN_URL, username, credential },
      ...stunServers,
    ];
  }
  return stunServers;
}
