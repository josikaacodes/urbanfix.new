import React, { useState, useEffect, useRef } from 'react';
import { Ticket, CitizenAuditFeedback, Language, Department } from '../types';
import { TRANSLATIONS } from '../data/translations';
import { CommunityFeedView } from './CommunityFeedView';
import { labelTicket, triageTicket, PRIORITY_TICKET_STYLE, type TriageResult } from '../services/triageApi';

interface CitizenPortalViewProps {
  tickets: Ticket[];
  onCitizenAuditSubmit: (ticketId: string, feedback: CitizenAuditFeedback) => void;
  onReturnToCommand: () => void;
  onReportNewIssue: (newTicket: Partial<Ticket>) => void;
  onOpenReportModal?: () => void;
  onSignOut: () => void;
  onToast: (msg: string) => void;
  residentPhone?: string;
  residentWard?: string;
  language?: Language;
  initialOpenReport?: boolean;
}

export const CitizenPortalView: React.FC<CitizenPortalViewProps> = ({
  tickets,
  onCitizenAuditSubmit,
  onReturnToCommand,
  onReportNewIssue,
  onOpenReportModal,
  onSignOut,
  onToast,
  residentPhone = '+91 98401 24789',
  residentWard = 'Ward 42 (GCC South)',
  language = 'en',
  initialOpenReport = false,
}) => {
  const t = TRANSLATIONS[language];
  const [showReportForm, setShowReportForm] = useState(initialOpenReport);
  const [selectedAuditTicket, setSelectedAuditTicket] = useState<Ticket | null>(null);
  const [citizenSubTab, setCitizenSubTab] = useState<'tickets' | 'community'>('tickets');

  // Intake Form States
  const [description, setDescription] = useState('');
  const [locationText, setLocationText] = useState('Metro Pillar 18, Avenue Road Corridor');
  const [coordinates, setCoordinates] = useState('13.0827° N, 80.2707° E');
  const [attachedPhoto, setAttachedPhoto] = useState<string | null>(
    'https://images.unsplash.com/photo-1544620347-c4fd4a3d5957?auto=format&fit=crop&w=800&q=80'
  );
  const [photoMeta, setPhotoMeta] = useState('IMG_20260925_GNSS.jpg (3.2 MB • EXIF Lock)');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const reportFormRef = useRef<HTMLDivElement>(null);

  // Voice Note Module State
  const [isRecording, setIsRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const recognitionRef = useRef<any>(null);

  // Debounced layer-1 prediction: the local Laya labeller via the agent API.
  const [inferredDept, setInferredDept] = useState<Department>('highways');
  const [inferredDeptLabel, setInferredDeptLabel] = useState('GCC Works / Highways');
  const [expectedSla, setExpectedSla] = useState('4 Hours (Critical Hazard)');
  const [labelSource, setLabelSource] = useState<'laya' | 'keyword-fallback'>('keyword-fallback');
  const [triaging, setTriaging] = useState(false);

  useEffect(() => {
    const text = description.trim();
    if (!text) return;
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        const labels = await labelTicket(text, { location: locationText });
        if (cancelled) return;
        setInferredDept(labels.department);
        setInferredDeptLabel(labels.dept_label);
        setExpectedSla(`${labels.sla_hours} Hours (${labels.priority} Priority)`);
        setLabelSource(labels.source);
      } catch {
        if (cancelled) return;
        const low = text.toLowerCase();
        let dept: Department = 'highways';
        if (/spark|wire|light|luminaire|electric|shock|cable/.test(low)) dept = 'electric';
        else if (/water|pipe|leak|valve|drain|hydro|sewage/.test(low)) dept = 'hydro';
        else if (/trash|garbage|waste|bin|debris|spill|dump/.test(low)) dept = 'sanitation';
        setInferredDept(dept);
        setInferredDeptLabel(
          dept === 'electric'
            ? 'TANGEDCO / Electrical Works'
            : dept === 'hydro'
              ? 'CMWSSB / Water & Sewerage'
              : dept === 'sanitation'
                ? 'Zonal Solid Waste Management'
                : 'GCC Works / Highways'
        );
        setExpectedSla(
          dept === 'electric'
            ? '2 Hours (Live Hazard SLA)'
            : dept === 'hydro'
              ? '6 Hours (Pressurized Main)'
              : dept === 'sanitation'
                ? '8 Hours (Sanitation Intake)'
                : '4 Hours (Corridor Paving)'
        );
        setLabelSource('keyword-fallback');
      }
    }, 900);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [description]);

  // Voice Recording Timer & Web Speech API
  useEffect(() => {
    let timer: NodeJS.Timeout;
    if (isRecording) {
      timer = setInterval(() => {
        setRecordSeconds((prev) => prev + 1);
      }, 1000);
    }
    return () => clearInterval(timer);
  }, [isRecording]);

  const toggleVoiceRecording = () => {
    if (isRecording) {
      // Stop recording
      setIsRecording(false);
      if (recognitionRef.current) {
        try { recognitionRef.current.stop(); } catch (err) {}
      }
      onToast('Voice telemetry captured. Machine transcription inserted into description.');
    } else {
      // Start recording
      setRecordSeconds(0);
      setIsRecording(true);

      const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (SpeechRecognition) {
        try {
          const recognition = new SpeechRecognition();
          recognition.lang = 'en-IN';
          recognition.interimResults = true;
          recognition.onresult = (event: any) => {
            const transcript = Array.from(event.results)
              .map((res: any) => res[0].transcript)
              .join(' ');
            setDescription((prev) => (prev ? `${prev} ${transcript}` : transcript));
          };
          recognition.onerror = () => {
            // Simulated transcription fallback if permission is blocked in sandbox
            setTimeout(() => {
              setDescription('Deep jagged crater on roadway shoulder near Metro Pillar 18. Sharp skid hazard for morning two-wheelers.');
            }, 1200);
          };
          recognition.start();
          recognitionRef.current = recognition;
        } catch (e) {
          setTimeout(() => {
            setDescription('Deep jagged crater on roadway shoulder near Metro Pillar 18. Sharp skid hazard for morning two-wheelers.');
          }, 1200);
        }
      } else {
        // Speech API simulation
        setTimeout(() => {
          setDescription('Deep jagged crater on roadway shoulder near Metro Pillar 18. Sharp skid hazard for morning two-wheelers.');
        }, 1500);
      }
    }
  };

  const handleAutoDetectGps = () => {
    setLocationText('Avenue Road Corridor, Metro Pillar 18 (Ward 42)');
    setCoordinates('13.0827° N, 80.2707° E');
    onToast('GNSS Coordinate Lock: 13.0827° N, 80.2707° E (Ward 42-4B)');
  };

  // Submit Complaint / Transmit Docket
  const handleTransmitDocket = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!description.trim()) {
      onToast('Please describe the defect or record a voice note.');
      return;
    }

    // Full graph run before the docket is filed: Laya -> main agent -> sub-agent -> main answer.
    setTriaging(true);
    let result: TriageResult | null = null;
    try {
      result = await triageTicket(description.trim(), { location: locationText, coordinates });
      setInferredDept(result.department);
      setInferredDeptLabel(result.deptLabel);
      setExpectedSla(`${result.slaHours} Hours (${result.priority} Priority)`);
      setLabelSource(result.labelSource);
    } catch {
      onToast('Agent API unreachable - filing with local keyword triage.');
    } finally {
      setTriaging(false);
    }

    const priority = result?.priority ?? 'P1';
    const style = PRIORITY_TICKET_STYLE[priority];
    const slaSeconds = (result?.slaHours ?? 4) * 3600;

    const randomNum = Math.floor(1000 + Math.random() * 9000);
    const newDocketNumber = `#W42-2026-${randomNum}`;
    const newId = `W42-${randomNum}`;

    const newTicket: Partial<Ticket> = {
      id: newId,
      docketNumber: newDocketNumber,
      title: (result?.title || description.slice(0, 56) + (description.length > 56 ? '...' : '')).slice(0, 60),
      description,
      department: result?.department ?? inferredDept,
      deptLabel: result?.deptLabel ?? inferredDeptLabel,
      location: locationText,
      coordinates,
      status: style.status,
      statusLabel: style.statusLabel,
      badgeClass: style.badgeClass,
      loggedTimeAgo: 'Logged just now',
      slaRemainingSeconds: slaSeconds,
      initialSlaSeconds: slaSeconds,
      aiConfidence: `${((result?.confidence ?? 0.5) * 100).toFixed(1)}% Laya Calibrated`,
      defectType: result?.defectType ?? 'Public Hazard',
      quote: result?.citizenReply ? `"${result.citizenReply}"` : undefined,
      evidencePhoto: attachedPhoto || 'https://images.unsplash.com/photo-1544620347-c4fd4a3d5957?auto=format&fit=crop&w=600&q=80',
      mapCoords: { x: Math.floor(120 + Math.random() * 320), y: Math.floor(100 + Math.random() * 200) },
      lifecycleStage: 'logged',
      citizenFeedback: null,
    };

    onReportNewIssue(newTicket);
    setShowReportForm(false);
    setDescription('');
    onToast(`Docket ${newDocketNumber} transmitted to Ward 42 AI Triage Queue!`);
  };

  // Minimalist Metric Summary
  const activeCount = tickets.filter((t) => t.status === 'critical' || t.status === 'assigned').length;
  const resolvedCount = tickets.filter((t) => t.citizenFeedback?.verified || t.lifecycleStage === 'verified').length;
  const awaitingAuditCount = tickets.filter(
    (t) => (t.status === 'pending' || t.lifecycleStage === 'repaired') && !t.citizenFeedback?.verified
  ).length;

  // Citizen Audit Modal State
  const [auditRating, setAuditRating] = useState(5);
  const [physicalState, setPhysicalState] = useState<'Fully Fixed' | 'Partially Fixed' | 'Not Fixed'>('Fully Fixed');
  const [auditRemarks, setAuditRemarks] = useState('Repaired neatly. Zero leak detected and road leveled.');

  const handleAuditSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAuditTicket) return;

    const feedback: CitizenAuditFeedback = {
      verified: true,
      rating: auditRating,
      physicalState,
      remarks: auditRemarks,
      verifiedAt: 'Today, ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' IST',
    };

    onCitizenAuditSubmit(selectedAuditTicket.id, feedback);
    setSelectedAuditTicket(null);
    onToast(`Docket ${selectedAuditTicket.docketNumber} verified and permanently sealed with 5-star citizen audit.`);
  };

  return (
    <div className="max-w-[1340px] w-full mx-auto p-4 sm:p-6 flex flex-col gap-6 animate-in fade-in">
      {/* ================= CLEAN RESIDENT HEADER ================= */}
      <div className="flex flex-wrap items-center justify-between gap-4 bg-white p-4 sm:p-5 rounded-2xl border border-[#c2c8c2]/40 shadow-xs">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#1a3125] text-white flex items-center justify-center font-bold">
            <span className="material-symbols-outlined text-[20px]">person</span>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-headline text-base sm:text-lg font-bold text-[#051c11]">
                {t.residentDeskTitle}
              </span>
              <span className="px-2 py-0.5 rounded-full bg-[#cee9d7] text-[#082015] font-mono text-[10px] font-bold">
                SIM Verified
              </span>
            </div>
            <div className="flex items-center gap-2 text-xs font-mono text-[#424844] mt-0.5">
              <span>{residentPhone}</span>
              <span>•</span>
              <span className="text-[#1a3125] font-semibold">{residentWard}</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            onClick={() => {
              if (onOpenReportModal) {
                onOpenReportModal();
              } else {
                setShowReportForm(true);
                setTimeout(() => {
                  reportFormRef.current?.scrollIntoView({ behavior: 'smooth' });
                }, 100);
              }
            }}
            className="px-4 py-2 rounded-xl bg-[#1a3125] text-white font-mono text-xs font-semibold hover:bg-[#051c11] transition-all flex items-center gap-1.5 shadow-xs cursor-pointer active:scale-95"
            title="Report New Civic Defect"
          >
            <span className="material-symbols-outlined text-[16px]">add_circle</span>
            <span>+ Report New Issue</span>
          </button>

          <button
            onClick={onReturnToCommand}
            className="px-3.5 py-2 rounded-xl bg-[#ece8df] hover:bg-[#e6e2d9] text-[#051c11] border border-[#c2c8c2]/40 font-mono text-xs font-medium transition-colors hidden sm:flex items-center gap-1"
          >
            <span className="material-symbols-outlined text-[15px]">admin_panel_settings</span>
            <span>Command Console</span>
          </button>

          <button
            onClick={onSignOut}
            className="p-2 text-[#ba1a1a] hover:bg-[#ffdad6]/40 rounded-xl transition-colors"
            title="Sign Out"
          >
            <span className="material-symbols-outlined text-[18px]">logout</span>
          </button>
        </div>
      </div>

      {/* ================= MINIMALIST METRIC SUMMARY (3 Cards) ================= */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {/* Card 1: Active Issues */}
        <div className="bg-white p-5 rounded-2xl border border-[#c2c8c2]/30 shadow-xs flex items-center justify-between">
          <div>
            <span className="font-mono text-[11px] text-[#727973] uppercase tracking-wider block font-semibold">
              {t.activeIssues}
            </span>
            <div className="font-headline text-3xl font-bold text-[#051c11] tabular-nums mt-1">
              {activeCount}
            </div>
            <span className="font-mono text-xs text-[#4c6451]">In Active Municipal Triage</span>
          </div>
          <span className="w-10 h-10 rounded-xl bg-[#f2ede4] text-[#1a3125] flex items-center justify-center">
            <span className="material-symbols-outlined text-[20px]">engineering</span>
          </span>
        </div>

        {/* Card 2: Resolved & Closed */}
        <div className="bg-white p-5 rounded-2xl border border-[#c2c8c2]/30 shadow-xs flex items-center justify-between">
          <div>
            <span className="font-mono text-[11px] text-[#727973] uppercase tracking-wider block font-semibold">
              {t.resolvedClosed}
            </span>
            <div className="font-headline text-3xl font-bold text-[#051c11] tabular-nums mt-1">
              {resolvedCount}
            </div>
            <span className="font-mono text-xs text-[#4c6451]">Citizen Audit Completed</span>
          </div>
          <span className="w-10 h-10 rounded-xl bg-[#c9e4cc] text-[#092011] flex items-center justify-center">
            <span className="material-symbols-outlined text-[20px]">check_circle</span>
          </span>
        </div>

        {/* Card 3: Awaiting Your Audit (Rust Accent Bar) */}
        <div className="bg-white p-5 rounded-2xl border-2 border-[#ffb59c] shadow-xs flex items-center justify-between relative overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-1.5 bg-[#4d1e0d]"></div>
          <div>
            <span className="font-mono text-[11px] text-[#370e01] uppercase tracking-wider block font-bold">
              {t.awaitingYourAudit}
            </span>
            <div className="font-headline text-3xl font-bold text-[#320a00] tabular-nums mt-1">
              {awaitingAuditCount}
            </div>
            <span className="font-mono text-xs text-[#ba1a1a] font-semibold">Physical Seal Required</span>
          </div>
          <span className="w-10 h-10 rounded-xl bg-[#ffdbcf] text-[#370e01] flex items-center justify-center">
            <span className="material-symbols-outlined text-[20px]">verified</span>
          </span>
        </div>
      </div>

      {/* ================= SECTION A: REPORT A CIVIC ISSUE (INTAKE DESK) ================= */}
      {showReportForm && (
        <div ref={reportFormRef} className="bg-white rounded-2xl border-2 border-[#1a3125] p-6 shadow-xl animate-in fade-in zoom-in-95 duration-150">
          <div className="flex items-center justify-between border-b border-[#ece8df] pb-3 mb-5">
            <div className="flex items-center gap-2">
              <span className="w-8 h-8 rounded-lg bg-[#1a3125] text-white flex items-center justify-center">
                <span className="material-symbols-outlined text-[18px]">add_a_photo</span>
              </span>
              <div>
                <h3 className="font-headline text-base font-bold text-[#051c11]">{t.intakeDeskHeader}</h3>
                <span className="font-mono text-[11px] text-[#727973]">
                  Ward 42 Intake Gateway • Automated Photogrammetric Classification
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {onOpenReportModal && (
                <button
                  type="button"
                  onClick={onOpenReportModal}
                  className="px-2.5 py-1 rounded bg-[#cee9d7] text-[#082015] font-mono text-[10px] font-bold hover:bg-[#b2cdbb] transition-colors"
                >
                  Open Full Intake Modal
                </button>
              )}
              <button
                onClick={() => setShowReportForm(false)}
                className="text-[#727973] hover:text-[#1c1c16]"
              >
                ✕
              </button>
            </div>
          </div>

          {/* Quick presets buttons */}
          <div className="mb-4">
            <span className="font-mono text-[10px] text-[#727973] uppercase font-bold block mb-1.5">
              Quick One-Click Test Defect Presets:
            </span>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  setDescription('Severe 8-inch asphalt crater skid hazard on Avenue Road corridor near Metro Pillar 18.');
                  setLocationText('Avenue Road Corridor, Metro Pillar 18 (Ward 42)');
                  setCoordinates('13.0827° N, 80.2707° E');
                  setAttachedPhoto('https://images.unsplash.com/photo-1544620347-c4fd4a3d5957?auto=format&fit=crop&w=800&q=80');
                  setPhotoMeta('POTHOLE_EXIF_GNSS.jpg (2.8 MB)');
                  onToast('Loaded Pothole Preset');
                }}
                className="px-2.5 py-1 rounded-lg bg-[#f7f3ea] hover:bg-[#ece8df] border border-[#c2c8c2]/40 font-mono text-[11px] text-[#051c11] flex items-center gap-1"
              >
                <span className="material-symbols-outlined text-[14px]">construction</span>
                Pothole Crater
              </button>
              <button
                type="button"
                onClick={() => {
                  setDescription('Streetlight pole luminaire sparking and flickering over crosswalk after rain.');
                  setLocationText('School Cross Street 4, Ward 42 Sector 4B');
                  setCoordinates('13.0841° N, 80.2689° E');
                  setAttachedPhoto('https://images.unsplash.com/photo-1517457373958-b7bdd4587205?auto=format&fit=crop&w=800&q=80');
                  setPhotoMeta('LIGHT_EXIF_GNSS.jpg (1.9 MB)');
                  onToast('Loaded Streetlight Preset');
                }}
                className="px-2.5 py-1 rounded-lg bg-[#f7f3ea] hover:bg-[#ece8df] border border-[#c2c8c2]/40 font-mono text-[11px] text-[#051c11] flex items-center gap-1"
              >
                <span className="material-symbols-outlined text-[14px]">lightbulb</span>
                Broken Luminaire
              </button>
              <button
                type="button"
                onClick={() => {
                  setDescription('Pressurized potable drinking water pipeline coupling leaking heavily onto road.');
                  setLocationText('Market Link Road, Sector 4 Junction');
                  setCoordinates('13.0815° N, 80.2730° E');
                  setAttachedPhoto('https://images.unsplash.com/photo-1584467735871-8e85353a8413?auto=format&fit=crop&w=800&q=80');
                  setPhotoMeta('HYDRO_EXIF_GNSS.jpg (3.1 MB)');
                  onToast('Loaded Water Leak Preset');
                }}
                className="px-2.5 py-1 rounded-lg bg-[#f7f3ea] hover:bg-[#ece8df] border border-[#c2c8c2]/40 font-mono text-[11px] text-[#051c11] flex items-center gap-1"
              >
                <span className="material-symbols-outlined text-[14px]">water_drop</span>
                Water Leak
              </button>
              <button
                type="button"
                onClick={() => {
                  setDescription('Garbage bin overflowed onto pedestrian sidewalk blocking transit access.');
                  setLocationText('Market West Gate, Sector 3');
                  setCoordinates('13.0850° N, 80.2670° E');
                  setAttachedPhoto('https://images.unsplash.com/photo-1605600659908-0ef719419d41?auto=format&fit=crop&w=800&q=80');
                  setPhotoMeta('GARBAGE_EXIF_GNSS.jpg (2.2 MB)');
                  onToast('Loaded Sanitation Preset');
                }}
                className="px-2.5 py-1 rounded-lg bg-[#f7f3ea] hover:bg-[#ece8df] border border-[#c2c8c2]/40 font-mono text-[11px] text-[#051c11] flex items-center gap-1"
              >
                <span className="material-symbols-outlined text-[14px]">delete</span>
                Garbage Spill
              </button>
            </div>
          </div>

          <form onSubmit={handleTransmitDocket} className="grid grid-cols-1 md:grid-cols-2 gap-5 text-xs font-body">
            {/* Left: Voice Note Module & Freeform Description */}
            <div className="flex flex-col gap-4">
              {/* Voice Note Module */}
              <div className="p-4 bg-[#f7f3ea] rounded-xl border border-[#c2c8c2]/50 flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 font-mono text-xs font-bold text-[#051c11]">
                    <span className="material-symbols-outlined text-[18px] text-[#4c6451]">mic</span>
                    <span>{t.voiceNoteTitle}</span>
                  </div>
                  {isRecording && (
                    <span className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-[#ffdad6] text-[#ba1a1a] font-mono text-[10px] font-bold">
                      <span className="w-2 h-2 rounded-full bg-[#ba1a1a] animate-ping"></span>
                      <span>REC {recordSeconds}s</span>
                    </span>
                  )}
                </div>

                {/* 8-Bar Audio Visualizer Telemetry */}
                {isRecording && (
                  <div className="flex items-center justify-center gap-1.5 py-2">
                    <span className="w-1.5 bg-[#ba1a1a] rounded-full animate-wave-1"></span>
                    <span className="w-1.5 bg-[#4c6451] rounded-full animate-wave-2"></span>
                    <span className="w-1.5 bg-[#1a3125] rounded-full animate-wave-3"></span>
                    <span className="w-1.5 bg-[#4c6451] rounded-full animate-wave-4"></span>
                    <span className="w-1.5 bg-[#ba1a1a] rounded-full animate-wave-5"></span>
                    <span className="w-1.5 bg-[#1a3125] rounded-full animate-wave-6"></span>
                    <span className="w-1.5 bg-[#4c6451] rounded-full animate-wave-7"></span>
                    <span className="w-1.5 bg-[#ba1a1a] rounded-full animate-wave-8"></span>
                  </div>
                )}

                <button
                  type="button"
                  onClick={toggleVoiceRecording}
                  className={`w-full py-2.5 rounded-lg font-mono text-xs font-semibold flex items-center justify-center gap-2 transition-all ${
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
              </div>

              {/* Freeform Description Area */}
              <div>
                <label className="block font-mono text-[11px] font-semibold text-[#1c1c16] mb-1">
                  Defect Description &amp; Public Hazard Context
                </label>
                <textarea
                  rows={3}
                  required
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={t.describeDefectPlaceholder}
                  className="w-full p-2.5 bg-[#f7f3ea] border border-[#c2c8c2]/50 rounded-xl font-body text-xs focus:outline-none focus:border-[#051c11]"
                />
              </div>

              {/* Debounced Real-Time LLM Pre-Triage Banner */}
              <div className="p-3 bg-[#c9e4cc]/40 rounded-xl border border-[#4c6451]/30 flex items-center justify-between text-xs">
                <div>
                  <span className="text-[10px] font-mono text-[#4e6753] uppercase block font-semibold">
                    {t.inferredDept}:
                  </span>
                  <span className="font-headline font-bold text-[#051c11]">{inferredDeptLabel}</span>
                  <span
                    className={`mt-1 inline-block px-1.5 py-0.5 rounded font-mono text-[9px] font-bold uppercase tracking-wide ${
                      triaging
                        ? 'bg-[#1a3125] text-[#cee9d7]'
                        : labelSource === 'laya'
                          ? 'bg-[#c9e4cc] text-[#1a3125]'
                          : 'bg-[#ece8df] text-[#5b615d]'
                    }`}
                  >
                    {triaging ? 'main agent → sub-agent…' : labelSource === 'laya' ? 'laya • calibrated' : 'keyword • api offline'}
                  </span>
                </div>
                <div className="text-right">
                  <span className="text-[10px] font-mono text-[#4e6753] uppercase block font-semibold">
                    {t.expectedSla}:
                  </span>
                  <span className="font-mono text-xs font-bold text-[#ba1a1a]">{expectedSla}</span>
                </div>
              </div>
            </div>

            {/* Right: Location & Photo Evidence Dropzone */}
            <div className="flex flex-col gap-4">
              {/* Location Input with Auto-Detect GPS */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="font-mono text-[11px] font-semibold text-[#1c1c16]">
                    Location / Landmark
                  </label>
                  <button
                    type="button"
                    onClick={handleAutoDetectGps}
                    className="text-[10px] font-mono text-[#4c6451] hover:underline flex items-center gap-1 font-semibold"
                  >
                    <span className="material-symbols-outlined text-[13px]">my_location</span>
                    {t.autoDetectGps}
                  </button>
                </div>
                <input
                  type="text"
                  required
                  value={locationText}
                  onChange={(e) => setLocationText(e.target.value)}
                  placeholder={t.locationPlaceholder}
                  className="w-full p-2.5 bg-[#f7f3ea] border border-[#c2c8c2]/50 rounded-xl font-body text-xs focus:outline-none focus:border-[#051c11]"
                />
                <span className="font-mono text-[10px] text-[#727973] block mt-1">
                  GPS Locked: {coordinates}
                </span>
              </div>

              {/* Photo Evidence Dropzone */}
              <div>
                <label className="block font-mono text-[11px] font-semibold text-[#1c1c16] mb-1">
                  {t.photoEvidence}
                </label>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      setPhotoMeta(`${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB • EXIF Lock)`);
                      const reader = new FileReader();
                      reader.onload = (ev) => {
                        if (ev.target?.result) {
                          setAttachedPhoto(ev.target.result as string);
                          onToast(`Attached site photo: ${file.name}`);
                        }
                      };
                      reader.readAsDataURL(file);
                    }
                  }}
                  className="hidden"
                />
                <div
                  onClick={() => fileInputRef.current?.click()}
                  className="border-2 border-dashed border-[#c2c8c2] hover:border-[#1a3125] p-3 rounded-xl bg-[#f7f3ea] flex items-center justify-between cursor-pointer transition-colors"
                  title="Click to choose image or camera"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-lg bg-white overflow-hidden shrink-0 border border-[#c2c8c2]/50">
                      {attachedPhoto ? (
                        <img src={attachedPhoto} alt="Site preview" className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-[#4c6451]">
                          <span className="material-symbols-outlined text-[20px]">add_a_photo</span>
                        </div>
                      )}
                    </div>
                    <div>
                      <span className="font-headline font-semibold text-xs text-[#051c11] block">
                        {photoMeta}
                      </span>
                      <span className="font-mono text-[10px] text-[#4c6451]">
                        Click to upload site photo or take camera snap
                      </span>
                    </div>
                  </div>
                  <span className="px-2 py-1 rounded bg-[#c9e4cc] text-[#092011] font-mono text-[10px] font-bold">
                    ATTACHED
                  </span>
                </div>
              </div>

              {/* Transmit Docket Submit */}
              <div className="mt-auto pt-4 flex items-center justify-end gap-2 border-t border-[#ece8df]">
                <button
                  type="button"
                  onClick={() => setShowReportForm(false)}
                  className="px-4 py-2 rounded-xl bg-[#f2ede4] font-mono text-xs hover:bg-[#ece8df]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={triaging}
                  className="px-5 py-2.5 rounded-xl bg-[#1a3125] text-white font-mono text-xs font-semibold hover:bg-[#051c11] shadow-xs flex items-center gap-1.5 disabled:opacity-60 disabled:cursor-wait"
                >
                  <span className="material-symbols-outlined text-[16px]">
                    {triaging ? 'hourglass_top' : 'send'}
                  </span>
                  <span>{triaging ? 'Agent triage…' : t.transmitDocket}</span>
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      {/* ================= SUB-NAVIGATION: MY TICKETS VS NEIGHBORHOOD COMMUNITY FEED ================= */}
      <div className="flex border-b border-[#ece8df] gap-2 pt-2">
        <button
          type="button"
          onClick={() => setCitizenSubTab('tickets')}
          className={`px-4 py-2.5 font-mono text-xs font-bold uppercase tracking-wider border-b-2 transition flex items-center gap-1.5 cursor-pointer ${
            citizenSubTab === 'tickets'
              ? 'border-[#051c11] text-[#051c11] bg-white rounded-t-xl shadow-xs'
              : 'border-transparent text-[#727973] hover:text-[#051c11]'
          }`}
        >
          <span className="material-symbols-outlined text-[16px]">assignment</span>
          <span>My Registered Tickets ({tickets.length})</span>
        </button>

        <button
          type="button"
          onClick={() => setCitizenSubTab('community')}
          className={`px-4 py-2.5 font-mono text-xs font-bold uppercase tracking-wider border-b-2 transition flex items-center gap-1.5 cursor-pointer ${
            citizenSubTab === 'community'
              ? 'border-[#051c11] text-[#051c11] bg-white rounded-t-xl shadow-xs'
              : 'border-transparent text-[#727973] hover:text-[#051c11]'
          }`}
        >
          <span className="material-symbols-outlined text-[16px]">groups</span>
          <span>Neighborhood Community Feed</span>
          <span className="px-1.5 py-0.2 bg-[#a43711] text-white rounded-full text-[10px] font-bold">New</span>
        </button>
      </div>

      {citizenSubTab === 'community' ? (
        <CommunityFeedView
          onOpenReportModal={onOpenReportModal || (() => setShowReportForm(true))}
          onToast={onToast}
          residentWard={residentWard}
        />
      ) : (
        /* ================= SECTION B: MY GRIEVANCE DOCKETS FEED ================= */
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-headline text-lg font-bold text-[#051c11]">{t.docketsFeedTitle}</h3>
              <span className="font-mono text-xs text-[#727973]">
                Chronological complaint feed with two-way audit gates
              </span>
            </div>
          <span className="font-mono text-xs text-[#4c6451] font-semibold">
            {tickets.length} Registered Dockets
          </span>
        </div>

        <div className="flex flex-col gap-4">
          {tickets.map((ticket) => {
            const isResolvedPendingAudit =
              (ticket.status === 'pending' || ticket.lifecycleStage === 'repaired') &&
              !ticket.citizenFeedback?.verified;

            return (
              <div
                key={ticket.id}
                className={`bg-white rounded-2xl border p-5 shadow-xs transition-all ${
                  isResolvedPendingAudit
                    ? 'border-[#ffb59c] ring-1 ring-[#ffb59c]'
                    : 'border-[#c2c8c2]/40 hover:border-[#4c6451]'
                }`}
              >
                {/* Header row */}
                <div className="flex flex-wrap items-start justify-between gap-2 border-b border-[#ece8df] pb-3 mb-3">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-bold text-[#051c11]">
                      {ticket.docketNumber}
                    </span>
                    <span className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold ${ticket.badgeClass}`}>
                      {ticket.statusLabel}
                    </span>
                    <span className="font-mono text-xs text-[#727973]">• {ticket.loggedTimeAgo}</span>
                  </div>

                  <div className="flex items-center gap-2 text-xs font-mono">
                    <span className="text-[#727973]">{ticket.deptLabel}</span>
                    <span>•</span>
                    <span className="font-bold text-[#ba1a1a]">
                      {ticket.slaRemainingSeconds > 0
                        ? `${Math.floor(ticket.slaRemainingSeconds / 3600)}h ${Math.floor(
                            (ticket.slaRemainingSeconds % 3600) / 60
                          )}m SLA remaining`
                        : 'SLA Met'}
                    </span>
                  </div>
                </div>

                {/* Body Details */}
                <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-center">
                  <div className="md:col-span-8 flex flex-col gap-1.5">
                    <h4 className="font-headline text-base font-bold text-[#051c11]">{ticket.title}</h4>
                    <p className="font-body text-xs text-[#424844] leading-relaxed">{ticket.description}</p>
                    <div className="flex items-center gap-3 text-xs font-mono text-[#727973] mt-1">
                      <span className="flex items-center gap-1">
                        <span className="material-symbols-outlined text-[14px]">location_on</span>
                        {ticket.location}
                      </span>
                      {ticket.assignedCrew && (
                        <span className="flex items-center gap-1 text-[#1a3125] font-semibold">
                          <span className="material-symbols-outlined text-[14px]">local_shipping</span>
                          {ticket.assignedCrew}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* 4-Step Progress Visualizer */}
                  <div className="md:col-span-4 bg-[#f7f3ea] p-3 rounded-xl border border-[#c2c8c2]/30 flex flex-col gap-2">
                    <span className="font-mono text-[10px] text-[#727973] uppercase tracking-wider block font-semibold text-center">
                      Resolution Continuum
                    </span>
                    <div className="flex items-center justify-between text-[10px] font-mono">
                      <div className="flex flex-col items-center">
                        <span className="w-5 h-5 rounded-full bg-[#1a3125] text-white flex items-center justify-center font-bold text-[10px]">
                          ✓
                        </span>
                        <span className="mt-0.5 font-bold">Logged</span>
                      </div>
                      <span className="h-0.5 w-4 bg-[#1a3125]"></span>
                      <div className="flex flex-col items-center">
                        <span
                          className={`w-5 h-5 rounded-full flex items-center justify-center font-bold text-[10px] ${
                            ticket.lifecycleStage !== 'logged' ? 'bg-[#1a3125] text-white' : 'bg-[#c2c8c2] text-white'
                          }`}
                        >
                          {ticket.lifecycleStage !== 'logged' ? '✓' : '2'}
                        </span>
                        <span className="mt-0.5">Inspected</span>
                      </div>
                      <span className="h-0.5 w-4 bg-[#1a3125]"></span>
                      <div className="flex flex-col items-center">
                        <span
                          className={`w-5 h-5 rounded-full flex items-center justify-center font-bold text-[10px] ${
                            ticket.lifecycleStage === 'repaired' || ticket.lifecycleStage === 'verified'
                              ? 'bg-[#1a3125] text-white'
                              : 'bg-[#c2c8c2] text-white'
                          }`}
                        >
                          {ticket.lifecycleStage === 'repaired' || ticket.lifecycleStage === 'verified' ? '✓' : '3'}
                        </span>
                        <span className="mt-0.5">Repaired</span>
                      </div>
                      <span className="h-0.5 w-4 bg-[#1a3125]"></span>
                      <div className="flex flex-col items-center">
                        <span
                          className={`w-5 h-5 rounded-full flex items-center justify-center font-bold text-[10px] ${
                            ticket.citizenFeedback?.verified
                              ? 'bg-[#4c6451] text-white'
                              : isResolvedPendingAudit
                              ? 'bg-[#4d1e0d] text-white animate-pulse'
                              : 'bg-[#c2c8c2] text-white'
                          }`}
                        >
                          {ticket.citizenFeedback?.verified ? '✓' : '4'}
                        </span>
                        <span className="mt-0.5 font-semibold">Verify</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* ================= CITIZEN AUDIT GATE ACTION BANNER ================= */}
                {isResolvedPendingAudit && (
                  <div className="mt-4 pt-3 border-t border-[#ffb59c] flex flex-wrap items-center justify-between gap-3 bg-[#ffdbcf]/30 p-3.5 rounded-xl">
                    <div className="flex items-center gap-2.5">
                      <span className="w-8 h-8 rounded-full bg-[#4d1e0d] text-[#ffdbcf] flex items-center justify-center shrink-0">
                        <span className="material-symbols-outlined text-[18px]">verified</span>
                      </span>
                      <div>
                        <span className="font-headline font-bold text-xs text-[#320a00] block">
                          {t.auditGateBannerTitle}
                        </span>
                        <span className="font-body text-xs text-[#6e3824]">
                          Field crew uploaded completion stamp. Your rating permanently seals this municipal docket.
                        </span>
                      </div>
                    </div>

                    <button
                      onClick={() => setSelectedAuditTicket(ticket)}
                      className="px-4 py-2 bg-[#1a3125] text-white rounded-lg font-mono text-xs font-bold hover:bg-[#051c11] transition-all shadow-xs flex items-center gap-1.5"
                    >
                      <span className="material-symbols-outlined text-[15px]">rate_review</span>
                      <span>{t.verifyGiveRating}</span>
                    </button>
                  </div>
                )}

                {/* If verified & feedback already submitted */}
                {ticket.citizenFeedback?.verified && (
                  <div className="mt-4 pt-3 border-t border-[#ece8df] flex items-center justify-between text-xs font-mono bg-[#c9e4cc]/30 p-3 rounded-xl">
                    <div className="flex items-center gap-2 text-[#092011]">
                      <span className="material-symbols-outlined text-[18px] text-[#4c6451]">verified</span>
                      <span>
                        Verified by resident ({ticket.citizenFeedback.rating} Stars • {ticket.citizenFeedback.physicalState})
                      </span>
                    </div>
                    <span className="text-[#727973]">{ticket.citizenFeedback.verifiedAt}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      )}

      {/* ================= CITIZEN AUDIT MODAL ================= */}
      {selectedAuditTicket && (
        <div className="fixed inset-0 z-50 bg-[#31302b]/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white max-w-lg w-full rounded-3xl border border-[#c2c8c2]/50 shadow-2xl overflow-hidden p-6 animate-in fade-in zoom-in-95">
            <div className="flex items-center justify-between pb-3 border-b border-[#ece8df] mb-4">
              <div className="flex items-center gap-2">
                <span className="w-8 h-8 rounded-lg bg-[#4c6451] text-white flex items-center justify-center">
                  <span className="material-symbols-outlined text-[18px]">verified</span>
                </span>
                <div>
                  <h3 className="font-headline text-base font-bold text-[#051c11]">Citizen Audit Gate</h3>
                  <span className="font-mono text-xs text-[#727973]">
                    Docket: {selectedAuditTicket.docketNumber}
                  </span>
                </div>
              </div>
              <button
                onClick={() => setSelectedAuditTicket(null)}
                className="text-[#727973] hover:text-[#1c1c16]"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleAuditSubmit} className="flex flex-col gap-4 text-xs font-body">
              <div>
                <span className="font-headline font-semibold text-xs text-[#051c11] block mb-1">
                  1-to-5 Star Satisfaction Rating
                </span>
                <div className="flex items-center gap-2">
                  {[1, 2, 3, 4, 5].map((star) => (
                    <button
                      key={star}
                      type="button"
                      onClick={() => setAuditRating(star)}
                      className={`text-2xl transition-transform hover:scale-125 ${
                        star <= auditRating ? 'text-[#d97706]' : 'text-[#c2c8c2]'
                      }`}
                    >
                      ★
                    </button>
                  ))}
                  <span className="font-mono text-xs text-[#727973] ml-2">
                    {auditRating === 5
                      ? 'Exceptional Resolution'
                      : auditRating >= 4
                      ? 'Satisfactory'
                      : 'Requires Re-inspection'}
                  </span>
                </div>
              </div>

              <div>
                <span className="font-headline font-semibold text-xs text-[#051c11] block mb-1.5">
                  Physical State Assessment
                </span>
                <div className="grid grid-cols-3 gap-2 font-mono text-xs">
                  {(['Fully Fixed', 'Partially Fixed', 'Not Fixed'] as const).map((state) => (
                    <button
                      key={state}
                      type="button"
                      onClick={() => setPhysicalState(state)}
                      className={`py-2 px-3 rounded-lg border text-center font-bold transition-all ${
                        physicalState === state
                          ? 'bg-[#1a3125] text-white border-[#1a3125]'
                          : 'bg-[#f7f3ea] border-[#c2c8c2]/50 text-[#424844]'
                      }`}
                    >
                      {state}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block font-mono text-[11px] font-semibold text-[#1c1c16] mb-1">
                  Inspector Verification Remarks
                </label>
                <textarea
                  rows={3}
                  value={auditRemarks}
                  onChange={(e) => setAuditRemarks(e.target.value)}
                  placeholder="Detail work quality or note residual debris on roadway..."
                  className="w-full p-2.5 bg-[#f7f3ea] border border-[#c2c8c2]/50 rounded-xl font-body text-xs focus:outline-none focus:border-[#051c11]"
                />
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-[#ece8df]">
                <button
                  type="button"
                  onClick={() => setSelectedAuditTicket(null)}
                  className="px-4 py-2 rounded-xl bg-[#f2ede4] font-mono text-xs hover:bg-[#ece8df]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2.5 rounded-xl bg-[#1a3125] text-white font-mono text-xs font-semibold hover:bg-[#051c11] shadow-xs flex items-center gap-1.5"
                >
                  <span className="material-symbols-outlined text-[16px]">check_circle</span>
                  <span>{t.confirmAndSeal}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
