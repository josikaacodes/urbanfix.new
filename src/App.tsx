import React, { useState, useEffect } from 'react';
import { Ticket, FieldUnit, AuditRecord, TicketStatus, AppView, AuthUser, Language, CitizenAuditFeedback } from './types';
import { INITIAL_TICKETS, INITIAL_CREWS, INITIAL_AUDIT_LOGS } from './data/mockData';
import { LandingPage } from './components/LandingPage';
import { LoginPage } from './components/LoginPage';
import { TopBar } from './components/TopBar';
import { KPIRow } from './components/KPIRow';
import { SpatialMap } from './components/SpatialMap';
import { InspectorCard } from './components/InspectorCard';
import { DispatchQueue } from './components/DispatchQueue';
import { DispatchModal } from './components/DispatchModal';
import { VerificationModal } from './components/VerificationModal';
import { EmergencyModal } from './components/EmergencyModal';
import { ShiftLogModal } from './components/ShiftLogModal';
import { ActiveCrewsView } from './components/ActiveCrewsView';
import { AuditRecordsView } from './components/AuditRecordsView';
import { CitizenPortalView } from './components/CitizenPortalView';
import { ReportModal } from './components/ReportModal';
import { Toast } from './components/Toast';

const DEFAULT_OFFICER: AuthUser = {
  id: 'officer-1',
  name: 'Eng. R. Sundaram',
  role: 'nodal_officer',
  roleTitle: 'Zonal Nodal Engineer',
  badgeId: 'ENG-GCC-W42',
  ward: 'Ward 42 Zonal Office',
  email: 'r.sundaram@chennaicorporation.gov.in',
  avatarInitials: 'RS',
};

export default function App() {
  const [tickets, setTickets] = useState<Ticket[]>(INITIAL_TICKETS);
  const [crews, setCrews] = useState<FieldUnit[]>(INITIAL_CREWS);
  const [auditLogs, setAuditLogs] = useState<AuditRecord[]>(INITIAL_AUDIT_LOGS);

  // App routing state: 'landing' | 'login' | 'dashboard' | 'citizen'
  const [appView, setAppView] = useState<AppView>('landing');
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(DEFAULT_OFFICER);
  const [language, setLanguage] = useState<Language>('en');

  // Citizen Session Data
  const [citizenPhone, setCitizenPhone] = useState('+91 98401 24789');
  const [citizenWard, setCitizenWard] = useState('Ward 42, Sector 4B');

  const [selectedTicketId, setSelectedTicketId] = useState<string>('W42-9842');
  const [currentTab, setCurrentTab] = useState<'triage' | 'gis' | 'crews' | 'audit'>('triage');
  const [selectedStatusTab, setSelectedStatusTab] = useState<'all' | TicketStatus>('all');
  const [globalSearch, setGlobalSearch] = useState('');

  // Modals state
  const [isReportModalOpen, setIsReportModalOpen] = useState(false);
  const [dispatchModalTicketId, setDispatchModalTicketId] = useState<string | null>(null);
  const [verificationModalTicketId, setVerificationModalTicketId] = useState<string | null>(null);
  const [emergencyModalOpen, setEmergencyModalOpen] = useState(false);
  const [shiftLogModalOpen, setShiftLogModalOpen] = useState(false);

  // Toast state
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [toastTimeout, setToastTimeout] = useState<NodeJS.Timeout | null>(null);

  // Auto-sync ticker (15s)
  const [autoSyncCount, setAutoSyncCount] = useState<number>(15);

  const showToast = (msg: string) => {
    if (toastTimeout) clearTimeout(toastTimeout);
    setToastMessage(msg);
    const t = setTimeout(() => {
      setToastMessage(null);
    }, 3800);
    setToastTimeout(t);
  };

  const toggleLanguage = () => {
    setLanguage((prev) => (prev === 'en' ? 'ta' : 'en'));
    showToast(language === 'en' ? 'மொழி தமிழுக்கு மாற்றப்பட்டது (Tamil Mode)' : 'Language switched to English');
  };

  // Decrement SLA countdowns & auto-sync ticker every second
  useEffect(() => {
    const timer = setInterval(() => {
      setTickets((prev) =>
        prev.map((ticket) => ({
          ...ticket,
          slaRemainingSeconds: Math.max(0, ticket.slaRemainingSeconds - 1),
        }))
      );

      setAutoSyncCount((prev) => (prev <= 1 ? 15 : prev - 1));
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  // Selected ticket object
  const selectedTicket = tickets.find((t) => t.id === selectedTicketId) || tickets[0];

  // Actions
  const handleSelectTicket = (id: string) => {
    setSelectedTicketId(id);
    const found = tickets.find((t) => t.id === id);
    if (found) {
      showToast(`Focused Docket ${found.docketNumber} on spatial canvas.`);
    }
  };

  const handleOpenDispatchModal = (ticketId: string, _defaultCrew?: string) => {
    setDispatchModalTicketId(ticketId);
  };

  // 1. Officer Dispatches Field Unit
  const handleConfirmDispatch = (
    ticketId: string,
    team: string,
    eta: number,
    instructions: string
  ) => {
    setTickets((prev) =>
      prev.map((t) => {
        if (t.id === ticketId) {
          return {
            ...t,
            status: 'assigned',
            statusLabel: 'In Progress',
            badgeClass: 'bg-[#c9e4cc] text-[#4e6753] border border-[#b3cdb6]/40',
            assignedCrew: team.split(' (')[0],
            assignedLead: `${team.split(' (')[0]} Lead`,
            etaMinutes: eta,
            lifecycleStage: 'inspected',
          };
        }
        return t;
      })
    );

    // Update crew status
    setCrews((prev) =>
      prev.map((c) => {
        if (team.includes(c.name)) {
          return {
            ...c,
            status: 'On-Site',
            activeDocket: `#${ticketId}`,
          };
        }
        return c;
      })
    );

    // Append to audit log
    const newAudit: AuditRecord = {
      id: `audit-${Date.now()}`,
      docketId: `#${ticketId}`,
      timestamp: 'Just now',
      action: 'Field Unit Dispatched',
      officer: currentUser?.name || 'Eng. R. Sundaram',
      details: `Dispatched ${team}. Instructions: ${instructions}`,
      slaMet: true,
    };
    setAuditLogs((prev) => [newAudit, ...prev]);

    showToast(`Field order issued: #${ticketId} dispatched to ${team.split(' (')[0]}.`);
  };

  const handleOpenVerificationModal = (ticketId: string) => {
    setVerificationModalTicketId(ticketId);
  };

  // 2. Officer Marks Repaired & Uploads Completion Proof
  const handleConfirmVerification = (ticketId: string, remarks: string, photoUrl: string) => {
    setTickets((prev) =>
      prev.map((t) => {
        if (t.id === ticketId) {
          return {
            ...t,
            status: 'pending',
            statusLabel: 'Resolved / Awaiting Audit',
            badgeClass: 'bg-[#cee9d1] text-[#092011] border border-[#b3cdb6]/40',
            completionPhoto: photoUrl,
            inspectionStatus: 'Seal Ready',
            lifecycleStage: 'repaired', // Immediately activates Citizen Audit Gate banner in Citizen Desk!
          };
        }
        return t;
      })
    );

    const newAudit: AuditRecord = {
      id: `audit-${Date.now()}`,
      docketId: `#${ticketId}`,
      timestamp: 'Just now',
      action: 'Repair Proof Uploaded & Citizen Alerted',
      officer: currentUser?.name || 'Eng. R. Sundaram',
      details: remarks,
      slaMet: true,
    };
    setAuditLogs((prev) => [newAudit, ...prev]);

    showToast(`Seal confirmed! Citizen notified via SMS and WhatsApp for #${ticketId}.`);
  };

  const handleConsolidateDuplicate = (ticketId: string) => {
    setTickets((prev) =>
      prev.map((t) => {
        if (t.id === ticketId) {
          return {
            ...t,
            mergedDuplicatesCount: (t.mergedDuplicatesCount || 0) + 1,
          };
        }
        return t;
      })
    );
    showToast(`Duplicate report merged into #${ticketId}. 1.8 contractor hours saved.`);
  };

  const handleReroutePriority = (ticketId: string) => {
    showToast(`Priority increased for Lineman Unit. Dispatch alerted for #${ticketId}.`);
  };

  const handleViewFieldProgress = (ticketId: string) => {
    showToast(`Live telemetry feed active for #${ticketId}. Bi-directional radio link nominal.`);
  };

  const handleReassign = (ticketId: string) => {
    showToast(`Docket #${ticketId} escalated to Highways Divisional Board.`);
  };

  const handleTriggerEmergencyAlert = (zone: string, incident: string) => {
    showToast(`EMERGENCY BROADCAST ACTIVE: ${incident} in ${zone}. Priority alert transmitted.`);
  };

  // 3. Citizen Submits Authoritative Audit Rating & Seal
  const handleCitizenAuditSubmit = (ticketId: string, feedback: CitizenAuditFeedback) => {
    setTickets((prev) =>
      prev.map((t) => {
        if (t.id === ticketId) {
          return {
            ...t,
            status: 'resolved',
            statusLabel: 'Citizen Verified & Closed',
            badgeClass: 'bg-[#cee9d1] text-[#092011] border border-[#b3cdb6]/40',
            lifecycleStage: 'verified',
            citizenFeedback: feedback,
          };
        }
        return t;
      })
    );

    const newAudit: AuditRecord = {
      id: `audit-${Date.now()}`,
      docketId: `#${ticketId}`,
      timestamp: 'Just now',
      action: `Citizen Verified Closure (${feedback.rating} Stars • ${feedback.physicalState})`,
      officer: 'Citizen SMS Auth Verified',
      details: feedback.remarks,
      slaMet: true,
    };
    setAuditLogs((prev) => [newAudit, ...prev]);
  };

  // 4. Citizen / Officer Transmits New Docket (from Voice / Photo / Form)
  const handleReportNewIssue = (newTicketData: Partial<Ticket>) => {
    const randomId = Math.floor(1000 + Math.random() * 9000);
    const newId = newTicketData.id || `W42-${randomId}`;
    const newDocketNumber = newTicketData.docketNumber || `#W42-2026-${randomId}`;

    const newTicket: Ticket = {
      id: newId,
      docketNumber: newDocketNumber,
      title: newTicketData.title || 'Reported Civic Defect',
      description: newTicketData.description || 'Citizen reported defect via GCC Public Portal.',
      department: newTicketData.department || 'highways',
      deptLabel: newTicketData.deptLabel || 'GCC Works / Highways',
      location: newTicketData.location || 'Ward 42 Sector 4B, Chennai',
      coordinates: newTicketData.coordinates || '13.0827° N, 80.2707° E',
      status: newTicketData.status || 'critical',
      statusLabel: newTicketData.statusLabel || 'Critical Severity',
      badgeClass: newTicketData.badgeClass || 'bg-[#ffdbcf] text-[#370e01] border border-[#ffb59c]/50',
      loggedTimeAgo: 'Logged just now',
      // SLA comes from the agent graph (dept base x priority) when the API answered.
      slaRemainingSeconds: newTicketData.slaRemainingSeconds ?? 4 * 3600,
      initialSlaSeconds: newTicketData.initialSlaSeconds ?? 4 * 3600,
      aiConfidence: newTicketData.aiConfidence || '98.2% Neural Match',
      defectType: newTicketData.defectType || 'Public Hazard',
      quote: newTicketData.quote,
      evidencePhoto:
        newTicketData.evidencePhoto ||
        'https://images.unsplash.com/photo-1544620347-c4fd4a3d5957?auto=format&fit=crop&w=600&q=80',
      mapCoords: newTicketData.mapCoords || {
        x: Math.floor(120 + Math.random() * 300),
        y: Math.floor(100 + Math.random() * 200),
      },
      lifecycleStage: 'logged',
      citizenFeedback: null,
    };

    setTickets((prev) => [newTicket, ...prev]);
    setSelectedTicketId(newId);

    // Append to audit log
    const newAudit: AuditRecord = {
      id: `audit-${Date.now()}`,
      docketId: newDocketNumber,
      timestamp: 'Just now',
      action: 'Public Docket Transmitted',
      officer: currentUser?.name || 'Citizen Intake (Public)',
      details: `${newTicket.title} - ${newTicket.location}`,
      slaMet: true,
    };
    setAuditLogs((prev) => [newAudit, ...prev]);

    showToast(`Docket ${newDocketNumber} submitted! Dispatched to ${newTicket.deptLabel}.`);

    // If submitted from landing, navigate to citizen portal so user sees their docket live
    if (appView === 'landing' || appView === 'login') {
      setAppView('citizen');
    }
  };

  const handleRefresh = () => {
    setAutoSyncCount(15);
    showToast('Refreshing live telemetry stream... Telemetry mesh 99.8% nominal.');
  };

  // Filtered tickets by global search if present
  const displayTickets = globalSearch.trim()
    ? tickets.filter(
        (t) =>
          t.docketNumber.toLowerCase().includes(globalSearch.toLowerCase()) ||
          t.title.toLowerCase().includes(globalSearch.toLowerCase()) ||
          t.location.toLowerCase().includes(globalSearch.toLowerCase())
      )
    : tickets;

  // Active modal ticket references
  const dispatchTicket = tickets.find((t) => t.id === dispatchModalTicketId) || null;
  const verificationTicket = tickets.find((t) => t.id === verificationModalTicketId) || null;

  // ================= 1. SCREEN 1: EDITORIAL LANDING PAGE =================
  if (appView === 'landing') {
    return (
      <>
        <LandingPage
          onNavigateLogin={(defaultRole) => {
            setAppView('login');
          }}
          onNavigateDashboard={() => setAppView('dashboard')}
          onNavigateCitizen={() => setAppView('citizen')}
          onOpenReportModal={() => setIsReportModalOpen(true)}
          tickets={tickets}
          language={language}
          onToggleLanguage={toggleLanguage}
        />
        <ReportModal
          isOpen={isReportModalOpen}
          onClose={() => setIsReportModalOpen(false)}
          onSubmit={handleReportNewIssue}
          onToast={showToast}
          language={language}
          onNavigateToTicket={(id) => {
            setSelectedTicketId(id);
            setAppView('citizen');
          }}
        />
        <Toast message={toastMessage} />
      </>
    );
  }

  // ================= 2. SCREEN 2: AUTHENTICATION & VERIFICATION GATEWAY =================
  if (appView === 'login') {
    return (
      <>
        <LoginPage
          onLoginOfficer={(user) => {
            setCurrentUser(user);
            setAppView('dashboard');
          }}
          onLoginCitizen={(phone, ward) => {
            setCitizenPhone(phone);
            setCitizenWard(ward);
            setAppView('citizen');
          }}
          onReturnHome={() => setAppView('landing')}
          onToast={showToast}
          language={language}
        />
        <Toast message={toastMessage} />
      </>
    );
  }

  // ================= 3. SCREEN 3: CITIZEN RESIDENT DASHBOARD =================
  if (appView === 'citizen') {
    return (
      <div className="min-h-screen bg-[#fdf9f0] text-[#1c1c16] flex flex-col font-body selection:bg-[#c9e4cc] selection:text-[#4e6753] civic-carto-grid">
        <TopBar
          currentTab="triage"
          onSelectTab={() => setAppView('dashboard')}
          onOpenShiftLog={() => setShiftLogModalOpen(true)}
          onOpenEmergencyAlert={() => setEmergencyModalOpen(true)}
          onOpenReportModal={() => setIsReportModalOpen(true)}
          onToggleCitizenView={() => setAppView('dashboard')}
          isCitizenView={true}
          globalSearch={globalSearch}
          onGlobalSearchChange={setGlobalSearch}
          onToast={showToast}
          currentUser={currentUser}
          onReturnLanding={() => setAppView('landing')}
          onSignOut={() => {
            setAppView('login');
            showToast('Signed out of session.');
          }}
          language={language}
          onToggleLanguage={toggleLanguage}
        />

        <main className="flex-1 max-w-[1720px] w-full mx-auto p-4 sm:p-6 flex flex-col gap-6">
          <CitizenPortalView
            tickets={tickets}
            onCitizenAuditSubmit={handleCitizenAuditSubmit}
            onReturnToCommand={() => setAppView('dashboard')}
            onReportNewIssue={handleReportNewIssue}
            onOpenReportModal={() => setIsReportModalOpen(true)}
            onSignOut={() => setAppView('login')}
            onToast={showToast}
            residentPhone={citizenPhone}
            residentWard={citizenWard}
            language={language}
          />
        </main>
        <ReportModal
          isOpen={isReportModalOpen}
          onClose={() => setIsReportModalOpen(false)}
          onSubmit={handleReportNewIssue}
          onToast={showToast}
          language={language}
          onNavigateToTicket={(id) => {
            setSelectedTicketId(id);
          }}
        />
        <Toast message={toastMessage} />
      </div>
    );
  }

  // ================= 4. SCREEN 4: MUNICIPAL AUTHORITY COMMAND CENTER =================
  return (
    <div className="min-h-screen bg-[#fdf9f0] text-[#1c1c16] flex flex-col font-body selection:bg-[#c9e4cc] selection:text-[#4e6753] civic-carto-grid">
      {/* Top Operational Header & Shift Bar */}
      <TopBar
        currentTab={currentTab}
        onSelectTab={(tab) => {
          setCurrentTab(tab);
        }}
        onOpenShiftLog={() => setShiftLogModalOpen(true)}
        onOpenEmergencyAlert={() => setEmergencyModalOpen(true)}
        onOpenReportModal={() => setIsReportModalOpen(true)}
        onToggleCitizenView={() => setAppView('citizen')}
        isCitizenView={false}
        globalSearch={globalSearch}
        onGlobalSearchChange={setGlobalSearch}
        onToast={showToast}
        currentUser={currentUser}
        onReturnLanding={() => setAppView('landing')}
        onSignOut={() => {
          setAppView('login');
          showToast('Signed out of session. Authenticate to re-enter.');
        }}
        language={language}
        onToggleLanguage={toggleLanguage}
      />

      {/* Main Operational View */}
      <main className="flex-1 max-w-[1720px] w-full mx-auto p-4 sm:p-6 flex flex-col gap-6">
        {currentTab === 'gis' ? (
          /* Expanded GIS Telemetry Canvas */
          <div className="flex-1 flex flex-col gap-4">
            <SpatialMap
              tickets={displayTickets}
              crews={crews}
              selectedTicketId={selectedTicketId}
              onSelectTicket={handleSelectTicket}
              onToast={showToast}
              fullScreen={true}
            />
          </div>
        ) : currentTab === 'crews' ? (
          /* Active Field Units Roster */
          <ActiveCrewsView
            crews={crews}
            onDispatchUnit={(id) => showToast(`Radio telemetry opened with ${id}`)}
            onToast={showToast}
          />
        ) : currentTab === 'audit' ? (
          /* Audit Records & Compliance Ledger */
          <AuditRecordsView logs={auditLogs} onToast={showToast} />
        ) : (
          /* Standard Triage Console Layout (Matches Master Prompt & Screenshot Exactly) */
          <>
            {/* KPI Telemetry Row (4 Cards) */}
            <KPIRow
              onCardClick={(metric) => {
                if (metric === 'crews') setCurrentTab('crews');
                else if (metric === 'compliance') setAppView('citizen');
                else showToast(`Metric breakdown: ${metric}`);
              }}
              mergedCount={tickets.reduce((acc, t) => acc + (t.mergedDuplicatesCount || 0), 80)}
            />

            {/* Split Console Layout (12 Columns) */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              {/* LEFT (5 COLUMNS): GIS SPATIAL TELEMETRY CANVAS & INSPECTOR */}
              <section className="lg:col-span-5 flex flex-col gap-4">
                <SpatialMap
                  tickets={displayTickets}
                  crews={crews}
                  selectedTicketId={selectedTicketId}
                  onSelectTicket={handleSelectTicket}
                  onToast={showToast}
                />

                {/* Selected Pin Inspector Card */}
                {selectedTicket && (
                  <InspectorCard
                    ticket={selectedTicket}
                    onDispatch={(id) => handleOpenDispatchModal(id, 'Asphalt Patch Unit B')}
                    onReassign={handleReassign}
                    onVerifyProof={(id) => handleOpenVerificationModal(id)}
                    onToast={showToast}
                  />
                )}
              </section>

              {/* RIGHT (7 COLUMNS): PRIORITY DISPATCH QUEUE */}
              <section className="lg:col-span-7 flex flex-col gap-4">
                <DispatchQueue
                  tickets={displayTickets}
                  selectedTicketId={selectedTicketId}
                  onSelectTicket={handleSelectTicket}
                  onOpenDispatchModal={handleOpenDispatchModal}
                  onOpenVerificationModal={handleOpenVerificationModal}
                  onConsolidateDuplicate={handleConsolidateDuplicate}
                  onReroutePriority={handleReroutePriority}
                  onViewFieldProgress={handleViewFieldProgress}
                  onOpenReportModal={() => setIsReportModalOpen(true)}
                  selectedStatusTab={selectedStatusTab}
                  onSelectStatusTab={setSelectedStatusTab}
                  onRefresh={handleRefresh}
                  autoSyncCount={autoSyncCount}
                />
              </section>
            </div>
          </>
        )}
      </main>

      {/* Officer Modals */}
      <DispatchModal
        isOpen={Boolean(dispatchModalTicketId)}
        onClose={() => setDispatchModalTicketId(null)}
        ticket={dispatchTicket}
        onConfirmDispatch={handleConfirmDispatch}
      />

      <VerificationModal
        isOpen={Boolean(verificationModalTicketId)}
        onClose={() => setVerificationModalTicketId(null)}
        ticket={verificationTicket}
        onConfirmVerification={handleConfirmVerification}
        onToast={showToast}
      />

      <EmergencyModal
        isOpen={emergencyModalOpen}
        onClose={() => setEmergencyModalOpen(false)}
        onTriggerAlert={handleTriggerEmergencyAlert}
      />

      <ShiftLogModal
        isOpen={shiftLogModalOpen}
        onClose={() => setShiftLogModalOpen(false)}
        tickets={tickets}
        onToast={showToast}
      />

      <ReportModal
        isOpen={isReportModalOpen}
        onClose={() => setIsReportModalOpen(false)}
        onSubmit={handleReportNewIssue}
        onToast={showToast}
        language={language}
        onNavigateToTicket={(id) => {
          setSelectedTicketId(id);
        }}
      />

      {/* Global Floating Toast Notification */}
      <Toast message={toastMessage} />
    </div>
  );
}
