/**
 * Data + logic layer for the Conference feature.
 *
 * Per the refactor convention (docs/FRONTEND_GLASS_REFACTOR.md), the page and
 * the detail panel do composition + presentation only; all data loading,
 * polling, mutations, and derived state live here.
 *
 * React #310: every hook below is called unconditionally at the top of its hook
 * function — no early returns precede a hook.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  listConferences,
  getConferenceLiveStatus,
  updateConference,
  kickMember,
  muteMember,
  listSchedules,
  deleteSchedule,
  listParticipants,
  removeParticipant,
} from '../../api/conference';
import type {
  Conference,
  ConferenceLiveStatus,
  ConferenceParticipant,
  ConferenceSchedule,
} from '../../types/conference';
import type { AggregatedSchedule, DetailTab } from './types';

/* ─── Page-level data: rooms + aggregated schedules + live polling ──────────── */

export interface UseConferenceDataResult {
  conferences: Conference[];
  selectedId: number | null;
  setSelectedId: (id: number | null) => void;
  activeConference: Conference | null;
  isLoading: boolean;
  allSchedules: AggregatedSchedule[];
  reload: () => void;
  addConference: (conf: Conference) => void;
  removeConference: (id: number) => void;
}

export function useConferenceData(): UseConferenceDataResult {
  const [conferences, setConferences] = useState<Conference[]>([]);
  // Live statuses are polled to keep the server session warm; the value itself
  // is not currently rendered at the page level.
  const [, setLiveStatuses] = useState<Map<number, ConferenceLiveStatus>>(new Map());
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [allSchedules, setAllSchedules] = useState<AggregatedSchedule[]>([]);

  const activeConference =
    selectedId !== null ? conferences.find((c) => c.id === selectedId) ?? null : null;

  /* ── Aggregate upcoming schedules across all rooms ────────────────────────── */
  const loadAllSchedules = useCallback(async (confs: Conference[]) => {
    if (confs.length === 0) {
      setAllSchedules([]);
      return;
    }
    const results = await Promise.allSettled(
      confs.map((c) =>
        listSchedules(c.id).then((s) => s.map((sch) => ({ ...sch, conference: c }))),
      ),
    );
    const now = new Date();
    const combined: AggregatedSchedule[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled') {
        for (const s of r.value) {
          if (new Date(s.end_time) >= now) combined.push(s);
        }
      }
    }
    combined.sort(
      (a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime(),
    );
    setAllSchedules(combined);
  }, []);

  /* ── Load conferences ─────────────────────────────────────────────────────── */
  const reload = useCallback(async () => {
    try {
      const list = await listConferences();
      setConferences(list);
      setSelectedId((prev) => (prev === null && list.length > 0 ? list[0].id : prev));
      void loadAllSchedules(list);
    } catch {
      // Soft-fail: an empty list still renders the page chrome.
    } finally {
      setIsLoading(false);
    }
  }, [loadAllSchedules]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /* ── Poll live statuses for every room ────────────────────────────────────── */
  const pollLiveStatuses = useCallback(async () => {
    if (conferences.length === 0) return;
    const results = await Promise.allSettled(
      conferences.map((c) => getConferenceLiveStatus(c.id).then((s) => ({ id: c.id, s }))),
    );
    const newMap = new Map<number, ConferenceLiveStatus>();
    for (const r of results) {
      if (r.status === 'fulfilled') newMap.set(r.value.id, r.value.s);
    }
    setLiveStatuses(newMap);
  }, [conferences]);

  useEffect(() => {
    void pollLiveStatuses();
    const timer = setInterval(() => void pollLiveStatuses(), 5_000);
    return () => clearInterval(timer);
  }, [pollLiveStatuses]);

  const addConference = useCallback((conf: Conference) => {
    setConferences((prev) => [...prev, conf]);
    setSelectedId(conf.id);
  }, []);

  const removeConference = useCallback((id: number) => {
    setConferences((prev) => prev.filter((c) => c.id !== id));
    setSelectedId((prev) => (prev === id ? null : prev));
  }, []);

  return {
    conferences,
    selectedId,
    setSelectedId,
    activeConference,
    isLoading,
    allSchedules,
    reload: () => void reload(),
    addConference,
    removeConference,
  };
}

/* ─── Detail panel: live status, schedules, participants, settings ──────────── */

export interface UseDetailPanelResult {
  activeTab: DetailTab;
  setActiveTab: (t: DetailTab) => void;

  liveStatus: ConferenceLiveStatus | null;
  liveError: string | null;

  schedules: ConferenceSchedule[];
  loadSchedules: () => void;
  removeSchedule: (scheduleId: number) => Promise<void>;

  participants: ConferenceParticipant[];
  participantsLoading: boolean;
  participantError: string | null;
  loadParticipants: () => void;
  handleRemoveParticipant: (userId: number) => Promise<void>;

  editingSettings: boolean;
  setEditingSettings: (v: boolean) => void;
  settingsName: string;
  setSettingsName: (v: string) => void;
  settingsMaxMembers: number;
  setSettingsMaxMembers: (v: number) => void;
  settingsPin: string;
  setSettingsPin: (v: string) => void;
  settingsModPin: string;
  setSettingsModPin: (v: string) => void;
  settingsVideo: boolean;
  setSettingsVideo: (v: boolean) => void;
  settingsRecording: boolean;
  setSettingsRecording: (v: boolean) => void;
  saving: boolean;
  handleSaveSettings: () => Promise<void>;

  handleKick: (memberId: number) => Promise<void>;
  handleMute: (memberId: number) => Promise<void>;
}

export function useDetailPanel(conf: Conference, onRefresh: () => void): UseDetailPanelResult {
  const [activeTab, setActiveTab] = useState<DetailTab>('live');
  const [liveStatus, setLiveStatus] = useState<ConferenceLiveStatus | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [schedules, setSchedules] = useState<ConferenceSchedule[]>([]);
  const [participants, setParticipants] = useState<ConferenceParticipant[]>(conf.participants ?? []);
  const [participantsLoading, setParticipantsLoading] = useState(false);
  const [participantError, setParticipantError] = useState<string | null>(null);
  const [editingSettings, setEditingSettings] = useState(false);
  const [settingsName, setSettingsName] = useState(conf.name);
  const [settingsMaxMembers, setSettingsMaxMembers] = useState(conf.max_members);
  const [settingsPin, setSettingsPin] = useState(conf.pin ?? '');
  const [settingsModPin, setSettingsModPin] = useState(conf.moderator_pin ?? '');
  const [settingsVideo, setSettingsVideo] = useState(conf.video_enabled);
  const [settingsRecording, setSettingsRecording] = useState(conf.recording_enabled);
  const [saving, setSaving] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /* ── Live status polling ──────────────────────────────────────────────────── */
  const fetchLiveStatus = useCallback(async () => {
    try {
      const status = await getConferenceLiveStatus(conf.id);
      setLiveStatus(status);
      setLiveError(null);
    } catch {
      setLiveError('Could not fetch live status');
    }
  }, [conf.id]);

  useEffect(() => {
    void fetchLiveStatus();
    if (activeTab === 'live') {
      pollRef.current = setInterval(() => void fetchLiveStatus(), 4_000);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchLiveStatus, activeTab]);

  /* ── Schedules ────────────────────────────────────────────────────────────── */
  const loadSchedules = useCallback(async () => {
    try {
      setSchedules(await listSchedules(conf.id));
    } catch {
      /* ignore */
    }
  }, [conf.id]);

  useEffect(() => {
    if (activeTab === 'schedule') void loadSchedules();
  }, [activeTab, loadSchedules]);

  const removeSchedule = useCallback(
    async (scheduleId: number) => {
      await deleteSchedule(conf.id, scheduleId);
      await loadSchedules();
    },
    [conf.id, loadSchedules],
  );

  /* ── Participants ─────────────────────────────────────────────────────────── */
  const loadParticipants = useCallback(async () => {
    setParticipantsLoading(true);
    setParticipantError(null);
    try {
      setParticipants(await listParticipants(conf.id));
    } catch {
      setParticipantError('Failed to load participants');
    } finally {
      setParticipantsLoading(false);
    }
  }, [conf.id]);

  useEffect(() => {
    if (activeTab === 'participants') void loadParticipants();
  }, [activeTab, loadParticipants]);

  const handleRemoveParticipant = useCallback(
    async (userId: number) => {
      try {
        await removeParticipant(conf.id, userId);
        setParticipants((prev) => prev.filter((p) => p.user_id !== userId));
      } catch {
        setParticipantError('Failed to remove participant');
      }
    },
    [conf.id],
  );

  /* ── Settings save ────────────────────────────────────────────────────────── */
  const handleSaveSettings = useCallback(async () => {
    setSaving(true);
    try {
      await updateConference(conf.id, {
        name: settingsName.trim(),
        max_members: settingsMaxMembers,
        pin: settingsPin.trim() || null,
        moderator_pin: settingsModPin.trim() || null,
        video_enabled: settingsVideo,
        recording_enabled: settingsRecording,
      });
      onRefresh();
      setEditingSettings(false);
    } catch {
      /* parent reload will resync */
    } finally {
      setSaving(false);
    }
  }, [
    conf.id,
    settingsName,
    settingsMaxMembers,
    settingsPin,
    settingsModPin,
    settingsVideo,
    settingsRecording,
    onRefresh,
  ]);

  /* ── Moderator actions ────────────────────────────────────────────────────── */
  const handleKick = useCallback(
    async (memberId: number) => {
      try {
        await kickMember(conf.id, memberId);
        await fetchLiveStatus();
      } catch {
        /* ignore */
      }
    },
    [conf.id, fetchLiveStatus],
  );

  const handleMute = useCallback(
    async (memberId: number) => {
      try {
        await muteMember(conf.id, memberId);
        await fetchLiveStatus();
      } catch {
        /* ignore */
      }
    },
    [conf.id, fetchLiveStatus],
  );

  return {
    activeTab,
    setActiveTab,
    liveStatus,
    liveError,
    schedules,
    loadSchedules: () => void loadSchedules(),
    removeSchedule,
    participants,
    participantsLoading,
    participantError,
    loadParticipants: () => void loadParticipants(),
    handleRemoveParticipant,
    editingSettings,
    setEditingSettings,
    settingsName,
    setSettingsName,
    settingsMaxMembers,
    setSettingsMaxMembers,
    settingsPin,
    setSettingsPin,
    settingsModPin,
    setSettingsModPin,
    settingsVideo,
    setSettingsVideo,
    settingsRecording,
    setSettingsRecording,
    saving,
    handleSaveSettings,
    handleKick,
    handleMute,
  };
}
