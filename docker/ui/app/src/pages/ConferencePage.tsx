/**
 * ConferencePage — full-screen conference management page (thin composition layer).
 *
 * Layout:  Sidebar | 320px left room rail | right detail panel — floating as
 * frosted-glass panels over the app-wide liquid-glass backdrop.
 *
 * This is a FULL-SCREEN route OUTSIDE AppLayout (it renders its own Sidebar +
 * SoftphoneWidget), so — per docs/FRONTEND_GLASS_REFACTOR.md §4 — it mounts its
 * own <GlassBackground/> (AppLayout's instance is not present here).
 *
 * Architecture (see docs/FRONTEND_GLASS_REFACTOR.md):
 *   ConferencePage.tsx  → composition + top-level state ONLY (this file)
 *   conference/hooks.ts → data loading, polling, mutations, detail-panel logic
 *   conference/styles.ts→ centralised CSSProperties / builders (blue glass)
 *   conference/components/ → dumb presentational pieces
 *   conference/types.ts → local types
 *
 * React #310: every hook sits unconditionally at the top, before any return.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Sidebar } from '../components/layout/Sidebar';
import { SoftphoneWidget } from '../components/softphone/SoftphoneWidget';
import { ConferenceRoom } from '../components/conference/ConferenceRoom';
import { GlassBackground } from '../components/glass/GlassBackground';
import { GLASS } from '../components/glass/glass';
import { useSoftphone } from '../contexts/SoftphoneContext';
import { createConference } from '../api/conference';
import type { Conference, CreateConferencePayload } from '../types/conference';
import { useConferenceData } from './conference/hooks';
import { CONFERENCE_KEYFRAMES } from './conference/styles';
import { dialCodeFor } from './conference/helpers';
import { RoomSidebar } from './conference/components/RoomSidebar';
import { DetailPanel } from './conference/components/DetailPanel';
import { EmptyDetail } from './conference/components/EmptyDetail';
import { CreateRoomModal } from './conference/components/CreateRoomModal';

export function ConferencePage() {
  // ── ALL hooks first (React #310) ──────────────────────────────────────────
  const { makeCall, activeCall } = useSoftphone();
  const {
    conferences,
    selectedId,
    setSelectedId,
    activeConference,
    isLoading,
    allSchedules,
    reload,
    addConference,
    removeConference,
  } = useConferenceData();

  const [showConferenceOverlay, setShowConferenceOverlay] = useState(false);
  const [isStartingNow, setIsStartingNow] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);

  /*
   * Guard against makeCall firing more than once per join action. A ref (not
   * state) so the flag is readable/writable synchronously within one event-loop
   * tick. Cleared when activeCall returns to null so a fresh join works.
   */
  const joiningRef = useRef(false);

  // Reset the join guard + close the overlay when the active call ends.
  useEffect(() => {
    if (activeCall === null) {
      joiningRef.current = false;
      setShowConferenceOverlay(false);
    }
  }, [activeCall]);

  /** Open the ConferenceRoom lobby for a room (makeCall fires later, in the lobby). */
  const openLobby = useCallback(
    (conf: Conference) => {
      setSelectedId(conf.id);
      setShowConferenceOverlay(true);
    },
    [setSelectedId],
  );

  /** Dial into the selected room — guarded against duplicate makeCall. */
  const dialConference = useCallback(async () => {
    if (!activeConference || joiningRef.current) return;
    joiningRef.current = true;
    await makeCall(dialCodeFor(activeConference.room_number), { video: activeConference.video_enabled });
  }, [activeConference, makeCall]);

  /** Start Meeting Now: join the first room, or auto-create one then join it. */
  const handleStartNow = useCallback(() => {
    if (isLoading || isStartingNow) return;
    const firstConf = conferences[0] ?? null;
    if (firstConf) {
      openLobby(firstConf);
      return;
    }
    void (async () => {
      setIsStartingNow(true);
      try {
        const payload: CreateConferencePayload = {
          name: 'Quick Meeting',
          max_members: 25,
          video_enabled: true,
          recording_enabled: false,
          pin: null,
          moderator_pin: null,
        };
        const newRoom = await createConference(payload);
        addConference(newRoom);
        openLobby(newRoom);
      } catch {
        // Silently ignore — user can use the Create Room modal instead.
      } finally {
        setIsStartingNow(false);
      }
    })();
  }, [isLoading, isStartingNow, conferences, openLobby, addConference]);

  const handleCreated = useCallback(
    (conf: Conference) => {
      addConference(conf);
      setShowCreateModal(false);
    },
    [addConference],
  );

  return (
    <div className="min-h-screen" style={{ position: 'relative', minHeight: '100vh', background: GLASS.bg }}>
      <style>{CONFERENCE_KEYFRAMES}</style>

      {/* Ambient liquid-glass backdrop (this route is outside AppLayout). */}
      <GlassBackground />

      {/* Fixed sidebar (keeps its own per-product accent — do not recolour). */}
      <Sidebar />

      {/* Main shell — fills the space to the right of the fixed 240px sidebar. */}
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          marginLeft: 240,
          height: '100vh',
          display: 'flex',
          gap: 16,
          padding: 16,
          boxSizing: 'border-box',
          overflow: 'hidden',
        }}
      >
        <RoomSidebar
          isLoading={isLoading}
          isStartingNow={isStartingNow}
          allSchedules={allSchedules}
          conferences={conferences}
          selectedId={selectedId}
          onStartNow={handleStartNow}
          onSelectRoom={setSelectedId}
        />

        {activeConference ? (
          <DetailPanel
            key={activeConference.id}
            conf={activeConference}
            onJoin={openLobby}
            onRefresh={reload}
            onDelete={removeConference}
          />
        ) : (
          <EmptyDetail />
        )}
      </div>

      {/* Softphone overlay */}
      <SoftphoneWidget />

      {/* Conference room full-screen overlay (includes the lobby pre-join screen) */}
      {showConferenceOverlay && activeConference && (
        <ConferenceRoom
          conferenceId={activeConference.id}
          conferenceName={activeConference.name}
          roomNumber={activeConference.room_number}
          isModerator={true}
          onJoin={() => void dialConference()}
          onCancel={() => setShowConferenceOverlay(false)}
        />
      )}

      {/* Create room modal (state preserved for parity with the prior page) */}
      {showCreateModal && (
        <CreateRoomModal onClose={() => setShowCreateModal(false)} onCreate={handleCreated} />
      )}
    </div>
  );
}
