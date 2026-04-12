import { useSoftphone } from '../../contexts/SoftphoneContext';

const IconMic = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 14, height: 14 }}>
    <path d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconSpeaker = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 14, height: 14 }}>
    <path d="M19.114 5.636a9 9 0 0 1 0 12.728M16.463 8.288a5.25 5.25 0 0 1 0 7.424M6.75 8.25l4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

interface SelectProps {
  label: string;
  icon: React.ReactNode;
  value: string | null;
  onChange: (deviceId: string) => void;
  devices: MediaDeviceInfo[];
}

function DeviceSelect({ label, icon, value, onChange, devices }: SelectProps) {
  if (devices.length === 0) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: '0.7rem',
          fontWeight: 600,
          color: '#64748b',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
        }}
      >
        {icon}
        {label}
      </label>
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        className="sp-device-select"
        style={{
          width: '100%',
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 8,
          color: '#e2e8f0',
          fontSize: '0.78rem',
          padding: '7px 10px',
          outline: 'none',
          cursor: 'pointer',
          appearance: 'none',
          backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2364748b' stroke-width='2'%3E%3Cpath d='m19 9-7 7-7-7' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`,
          backgroundRepeat: 'no-repeat',
          backgroundPosition: 'right 8px center',
          backgroundSize: '14px',
          paddingRight: 28,
        }}
      >
        {devices.map((device) => (
          <option key={device.deviceId} value={device.deviceId}>
            {device.label || `Device ${device.deviceId.slice(0, 8)}`}
          </option>
        ))}
      </select>
    </div>
  );
}

export function DeviceSelector() {
  const {
    audioInputDevices,
    audioOutputDevices,
    selectedMicId,
    selectedSpeakerId,
    selectMic,
    selectSpeaker,
  } = useSoftphone();

  const hasDevices = audioInputDevices.length > 0 || audioOutputDevices.length > 0;

  if (!hasDevices) {
    return (
      <div style={{ fontSize: '0.8rem', color: '#475569', textAlign: 'center', padding: '16px 0' }}>
        No audio devices found.
        <br />
        <span style={{ fontSize: '0.7rem', color: '#334155' }}>
          Grant microphone access to populate this list.
        </span>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <DeviceSelect
        label="Microphone"
        icon={<IconMic />}
        value={selectedMicId}
        onChange={selectMic}
        devices={audioInputDevices}
      />
      <DeviceSelect
        label="Speaker"
        icon={<IconSpeaker />}
        value={selectedSpeakerId}
        onChange={selectSpeaker}
        devices={audioOutputDevices}
      />
    </div>
  );
}
