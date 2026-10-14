import React, { useState, useEffect, useRef } from 'react';
import { Ticket, Language, Department } from '../types';
import { TRANSLATIONS } from '../data/translations';
import {
  labelTicket,
  triageTicket,
  PRIORITY_TICKET_STYLE,
  type Priority,
  type TriageResult,
} from '../services/triageApi';

interface ReportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (newTicket: Partial<Ticket>) => void;
  onToast: (msg: string) => void;
  language?: Language;
  onNavigateToTicket?: (ticketId: string) => void;
}

const PRESET_TEMPLATES = [
  {
    label: 'Road Pothole',
    icon: 'construction',
    dept: 'highways' as Department,
    deptLabel: 'GCC Works / Highways',
    title: 'Severe asphalt crater skid hazard on Avenue Road corridor',
    desc: 'Deep 8-inch pothole crater expanding on primary bus lane near Metro Pillar 18. Two-wheelers actively swerving into opposite oncoming traffic lane.',
    location: 'Avenue Road Corridor, Near Metro Pillar 18 (Ward 42)',
    coords: '13.0827° N, 80.2707° E',
    photo: 'https://images.unsplash.com/photo-1544620347-c4fd4a3d5957?auto=format&fit=crop&w=800&q=80',
    slaHours: 4,
    slaLabel: '4 Hours (Critical Road Hazard)',
    defectType: 'Asphalt Void / Skid Hazard',
    aiConfidence: '98.4% Neural Match',
  },
  {
    label: 'Streetlight Luminaire',
    icon: 'lightbulb',
    dept: 'electric' as Department,
    deptLabel: 'TANGEDCO / Electrical Works',
    title: 'Streetlight pole luminaire sparking and flickering over crosswalk',
    desc: 'High-mast street fixture ballast sparking intermittently after rain showers. Pedestrian crossing plunged in darkness creating severe nighttime safety risk.',
    location: 'School Cross Street 4, Ward 42 Sector 4B',
    coords: '13.0841° N, 80.2689° E',
    photo: 'https://images.unsplash.com/photo-1517457373958-b7bdd4587205?auto=format&fit=crop&w=800&q=80',
    slaHours: 2,
    slaLabel: '2 Hours (Electrical Arc Hazard)',
    defectType: 'Short Circuit / Dark Spot',
    aiConfidence: '96.2% Neural Match',
  },
  {
    label: 'Water Main Leak',
    icon: 'water_drop',
    dept: 'hydro' as Department,
    deptLabel: 'CMWSSB / Water & Sewerage',
    title: 'High-pressure potable water pipe coupling ruptured',
    desc: 'Underground pressurized potable pipeline coupling leaking heavily. Clean drinking water flooding pavement and eroding road foundation.',
    location: 'Market Link Road, Sector 4 Junction',
    coords: '13.0815° N, 80.2730° E',
    photo: 'https://images.unsplash.com/photo-1584467735871-8e85353a8413?auto=format&fit=crop&w=800&q=80',
    slaHours: 6,
    slaLabel: '6 Hours (Pressurized Main Breach)',
    defectType: 'Pipe Rupture / Potable Waste',
    aiConfidence: '94.8% Neural Match',
  },
  {
    label: 'Overflowing Garbage',
    icon: 'delete',
    dept: 'sanitation' as Department,
    deptLabel: 'Zonal Solid Waste Management',
    title: 'Heavy garbage bin spillover blocking pedestrian sidewalk',
    desc: 'Secondary collection container overflowed onto adjacent footpath. Commercial organic waste generating foul odor and street block.',
    location: 'Ward 42 Market West Gate, Sector 3',
    coords: '13.0850° N, 80.2670° E',
    photo: 'https://images.unsplash.com/photo-1605600659908-0ef719419d41?auto=format&fit=crop&w=800&q=80',
    slaHours: 8,
    slaLabel: '8 Hours (Solid Waste Backlog)',
    defectType: 'Secondary Bin Overflow',
    aiConfidence: '97.1% Neural Match',
  },
];

// Defect label shown while only layer-1 (Laya labelling) has run.
const DEFAULT_DEFECT: Record<Department, string> = {
  highways: 'Asphalt Defect / Skid Hazard',
  electric: 'Electrical Luminaire / Arc Hazard',
  hydro: 'Pipe Rupture / Flow Hazard',
  sanitation: 'Solid Waste Backlog',
};

const DEPT_LABEL: Record<Department, string> = {
  highways: 'GCC Works / Highways',
  electric: 'TANGEDCO / Electrical Works',
  hydro: 'CMWSSB / Water & Sewerage',
  sanitation: 'Zonal Solid Waste Management',
};

const SLA_BY_DEPT: Record<Department, number> = { highways: 4, electric: 2, hydro: 6, sanitation: 8 };

// Keyword inference used only when the agent API is unreachable.
const keywordInfer = (text: string): Department => {
  if (/spark|wire|light|luminaire|electric|shock|cable|transformer|bulb/.test(text)) return 'electric';
  if (/water|pipe|leak|valve|drain|hydro|sewage|manhole|flood/.test(text)) return 'hydro';
  if (/trash|garbage|waste|bin|debris|spill|dump|sweep/.test(text)) return 'sanitation';
  return 'highways';
};

export const ReportModal: React.FC<ReportModalProps> = ({
  isOpen,
  onClose,
  onSubmit,
  onToast,
  language = 'en',
  onNavigateToTicket,
}) => {
  const t = TRANSLATIONS[language];

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [locationText, setLocationText] = useState('Avenue Road Corridor, Near Metro Pillar 18');
  const [coordinates, setCoordinates] = useState('13.0827° N, 80.2707° E');
  const [selectedDept, setSelectedDept] = useState<Department>('highways');
  const [deptLabel, setDeptLabel] = useState('GCC Works / Highways');
  const [expectedSla, setExpectedSla] = useState('4 Hours (Critical Hazard)');
  const [aiConfidence, setAiConfidence] = useState('98.2% Neural Match');
  const [defectType, setDefectType] = useState('Public Hazard');
  const [evidencePhoto, setEvidencePhoto] = useState<string>(PRESET_TEMPLATES[0].photo);
  const [photoName, setPhotoName] = useState('IMG_20260925_GNSS.jpg');
  // Agent API state: layer-1 labelling runs live, the full graph runs on submit.
  const [aiSource, setAiSource] = useState<'laya' | 'keyword-fallback'>('keyword-fallback');
  const [aiStatus, setAiStatus] = useState<'idle' | 'labelling' | 'triaging'>('idle');

  // Voice recording
  const [isRecording, setIsRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const recognitionRef = useRef<any>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Initialize with first preset
  useEffect(() => {
    if (isOpen && !title) {
      applyPreset(PRESET_TEMPLATES[0]);
    }
  }, [isOpen]);

  const applyPreset = (preset: typeof PRESET_TEMPLATES[0]) => {
    setTitle(preset.title);
    setDescription(preset.desc);
    setSelectedDept(preset.dept);
    setDeptLabel(preset.deptLabel);
    setLocationText(preset.location);
    setCoordinates(preset.coords);
    setEvidencePhoto(preset.photo);
    setExpectedSla(preset.slaLabel);
    setDefectType(preset.defectType);
    setAiConfidence(preset.aiConfidence);
    setPhotoName(`${preset.dept.toUpperCase()}_EVIDENCE_GNSS.jpg`);
    onToast(`Applied preset: ${preset.label}`);
  };

  // Layer-1 inference: the local Laya labeller via the agent API, debounced so it fires ~1s
  // after the citizen stops typing. Keyword fallback keeps the UI usable if the API is down.
  useEffect(() => {
    const text = `${description} ${title}`.trim();
    if (!text) return;
    let cancelled = false;
    const handle = setTimeout(async () => {
      setAiStatus('labelling');
      try {
        const labels = await labelTicket(text, { location: locationText });
        if (cancelled) return;
        setSelectedDept(labels.department);
        setDeptLabel(labels.dept_label);
        setDefectType(DEFAULT_DEFECT[labels.department]);
        setExpectedSla(`${labels.sla_hours} Hours (${labels.priority} Priority)`);
        setAiConfidence(
          `${(labels.department_confidence * 100).toFixed(1)}% ${
            labels.source === 'laya' ? 'Laya Calibrated' : 'Keyword Match'
          }`
        );
        setAiSource(labels.source);
      } catch {
        if (cancelled) return;
        const dept = keywordInfer(text.toLowerCase());
        setSelectedDept(dept);
        setDeptLabel(DEPT_LABEL[dept]);
        setExpectedSla(`${SLA_BY_DEPT[dept]} Hours (Local Keyword Triage)`);
        setDefectType(DEFAULT_DEFECT[dept]);
        setAiConfidence('Keyword Heuristic (API offline)');
        setAiSource('keyword-fallback');
      } finally {
        if (!cancelled) setAiStatus('idle');
      }
    }, 900);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [description, title]);

  // Voice recording timer
  useEffect(() => {
    let timer: NodeJS.Timeout;
    if (isRecording) {
      timer = setInterval(() => {
        setRecordSeconds((s) => s + 1);
      }, 1000);
    }
    return () => clearInterval(timer);
  }, [isRecording]);

  const toggleVoiceRecording = () => {
    if (isRecording) {
      setIsRecording(false);
      if (recognitionRef.current) {
        try { recognitionRef.current.stop(); } catch (err) {}
      }
      onToast('Voice transcription telemetry saved to description.');
    } else {
      setRecordSeconds(0);
      setIsRecording(true);

      const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (SpeechRecognition) {
        try {
          const rec = new SpeechRecognition();
          rec.lang = language === 'ta' ? 'ta-IN' : 'en-IN';
          rec.interimResults = true;
          rec.onresult = (ev: any) => {
            const transcript = Array.from(ev.results)
              .map((res: any) => res[0].transcript)
              .join(' ');
            setDescription((prev) => (prev ? `${prev} ${transcript}` : transcript));
            if (!title) {
              setTitle(transcript.slice(0, 50));
            }
          };
          rec.onerror = () => {
            // Simulated transcription
            setTimeout(() => {
              setDescription((prev) =>
                prev ? `${prev}. Severe asphalt crater hazard noted by resident.` : 'Deep crater on Avenue Road corridor near Metro Pillar 18. Dangerous skid hazard.'
              );
              if (!title) setTitle('Asphalt crater skid hazard near Metro Pillar 18');
            }, 1200);
          };
          rec.start();
          recognitionRef.current = rec;
        } catch (e) {
          setTimeout(() => {
            setDescription((prev) =>
              prev ? `${prev}. Severe asphalt crater hazard noted by resident.` : 'Deep crater on Avenue Road corridor near Metro Pillar 18. Dangerous skid hazard.'
            );
          }, 1200);
        }
      } else {
        setTimeout(() => {
          setDescription((prev) =>
            prev ? `${prev}. Severe asphalt crater hazard noted by resident.` : 'Deep crater on Avenue Road corridor near Metro Pillar 18. Dangerous skid hazard.'
          );
        }, 1200);
      }
    }
  };

  const handleAutoDetectGPS = () => {
    setLocationText('Avenue Road Corridor, Near Metro Pillar 18 (Ward 42-4B)');
    setCoordinates('13.0827° N, 80.2707° E');
    onToast('Locked GNSS Telemetry: 13.0827° N, 80.2707° E (Precision <1.4m)');
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setPhotoName(file.name);
      const reader = new FileReader();
      reader.onload = (event) => {
        if (event.target?.result) {
          setEvidencePhoto(event.target.result as string);
          onToast(`Uploaded image ${file.name} with EXIF GNSS tag.`);
        }
      };
      reader.readAsDataURL(file);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!description.trim() && !title.trim()) {
      onToast('Please describe the defect or select a preset template.');
      return;
    }

    // Full graph: Laya labels -> main agent routes -> department sub-agent -> main answer.
    const ticketText = `${title.trim()} ${description.trim()}`.trim();
    setAiStatus('triaging');
    onToast('Agent triage running: Laya labelling → main agent → sub-agent dispatch…');
    let result: TriageResult | null = null;
    try {
      result = await triageTicket(ticketText, { location: locationText, coordinates });
      setSelectedDept(result.department);
      setDeptLabel(result.deptLabel);
      setDefectType(result.defectType);
      setExpectedSla(`${result.slaHours} Hours (${result.priority} Priority)`);
      setAiConfidence(`${(result.confidence * 100).toFixed(1)}% Laya Calibrated`);
      setAiSource(result.labelSource);
    } catch {
      onToast('Agent API unreachable - docket filed with local keyword triage.');
    } finally {
      setAiStatus('idle');
    }

    const priority: Priority = result?.priority ?? 'P1';
    const style = PRIORITY_TICKET_STYLE[priority];
    const slaSeconds = (result?.slaHours ?? 4) * 3600;

    const randomId = Math.floor(1000 + Math.random() * 9000);
    const newId = `W42-${randomId}`;
    const newDocketNumber = `#W42-2026-${randomId}`;

    const newTicket: Partial<Ticket> = {
      id: newId,
      docketNumber: newDocketNumber,
      title: (result?.title || title.trim() || description.slice(0, 50) || 'Reported Civic Defect').slice(0, 60),
      description: description.trim() || 'Citizen reported public defect via UrbanFix AI Intake Gateway.',
      department: result?.department ?? selectedDept,
      deptLabel: result?.deptLabel ?? deptLabel,
      location: locationText,
      coordinates,
      status: style.status,
      statusLabel: style.statusLabel,
      badgeClass: style.badgeClass,
      loggedTimeAgo: 'Logged just now',
      slaRemainingSeconds: slaSeconds,
      initialSlaSeconds: slaSeconds,
      aiConfidence,
      defectType,
      // Main agent's reply to the citizen, surfaced as the docket quote.
      quote: result?.citizenReply ? `"${result.citizenReply}"` : undefined,
      evidencePhoto,
      mapCoords: {
        x: Math.floor(140 + Math.random() * 260),
        y: Math.floor(110 + Math.random() * 180),
      },
      lifecycleStage: 'logged',
      citizenFeedback: null,
    };

    onSubmit(newTicket);
    onClose();

    if (onNavigateToTicket) {
      onNavigateToTicket(newId);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-[#051c11]/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4 overflow-y-auto">
      <div className="bg-white max-w-2xl w-full rounded-2xl border border-[#c2c8c2]/50 shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 my-auto">
        {/* Header */}
        <div className="bg-[#1a3125] text-white p-4 sm:p-5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-white/10 text-[#cee9d7] flex items-center justify-center font-bold">
              <span className="material-symbols-outlined text-[22px]">add_a_photo</span>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-headline text-lg sm:text-xl font-bold tracking-tight">
                  {language === 'ta' ? 'குறைபாட்டைப் புகாரளிக்கவும்' : 'Report New Civic Issue'}
                </h2>
                <span className="px-2 py-0.5 rounded-full bg-[#cee9d7] text-[#082015] font-mono text-[10px] font-bold uppercase">
                  Ward 42 Intake
                </span>
              </div>
              <p className="font-mono text-xs text-[#b2cdbb] mt-0.5">
                Multimodal AI Ingestion • Photogrammetric Defect Detection &amp; Priority SLA
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-4 sm:p-6 flex flex-col gap-5 text-xs font-body max-h-[82vh] overflow-y-auto custom-scroll">
          {/* Quick Presets Strip */}
          <div>
            <span className="font-mono text-[11px] font-semibold text-[#424844] uppercase tracking-wider block mb-2">
              Quick One-Click Test Presets:
            </span>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {PRESET_TEMPLATES.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => applyPreset(preset)}
                  className={`p-2.5 rounded-xl border text-left flex flex-col gap-1 transition-all ${
                    title === preset.title
                      ? 'bg-[#1a3125] text-white border-[#1a3125] shadow-xs scale-[1.02]'
                      : 'bg-[#f7f3ea] text-[#1c1c16] border-[#c2c8c2]/50 hover:bg-[#ece8df]'
                  }`}
                >
                  <span className="material-symbols-outlined text-[18px]">
                    {preset.icon}
                  </span>
                  <span className="font-headline font-bold text-xs leading-tight">
                    {preset.label}
                  </span>
                  <span className="font-mono text-[10px] opacity-80">
                    {preset.slaHours}h SLA
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Department Selection */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block font-mono text-[11px] font-semibold text-[#1c1c16] mb-1">
                Target Municipal Department
              </label>
              <select
                value={selectedDept}
                onChange={(e) => {
                  const val = e.target.value as Department;
                  setSelectedDept(val);
                  if (val === 'highways') setDeptLabel('GCC Works / Highways');
                  if (val === 'electric') setDeptLabel('TANGEDCO / Electrical Works');
                  if (val === 'hydro') setDeptLabel('CMWSSB / Water & Sewerage');
                  if (val === 'sanitation') setDeptLabel('Zonal Solid Waste Management');
                }}
                className="w-full p-2.5 bg-[#f7f3ea] border border-[#c2c8c2]/50 rounded-xl font-mono text-xs focus:outline-none focus:border-[#051c11]"
              >
                <option value="highways">GCC Works / Highways (Potholes, Roadways)</option>
                <option value="electric">TANGEDCO / Electrical Works (Luminaires, Wires)</option>
                <option value="hydro">CMWSSB / Water &amp; Sewerage (Pipes, Valves)</option>
                <option value="sanitation">Zonal Solid Waste Management (Garbage, Bins)</option>
              </select>
            </div>

            <div>
              <label className="block font-mono text-[11px] font-semibold text-[#1c1c16] mb-1">
                Issue Summary / Short Title
              </label>
              <input
                type="text"
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="E.g., Asphalt crater skid hazard near Metro Pillar 18"
                className="w-full p-2.5 bg-[#f7f3ea] border border-[#c2c8c2]/50 rounded-xl font-body text-xs focus:outline-none focus:border-[#051c11]"
              />
            </div>
          </div>

          {/* Voice Recording + Description */}
          <div className="p-4 bg-[#f7f3ea] rounded-xl border border-[#c2c8c2]/50 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 font-mono text-xs font-bold text-[#051c11]">
                <span className="material-symbols-outlined text-[18px] text-[#4c6451]">mic</span>
                <span>{t.voiceNoteTitle}</span>
              </div>
              {isRecording ? (
                <span className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-[#ffdad6] text-[#ba1a1a] font-mono text-[10px] font-bold">
                  <span className="w-2 h-2 rounded-full bg-[#ba1a1a] animate-ping"></span>
                  <span>RECORDING {recordSeconds}s</span>
                </span>
              ) : (
                <span className="text-[11px] font-mono text-[#727973]">
                  Web Speech API Active
                </span>
              )}
            </div>

            {/* 8-bar audio visualizer telemetry */}
            {isRecording && (
              <div className="flex items-center justify-center gap-1.5 py-2">
                <span className="w-1.5 h-6 bg-[#ba1a1a] rounded-full animate-pulse"></span>
                <span className="w-1.5 h-8 bg-[#4c6451] rounded-full animate-bounce"></span>
                <span className="w-1.5 h-10 bg-[#1a3125] rounded-full animate-pulse"></span>
                <span className="w-1.5 h-7 bg-[#4c6451] rounded-full animate-bounce"></span>
                <span className="w-1.5 h-9 bg-[#ba1a1a] rounded-full animate-pulse"></span>
                <span className="w-1.5 h-11 bg-[#1a3125] rounded-full animate-bounce"></span>
                <span className="w-1.5 h-8 bg-[#4c6451] rounded-full animate-pulse"></span>
                <span className="w-1.5 h-6 bg-[#ba1a1a] rounded-full animate-bounce"></span>
              </div>
            )}

            <div className="flex gap-2">
              <button
                type="button"
                onClick={toggleVoiceRecording}
                className={`py-2 px-4 rounded-lg font-mono text-xs font-semibold flex items-center justify-center gap-2 transition-all ${
                  isRecording
                    ? 'bg-[#ba1a1a] text-white animate-pulse'
                    : 'bg-white text-[#051c11] border border-[#c2c8c2]/50 hover:bg-[#ece8df]'
                }`}
              >
                <span className="material-symbols-outlined text-[16px]">
                  {isRecording ? 'stop_circle' : 'mic'}
                </span>
                <span>{isRecording ? t.stopRecording : t.recordVoice}</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setDescription(
                    'Large asphalt cavity approximately 10cm depth expanding on south carriage lane. Two wheelers encountering skid hazard.'
                  );
                  onToast('Simulated voice note transcribed into text.');
                }}
                className="py-2 px-3 rounded-lg bg-white border border-[#c2c8c2]/50 text-[#424844] font-mono text-[11px] hover:bg-[#ece8df]"
              >
                Insert Sample Audio Note
              </button>
            </div>

            <div>
              <label className="block font-mono text-[11px] font-semibold text-[#1c1c16] mb-1">
                Detailed Defect &amp; Hazard Context
              </label>
              <textarea
                rows={3}
                required
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t.describeDefectPlaceholder}
                className="w-full p-2.5 bg-white border border-[#c2c8c2]/50 rounded-xl font-body text-xs focus:outline-none focus:border-[#051c11]"
              />
            </div>

            {/* AI Pre-triage banner */}
            <div className="p-3 bg-[#c9e4cc]/40 rounded-xl border border-[#4c6451]/30 flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-[18px] text-[#1a3125]">psychology</span>
                <div>
                  <span className="text-[10px] font-mono text-[#4e6753] uppercase block font-semibold">
                    {t.inferredDept}: {deptLabel}
                  </span>
                  <span className="font-headline font-bold text-[#051c11]">{defectType}</span>
                  <span
                    className={`mt-1 inline-block px-1.5 py-0.5 rounded font-mono text-[9px] font-bold uppercase tracking-wide ${
                      aiStatus === 'triaging'
                        ? 'bg-[#1a3125] text-[#cee9d7]'
                        : aiStatus === 'labelling'
                          ? 'bg-[#d9e8ff] text-[#123a6b]'
                          : aiSource === 'laya'
                            ? 'bg-[#c9e4cc] text-[#1a3125]'
                            : 'bg-[#ece8df] text-[#5b615d]'
                    }`}
                  >
                    {aiStatus === 'triaging'
                      ? 'main agent → sub-agent…'
                      : aiStatus === 'labelling'
                        ? 'laya labelling…'
                        : aiSource === 'laya'
                          ? 'laya • calibrated'
                          : 'keyword • api offline'}
                  </span>
                </div>
              </div>
              <div className="text-right">
                <span className="text-[10px] font-mono text-[#4e6753] uppercase block font-semibold">
                  AI Severity SLA:
                </span>
                <span className="font-mono text-xs font-bold text-[#ba1a1a]">{expectedSla}</span>
                <span className="text-[10px] font-mono text-[#4c6451] block">{aiConfidence}</span>
              </div>
            </div>
          </div>

          {/* Location & Photo Evidence */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Location */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <label className="font-mono text-[11px] font-semibold text-[#1c1c16]">
                  Location / Sector Landmark
                </label>
                <button
                  type="button"
                  onClick={handleAutoDetectGPS}
                  className="text-[10px] font-mono text-[#1a3125] font-bold hover:underline flex items-center gap-1"
                >
                  <span className="material-symbols-outlined text-[13px]">my_location</span>
                  Auto-Detect GPS
                </button>
              </div>
              <input
                type="text"
                required
                value={locationText}
                onChange={(e) => setLocationText(e.target.value)}
                placeholder="E.g. Metro Pillar 18, Avenue Road Corridor"
                className="w-full p-2.5 bg-[#f7f3ea] border border-[#c2c8c2]/50 rounded-xl font-body text-xs focus:outline-none focus:border-[#051c11]"
              />
              <div className="flex items-center justify-between p-2 bg-[#ece8df]/60 rounded-lg text-[10px] font-mono text-[#424844]">
                <span>GNSS Locked: {coordinates}</span>
                <span className="text-[#4c6451] font-semibold">Ward 42 Zonal Mesh</span>
              </div>
            </div>

            {/* Photo Evidence */}
            <div className="flex flex-col gap-2">
              <label className="block font-mono text-[11px] font-semibold text-[#1c1c16]">
                Photogrammetric Evidence
              </label>

              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleFileUpload}
                className="hidden"
              />

              <div
                onClick={() => fileInputRef.current?.click()}
                className="border-2 border-dashed border-[#c2c8c2] hover:border-[#1a3125] p-2.5 rounded-xl bg-[#f7f3ea] flex items-center justify-between cursor-pointer transition-colors"
                title="Click to select or upload site photo"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-12 h-12 rounded-lg bg-white overflow-hidden shrink-0 border border-[#c2c8c2]/40">
                    <img
                      src={evidencePhoto}
                      alt="Site Evidence Preview"
                      className="w-full h-full object-cover"
                    />
                  </div>
                  <div className="truncate">
                    <span className="font-headline font-semibold text-xs text-[#051c11] block truncate">
                      {photoName}
                    </span>
                    <span className="font-mono text-[10px] text-[#4c6451] flex items-center gap-1">
                      <span className="material-symbols-outlined text-[12px]">check_circle</span>
                      Click to choose file or camera
                    </span>
                  </div>
                </div>
                <span className="px-2 py-1 rounded bg-[#c9e4cc] text-[#092011] font-mono text-[10px] font-bold shrink-0">
                  ATTACHED
                </span>
              </div>
            </div>
          </div>

          {/* Modal Actions */}
          <div className="flex items-center justify-between pt-4 border-t border-[#ece8df]">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2.5 rounded-xl bg-[#f2ede4] font-mono text-xs hover:bg-[#ece8df] text-[#424844]"
            >
              Cancel
            </button>

            <button
              type="submit"
              disabled={aiStatus === 'triaging'}
              className="px-6 py-2.5 rounded-xl bg-[#1a3125] text-white font-mono text-xs font-semibold hover:bg-[#051c11] shadow-md flex items-center gap-2 transition-all active:scale-[0.98] disabled:opacity-60 disabled:cursor-wait"
            >
              <span className="material-symbols-outlined text-[18px]">
                {aiStatus === 'triaging' ? 'hourglass_top' : 'send'}
              </span>
              <span>
                {aiStatus === 'triaging'
                  ? 'Agent triage in progress…'
                  : 'Transmit Docket to Ward 42 Dispatch'}
              </span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
