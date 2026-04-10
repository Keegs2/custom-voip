# UCaaS Extension Plan — Granite Voice Platform

## Document Purpose
Complete A-to-Z plan for extending the existing VoIP platform into a production-grade Unified Communications as a Service (UCaaS) solution. Covers Tier 1 (WebRTC calling, presence, voicemail) and Tier 2 (video, conferencing, chat, screen sharing) — everything except the mobile app.

---

## 1. Current Platform Summary

| Component | Technology | Status |
|-----------|-----------|--------|
| SBC | Kamailio (host networking, port 5060) | Production |
| B2BUA | FreeSWITCH (host networking, ports 5080/5090) | Production |
| Carrier | Bandwidth (Dallas + LA trunks) | Production |
| Database | PostgreSQL + TimescaleDB | Production |
| Cache | Redis (port 6380) | Partial (broken from mod_lua) |
| API | FastAPI (port 8088) | Production |
| UI | React 19 + Vite + Tailwind v4 | Production |
| Monitoring | Homer 7 (HEP capture) | Production |
| Auth | JWT with role-based access | Production |

---

## 2. UCaaS Architecture Overview

```
                          ┌─────────────────────┐
                          │   Browser / Electron │
                          │   (Verto.js client)  │
                          └──────────┬──────────┘
                                     │ WSS (port 8082)
                                     ▼
┌──────────┐  SIP/5060  ┌────────────────────────┐  SIP/5060  ┌──────────┐
│ Bandwidth ├───────────►│      Kamailio SBC      │◄───────────┤ SIP PBX  │
│ (PSTN)   │◄───────────┤  (rate limit, routing)  ├───────────►│ (Trunk)  │
└──────────┘            └───────────┬────────────┘            └──────────┘
                                    │ SIP/5080
                                    ▼
                        ┌────────────────────────┐
                        │     FreeSWITCH         │
                        │  ┌──────────────────┐  │
                        │  │ mod_verto (WSS)   │  │  ◄── WebRTC clients
                        │  │ mod_sofia (SIP)   │  │  ◄── SIP endpoints
                        │  │ mod_conference    │  │  ◄── Multi-party
                        │  │ mod_voicemail     │  │  ◄── VM storage
                        │  │ mod_callcenter    │  │  ◄── Queue/ACD
                        │  │ mod_record        │  │  ◄── Recording
                        │  │ mod_chat          │  │  ◄── Messaging
                        │  │ mod_presence      │  │  ◄── BLF/Status
                        │  └──────────────────┘  │
                        └────────────┬───────────┘
                                     │
                    ┌────────────────┼────────────────┐
                    ▼                ▼                ▼
              ┌──────────┐   ┌──────────┐   ┌──────────┐
              │ PostgreSQL│   │  Redis   │   │  GCS/S3  │
              │ (CDRs,   │   │ (presence│   │(recordings│
              │  users,  │   │  state,  │   │ voicemail│
              │  config) │   │  cache)  │   │  files)  │
              └──────────┘   └──────────┘   └──────────┘

              ┌──────────┐
              │  coturn   │  ◄── TURN relay for NAT traversal
              │ (STUN/   │
              │  TURN)   │
              └──────────┘
```

---

## 3. FreeSWITCH Module Requirements

### Already Compiled & Loaded
| Module | Purpose | Status |
|--------|---------|--------|
| mod_sofia | SIP endpoint | ✅ Active |
| mod_dptools | Dialplan tools | ✅ Active |
| mod_commands | CLI commands | ✅ Active |
| mod_cdr_csv | CSV CDRs | ✅ Active |
| mod_json_cdr | JSON CDR to API | ✅ Active |
| mod_lua | Lua scripting | ✅ Active |
| mod_loopback | Loopback channels | ✅ Active |

### Need to Enable (Already Compiled)
| Module | Purpose | Action Needed |
|--------|---------|---------------|
| mod_verto | WebRTC via JSON-RPC/WSS | Uncomment in modules.conf.xml, create verto.conf.xml |
| mod_conference | Multi-party conferencing | Uncomment in modules.conf.xml, create conference.conf.xml |
| mod_voicemail | Voicemail system | Uncomment, create voicemail.conf.xml |
| mod_callcenter | ACD/queue | Uncomment, create callcenter.conf.xml |
| mod_chat | Instant messaging | Uncomment |
| mod_presence | Presence/BLF | Already loaded (line 67 in modules.conf.xml) |
| mod_valet_parking | Call parking | Uncomment |
| mod_spy | Call monitoring | Uncomment |

### Need to Compile (Add to Dockerfile)
| Module | Purpose | Dockerfile sed command |
|--------|---------|----------------------|
| mod_verto | WebRTC endpoint | `sed -i 's\|#endpoints/mod_verto\|endpoints/mod_verto\|'` |
| mod_shout | MP3 recording/streaming | `sed -i 's\|#formats/mod_shout\|formats/mod_shout\|'` |
| mod_http_cache | HTTP-based file cache | Already available |
| mod_png | Video overlay | Optional |

---

## 4. New Infrastructure Components

### 4A. TURN Server (coturn)
Required for WebRTC NAT traversal. Without TURN, ~15% of users behind strict NAT/firewalls can't establish media.

```yaml
# docker-compose.yml addition
coturn:
  image: coturn/coturn:latest
  container_name: voip-coturn
  network_mode: host
  volumes:
    - ./docker/coturn/turnserver.conf:/etc/coturn/turnserver.conf
  restart: unless-stopped
```

**turnserver.conf:**
```
listening-port=3478
tls-listening-port=5349
relay-ip=34.74.71.32
external-ip=34.74.71.32
min-port=49152
max-port=65535
realm=voiceplatform.local
server-name=voiceplatform.local
# Static credentials (replace with REST API auth for production)
user=voip:secretpassword
# TLS
cert=/etc/coturn/tls/cert.pem
pkey=/etc/coturn/tls/key.pem
# Logging
log-file=/var/log/coturn/turnserver.log
```

**Ports needed:** UDP/TCP 3478 (STUN), TCP 5349 (TURNS), UDP 49152-65535 (relay)

### 4B. TLS Certificates
WebRTC requires WSS (not plain WS). Options:
- **Let's Encrypt** via certbot for public domain
- **Self-signed** for internal/POC (browsers will warn)
- Certificates shared between coturn + FreeSWITCH mod_verto

### 4C. Object Storage (Call Recordings + Voicemail)
- **Google Cloud Storage** bucket for recording files
- Mount via FUSE or upload via API after recording completes
- Retention policies per customer
- Estimated storage: ~1MB/minute for G.711, ~128KB/minute for compressed

---

## 5. Tier 1 Implementation Plan

### Phase 1.1: WebRTC Calling (2-3 weeks)

**FreeSWITCH Config:**
1. Add `mod_verto` to Dockerfile build + modules.conf.xml
2. Create `verto.conf.xml` with WSS profile on port 8082
3. Generate TLS certificates for WSS
4. Create Verto dialplan context for WebRTC users
5. Configure SRTP (mandatory for WebRTC)
6. Add user directory for WebRTC endpoints (extension numbers)

**verto.conf.xml:**
```xml
<configuration name="verto.conf" description="Verto WebRTC">
  <settings>
    <param name="debug" value="0"/>
  </settings>
  <profiles>
    <profile name="default-v4">
      <param name="bind-local" value="0.0.0.0:8082" secure="true"/>
      <param name="force-register-domain" value="voiceplatform.local"/>
      <param name="secure-combined" value="/usr/local/freeswitch/conf/tls/wss.pem"/>
      <param name="secure-chain" value="/usr/local/freeswitch/conf/tls/wss.pem"/>
      <param name="userauth" value="true"/>
      <param name="context" value="default"/>
      <param name="dialplan" value="XML"/>
      <param name="mcast-address" value="224.1.1.1"/>
      <param name="mcast-port" value="1337"/>
      <param name="rtp-ip" value="34.74.71.32"/>
      <!-- ICE/STUN/TURN -->
      <param name="ext-rtp-ip" value="34.74.71.32"/>
      <param name="outbound-codec-string" value="opus,PCMU,PCMA"/>
      <param name="inbound-codec-string" value="opus,PCMU,PCMA"/>
      <param name="apply-candidate-acl" value="wan_v4.auto"/>
      <param name="timer-name" value="soft"/>
    </profile>
  </profiles>
</configuration>
```

**TURN Server:**
1. Deploy coturn container
2. Configure with platform credentials
3. Point Verto ICE candidates to TURN server

**Frontend (React):**
1. Install Verto.js client library
2. Create `SoftphoneContext` — manages Verto WebSocket connection
3. Build `SoftphoneWidget` — floating dial pad + call controls
4. Integrate with AuthContext (WebRTC credentials from user account)
5. Audio device management (mic/speaker selection)

**API:**
1. `POST /extensions` — assign extension to user
2. `GET /extensions` — list user's extensions
3. WebRTC credentials endpoint (generates Verto auth)
4. Extension-to-user mapping in database

**Database:**
```sql
CREATE TABLE extensions (
    id SERIAL PRIMARY KEY,
    extension VARCHAR(10) NOT NULL UNIQUE,
    user_id INT REFERENCES users(id),
    customer_id INT REFERENCES customers(id),
    display_name VARCHAR(100),
    voicemail_enabled BOOLEAN DEFAULT true,
    dnd BOOLEAN DEFAULT false,
    forward_on_busy VARCHAR(20),
    forward_on_no_answer VARCHAR(20),
    forward_timeout INT DEFAULT 30,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE user_devices (
    id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(id),
    device_type VARCHAR(20) NOT NULL, -- 'webrtc', 'sip_phone', 'softphone'
    device_name VARCHAR(100),
    user_agent VARCHAR(200),
    registered_at TIMESTAMPTZ,
    last_seen TIMESTAMPTZ,
    status VARCHAR(20) DEFAULT 'offline'
);
```

### Phase 1.2: Presence / BLF (1 week)

**FreeSWITCH:**
- `mod_presence` already loaded
- Configure presence events for Verto channels
- Map extension status: available, on-call, DND, away, offline

**Frontend:**
- Presence indicators (colored dots) next to contacts/extensions
- Status selector in softphone widget (Available / Busy / DND / Away)
- Real-time updates via Verto event subscriptions

**API:**
```sql
CREATE TABLE presence_status (
    user_id INT PRIMARY KEY REFERENCES users(id),
    status VARCHAR(20) NOT NULL DEFAULT 'available',
    status_message VARCHAR(200),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Phase 1.3: Voicemail (1-2 weeks)

**FreeSWITCH:**
- Enable `mod_voicemail`
- Configure voicemail profiles (greeting, max message length, retention)
- MWI (Message Waiting Indicator) notifications via Verto
- Voicemail-to-email via API webhook (FS calls our API which sends email)

**Storage:**
- Voicemail audio files stored in GCS bucket
- Metadata in PostgreSQL

**Frontend:**
- Visual voicemail in softphone widget
- Play/delete messages
- Record custom greeting
- Voicemail notification badge

**Database:**
```sql
CREATE TABLE voicemails (
    id SERIAL PRIMARY KEY,
    extension_id INT REFERENCES extensions(id),
    caller_id VARCHAR(30),
    caller_name VARCHAR(100),
    duration_ms INT,
    storage_path VARCHAR(500), -- GCS path
    read BOOLEAN DEFAULT false,
    transcription TEXT, -- future: speech-to-text
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE voicemail_greetings (
    id SERIAL PRIMARY KEY,
    extension_id INT REFERENCES extensions(id),
    greeting_type VARCHAR(20) DEFAULT 'unavailable', -- unavailable, busy, name
    storage_path VARCHAR(500),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 6. Tier 2 Implementation Plan

### Phase 2.1: Video Calling (1-2 weeks)

**FreeSWITCH:**
- Already supports H.264, VP8, VP9 via mod_verto
- Add video codec preferences to verto.conf.xml
- Configure video bandwidth limits per profile

**Frontend:**
- Extend SoftphoneWidget with video toggle button
- `VideoCallPanel` component with local/remote video streams
- Camera device selector
- Picture-in-Picture mode
- Bandwidth-adaptive quality (720p default, 1080p on good connection)

**No new database tables needed** — video calls use existing CDR pipeline.

### Phase 2.2: Conferencing (2-3 weeks)

**FreeSWITCH:**
- Enable `mod_conference`
- Conference profiles: `default` (audio), `video` (audio+video), `webinar` (presenter mode)
- Conference controls: mute, deaf, kick, lock, record
- Dynamic conference creation via API

**conference.conf.xml:**
```xml
<configuration name="conference.conf" description="Audio/Video Conferencing">
  <caller-controls>
    <group name="default">
      <control action="mute" digits="0"/>
      <control action="deaf mute" digits="*"/>
      <control action="energy up" digits="9"/>
      <control action="energy equ" digits="8"/>
      <control action="energy dn" digits="7"/>
      <control action="vol talk up" digits="3"/>
      <control action="vol talk zero" digits="2"/>
      <control action="vol talk dn" digits="1"/>
      <control action="vol listen up" digits="6"/>
      <control action="vol listen zero" digits="5"/>
      <control action="vol listen dn" digits="4"/>
      <control action="hangup" digits="#"/>
    </group>
  </caller-controls>

  <profiles>
    <profile name="default">
      <param name="domain" value="voiceplatform.local"/>
      <param name="rate" value="48000"/>
      <param name="interval" value="20"/>
      <param name="energy-level" value="100"/>
      <param name="comfort-noise" value="true"/>
      <param name="moh-sound" value="$${hold_music}"/>
      <param name="caller-controls" value="default"/>
      <param name="moderator-controls" value="default"/>
      <param name="max-members" value="50"/>
    </profile>
    <profile name="video">
      <param name="domain" value="voiceplatform.local"/>
      <param name="rate" value="48000"/>
      <param name="interval" value="20"/>
      <param name="energy-level" value="100"/>
      <param name="max-members" value="25"/>
      <param name="video-mode" value="mux"/>
      <param name="video-layout-name" value="group:grid"/>
      <param name="video-canvas-size" value="1920x1080"/>
      <param name="video-fps" value="30"/>
      <param name="video-codec-bandwidth" value="2mb"/>
    </profile>
  </profiles>
</configuration>
```

**Frontend:**
- `ConferencePanel` — multi-party view with participant grid
- Create/join conference from UI
- Moderator controls (mute all, kick, lock room)
- Participant list with status indicators
- Screen sharing in conferences (via getDisplayMedia)

**API:**
```sql
CREATE TABLE conference_rooms (
    id SERIAL PRIMARY KEY,
    customer_id INT REFERENCES customers(id),
    name VARCHAR(100) NOT NULL,
    room_number VARCHAR(20) UNIQUE,
    pin VARCHAR(10),
    moderator_pin VARCHAR(10),
    max_participants INT DEFAULT 25,
    video_enabled BOOLEAN DEFAULT true,
    recording_enabled BOOLEAN DEFAULT false,
    created_by INT REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE conference_participants (
    id SERIAL PRIMARY KEY,
    room_id INT REFERENCES conference_rooms(id),
    user_id INT REFERENCES users(id),
    extension VARCHAR(10),
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    left_at TIMESTAMPTZ,
    is_moderator BOOLEAN DEFAULT false
);

CREATE TABLE conference_recordings (
    id SERIAL PRIMARY KEY,
    room_id INT REFERENCES conference_rooms(id),
    storage_path VARCHAR(500),
    duration_ms INT,
    file_size_bytes BIGINT,
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ
);
```

### Phase 2.3: Chat / Messaging (2-3 weeks)

**Architecture Decision: Dedicated WebSocket chat service vs Verto chat**

Verto supports chat via event channels, but for a production messaging system, a dedicated service is better:
- Message persistence
- Read receipts
- Typing indicators
- Group conversations
- File attachments (future)
- Offline message delivery

**Recommended: WebSocket service integrated into FastAPI**
- FastAPI supports WebSocket natively
- Messages stored in PostgreSQL
- Real-time delivery via WebSocket
- Falls back to polling if WS disconnects

**Frontend:**
- `ChatPanel` in sidebar or floating panel
- Conversation list with unread badges
- Message thread with timestamps
- Typing indicators
- Online/offline status from presence

**Database:**
```sql
CREATE TABLE chat_conversations (
    id SERIAL PRIMARY KEY,
    type VARCHAR(20) NOT NULL DEFAULT 'direct', -- 'direct', 'group'
    name VARCHAR(100), -- for group chats
    customer_id INT REFERENCES customers(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE chat_participants (
    id SERIAL PRIMARY KEY,
    conversation_id INT REFERENCES chat_conversations(id),
    user_id INT REFERENCES users(id),
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    last_read_at TIMESTAMPTZ,
    UNIQUE(conversation_id, user_id)
);

CREATE TABLE chat_messages (
    id BIGSERIAL PRIMARY KEY,
    conversation_id INT REFERENCES chat_conversations(id),
    sender_id INT REFERENCES users(id),
    content TEXT NOT NULL,
    message_type VARCHAR(20) DEFAULT 'text', -- 'text', 'file', 'system'
    metadata JSONB, -- file info, mentions, etc.
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_chat_messages_conv ON chat_messages(conversation_id, created_at DESC);
```

### Phase 2.4: Screen Sharing (1 week)

**No server-side changes needed** — WebRTC `getDisplayMedia()` is browser-native.

**Frontend:**
- "Share Screen" button in video calls and conferences
- Replaces camera feed with screen capture
- Can share entire screen, specific window, or browser tab
- Stop sharing button
- Viewer sees shared screen as a video stream

### Phase 2.5: Call Recording (1-2 weeks)

**FreeSWITCH:**
- `record_session` command in dialplan/Lua
- Recording format: WAV (lossless) or MP3 (via mod_shout, smaller files)
- Automatic recording based on customer settings
- On-demand recording via API (start/stop during call)

**Storage:**
- Upload to GCS bucket after recording completes
- Signed URLs for playback from the portal

**Frontend:**
- Recording indicator during calls
- Recording browser in customer portal
- Playback with waveform visualization
- Download button

**Database:**
```sql
CREATE TABLE call_recordings (
    id SERIAL PRIMARY KEY,
    cdr_uuid VARCHAR(64) REFERENCES cdrs(uuid),
    customer_id INT REFERENCES customers(id),
    storage_path VARCHAR(500),
    storage_bucket VARCHAR(100),
    duration_ms INT,
    file_size_bytes BIGINT,
    format VARCHAR(10) DEFAULT 'wav',
    recorded_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Phase 2.6: Call Queues / ACD (2 weeks)

**FreeSWITCH:**
- Enable `mod_callcenter`
- Queue strategies: ring-all, longest-idle, round-robin, top-down
- Agent states: available, on-break, logged-out
- Queue announcements (position, estimated wait)
- Overflow rules (timeout to voicemail, other queue, external number)

**Frontend:**
- Queue dashboard (real-time stats: calls waiting, avg wait, agents available)
- Agent status toggle (Available / Break / Sign Out)
- Supervisor view: monitor, whisper, barge

**Database:**
```sql
CREATE TABLE call_queues (
    id SERIAL PRIMARY KEY,
    customer_id INT REFERENCES customers(id),
    name VARCHAR(100) NOT NULL,
    strategy VARCHAR(30) DEFAULT 'longest-idle-agent',
    max_wait_time INT DEFAULT 300,
    moh_sound VARCHAR(200),
    announce_position BOOLEAN DEFAULT true,
    announce_interval INT DEFAULT 30,
    overflow_action VARCHAR(50), -- 'voicemail', 'extension:1001', 'external:+15551234567'
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE queue_agents (
    id SERIAL PRIMARY KEY,
    queue_id INT REFERENCES call_queues(id),
    user_id INT REFERENCES users(id),
    extension VARCHAR(10),
    priority INT DEFAULT 1,
    status VARCHAR(20) DEFAULT 'logged-out',
    last_call_at TIMESTAMPTZ,
    UNIQUE(queue_id, user_id)
);
```

---

## 7. Electron Desktop App

### Architecture
```
electron-app/
  package.json
  main.js          — Electron main process
  preload.js       — Bridge between main and renderer
  src/
    index.html     — loads the React app
```

### Key Features
- **System tray** with presence color indicator (green/red/yellow)
- **OS notifications** for incoming calls (even when minimized)
- **Global keyboard shortcuts** — answer (Ctrl+Enter), hangup (Ctrl+Escape), mute (Ctrl+M)
- **Auto-launch** on system startup (optional)
- **Deep linking** — handle `tel:` and `sip:` URIs for click-to-call
- **Auto-update** via electron-updater + GitHub releases

### Build
- electron-builder for packaging (macOS .dmg, Windows .exe/.msi)
- Code signing for macOS (Apple Developer cert) and Windows (Authenticode)

---

## 8. Implementation Timeline

### Tier 1: Core UCaaS (6-8 weeks)

| Week | Phase | Deliverable |
|------|-------|-------------|
| 1-2 | 1.1a | mod_verto enabled, WSS working, TURN server deployed |
| 2-3 | 1.1b | Verto.js client integrated, basic calling works |
| 3-4 | 1.1c | Softphone widget complete (dial, answer, hold, transfer) |
| 4-5 | 1.2 | Presence system working (status indicators, BLF) |
| 5-6 | 1.3 | Voicemail system (record, play, MWI, visual VM) |
| 6-7 | — | Testing, polish, bug fixes |
| 7-8 | — | Electron desktop app packaging |

### Tier 2: Collaboration (6-8 weeks)

| Week | Phase | Deliverable |
|------|-------|-------------|
| 1-2 | 2.1 | Video calling (1:1 video, camera management) |
| 2-4 | 2.2 | Conferencing (multi-party, moderator controls, video grid) |
| 4-6 | 2.3 | Chat/messaging (conversations, real-time, persistence) |
| 5 | 2.4 | Screen sharing in calls and conferences |
| 6-7 | 2.5 | Call recording (automatic + on-demand, storage, playback) |
| 7-8 | 2.6 | Call queues/ACD (agent management, queue dashboard) |

### Total: 12-16 weeks for both tiers

---

## 9. Production Readiness Checklist

### Security
- [ ] TLS certificates for WSS (Let's Encrypt or enterprise CA)
- [ ] SRTP mandatory for all WebRTC media
- [ ] TURN server with ephemeral credentials (not static)
- [ ] Rate limiting on Verto WebSocket connections
- [ ] Input validation on all chat messages
- [ ] Recording encryption at rest

### Scalability
- [ ] Multiple FreeSWITCH instances behind Kamailio dispatcher
- [ ] Redis cluster for shared presence/registration state
- [ ] PostgreSQL read replicas for CDR queries
- [ ] GCS bucket with lifecycle policies for recordings
- [ ] CDN for static assets (Electron updates, web app)

### Compliance
- [ ] E911 (Bandwidth provides, needs integration)
- [ ] HIPAA (if healthcare customers) — encrypted recordings, audit logs
- [ ] Call recording consent announcements
- [ ] Data retention policies per customer

### Monitoring
- [ ] Prometheus metrics from FreeSWITCH (mod_prometheus)
- [ ] Grafana dashboards for call volume, quality, errors
- [ ] Homer for SIP/RTP quality monitoring
- [ ] Telchemy integration for advanced QoS (future)
- [ ] Alerting on MOS degradation, high packet loss

---

## 10. Technology Stack Summary

| Layer | Current | UCaaS Addition |
|-------|---------|---------------|
| Signaling | SIP (Kamailio + Sofia) | + Verto/WSS (mod_verto) |
| Media | RTP/SRTP (G.711) | + WebRTC (Opus, VP8/H.264) |
| NAT Traversal | ext-rtp-ip (simple) | + ICE/STUN/TURN (coturn) |
| Conferencing | None | mod_conference (audio + video) |
| Messaging | None | FastAPI WebSocket + PostgreSQL |
| Voicemail | None | mod_voicemail + GCS storage |
| Call Queues | None | mod_callcenter |
| Recording | None | record_session + GCS |
| Desktop | Browser only | + Electron app |
| Presence | None | mod_presence + Verto events |

---

## 11. Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|-----------|
| mod_verto stability | High | Extensive testing, fallback to SIP.js if needed |
| TURN server costs | Medium | Monitor relay bandwidth, set per-user limits |
| Video bandwidth | Medium | Adaptive bitrate, cap at 720p default |
| Redis dependency | Medium | Fix existing Redis issues first |
| Browser compatibility | Medium | Test Chrome, Firefox, Safari, Edge |
| Recording storage costs | Low | Compressed format (Opus/MP3), retention policies |
| Electron maintenance | Low | Auto-update, shared codebase with web |

---

## 12. Dependencies & Prerequisites

Before starting Tier 1:
1. **Fix Redis connectivity** — needed for presence, caching, shared state
2. **TLS certificates** — WSS requires valid TLS
3. **Domain name** — needed for TLS certs and proper WebRTC origin
4. **GCP firewall rules** — open ports 8082 (WSS), 3478 (STUN), 49152-65535 (TURN relay)
5. **GCS bucket** — for recordings and voicemail storage

---

*This document should be revisited and updated as implementation progresses. Each phase should have its own detailed technical spec before coding begins.*
