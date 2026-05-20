/**
 * SIP Protocol Parsing Library
 *
 * Pure TypeScript implementation for parsing raw SIP messages into structured
 * data, extracting SDP media information, and generating automated
 * troubleshooting hints.
 *
 * Covers RFC 3261 (SIP), RFC 4566 (SDP), RFC 3264 (offer/answer), RFC 4028
 * (session timers), and platform-specific diagnostics for the RevUp RCF
 * multi-VM architecture.
 *
 * No external dependencies.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SIPMethod =
  | 'INVITE'
  | 'ACK'
  | 'BYE'
  | 'CANCEL'
  | 'REGISTER'
  | 'OPTIONS'
  | 'PRACK'
  | 'SUBSCRIBE'
  | 'NOTIFY'
  | 'PUBLISH'
  | 'INFO'
  | 'REFER'
  | 'MESSAGE'
  | 'UPDATE';

export type HintSeverity = 'info' | 'warning' | 'error';

export interface ViaInfo {
  protocol: string;
  transport: string;
  host: string;
  port: string;
  branch: string;
  received: string;
  rport: string;
  raw: string;
}

export interface ContactInfo {
  displayName: string;
  uri: string;
  host: string;
  port: string;
  transport: string;
  expires: string;
  raw: string;
}

export interface RecordRouteInfo {
  uri: string;
  host: string;
  port: string;
  lr: boolean;
  raw: string;
}

export interface RouteInfo {
  uri: string;
  host: string;
  port: string;
  lr: boolean;
  raw: string;
}

export interface AuthInfo {
  scheme: string;
  realm: string;
  nonce: string;
  algorithm: string;
  qop: string;
  opaque: string;
  raw: string;
}

export interface SDPMediaStream {
  type: string;          // "audio", "video", "application", etc.
  port: number;
  protocol: string;      // "RTP/AVP", "RTP/SAVP", "UDP/TLS/RTP/SAVPF", etc.
  payloadTypes: number[];
  codecs: CodecInfo[];
  direction: string;     // "sendrecv", "sendonly", "recvonly", "inactive"
  connectionAddress: string;
  rtcpPort: number | null;
  rtcpMux: boolean;
  encryption: string;    // "none", "SRTP", "DTLS-SRTP"
  iceUfrag: string;
  icePwd: string;
  candidates: string[];
  bandwidth: string;
  ptime: number | null;
  raw: string;
}

export interface CodecInfo {
  payloadType: number;
  name: string;
  clockRate: number;
  channels: number | null;
  fmtp: string;
}

export interface SDPInfo {
  version: string;
  origin: string;
  sessionName: string;
  connectionAddress: string;
  timing: string;
  mediaStreams: SDPMediaStream[];
  iceUfrag: string;
  icePwd: string;
  fingerprint: string;
  setup: string;
  raw: string;
}

export interface SIPMessageInfo {
  // Request line / status line
  isRequest: boolean;
  method: string;
  requestUri: string;
  statusCode: number | null;
  reasonPhrase: string;
  sipVersion: string;

  // Core headers
  callId: string;
  fromTag: string;
  fromUri: string;
  fromDisplay: string;
  toTag: string;
  toUri: string;
  toDisplay: string;
  cseq: string;
  cseqMethod: string;
  cseqNumber: number;
  maxForwards: number | null;
  contentLength: number | null;
  contentType: string;

  // Via headers (ordered, first = topmost)
  vias: ViaInfo[];

  // Contact
  contact: ContactInfo | null;

  // Record-Route / Route
  recordRoutes: RecordRouteInfo[];
  routes: RouteInfo[];

  // Auth
  authorization: AuthInfo | null;
  wwwAuthenticate: AuthInfo | null;
  proxyAuthenticate: AuthInfo | null;
  proxyAuthorization: AuthInfo | null;

  // Session timers (RFC 4028)
  sessionExpires: number | null;
  sessionRefresher: string;
  minSE: number | null;

  // Transport & routing
  userAgent: string;
  server: string;
  allow: string[];
  supported: string[];
  require: string[];

  // Custom / extension headers
  xCarrier: string;
  pAssertedIdentity: string;
  pPreferredIdentity: string;
  diversion: string;
  reasonHeader: string;
  privacy: string;

  // SDP body
  sdp: SDPInfo | null;
  hasSDP: boolean;

  // Raw message
  raw: string;

  // Computed summaries
  summary: string;
  direction: string;  // "request" | "response"
}

export interface TroubleshootingHint {
  severity: HintSeverity;
  category: string;
  title: string;
  description: string;
  suggestion: string;
  rfc: string;
}

// ---------------------------------------------------------------------------
// Well-known codec library
// ---------------------------------------------------------------------------

const CODEC_REGISTRY: Record<number, { name: string; clockRate: number; channels: number | null }> = {
  0:   { name: 'PCMU',      clockRate: 8000,  channels: 1 },
  3:   { name: 'GSM',       clockRate: 8000,  channels: 1 },
  4:   { name: 'G723',      clockRate: 8000,  channels: 1 },
  5:   { name: 'DVI4',      clockRate: 8000,  channels: 1 },
  6:   { name: 'DVI4',      clockRate: 16000, channels: 1 },
  7:   { name: 'LPC',       clockRate: 8000,  channels: 1 },
  8:   { name: 'PCMA',      clockRate: 8000,  channels: 1 },
  9:   { name: 'G722',      clockRate: 8000,  channels: 1 },
  10:  { name: 'L16',       clockRate: 44100, channels: 2 },
  11:  { name: 'L16',       clockRate: 44100, channels: 1 },
  12:  { name: 'QCELP',     clockRate: 8000,  channels: 1 },
  13:  { name: 'CN',        clockRate: 8000,  channels: 1 },
  14:  { name: 'MPA',       clockRate: 90000, channels: null },
  15:  { name: 'G728',      clockRate: 8000,  channels: 1 },
  16:  { name: 'DVI4',      clockRate: 11025, channels: 1 },
  17:  { name: 'DVI4',      clockRate: 22050, channels: 1 },
  18:  { name: 'G729',      clockRate: 8000,  channels: 1 },
  25:  { name: 'CelB',      clockRate: 90000, channels: null },
  26:  { name: 'JPEG',      clockRate: 90000, channels: null },
  28:  { name: 'nv',        clockRate: 90000, channels: null },
  31:  { name: 'H261',      clockRate: 90000, channels: null },
  32:  { name: 'MPV',       clockRate: 90000, channels: null },
  33:  { name: 'MP2T',      clockRate: 90000, channels: null },
  34:  { name: 'H263',      clockRate: 90000, channels: null },
  96:  { name: 'dynamic',   clockRate: 0,     channels: null },
  97:  { name: 'dynamic',   clockRate: 0,     channels: null },
  98:  { name: 'dynamic',   clockRate: 0,     channels: null },
  99:  { name: 'dynamic',   clockRate: 0,     channels: null },
  100: { name: 'dynamic',   clockRate: 0,     channels: null },
  101: { name: 'telephone-event', clockRate: 8000, channels: null },
  102: { name: 'dynamic',   clockRate: 0,     channels: null },
  103: { name: 'dynamic',   clockRate: 0,     channels: null },
  104: { name: 'dynamic',   clockRate: 0,     channels: null },
  105: { name: 'dynamic',   clockRate: 0,     channels: null },
  106: { name: 'dynamic',   clockRate: 0,     channels: null },
  107: { name: 'dynamic',   clockRate: 0,     channels: null },
  108: { name: 'dynamic',   clockRate: 0,     channels: null },
  109: { name: 'dynamic',   clockRate: 0,     channels: null },
  110: { name: 'dynamic',   clockRate: 0,     channels: null },
  111: { name: 'dynamic',   clockRate: 0,     channels: null },
  112: { name: 'dynamic',   clockRate: 0,     channels: null },
  127: { name: 'dynamic',   clockRate: 0,     channels: null },
};

// ---------------------------------------------------------------------------
// Private IP detection
// ---------------------------------------------------------------------------

/**
 * Checks whether an IP address falls within a private/reserved range.
 * Covers RFC 1918 (10/8, 172.16/12, 192.168/16), link-local (169.254/16),
 * loopback (127/8), CGNAT (100.64/10), and Docker default bridge (172.17-31).
 */
export function isPrivateIP(ip: string): boolean {
  if (!ip) return false;

  // IPv6 loopback
  if (ip === '::1' || ip === '0:0:0:0:0:0:0:1') return true;

  // IPv6 link-local
  if (ip.toLowerCase().startsWith('fe80:')) return true;

  // IPv6 unique local (fc00::/7)
  const first2 = ip.toLowerCase().slice(0, 2);
  if (first2 === 'fc' || first2 === 'fd') return true;

  const parts = ip.split('.');
  if (parts.length !== 4) return false;

  const octets = parts.map(Number);
  if (octets.some(o => isNaN(o) || o < 0 || o > 255)) return false;

  const [a, b] = octets;

  // 10.0.0.0/8
  if (a === 10) return true;

  // 172.16.0.0/12 (172.16.x.x - 172.31.x.x) -- includes Docker bridge
  if (a === 172 && b >= 16 && b <= 31) return true;

  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;

  // 127.0.0.0/8 loopback
  if (a === 127) return true;

  // 169.254.0.0/16 link-local
  if (a === 169 && b === 254) return true;

  // 100.64.0.0/10 CGNAT
  if (a === 100 && b >= 64 && b <= 127) return true;

  // 0.0.0.0
  if (a === 0 && b === 0 && octets[2] === 0 && octets[3] === 0) return true;

  return false;
}

/**
 * Specifically detects Docker bridge network IPs (172.28.x.x is our compose
 * default, but any 172.16-31.x.x qualifies).
 */
export function isDockerIP(ip: string): boolean {
  if (!ip) return false;
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  return a === 172 && b >= 16 && b <= 31;
}

// ---------------------------------------------------------------------------
// Header parsing helpers
// ---------------------------------------------------------------------------

/**
 * Extracts a single header value from raw SIP text.
 * Handles header continuation (lines starting with whitespace) per RFC 3261.
 * Also recognizes compact form headers.
 */
function getHeader(raw: string, name: string): string {
  // Map of compact form headers (RFC 3261 Section 7.3.3)
  const compactForms: Record<string, string> = {
    'call-id': 'i',
    'contact': 'm',
    'content-encoding': 'e',
    'content-length': 'l',
    'content-type': 'c',
    'from': 'f',
    'subject': 's',
    'supported': 'k',
    'to': 't',
    'via': 'v',
    'allow-events': 'u',
    'event': 'o',
    'refer-to': 'r',
  };

  const lowerName = name.toLowerCase();
  const compact = compactForms[lowerName];
  const lines = raw.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match full header name (case-insensitive) or compact form
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;

    const headerName = line.slice(0, colonIdx).trim().toLowerCase();
    if (headerName === lowerName || (compact && headerName === compact)) {
      let value = line.slice(colonIdx + 1).trim();

      // Handle header continuation lines (RFC 3261 Section 7.3.1)
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].startsWith(' ') || lines[j].startsWith('\t')) {
          value += ' ' + lines[j].trim();
        } else {
          break;
        }
      }
      return value;
    }
  }
  return '';
}

/**
 * Extracts ALL values for a multi-instance header (e.g., Via, Record-Route).
 * Returns them in order of appearance.
 */
function getAllHeaders(raw: string, name: string): string[] {
  const compactForms: Record<string, string> = {
    'via': 'v',
    'contact': 'm',
    'record-route': '',
    'route': '',
  };

  const lowerName = name.toLowerCase();
  const compact = compactForms[lowerName] || '';
  const lines = raw.split(/\r?\n/);
  const results: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;

    const headerName = line.slice(0, colonIdx).trim().toLowerCase();
    if (headerName === lowerName || (compact && headerName === compact)) {
      let value = line.slice(colonIdx + 1).trim();

      // Handle continuation
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].startsWith(' ') || lines[j].startsWith('\t')) {
          value += ' ' + lines[j].trim();
        } else {
          break;
        }
      }

      // A single header line can contain comma-separated values for
      // Via, Record-Route, Route (RFC 3261 Section 7.3.1)
      // But NOT for Contact (which can have comma in display name)
      if (lowerName !== 'contact') {
        const parts = splitHeaderValues(value);
        results.push(...parts);
      } else {
        results.push(value);
      }
    }
  }
  return results;
}

/**
 * Splits comma-separated header values while respecting angle brackets and
 * quoted strings. Example:
 *   "<sip:a@b;lr>, <sip:c@d;lr>" -> ["<sip:a@b;lr>", "<sip:c@d;lr>"]
 */
function splitHeaderValues(value: string): string[] {
  const results: string[] = [];
  let depth = 0;
  let inQuote = false;
  let current = '';

  for (let i = 0; i < value.length; i++) {
    const ch = value[i];

    if (ch === '"' && value[i - 1] !== '\\') {
      inQuote = !inQuote;
      current += ch;
    } else if (!inQuote && ch === '<') {
      depth++;
      current += ch;
    } else if (!inQuote && ch === '>') {
      depth--;
      current += ch;
    } else if (!inQuote && depth === 0 && ch === ',') {
      const trimmed = current.trim();
      if (trimmed) results.push(trimmed);
      current = '';
    } else {
      current += ch;
    }
  }

  const trimmed = current.trim();
  if (trimmed) results.push(trimmed);
  return results;
}

/**
 * Extracts a parameter value from a SIP URI or header parameter list.
 * Example: extractParam("tag=abc123;lr", "tag") => "abc123"
 */
function extractParam(params: string, name: string): string {
  const lowerParams = params.toLowerCase();
  const lowerName = name.toLowerCase();
  const idx = lowerParams.indexOf(lowerName + '=');
  if (idx < 0) return '';

  const start = idx + lowerName.length + 1;
  let end = params.indexOf(';', start);
  if (end < 0) end = params.indexOf(',', start);
  if (end < 0) end = params.indexOf(' ', start);
  if (end < 0) end = params.length;

  let val = params.slice(start, end).trim();
  // Remove surrounding quotes
  if (val.startsWith('"') && val.endsWith('"')) {
    val = val.slice(1, -1);
  }
  return val;
}

/**
 * Extracts the URI from a name-addr or addr-spec.
 * "Bob" <sip:bob@example.com> => sip:bob@example.com
 * sip:bob@example.com => sip:bob@example.com
 */
function extractUri(headerValue: string): string {
  const angleBracket = headerValue.match(/<([^>]+)>/);
  if (angleBracket) return angleBracket[1];

  // No angle brackets — the whole thing might be a bare URI
  const semicolonIdx = headerValue.indexOf(';');
  if (semicolonIdx > 0) {
    const maybeUri = headerValue.slice(0, semicolonIdx).trim();
    if (maybeUri.startsWith('sip:') || maybeUri.startsWith('sips:') || maybeUri.startsWith('tel:')) {
      return maybeUri;
    }
  }

  const trimmed = headerValue.trim();
  if (trimmed.startsWith('sip:') || trimmed.startsWith('sips:') || trimmed.startsWith('tel:')) {
    return trimmed;
  }
  return headerValue.trim();
}

/**
 * Extracts display name from a From/To/Contact header.
 * "Bob Smith" <sip:bob@example.com> => Bob Smith
 */
function extractDisplayName(headerValue: string): string {
  // Quoted display name
  const quotedMatch = headerValue.match(/^"([^"]*)"[\s]*</);
  if (quotedMatch) return quotedMatch[1];

  // Unquoted display name before <
  const unquotedMatch = headerValue.match(/^([^<]*?)\s*</);
  if (unquotedMatch) {
    const name = unquotedMatch[1].trim();
    if (name && !name.startsWith('sip:') && !name.startsWith('sips:')) {
      return name;
    }
  }
  return '';
}

/**
 * Extracts host and port from a SIP URI.
 * sip:user@host:port;params => { host, port }
 */
function extractHostPort(uri: string): { host: string; port: string } {
  // Remove scheme
  let cleaned = uri.replace(/^sips?:/, '').replace(/^tel:/, '');

  // Remove user@ part
  const atIdx = cleaned.indexOf('@');
  if (atIdx >= 0) {
    cleaned = cleaned.slice(atIdx + 1);
  }

  // Remove parameters
  const semiIdx = cleaned.indexOf(';');
  if (semiIdx >= 0) {
    cleaned = cleaned.slice(0, semiIdx);
  }

  // Split host:port
  // Handle IPv6 [::1]:5060
  if (cleaned.startsWith('[')) {
    const bracketEnd = cleaned.indexOf(']');
    if (bracketEnd >= 0) {
      const host = cleaned.slice(1, bracketEnd);
      const rest = cleaned.slice(bracketEnd + 1);
      const colonIdx = rest.indexOf(':');
      const port = colonIdx >= 0 ? rest.slice(colonIdx + 1) : '';
      return { host, port };
    }
  }

  const colonIdx = cleaned.lastIndexOf(':');
  if (colonIdx >= 0) {
    const possiblePort = cleaned.slice(colonIdx + 1);
    if (/^\d+$/.test(possiblePort)) {
      return { host: cleaned.slice(0, colonIdx), port: possiblePort };
    }
  }

  return { host: cleaned, port: '' };
}

// ---------------------------------------------------------------------------
// Via parsing
// ---------------------------------------------------------------------------

export function parseViaInfo(viaValue: string): ViaInfo {
  const raw = viaValue.trim();

  // SIP/2.0/UDP 10.142.0.100:5060;branch=z9hG4bK...;rport;received=1.2.3.4
  const protocolMatch = raw.match(/^(SIP\/[\d.]+)\/(UDP|TCP|TLS|WSS?|SCTP)\s+/i);
  const protocol = protocolMatch ? protocolMatch[1] : 'SIP/2.0';
  const transport = protocolMatch ? protocolMatch[2].toUpperCase() : 'UDP';

  // Extract host:port after the transport
  const afterProtocol = protocolMatch ? raw.slice(protocolMatch[0].length) : raw;
  const semiIdx = afterProtocol.indexOf(';');
  const hostPortStr = semiIdx >= 0 ? afterProtocol.slice(0, semiIdx).trim() : afterProtocol.trim();
  const params = semiIdx >= 0 ? afterProtocol.slice(semiIdx) : '';

  // Parse host:port (handle IPv6)
  let host = hostPortStr;
  let port = '';
  if (hostPortStr.startsWith('[')) {
    const bracketEnd = hostPortStr.indexOf(']');
    if (bracketEnd >= 0) {
      host = hostPortStr.slice(1, bracketEnd);
      const rest = hostPortStr.slice(bracketEnd + 1);
      if (rest.startsWith(':')) port = rest.slice(1);
    }
  } else {
    const colonIdx = hostPortStr.lastIndexOf(':');
    if (colonIdx >= 0) {
      const maybePort = hostPortStr.slice(colonIdx + 1);
      if (/^\d+$/.test(maybePort)) {
        host = hostPortStr.slice(0, colonIdx);
        port = maybePort;
      }
    }
  }

  const branch = extractParam(params, 'branch');
  const received = extractParam(params, 'received');

  // rport might be just ";rport" (no value) or ";rport=12345"
  let rport = '';
  const rportIdx = params.toLowerCase().indexOf('rport');
  if (rportIdx >= 0) {
    const afterRport = params.slice(rportIdx + 5);
    if (afterRport.startsWith('=')) {
      const end = afterRport.indexOf(';', 1);
      rport = end >= 0 ? afterRport.slice(1, end) : afterRport.slice(1);
    } else {
      rport = 'present'; // flag-only rport
    }
  }

  return { protocol, transport, host, port, branch, received, rport, raw };
}

// ---------------------------------------------------------------------------
// Contact parsing
// ---------------------------------------------------------------------------

export function parseContactInfo(contactValue: string): ContactInfo {
  const raw = contactValue.trim();

  if (raw === '*') {
    return {
      displayName: '',
      uri: '*',
      host: '',
      port: '',
      transport: '',
      expires: '',
      raw,
    };
  }

  const displayName = extractDisplayName(raw);
  const uri = extractUri(raw);
  const { host, port } = extractHostPort(uri);

  // Transport from URI params or Contact params
  let transport = '';
  const transportMatch = raw.match(/transport=(UDP|TCP|TLS|WSS?|SCTP)/i);
  if (transportMatch) transport = transportMatch[1].toUpperCase();

  const expires = extractParam(raw, 'expires');

  return { displayName, uri, host, port, transport, expires, raw };
}

// ---------------------------------------------------------------------------
// Record-Route / Route parsing
// ---------------------------------------------------------------------------

function parseRecordRoute(value: string): RecordRouteInfo {
  const raw = value.trim();
  const uri = extractUri(raw);
  const { host, port } = extractHostPort(uri);
  const lr = raw.toLowerCase().includes(';lr') || uri.toLowerCase().includes(';lr');
  return { uri, host, port, lr, raw };
}

function parseRoute(value: string): RouteInfo {
  const raw = value.trim();
  const uri = extractUri(raw);
  const { host, port } = extractHostPort(uri);
  const lr = raw.toLowerCase().includes(';lr') || uri.toLowerCase().includes(';lr');
  return { uri, host, port, lr, raw };
}

// ---------------------------------------------------------------------------
// Auth header parsing
// ---------------------------------------------------------------------------

function parseAuthHeader(value: string): AuthInfo | null {
  if (!value) return null;

  const raw = value.trim();
  const schemeMatch = raw.match(/^(\w+)\s+/);
  const scheme = schemeMatch ? schemeMatch[1] : '';
  const params = schemeMatch ? raw.slice(schemeMatch[0].length) : raw;

  return {
    scheme,
    realm: extractParam(params, 'realm'),
    nonce: extractParam(params, 'nonce'),
    algorithm: extractParam(params, 'algorithm'),
    qop: extractParam(params, 'qop'),
    opaque: extractParam(params, 'opaque'),
    raw,
  };
}

// ---------------------------------------------------------------------------
// SDP parsing
// ---------------------------------------------------------------------------

/**
 * Extracts SDP information from a raw SDP body string.
 * Handles session-level and media-level attributes per RFC 4566.
 */
export function extractSDPInfo(sdpText: string): SDPInfo {
  const lines = sdpText.split(/\r?\n/).filter(l => l.trim().length > 0);

  let version = '';
  let origin = '';
  let sessionName = '';
  let connectionAddress = '';
  let timing = '';
  let sessionIceUfrag = '';
  let sessionIcePwd = '';
  let fingerprint = '';
  let setup = '';

  const mediaStreams: SDPMediaStream[] = [];
  let currentMedia: SDPMediaStream | null = null;

  for (const line of lines) {
    const type = line[0];
    const value = line.length > 2 ? line.slice(2) : '';

    // When we hit a new m= line, finalize the previous media and start a new one
    if (type === 'm') {
      if (currentMedia) {
        mediaStreams.push(currentMedia);
      }
      currentMedia = parseMediaLine(value, connectionAddress);
      continue;
    }

    if (currentMedia) {
      // Media-level attributes
      applyMediaAttribute(currentMedia, type, value);
    } else {
      // Session-level attributes
      switch (type) {
        case 'v': version = value; break;
        case 'o': origin = value; break;
        case 's': sessionName = value; break;
        case 'c': connectionAddress = parseSdpConnection(value); break;
        case 't': timing = value; break;
        case 'a': {
          if (value.startsWith('ice-ufrag:')) sessionIceUfrag = value.slice(10).trim();
          else if (value.startsWith('ice-pwd:')) sessionIcePwd = value.slice(8).trim();
          else if (value.startsWith('fingerprint:')) fingerprint = value.slice(12).trim();
          else if (value.startsWith('setup:')) setup = value.slice(6).trim();
          break;
        }
      }
    }
  }

  // Finalize last media stream
  if (currentMedia) {
    mediaStreams.push(currentMedia);
  }

  // Propagate session-level ICE to media streams that don't have their own
  for (const ms of mediaStreams) {
    if (!ms.iceUfrag && sessionIceUfrag) ms.iceUfrag = sessionIceUfrag;
    if (!ms.icePwd && sessionIcePwd) ms.icePwd = sessionIcePwd;
    if (!ms.connectionAddress && connectionAddress) ms.connectionAddress = connectionAddress;
  }

  return {
    version,
    origin,
    sessionName,
    connectionAddress,
    timing,
    mediaStreams,
    iceUfrag: sessionIceUfrag,
    icePwd: sessionIcePwd,
    fingerprint,
    setup,
    raw: sdpText,
  };
}

function parseSdpConnection(value: string): string {
  // c=IN IP4 10.142.0.100
  const parts = value.split(/\s+/);
  return parts.length >= 3 ? parts[2] : value;
}

function parseMediaLine(value: string, sessionConnection: string): SDPMediaStream {
  // m=audio 20000 RTP/AVP 0 8 101
  const parts = value.split(/\s+/);
  const mediaType = parts[0] || 'unknown';
  const port = parseInt(parts[1] || '0', 10);
  const protocol = parts[2] || '';
  const payloadTypes = parts.slice(3).map(pt => parseInt(pt, 10)).filter(n => !isNaN(n));

  // Pre-populate codecs from static payload types
  const codecs: CodecInfo[] = payloadTypes.map(pt => {
    const known = CODEC_REGISTRY[pt];
    if (known && known.name !== 'dynamic') {
      return {
        payloadType: pt,
        name: known.name,
        clockRate: known.clockRate,
        channels: known.channels,
        fmtp: '',
      };
    }
    return {
      payloadType: pt,
      name: `PT${pt}`,
      clockRate: 0,
      channels: null,
      fmtp: '',
    };
  });

  // Determine encryption from protocol
  let encryption = 'none';
  const protocolUpper = protocol.toUpperCase();
  if (protocolUpper.includes('SAVPF') || protocolUpper.includes('SAVP')) {
    encryption = 'SRTP';
  }
  if (protocolUpper.includes('DTLS') || protocolUpper.includes('TLS')) {
    encryption = 'DTLS-SRTP';
  }

  return {
    type: mediaType,
    port,
    protocol,
    payloadTypes,
    codecs,
    direction: 'sendrecv', // default per RFC 3264
    connectionAddress: sessionConnection,
    rtcpPort: null,
    rtcpMux: false,
    encryption,
    iceUfrag: '',
    icePwd: '',
    candidates: [],
    bandwidth: '',
    ptime: null,
    raw: `m=${value}`,
  };
}

function applyMediaAttribute(media: SDPMediaStream, type: string, value: string): void {
  switch (type) {
    case 'c':
      media.connectionAddress = parseSdpConnection(value);
      break;
    case 'b':
      media.bandwidth = value;
      break;
    case 'a': {
      // rtpmap
      if (value.startsWith('rtpmap:')) {
        const rtpmap = value.slice(7).trim();
        const spaceIdx = rtpmap.indexOf(' ');
        if (spaceIdx > 0) {
          const pt = parseInt(rtpmap.slice(0, spaceIdx), 10);
          const codecDesc = rtpmap.slice(spaceIdx + 1);
          const codecParts = codecDesc.split('/');
          const codecName = codecParts[0] || '';
          const clockRate = parseInt(codecParts[1] || '0', 10);
          const channels = codecParts[2] ? parseInt(codecParts[2], 10) : null;

          const existing = media.codecs.find(c => c.payloadType === pt);
          if (existing) {
            existing.name = codecName;
            existing.clockRate = clockRate;
            existing.channels = channels;
          } else {
            media.codecs.push({
              payloadType: pt,
              name: codecName,
              clockRate,
              channels,
              fmtp: '',
            });
          }
        }
      }
      // fmtp
      else if (value.startsWith('fmtp:')) {
        const fmtp = value.slice(5).trim();
        const spaceIdx = fmtp.indexOf(' ');
        if (spaceIdx > 0) {
          const pt = parseInt(fmtp.slice(0, spaceIdx), 10);
          const params = fmtp.slice(spaceIdx + 1);
          const existing = media.codecs.find(c => c.payloadType === pt);
          if (existing) {
            existing.fmtp = params;
          }
        }
      }
      // Direction attributes
      else if (value === 'sendrecv' || value === 'sendonly' || value === 'recvonly' || value === 'inactive') {
        media.direction = value;
      }
      // RTCP
      else if (value.startsWith('rtcp:')) {
        const rtcpPort = parseInt(value.slice(5).trim().split(/\s+/)[0], 10);
        if (!isNaN(rtcpPort)) media.rtcpPort = rtcpPort;
      }
      else if (value === 'rtcp-mux') {
        media.rtcpMux = true;
      }
      // ICE
      else if (value.startsWith('ice-ufrag:')) {
        media.iceUfrag = value.slice(10).trim();
      }
      else if (value.startsWith('ice-pwd:')) {
        media.icePwd = value.slice(8).trim();
      }
      else if (value.startsWith('candidate:')) {
        media.candidates.push(value);
      }
      // Crypto (SDES-SRTP)
      else if (value.startsWith('crypto:')) {
        if (media.encryption === 'none') media.encryption = 'SRTP';
      }
      // Fingerprint at media level
      else if (value.startsWith('fingerprint:')) {
        media.encryption = 'DTLS-SRTP';
      }
      // ptime
      else if (value.startsWith('ptime:')) {
        const pt = parseInt(value.slice(6).trim(), 10);
        if (!isNaN(pt)) media.ptime = pt;
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Main SIP message parser
// ---------------------------------------------------------------------------

/**
 * Extracts structured SIP message information from a raw SIP message string.
 * Handles both requests and responses, all standard headers, and SDP body.
 *
 * @param rawMessage - Complete raw SIP message text (headers + optional body)
 * @returns Parsed SIPMessageInfo structure
 */
export function extractSIPInfo(rawMessage: string): SIPMessageInfo {
  const raw = rawMessage.trim();
  if (!raw) {
    return createEmptySIPInfo(raw);
  }

  // Split headers from body (blank line separates them)
  const blankLineIdx = raw.search(/\r?\n\r?\n/);
  const headerSection = blankLineIdx >= 0 ? raw.slice(0, blankLineIdx) : raw;
  const bodySection = blankLineIdx >= 0 ? raw.slice(blankLineIdx).replace(/^\r?\n\r?\n/, '') : '';

  const lines = headerSection.split(/\r?\n/);
  const firstLine = lines[0] || '';

  // Determine if this is a request or response
  let isRequest = false;
  let method = '';
  let requestUri = '';
  let statusCode: number | null = null;
  let reasonPhrase = '';
  let sipVersion = 'SIP/2.0';

  // Response: SIP/2.0 200 OK
  const responseMatch = firstLine.match(/^(SIP\/[\d.]+)\s+(\d{3})\s*(.*)/);
  // Request: INVITE sip:user@host SIP/2.0
  const requestMatch = firstLine.match(/^(\w+)\s+(\S+)\s+(SIP\/[\d.]+)/);

  if (responseMatch) {
    isRequest = false;
    sipVersion = responseMatch[1];
    statusCode = parseInt(responseMatch[2], 10);
    reasonPhrase = responseMatch[3] || getDefaultReasonPhrase(statusCode);
  } else if (requestMatch) {
    isRequest = true;
    method = requestMatch[1].toUpperCase();
    requestUri = requestMatch[2];
    sipVersion = requestMatch[3];
  } else {
    // Malformed first line -- try best-effort
    if (firstLine.startsWith('SIP/')) {
      const parts = firstLine.split(/\s+/);
      sipVersion = parts[0] || 'SIP/2.0';
      statusCode = parseInt(parts[1] || '0', 10) || null;
      reasonPhrase = parts.slice(2).join(' ');
    } else {
      const parts = firstLine.split(/\s+/);
      method = (parts[0] || '').toUpperCase();
      requestUri = parts[1] || '';
      sipVersion = parts[2] || 'SIP/2.0';
      isRequest = true;
    }
  }

  // Parse core headers
  const fromHeader = getHeader(raw, 'From');
  const toHeader = getHeader(raw, 'To');
  const callId = getHeader(raw, 'Call-ID');
  const cseqHeader = getHeader(raw, 'CSeq');
  const contentType = getHeader(raw, 'Content-Type');
  const contentLengthStr = getHeader(raw, 'Content-Length');
  const maxForwardsStr = getHeader(raw, 'Max-Forwards');
  const userAgent = getHeader(raw, 'User-Agent');
  const server = getHeader(raw, 'Server');

  // From parsing
  const fromUri = extractUri(fromHeader);
  const fromDisplay = extractDisplayName(fromHeader);
  const fromTag = extractParam(fromHeader, 'tag');

  // To parsing
  const toUri = extractUri(toHeader);
  const toDisplay = extractDisplayName(toHeader);
  const toTag = extractParam(toHeader, 'tag');

  // CSeq parsing
  const cseqParts = cseqHeader.trim().split(/\s+/);
  const cseqNumber = parseInt(cseqParts[0] || '0', 10);
  const cseqMethod = (cseqParts[1] || method).toUpperCase();

  // For responses, derive method from CSeq
  if (!isRequest && !method) {
    method = cseqMethod;
  }

  // Content-Length
  const contentLength = contentLengthStr ? parseInt(contentLengthStr, 10) : null;

  // Max-Forwards
  const maxForwards = maxForwardsStr ? parseInt(maxForwardsStr, 10) : null;

  // Via headers
  const viaValues = getAllHeaders(raw, 'Via');
  const vias = viaValues.map(parseViaInfo);

  // Contact
  const contactValue = getHeader(raw, 'Contact');
  const contact = contactValue ? parseContactInfo(contactValue) : null;

  // Record-Route
  const rrValues = getAllHeaders(raw, 'Record-Route');
  const recordRoutes = rrValues.map(parseRecordRoute);

  // Route
  const routeValues = getAllHeaders(raw, 'Route');
  const routes = routeValues.map(parseRoute);

  // Auth headers
  const authorization = parseAuthHeader(getHeader(raw, 'Authorization'));
  const wwwAuthenticate = parseAuthHeader(getHeader(raw, 'WWW-Authenticate'));
  const proxyAuthenticate = parseAuthHeader(getHeader(raw, 'Proxy-Authenticate'));
  const proxyAuthorization = parseAuthHeader(getHeader(raw, 'Proxy-Authorization'));

  // Session timers (RFC 4028)
  const sessionExpiresHeader = getHeader(raw, 'Session-Expires');
  let sessionExpires: number | null = null;
  let sessionRefresher = '';
  if (sessionExpiresHeader) {
    const seParts = sessionExpiresHeader.split(';');
    sessionExpires = parseInt(seParts[0].trim(), 10);
    if (isNaN(sessionExpires)) sessionExpires = null;
    sessionRefresher = extractParam(sessionExpiresHeader, 'refresher');
  }
  const minSEHeader = getHeader(raw, 'Min-SE');
  const minSE = minSEHeader ? parseInt(minSEHeader.trim(), 10) : null;

  // Allow, Supported, Require
  const allowHeader = getHeader(raw, 'Allow');
  const allow = allowHeader ? allowHeader.split(',').map(s => s.trim()).filter(Boolean) : [];
  const supportedHeader = getHeader(raw, 'Supported');
  const supported = supportedHeader ? supportedHeader.split(',').map(s => s.trim()).filter(Boolean) : [];
  const requireHeader = getHeader(raw, 'Require');
  const require_ = requireHeader ? requireHeader.split(',').map(s => s.trim()).filter(Boolean) : [];

  // Extension / custom headers
  const xCarrier = getHeader(raw, 'X-Carrier');
  const pAssertedIdentity = getHeader(raw, 'P-Asserted-Identity');
  const pPreferredIdentity = getHeader(raw, 'P-Preferred-Identity');
  const diversion = getHeader(raw, 'Diversion');
  const reasonHeader = getHeader(raw, 'Reason');
  const privacy = getHeader(raw, 'Privacy');

  // SDP body
  let sdp: SDPInfo | null = null;
  const hasSDP = bodySection.trim().length > 0 &&
    (contentType.toLowerCase().includes('application/sdp') || bodySection.includes('v=0'));
  if (hasSDP) {
    sdp = extractSDPInfo(bodySection);
  }

  // Generate summary
  const summary = generateSummary(isRequest, method, statusCode, reasonPhrase, cseqMethod);

  return {
    isRequest,
    method,
    requestUri,
    statusCode,
    reasonPhrase,
    sipVersion,
    callId,
    fromTag,
    fromUri,
    fromDisplay,
    toTag,
    toUri,
    toDisplay,
    cseq: cseqHeader,
    cseqMethod,
    cseqNumber,
    maxForwards,
    contentLength,
    contentType,
    vias,
    contact,
    recordRoutes,
    routes,
    authorization,
    wwwAuthenticate,
    proxyAuthenticate,
    proxyAuthorization,
    sessionExpires,
    sessionRefresher,
    minSE,
    userAgent,
    server,
    allow,
    supported,
    require: require_,
    xCarrier,
    pAssertedIdentity,
    pPreferredIdentity,
    diversion,
    reasonHeader,
    privacy,
    sdp,
    hasSDP,
    raw,
    summary,
    direction: isRequest ? 'request' : 'response',
  };
}

// ---------------------------------------------------------------------------
// Summary generation
// ---------------------------------------------------------------------------

function generateSummary(
  isRequest: boolean,
  method: string,
  statusCode: number | null,
  reasonPhrase: string,
  cseqMethod: string,
): string {
  if (isRequest) {
    return method;
  }
  if (statusCode !== null) {
    const phrase = reasonPhrase || getDefaultReasonPhrase(statusCode);
    return `${statusCode} ${phrase} (${cseqMethod})`;
  }
  return 'Unknown';
}

function getDefaultReasonPhrase(code: number): string {
  const phrases: Record<number, string> = {
    100: 'Trying',
    180: 'Ringing',
    181: 'Call Is Being Forwarded',
    182: 'Queued',
    183: 'Session Progress',
    199: 'Early Dialog Terminated',
    200: 'OK',
    202: 'Accepted',
    204: 'No Notification',
    300: 'Multiple Choices',
    301: 'Moved Permanently',
    302: 'Moved Temporarily',
    305: 'Use Proxy',
    380: 'Alternative Service',
    400: 'Bad Request',
    401: 'Unauthorized',
    402: 'Payment Required',
    403: 'Forbidden',
    404: 'Not Found',
    405: 'Method Not Allowed',
    406: 'Not Acceptable',
    407: 'Proxy Authentication Required',
    408: 'Request Timeout',
    410: 'Gone',
    412: 'Conditional Request Failed',
    413: 'Request Entity Too Large',
    414: 'Request-URI Too Long',
    415: 'Unsupported Media Type',
    416: 'Unsupported URI Scheme',
    417: 'Unknown Resource-Priority',
    420: 'Bad Extension',
    421: 'Extension Required',
    422: 'Session Interval Too Small',
    423: 'Interval Too Brief',
    424: 'Bad Location Information',
    428: 'Use Identity Header',
    429: 'Provide Referrer Identity',
    430: 'Flow Failed',
    433: 'Anonymity Disallowed',
    436: 'Bad Identity-Info',
    437: 'Unsupported Certificate',
    438: 'Invalid Identity Header',
    439: 'First Hop Lacks Outbound Support',
    440: 'Max-Breadth Exceeded',
    469: 'Bad Info Package',
    470: 'Consent Needed',
    480: 'Temporarily Unavailable',
    481: 'Call/Transaction Does Not Exist',
    482: 'Loop Detected',
    483: 'Too Many Hops',
    484: 'Address Incomplete',
    485: 'Ambiguous',
    486: 'Busy Here',
    487: 'Request Terminated',
    488: 'Not Acceptable Here',
    489: 'Bad Event',
    491: 'Request Pending',
    493: 'Undecipherable',
    494: 'Security Agreement Required',
    500: 'Server Internal Error',
    501: 'Not Implemented',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
    504: 'Server Time-out',
    505: 'Version Not Supported',
    513: 'Message Too Large',
    555: 'Push Notification Service Not Supported',
    580: 'Precondition Failure',
    600: 'Busy Everywhere',
    603: 'Decline',
    604: 'Does Not Exist Anywhere',
    606: 'Not Acceptable',
    607: 'Unwanted',
    608: 'Rejected',
  };
  return phrases[code] || 'Unknown';
}

// ---------------------------------------------------------------------------
// Routing loop detection
// ---------------------------------------------------------------------------

/**
 * Detects potential SIP routing loops by analyzing Via headers.
 * A loop is suspected when the same host:port appears more than once in the
 * Via chain, or when Max-Forwards is dangerously low.
 */
export function detectRoutingLoop(info: SIPMessageInfo): {
  detected: boolean;
  description: string;
} {
  if (info.vias.length === 0) {
    return { detected: false, description: '' };
  }

  // Check for duplicate Via host:port combinations
  const viaKeys = new Set<string>();
  const duplicates: string[] = [];
  for (const via of info.vias) {
    const key = `${via.host}:${via.port || '5060'}`;
    if (viaKeys.has(key)) {
      duplicates.push(key);
    }
    viaKeys.add(key);
  }

  if (duplicates.length > 0) {
    return {
      detected: true,
      description: `Duplicate Via entries for ${duplicates.join(', ')} suggest a routing loop`,
    };
  }

  // Check Max-Forwards
  if (info.maxForwards !== null && info.maxForwards <= 5) {
    return {
      detected: true,
      description: `Max-Forwards is critically low (${info.maxForwards}), indicating possible loop`,
    };
  }

  // Check for 482 Loop Detected response
  if (!info.isRequest && info.statusCode === 482) {
    return {
      detected: true,
      description: 'Server responded with 482 Loop Detected',
    };
  }

  return { detected: false, description: '' };
}

// ---------------------------------------------------------------------------
// Fragmentation check
// ---------------------------------------------------------------------------

/**
 * Estimates whether a SIP message might exceed typical MTU sizes, causing
 * IP fragmentation which is problematic for UDP transport.
 */
export function checkFragmentation(rawMessage: string): {
  atRisk: boolean;
  estimatedSize: number;
  mtuThreshold: number;
  suggestion: string;
} {
  const estimatedSize = new Blob([rawMessage]).size;
  // Standard Ethernet MTU minus IP (20) and UDP (8) overhead
  const mtuThreshold = 1472;
  // RFC 3261 recommends switching to TCP above 1300 bytes for congestion control
  const sipTcpThreshold = 1300;

  const atRisk = estimatedSize > mtuThreshold;

  let suggestion = '';
  if (estimatedSize > mtuThreshold) {
    suggestion = `Message size (${estimatedSize} bytes) exceeds UDP MTU. Will be fragmented. Consider TCP transport.`;
  } else if (estimatedSize > sipTcpThreshold) {
    suggestion = `Message size (${estimatedSize} bytes) exceeds RFC 3261 recommended limit of ${sipTcpThreshold} bytes for UDP. TCP recommended.`;
  }

  return { atRisk, estimatedSize, mtuThreshold, suggestion };
}

// ---------------------------------------------------------------------------
// Troubleshooting hints generator
// ---------------------------------------------------------------------------

/**
 * Analyzes a parsed SIP message and generates automated troubleshooting hints.
 * Covers RFC compliance issues, NAT problems, authentication failures, codec
 * negotiation problems, and RevUp platform-specific issues including:
 *   - Session-Expires below 90 (Bandwidth carrier quirk)
 *   - Docker IP leaking in Via/Contact/SDP
 *   - Missing or incorrect Record-Route for multi-VM
 *   - X-Carrier header verification
 *   - Double Record-Route validation (VIP + SBC_INTERNAL_IP)
 *
 * @param info - Parsed SIPMessageInfo from extractSIPInfo()
 * @returns Array of TroubleshootingHint objects
 */
export function generateTroubleshootingHints(info: SIPMessageInfo): TroubleshootingHint[] {
  const hints: TroubleshootingHint[] = [];

  // ---- Authentication failures ----
  checkAuthFailures(info, hints);

  // ---- NAT / Network issues ----
  checkNATIssues(info, hints);

  // ---- Docker IP leaking (RevUp-specific) ----
  checkDockerIPLeak(info, hints);

  // ---- Routing issues ----
  checkRoutingIssues(info, hints);

  // ---- Session timer issues (RFC 4028 / Bandwidth-specific) ----
  checkSessionTimers(info, hints);

  // ---- Codec negotiation ----
  checkCodecNegotiation(info, hints);

  // ---- Record-Route validation (multi-VM / RevUp-specific) ----
  checkRecordRouteMultiVM(info, hints);

  // ---- X-Carrier header (RevUp-specific) ----
  checkXCarrierHeader(info, hints);

  // ---- Loop detection ----
  checkLoopDetection(info, hints);

  // ---- Fragmentation ----
  checkFragmentationHints(info, hints);

  // ---- Response code analysis ----
  checkResponseCodes(info, hints);

  // ---- Via analysis ----
  checkViaIssues(info, hints);

  // ---- SDP media issues ----
  checkSDPIssues(info, hints);

  // ---- Missing critical headers ----
  checkMissingHeaders(info, hints);

  return hints;
}

// ---------------------------------------------------------------------------
// Hint sub-checks
// ---------------------------------------------------------------------------

function checkAuthFailures(info: SIPMessageInfo, hints: TroubleshootingHint[]): void {
  // 401 Unauthorized
  if (!info.isRequest && info.statusCode === 401) {
    hints.push({
      severity: 'error',
      category: 'Authentication',
      title: '401 Unauthorized',
      description: 'The server requires authentication credentials. This is typically the first step in SIP digest authentication.',
      suggestion: info.wwwAuthenticate
        ? `Server requested ${info.wwwAuthenticate.scheme} auth for realm "${info.wwwAuthenticate.realm}". Verify credentials are configured for this realm.`
        : 'Check that valid credentials are configured for this endpoint.',
      rfc: 'RFC 3261 Section 22',
    });
  }

  // 407 Proxy Authentication Required
  if (!info.isRequest && info.statusCode === 407) {
    hints.push({
      severity: 'error',
      category: 'Authentication',
      title: '407 Proxy Authentication Required',
      description: 'The SIP proxy requires authentication before forwarding the request.',
      suggestion: info.proxyAuthenticate
        ? `Proxy requested ${info.proxyAuthenticate.scheme} auth for realm "${info.proxyAuthenticate.realm}". Verify proxy credentials.`
        : 'Check that proxy authentication credentials are configured.',
      rfc: 'RFC 3261 Section 26.3',
    });
  }

  // 403 Forbidden
  if (!info.isRequest && info.statusCode === 403) {
    hints.push({
      severity: 'error',
      category: 'Authentication',
      title: '403 Forbidden',
      description: 'The server understood the request but refuses to fulfill it. This is NOT an auth challenge — credentials may be wrong or the account may be disabled.',
      suggestion: 'Verify the account is active and the source IP is authorized. Check ACLs and IP allowlists on the SBC.',
      rfc: 'RFC 3261 Section 21.4.4',
    });
  }

  // Request with Authorization header — informational
  if (info.isRequest && info.authorization) {
    hints.push({
      severity: 'info',
      category: 'Authentication',
      title: 'Digest Authentication Present',
      description: `Request includes ${info.authorization.scheme} credentials for realm "${info.authorization.realm}".`,
      suggestion: 'If auth keeps failing, verify the username, password, and realm match the server configuration.',
      rfc: 'RFC 3261 Section 22.4',
    });
  }
}

function checkNATIssues(info: SIPMessageInfo, hints: TroubleshootingHint[]): void {
  // Check Via received parameter for NAT indication
  for (const via of info.vias) {
    if (via.received && via.received !== via.host) {
      hints.push({
        severity: 'warning',
        category: 'NAT',
        title: 'NAT Detected in Via',
        description: `Via host ${via.host} differs from received=${via.received}. The sender is behind NAT.`,
        suggestion: 'Ensure NAT traversal is properly configured (STUN/TURN, rport, or fix_nated_contact in Kamailio). For our platform, NAT detection must NOT apply to FreeSWITCH traffic — only inbound from Bandwidth.',
        rfc: 'RFC 3581',
      });
    }
  }

  // Check Contact for private IP
  if (info.contact && info.contact.host && isPrivateIP(info.contact.host)) {
    hints.push({
      severity: 'warning',
      category: 'NAT',
      title: 'Private IP in Contact Header',
      description: `Contact contains private IP ${info.contact.host}. Remote endpoints won't be able to route responses back.`,
      suggestion: 'The Contact should contain the public IP. Check ext-sip-ip in FreeSWITCH sofia profile, or fix_nated_contact() in Kamailio. Verify local-network-acl=loopback.auto is set on both sofia profiles.',
      rfc: 'RFC 3261 Section 20.10',
    });
  }

  // Check SDP connection address for private IP
  if (info.sdp) {
    const sdpHost = info.sdp.connectionAddress;
    if (sdpHost && isPrivateIP(sdpHost)) {
      hints.push({
        severity: 'error',
        category: 'NAT',
        title: 'Private IP in SDP Connection Address',
        description: `SDP c= line contains private IP ${sdpHost}. RTP media will not be routable from external endpoints.`,
        suggestion: 'Check ext-rtp-ip in FreeSWITCH sofia profile. Ensure local-network-acl=loopback.auto is set. Verify the VM is NOT on a subnet covered by GCP Cloud NAT.',
        rfc: 'RFC 4566 Section 5.7',
      });
    }

    // Also check per-media-stream addresses
    for (const ms of info.sdp.mediaStreams) {
      if (ms.connectionAddress && isPrivateIP(ms.connectionAddress) && ms.connectionAddress !== sdpHost) {
        hints.push({
          severity: 'error',
          category: 'NAT',
          title: `Private IP in SDP Media Stream (${ms.type})`,
          description: `Media-level c= for ${ms.type} contains private IP ${ms.connectionAddress}.`,
          suggestion: 'Each media stream connection address must be publicly routable. Check FreeSWITCH ext-rtp-ip configuration.',
          rfc: 'RFC 4566 Section 5.7',
        });
      }
    }
  }
}

function checkDockerIPLeak(info: SIPMessageInfo, hints: TroubleshootingHint[]): void {
  // RevUp-specific: Docker bridge IPs (172.28.x.x, 172.17.x.x) leaking into
  // SIP headers is a known issue when NAT detection misapplies to FS traffic
  // or when ext-sip-ip/ext-rtp-ip is misconfigured.

  const dockerIPs: string[] = [];

  // Check Via headers for Docker IPs
  for (const via of info.vias) {
    if (isDockerIP(via.host)) {
      dockerIPs.push(`Via: ${via.host}`);
    }
    if (via.received && isDockerIP(via.received)) {
      dockerIPs.push(`Via received: ${via.received}`);
    }
  }

  // Check Contact
  if (info.contact && isDockerIP(info.contact.host)) {
    dockerIPs.push(`Contact: ${info.contact.host}`);
  }

  // Check SDP
  if (info.sdp) {
    if (isDockerIP(info.sdp.connectionAddress)) {
      dockerIPs.push(`SDP c=: ${info.sdp.connectionAddress}`);
    }
    for (const ms of info.sdp.mediaStreams) {
      if (ms.connectionAddress && isDockerIP(ms.connectionAddress)) {
        dockerIPs.push(`SDP ${ms.type} c=: ${ms.connectionAddress}`);
      }
    }
  }

  // Check Record-Routes
  for (const rr of info.recordRoutes) {
    if (isDockerIP(rr.host)) {
      dockerIPs.push(`Record-Route: ${rr.host}`);
    }
  }

  if (dockerIPs.length > 0) {
    hints.push({
      severity: 'error',
      category: 'Docker IP Leak',
      title: 'Docker Internal IP Exposed in SIP Message',
      description: `Docker bridge network IPs detected in: ${dockerIPs.join(', ')}. These are not routable from external endpoints.`,
      suggestion: 'This typically happens when: (1) force_rport()/fix_nated_contact() in Kamailio applies to FreeSWITCH traffic — NAT_DETECT must only run for Bandwidth inbound, (2) ext-sip-ip/ext-rtp-ip is not set in FreeSWITCH sofia profiles, (3) local-network-acl is not set to loopback.auto. Do NOT use the -nonat flag on FreeSWITCH.',
      rfc: 'Platform-specific',
    });
  }
}

function checkRoutingIssues(info: SIPMessageInfo, hints: TroubleshootingHint[]): void {
  // 404 Not Found
  if (!info.isRequest && info.statusCode === 404) {
    hints.push({
      severity: 'error',
      category: 'Routing',
      title: '404 Not Found',
      description: 'The destination user or resource was not found on the server.',
      suggestion: 'Verify the DID is provisioned. Check PostgreSQL did_numbers table. For BYE 404, the dialog may have been lost — check that Record-Route includes both VIP and SBC_INTERNAL_IP for multi-VM routing.',
      rfc: 'RFC 3261 Section 21.4.5',
    });
  }

  // 484 Address Incomplete
  if (!info.isRequest && info.statusCode === 484) {
    hints.push({
      severity: 'error',
      category: 'Routing',
      title: '484 Address Incomplete',
      description: 'The Request-URI was incomplete. The server needs more digits or information.',
      suggestion: 'The dialed number may be too short. Check if the DID in the INVITE matches E.164 format (+1NPANXXXXXX).',
      rfc: 'RFC 3261 Section 21.4.15',
    });
  }

  // 502 Bad Gateway
  if (!info.isRequest && info.statusCode === 502) {
    hints.push({
      severity: 'error',
      category: 'Routing',
      title: '502 Bad Gateway',
      description: 'The proxy received an invalid response from the downstream server (FreeSWITCH or Bandwidth).',
      suggestion: 'Check FreeSWITCH is running and reachable from the SBC. Verify dispatcher health checks are passing. Run "kamcmd dispatcher.list" on the SBC.',
      rfc: 'RFC 3261 Section 21.5.3',
    });
  }

  // 503 Service Unavailable
  if (!info.isRequest && info.statusCode === 503) {
    hints.push({
      severity: 'error',
      category: 'Routing',
      title: '503 Service Unavailable',
      description: 'The server is temporarily unable to process the request. May indicate overload or all downstream targets are unreachable.',
      suggestion: 'Check Kamailio dispatcher — all FreeSWITCH destinations may be marked as down. Verify health check probe is succeeding (OPTIONS on port 5080). Check FreeSWITCH for max-sessions limits.',
      rfc: 'RFC 3261 Section 21.5.4',
    });
  }

  // 408 Request Timeout
  if (!info.isRequest && info.statusCode === 408) {
    hints.push({
      severity: 'error',
      category: 'Routing',
      title: '408 Request Timeout',
      description: 'No response was received within the transaction timeout period.',
      suggestion: 'The downstream endpoint is unreachable or too slow. Check network connectivity between SBC and FreeSWITCH. For carrier-side 408, verify Bandwidth IPs are reachable (Dallas: 67.231.2.12, LA: 216.82.238.134).',
      rfc: 'RFC 3261 Section 21.4.9',
    });
  }

  // 480 Temporarily Unavailable
  if (!info.isRequest && info.statusCode === 480) {
    hints.push({
      severity: 'warning',
      category: 'Routing',
      title: '480 Temporarily Unavailable',
      description: 'The called party endpoint is not currently reachable.',
      suggestion: 'For RCF, this means the forward_to destination did not answer. The PSTN number may be offline, busy, or unreachable. Check if the number is valid.',
      rfc: 'RFC 3261 Section 21.4.18',
    });
  }
}

function checkSessionTimers(info: SIPMessageInfo, hints: TroubleshootingHint[]): void {
  // RevUp-specific: Bandwidth sends Session-Expires: 30 in 200 OK which is
  // below the RFC 4028 minimum of 90. FreeSWITCH ignores it and Bandwidth
  // then kills the call.

  if (info.sessionExpires !== null) {
    if (info.sessionExpires < 90) {
      hints.push({
        severity: 'error',
        category: 'Session Timer',
        title: 'Session-Expires Below RFC 4028 Minimum',
        description: `Session-Expires value is ${info.sessionExpires}s, which is below the RFC 4028 minimum of 90s. FreeSWITCH will silently ignore this value and never set up the refresh timer.`,
        suggestion: 'This is a known Bandwidth carrier issue. Kamailio REPLY_HANDLER must normalize Session-Expires to 1800 on all carrier responses. Verify the reply_route is running and subst_body/replace_hf for Session-Expires is working.',
        rfc: 'RFC 4028 Section 4',
      });
    } else if (info.sessionExpires < 90 + 1) {
      // Exactly 90 — edge case
      hints.push({
        severity: 'info',
        category: 'Session Timer',
        title: 'Session-Expires at RFC Minimum',
        description: `Session-Expires is ${info.sessionExpires}s (the RFC 4028 minimum). This is technically valid but may cause frequent re-INVITEs.`,
        suggestion: 'Consider normalizing to 1800s for reduced overhead.',
        rfc: 'RFC 4028 Section 4',
      });
    }

    if (!info.sessionRefresher && info.sessionExpires !== null) {
      hints.push({
        severity: 'warning',
        category: 'Session Timer',
        title: 'Missing refresher Parameter',
        description: 'Session-Expires header is present but does not specify a refresher (uac or uas).',
        suggestion: 'Add refresher=uac or refresher=uas to the Session-Expires header. Our platform uses refresher=uac on outbound INVITEs.',
        rfc: 'RFC 4028 Section 4',
      });
    }
  }

  // 422 Session Interval Too Small
  if (!info.isRequest && info.statusCode === 422) {
    hints.push({
      severity: 'warning',
      category: 'Session Timer',
      title: '422 Session Interval Too Small',
      description: 'The server rejected the session timer value as too small. The Min-SE header in the response indicates the minimum acceptable value.',
      suggestion: 'Kamailio should retry with Session-Expires: 3600 and Min-SE: 900 per the 422 handling logic. Check that the failure route is handling 422 responses.',
      rfc: 'RFC 4028 Section 7',
    });
  }

  // Min-SE sanity
  if (info.minSE !== null && info.sessionExpires !== null && info.minSE > info.sessionExpires) {
    hints.push({
      severity: 'error',
      category: 'Session Timer',
      title: 'Min-SE Exceeds Session-Expires',
      description: `Min-SE (${info.minSE}s) is greater than Session-Expires (${info.sessionExpires}s). This is a protocol violation.`,
      suggestion: 'Session-Expires must be >= Min-SE. Fix the Min-SE or Session-Expires values.',
      rfc: 'RFC 4028 Section 4',
    });
  }
}

function checkCodecNegotiation(info: SIPMessageInfo, hints: TroubleshootingHint[]): void {
  if (!info.sdp) return;

  for (const ms of info.sdp.mediaStreams) {
    // Port 0 means media stream rejected
    if (ms.port === 0) {
      hints.push({
        severity: 'warning',
        category: 'Codec Negotiation',
        title: `Media Stream Rejected (${ms.type})`,
        description: `The ${ms.type} media stream has port 0, indicating it was rejected by the answerer.`,
        suggestion: 'The answerer could not match any offered codecs or capabilities for this stream. Check codec configuration on both sides.',
        rfc: 'RFC 3264 Section 6',
      });
      continue;
    }

    // Check for empty codec list
    if (ms.codecs.length === 0) {
      hints.push({
        severity: 'error',
        category: 'Codec Negotiation',
        title: `No Codecs in ${ms.type} Stream`,
        description: `The ${ms.type} media stream has no codecs listed. The media line may be malformed.`,
        suggestion: 'Check the m= line in SDP for valid payload type numbers and corresponding a=rtpmap lines.',
        rfc: 'RFC 4566 Section 5.14',
      });
    }

    // Narrowband-only check
    const hasWideband = ms.codecs.some(c =>
      c.clockRate > 8000 ||
      c.name.toUpperCase() === 'G722' ||
      c.name.toLowerCase() === 'opus'
    );
    const hasNarrowband = ms.codecs.some(c =>
      (c.clockRate === 8000 || c.name.toUpperCase() === 'PCMU' || c.name.toUpperCase() === 'PCMA' || c.name.toUpperCase() === 'G729')
      && c.name.toLowerCase() !== 'telephone-event' && c.name.toLowerCase() !== 'cn'
    );

    if (ms.type === 'audio' && !hasWideband && hasNarrowband) {
      hints.push({
        severity: 'info',
        category: 'Codec Negotiation',
        title: 'Narrowband Audio Only',
        description: `The ${ms.type} stream only offers narrowband codecs (8kHz). Audio quality is limited to traditional PSTN quality.`,
        suggestion: 'This is expected for PSTN/RCF calls through Bandwidth. Wideband codecs (G.722, Opus) are only relevant for WebRTC/UCaaS.',
        rfc: 'RFC 3551',
      });
    }

    // telephone-event / DTMF check
    const hasDTMF = ms.codecs.some(c =>
      c.name.toLowerCase() === 'telephone-event' || c.payloadType === 101
    );
    if (ms.type === 'audio' && !hasDTMF) {
      hints.push({
        severity: 'warning',
        category: 'Codec Negotiation',
        title: 'No DTMF Support (telephone-event)',
        description: 'The audio stream does not include telephone-event for RFC 2833 DTMF. IVR and DTMF-based services may not work.',
        suggestion: 'Add telephone-event to the codec list. For RCF passthrough this is typically not critical, but for IVR it is essential.',
        rfc: 'RFC 4733',
      });
    }

    // 488 Not Acceptable Here
    if (!info.isRequest && info.statusCode === 488) {
      hints.push({
        severity: 'error',
        category: 'Codec Negotiation',
        title: '488 Not Acceptable Here',
        description: 'The server cannot accept the media capabilities (codecs, encryption, etc.) offered in the INVITE.',
        suggestion: 'Compare the offered SDP with what the server supports. Common causes: SRTP required but not offered, no common audio codec, or SDP body malformed.',
        rfc: 'RFC 3261 Section 21.4.19',
      });
    }
  }
}

function checkRecordRouteMultiVM(info: SIPMessageInfo, hints: TroubleshootingHint[]): void {
  // RevUp multi-VM architecture requires double Record-Route:
  //   outer: NLB VIP (what Bandwidth sees)
  //   inner: SBC_INTERNAL_IP (what FreeSWITCH sees)
  //
  // Missing either causes ACK/BYE routing failures.

  if (!info.isRequest) return; // Only check on requests going to carrier
  if (info.method !== 'INVITE') return; // Only relevant for dialog-creating requests

  if (info.recordRoutes.length === 0) {
    hints.push({
      severity: 'warning',
      category: 'Multi-VM Routing',
      title: 'No Record-Route in INVITE',
      description: 'The INVITE has no Record-Route headers. In-dialog requests (ACK, BYE) will route directly between endpoints, bypassing the proxy.',
      suggestion: 'For multi-VM deployments, Kamailio must insert Record-Route. Use record_route_preset() with both VIP and SBC_INTERNAL_IP for correct mid-dialog routing.',
      rfc: 'RFC 3261 Section 16.6',
    });
  }

  // Check if Record-Route hosts include both public and internal IPs
  // (suggesting proper double-RR for multi-VM)
  if (info.recordRoutes.length >= 2) {
    const hasPublicRR = info.recordRoutes.some(rr => !isPrivateIP(rr.host));
    const hasInternalRR = info.recordRoutes.some(rr => isPrivateIP(rr.host) && !isDockerIP(rr.host));

    if (hasPublicRR && hasInternalRR) {
      hints.push({
        severity: 'info',
        category: 'Multi-VM Routing',
        title: 'Double Record-Route Detected',
        description: `Record-Route includes both public IP (${info.recordRoutes.find(rr => !isPrivateIP(rr.host))?.host}) and internal IP (${info.recordRoutes.find(rr => isPrivateIP(rr.host) && !isDockerIP(rr.host))?.host}). This is the correct pattern for multi-VM deployments.`,
        suggestion: 'Verify the outer RR is the NLB VIP (34.24.133.82) and the inner RR is the SBC\'s VPC IP. The inner RR must be recognized via Kamailio alias= directive.',
        rfc: 'RFC 3261 Section 16.6',
      });
    }

    // Check for Docker IP in Record-Route (bad)
    const hasDockerRR = info.recordRoutes.some(rr => isDockerIP(rr.host));
    if (hasDockerRR) {
      hints.push({
        severity: 'error',
        category: 'Multi-VM Routing',
        title: 'Docker IP in Record-Route',
        description: `A Record-Route header contains a Docker bridge IP. Mid-dialog requests from external endpoints will fail to route.`,
        suggestion: 'Record-Route must use the NLB VIP (public) and SBC_INTERNAL_IP (VPC). Never Docker bridge IPs. Check record_route_preset() parameters in Kamailio config.',
        rfc: 'Platform-specific',
      });
    }
  }

  // Check lr parameter (loose routing)
  for (const rr of info.recordRoutes) {
    if (!rr.lr) {
      hints.push({
        severity: 'warning',
        category: 'Multi-VM Routing',
        title: 'Record-Route Missing lr Parameter',
        description: `Record-Route ${rr.host} does not include ;lr (loose routing). This causes strict routing behavior which most modern SIP stacks don't handle well.`,
        suggestion: 'Always include ;lr in Record-Route URIs. Use record_route_preset("ip:port;lr").',
        rfc: 'RFC 3261 Section 16.6',
      });
    }
  }
}

function checkXCarrierHeader(info: SIPMessageInfo, hints: TroubleshootingHint[]): void {
  // RevUp-specific: X-Carrier header from FreeSWITCH tells Kamailio which
  // Bandwidth IP to use (dallas or la). Missing X-Carrier on outbound
  // INVITEs means Kamailio can't route to the correct carrier edge.

  if (!info.isRequest) return;
  if (info.method !== 'INVITE') return;

  if (info.xCarrier) {
    const validCarriers = ['dallas', 'la', 'los_angeles', 'losangeles'];
    const normalized = info.xCarrier.toLowerCase().trim();
    if (!validCarriers.includes(normalized)) {
      hints.push({
        severity: 'warning',
        category: 'Carrier Routing',
        title: 'Unknown X-Carrier Value',
        description: `X-Carrier header has value "${info.xCarrier}" which is not a recognized Bandwidth edge. Expected: "dallas" or "la".`,
        suggestion: 'Check inbound_router.lua for X-Carrier header value. The Kamailio TO_CARRIER route switches on this value to select Bandwidth Dallas (67.231.2.12) or LA (216.82.238.134).',
        rfc: 'Platform-specific',
      });
    } else {
      hints.push({
        severity: 'info',
        category: 'Carrier Routing',
        title: `X-Carrier: ${info.xCarrier}`,
        description: `Outbound INVITE targets Bandwidth ${normalized === 'dallas' ? 'Dallas (67.231.2.12)' : 'Los Angeles (216.82.238.134)'} edge.`,
        suggestion: 'Carrier routing is correctly specified.',
        rfc: 'Platform-specific',
      });
    }
  }

  // Only flag missing X-Carrier if this looks like it's from FreeSWITCH
  // (has User-Agent containing FreeSWITCH or the request is going to a carrier)
  const isFromFS = info.userAgent.toLowerCase().includes('freeswitch');
  if (!info.xCarrier && isFromFS) {
    hints.push({
      severity: 'warning',
      category: 'Carrier Routing',
      title: 'Missing X-Carrier Header',
      description: 'FreeSWITCH INVITE does not include X-Carrier header. Kamailio may not route to the correct Bandwidth edge.',
      suggestion: 'Verify inbound_router.lua sets X-Carrier via sip_h_X-Carrier channel variable before bridging. Default should be "dallas".',
      rfc: 'Platform-specific',
    });
  }
}

function checkLoopDetection(info: SIPMessageInfo, hints: TroubleshootingHint[]): void {
  const loop = detectRoutingLoop(info);
  if (loop.detected) {
    hints.push({
      severity: 'error',
      category: 'Loop Detection',
      title: 'Routing Loop Suspected',
      description: loop.description,
      suggestion: 'Check Kamailio routing logic for circular routes. Verify that loose_route() recognizes the SBC_INTERNAL_IP via the alias= directive. Missing alias causes Kamailio to not match the inner Record-Route and creates a routing loop for ACKs.',
      rfc: 'RFC 3261 Section 16.3',
    });
  }
}

function checkFragmentationHints(info: SIPMessageInfo, hints: TroubleshootingHint[]): void {
  const frag = checkFragmentation(info.raw);
  if (frag.atRisk) {
    hints.push({
      severity: 'warning',
      category: 'Transport',
      title: 'Message May Be Fragmented',
      description: frag.suggestion,
      suggestion: 'Large SIP messages over UDP risk fragmentation and packet loss. Consider TCP for large messages or reduce unnecessary headers/SDP attributes.',
      rfc: 'RFC 3261 Section 18.1.1',
    });
  }
}

function checkResponseCodes(info: SIPMessageInfo, hints: TroubleshootingHint[]): void {
  if (info.isRequest || info.statusCode === null) return;

  const code = info.statusCode;

  // 100 Trying
  if (code === 100) {
    hints.push({
      severity: 'info',
      category: 'Call Flow',
      title: '100 Trying',
      description: 'The next-hop server has received the request and is processing it. This is a hop-by-hop response.',
      suggestion: 'Normal. The proxy has accepted the request. Waiting for downstream response.',
      rfc: 'RFC 3261 Section 21.1.1',
    });
  }

  // 183 Session Progress (with SDP = early media / ringback)
  if (code === 183) {
    hints.push({
      severity: 'info',
      category: 'Call Flow',
      title: '183 Session Progress',
      description: info.hasSDP
        ? 'Early media is being offered. The caller should hear ringback tone from the PSTN side.'
        : '183 without SDP body. This is unusual — typically 183 carries an SDP for early media.',
      suggestion: info.hasSDP
        ? '183 SDP passthrough works in FreeSWITCH default media mode. No special handling needed for RCF.'
        : 'A 183 without SDP may indicate the carrier is sending a provisional response but not yet ready for media.',
      rfc: 'RFC 3261 Section 21.1.4',
    });
  }

  // 486 Busy Here
  if (code === 486) {
    hints.push({
      severity: 'info',
      category: 'Call Flow',
      title: '486 Busy Here',
      description: 'The called party is busy and cannot accept the call at this time.',
      suggestion: 'The forward-to number is busy. This is a normal call outcome for RCF.',
      rfc: 'RFC 3261 Section 21.4.17',
    });
  }

  // 487 Request Terminated
  if (code === 487) {
    hints.push({
      severity: 'info',
      category: 'Call Flow',
      title: '487 Request Terminated',
      description: 'The INVITE was cancelled (CANCEL received) before being answered.',
      suggestion: 'The caller hung up before the call was answered. This is normal behavior.',
      rfc: 'RFC 3261 Section 21.4.18',
    });
  }

  // 482 Loop Detected / Merged
  if (code === 482) {
    hints.push({
      severity: 'warning',
      category: 'Call Flow',
      title: '482 Loop Detected / Merged',
      description: 'The server detected a loop or received a duplicate request. In our platform, this is used for Bandwidth duplicate INVITE deduplication.',
      suggestion: 'If this is from Kamailio bw_dedup, it is expected — Bandwidth sends duplicates from multiple edges. If unexpected, check Kamailio routing for loops.',
      rfc: 'RFC 3261 Section 21.4.13',
    });
  }

  // 5xx Server errors
  if (code >= 500 && code < 600 && code !== 503) {
    hints.push({
      severity: 'error',
      category: 'Server Error',
      title: `${code} ${info.reasonPhrase}`,
      description: `Server error response on ${info.cseqMethod}. This indicates an internal problem on the server side.`,
      suggestion: 'Check server logs (Kamailio syslog, FreeSWITCH freeswitch.log) for the corresponding error. For 500/503/408/480/404 from Bandwidth, Kamailio should failover to the alternate carrier IP.',
      rfc: 'RFC 3261 Section 21.5',
    });
  }

  // 6xx Global failures
  if (code >= 600) {
    hints.push({
      severity: 'error',
      category: 'Global Failure',
      title: `${code} ${info.reasonPhrase}`,
      description: 'Global failure response — the call cannot succeed at any location.',
      suggestion: 'The called party actively refused the call. For 603 Decline or 607 Unwanted, the number may be blocking calls.',
      rfc: 'RFC 3261 Section 21.6',
    });
  }
}

function checkViaIssues(info: SIPMessageInfo, hints: TroubleshootingHint[]): void {
  // Multiple Via headers are normal in a proxy chain, but check for issues

  if (info.vias.length > 5) {
    hints.push({
      severity: 'warning',
      category: 'Via Chain',
      title: 'Deep Via Chain',
      description: `Message has ${info.vias.length} Via headers, indicating it has traversed many hops. This adds latency and may indicate misconfigured routing.`,
      suggestion: 'Verify each hop in the Via chain is intentional. Our platform should have 2-3 Vias max (Bandwidth -> Kamailio -> FreeSWITCH).',
      rfc: 'RFC 3261 Section 20.42',
    });
  }

  // Check for missing branch parameter (RFC 3261 requires it)
  for (const via of info.vias) {
    if (!via.branch) {
      hints.push({
        severity: 'warning',
        category: 'Via Chain',
        title: 'Via Missing Branch Parameter',
        description: `Via header for ${via.host} lacks the branch parameter. Branch is mandatory per RFC 3261 and used for transaction matching.`,
        suggestion: 'All modern SIP stacks add branch automatically. This may indicate a malformed message or very old SIP implementation.',
        rfc: 'RFC 3261 Section 8.1.1.7',
      });
    } else if (!via.branch.startsWith('z9hG4bK')) {
      hints.push({
        severity: 'info',
        category: 'Via Chain',
        title: 'Non-RFC 3261 Branch',
        description: `Via branch "${via.branch}" does not start with the RFC 3261 magic cookie "z9hG4bK". The server will use RFC 2543 transaction matching.`,
        suggestion: 'This is rare but valid for legacy endpoints. All modern stacks should use the z9hG4bK prefix.',
        rfc: 'RFC 3261 Section 8.1.1.7',
      });
    }
  }
}

function checkSDPIssues(info: SIPMessageInfo, hints: TroubleshootingHint[]): void {
  if (!info.sdp) return;

  // Check for 0.0.0.0 in SDP (call hold per RFC 3264)
  if (info.sdp.connectionAddress === '0.0.0.0') {
    hints.push({
      severity: 'info',
      category: 'SDP',
      title: 'Call Hold Detected (0.0.0.0)',
      description: 'SDP connection address is 0.0.0.0, which is the legacy method for placing a call on hold.',
      suggestion: 'Modern implementations use a=sendonly/a=inactive for hold. The 0.0.0.0 method is deprecated but still widely used.',
      rfc: 'RFC 3264 Section 8.4',
    });
  }

  // Check for mismatched audio ports in offer/answer (port 0 = rejected)
  for (const ms of info.sdp.mediaStreams) {
    // G.729 with Annex B
    const g729 = ms.codecs.find(c => c.name.toUpperCase() === 'G729');
    if (g729 && g729.fmtp && g729.fmtp.includes('annexb=no')) {
      hints.push({
        severity: 'info',
        category: 'SDP',
        title: 'G.729 Annex B Disabled',
        description: 'G.729 with annexb=no means silence suppression (VAD/CNG) is disabled. This provides better audio quality but uses more bandwidth.',
        suggestion: 'This is typically fine for PSTN calls. VAD can cause audio clipping on some endpoints.',
        rfc: 'RFC 3555 Section 4.1.9',
      });
    }

    // WebRTC indicators
    if (ms.rtcpMux && ms.encryption === 'DTLS-SRTP') {
      hints.push({
        severity: 'info',
        category: 'SDP',
        title: 'WebRTC Media Detected',
        description: `The ${ms.type} stream uses DTLS-SRTP with rtcp-mux, indicating a WebRTC endpoint.`,
        suggestion: 'WebRTC requires ICE, DTLS, and rtcp-mux. Ensure all three are negotiated correctly.',
        rfc: 'RFC 8829',
      });
    }

    // ICE candidates present
    if (ms.candidates.length > 0) {
      hints.push({
        severity: 'info',
        category: 'SDP',
        title: `ICE Candidates Present (${ms.type})`,
        description: `${ms.candidates.length} ICE candidate(s) in ${ms.type} stream. ICE connectivity checks will be performed.`,
        suggestion: 'Ensure STUN/TURN servers are reachable. For PSTN calls through our platform, ICE is not used.',
        rfc: 'RFC 8445',
      });
    }
  }

  // No audio stream at all
  const hasAudio = info.sdp.mediaStreams.some(ms => ms.type === 'audio');
  if (!hasAudio && info.sdp.mediaStreams.length > 0) {
    hints.push({
      severity: 'warning',
      category: 'SDP',
      title: 'No Audio Media Stream',
      description: 'The SDP does not contain an audio media stream. Voice calls require at least one audio m= line.',
      suggestion: 'Check the SDP generation. For voice calls, at minimum m=audio with PCMU/PCMA should be present.',
      rfc: 'RFC 3264 Section 5',
    });
  }
}

function checkMissingHeaders(info: SIPMessageInfo, hints: TroubleshootingHint[]): void {
  if (!info.isRequest) return;

  // Missing Call-ID
  if (!info.callId) {
    hints.push({
      severity: 'error',
      category: 'Protocol',
      title: 'Missing Call-ID Header',
      description: 'The Call-ID header is mandatory in all SIP messages. Its absence makes the message invalid.',
      suggestion: 'This is a serious protocol violation. Check the originating endpoint.',
      rfc: 'RFC 3261 Section 20.8',
    });
  }

  // Missing From tag
  if (!info.fromTag && info.method !== 'CANCEL') {
    hints.push({
      severity: 'warning',
      category: 'Protocol',
      title: 'Missing From Tag',
      description: 'The From header should contain a tag parameter for dialog identification.',
      suggestion: 'While not strictly mandatory per RFC 3261, the tag is required for dialog matching. All modern UAs should include it.',
      rfc: 'RFC 3261 Section 8.1.1.3',
    });
  }

  // Missing Contact in INVITE
  if (info.method === 'INVITE' && !info.contact) {
    hints.push({
      severity: 'error',
      category: 'Protocol',
      title: 'Missing Contact Header in INVITE',
      description: 'INVITE requests must include a Contact header. Without it, the remote party cannot send in-dialog requests back.',
      suggestion: 'Contact must be added BEFORE msg_apply_changes() in Kamailio. The dialog module reads Contact during record_route() to create leg info. Missing Contact causes "bad sip message or missing Contact hdr" and breaks ACK/BYE routing.',
      rfc: 'RFC 3261 Section 8.1.1.8',
    });
  }

  // Max-Forwards missing or zero
  if (info.maxForwards === null) {
    hints.push({
      severity: 'info',
      category: 'Protocol',
      title: 'Missing Max-Forwards Header',
      description: 'Max-Forwards is recommended in all requests to prevent infinite loops.',
      suggestion: 'The proxy should add Max-Forwards: 70 if not present.',
      rfc: 'RFC 3261 Section 8.1.1.6',
    });
  } else if (info.maxForwards === 0) {
    hints.push({
      severity: 'error',
      category: 'Protocol',
      title: 'Max-Forwards Reached Zero',
      description: 'Max-Forwards is 0. The proxy must respond with 483 Too Many Hops and not forward the request.',
      suggestion: 'This typically indicates a routing loop. Check proxy configuration.',
      rfc: 'RFC 3261 Section 16.3',
    });
  }
}

// ---------------------------------------------------------------------------
// Convenience: create empty SIPMessageInfo
// ---------------------------------------------------------------------------

function createEmptySIPInfo(raw: string): SIPMessageInfo {
  return {
    isRequest: false,
    method: '',
    requestUri: '',
    statusCode: null,
    reasonPhrase: '',
    sipVersion: '',
    callId: '',
    fromTag: '',
    fromUri: '',
    fromDisplay: '',
    toTag: '',
    toUri: '',
    toDisplay: '',
    cseq: '',
    cseqMethod: '',
    cseqNumber: 0,
    maxForwards: null,
    contentLength: null,
    contentType: '',
    vias: [],
    contact: null,
    recordRoutes: [],
    routes: [],
    authorization: null,
    wwwAuthenticate: null,
    proxyAuthenticate: null,
    proxyAuthorization: null,
    sessionExpires: null,
    sessionRefresher: '',
    minSE: null,
    userAgent: '',
    server: '',
    allow: [],
    supported: [],
    require: [],
    xCarrier: '',
    pAssertedIdentity: '',
    pPreferredIdentity: '',
    diversion: '',
    reasonHeader: '',
    privacy: '',
    sdp: null,
    hasSDP: false,
    raw,
    summary: '',
    direction: 'request',
  };
}
