// ICE servers for WebRTC (PeerJS). This MUST be a flat array of RTCIceServer
// objects: each entry is either a STUN url string, or a TURN object carrying
// `urls` plus its `username`/`credential` at the top level. (The credentials
// belong on the server object itself — NOT nested inside a `urls` array, which
// is the bug that previously stopped the TURN relays from ever authenticating.)
//
// The TURN servers are listed first on purpose: they are the ones that relay
// traffic when a direct/STUN connection can't be made (symmetric NATs, strict
// firewalls), and browsers only use the first handful of ICE servers, so the
// relays must come before the long STUN fallback list.
const meteredUser = import.meta.env.VITE_METERED_USER;
const meteredPass = import.meta.env.VITE_METERED_PASS;

const turnServers = meteredUser
  ? [
      {
        urls: "turn:global.relay.metered.ca:80",
        username: meteredUser,
        credential: meteredPass,
      },
      {
        urls: "turn:global.relay.metered.ca:80?transport=tcp",
        username: meteredUser,
        credential: meteredPass,
      },
      {
        urls: "turn:global.relay.metered.ca:443",
        username: meteredUser,
        credential: meteredPass,
      },
      {
        urls: "turns:global.relay.metered.ca:443?transport=tcp",
        username: meteredUser,
        credential: meteredPass,
      },
    ]
  : [];

export const iceServers = [
  ...turnServers,
  { urls: "stun:stun.relay.metered.ca:80" },
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  { urls: "stun:stun3.l.google.com:19302" },
  { urls: "stun:stun4.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:stun.nextcloud.com:443" },
];
