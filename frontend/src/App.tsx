import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Activity, AlertTriangle, Bot, Check, ChevronDown, CircleHelp, ClipboardCheck,
  FileKey2, Fingerprint, LayoutDashboard, LockKeyhole, Menu, Moon, RefreshCw, Search,
  Shield, ShieldCheck, Sparkles, Sun, X,
} from 'lucide-react';

const ACTOR_ID = 'demo-actor';
type Theme = 'light' | 'dark';

function getInitialTheme(): Theme {
  try {
    const savedTheme = window.localStorage.getItem('cybersentinel-theme');
    if (savedTheme === 'light' || savedTheme === 'dark') return savedTheme;
  } catch {
    // Storage may be unavailable; continue with the system preference.
  }
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

type View = 'Security Overview' | 'Consent Management' | 'Protected Files' | 'Audit Logs' | 'AI Risk Analysis' | 'Administrator Approvals';
type Consent = { actorId: string; scope: string; status: string; event: ConsentEvent | null };
type ConsentEvent = { id: string; event_type: string; occurred_at: string; expires_at: string | null };
type ProtectedFile = { id: string; actor_id: string; name: string; size: number; sha256: string; content_type: string; permissions: string[]; created_at: string };
type Approval = { id: string; actor_id: string; file_id: string; status: string; expires_at: string; created_at: string };
type ApiHealth = { status?: string; storage?: string; database?: { configured: boolean; available: boolean }; gateway?: { ready: boolean; consistent: boolean; ageMs: number | null; error: string | null }; audit?: { ready: boolean; consistent: boolean; error: string | null } };
type DataSource = 'health' | 'consents' | 'files' | 'approvals' | 'approvalStatus' | 'ai';
type DataLoadState = 'loading' | 'available' | 'unavailable';
type DataLoadStates = Record<DataSource, DataLoadState>;
type AuditCheck = { valid: boolean | null; eventCount: number; error: string | null; storageAvailable?: boolean };

class ApiResponseError extends Error {
  constructor(message: string, readonly status: number, readonly body: unknown) {
    super(message);
  }
}

const initialDataLoadStates: DataLoadStates = {
  health: 'loading',
  consents: 'loading',
  files: 'loading',
  approvals: 'loading',
  approvalStatus: 'loading',
  ai: 'loading',
};

const pages: Array<{ name: View; icon: typeof Shield }> = [
  { name: 'Security Overview', icon: LayoutDashboard },
  { name: 'Consent Management', icon: Fingerprint },
  { name: 'Protected Files', icon: FileKey2 },
  { name: 'Audit Logs', icon: ClipboardCheck },
  { name: 'AI Risk Analysis', icon: Bot },
  { name: 'Administrator Approvals', icon: LockKeyhole },
];

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...options,
      headers: { ...(options?.body ? { 'content-type': 'application/json' } : {}), ...options?.headers },
    });
  } catch {
    throw new Error('Cannot reach the API. Start the backend with "npm run dev:backend" and retry.');
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    const message = response.ok
      ? `The API returned an invalid response (HTTP ${response.status}).`
      : `API request failed (HTTP ${response.status}). Check backend terminal logs; if it is stopped, run "npm run dev:backend".`;
    throw new ApiResponseError(message, response.status, null);
  }
  if (!response.ok) {
    if (typeof body === 'object' && body !== null) {
      const errorMessage = 'error' in body && typeof body.error === 'string' ? body.error : undefined;
      const denialReason = 'reason' in body && typeof body.reason === 'string' ? body.reason : undefined;
      throw new ApiResponseError(errorMessage ?? (denialReason ? `Access denied: ${denialReason}` : `API request failed (HTTP ${response.status}).`), response.status, body);
    }
    throw new ApiResponseError(`API request failed (HTTP ${response.status}).`, response.status, body);
  }
  return body as T;
}

function App() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [view, setView] = useState<View>('Security Overview');
  const [health, setHealth] = useState<ApiHealth | null>(null);
  const [consents, setConsents] = useState<Consent[]>([]);
  const [files, setFiles] = useState<ProtectedFile[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [dataLoadStates, setDataLoadStates] = useState<DataLoadStates>(initialDataLoadStates);
  const [dataLoadErrors, setDataLoadErrors] = useState<Partial<Record<DataSource, string>>>({});
  const [approvalStatus, setApprovalStatus] = useState<{ available: boolean; deliveryChannel: string | null; otpConfigured: boolean } | null>(null);
  const [geminiAvailable, setGeminiAvailable] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [scope, setScope] = useState('files:read');
  const [expiry, setExpiry] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [filePermissions, setFilePermissions] = useState({ read: true, export: false });
  const [analysisText, setAnalysisText] = useState('');
  const [analysis, setAnalysis] = useState('');
  const [auditResult, setAuditResult] = useState<AuditCheck | null>(null);
  const [otp, setOtp] = useState('');

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const toggleTheme = () => {
    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = nextTheme;
    setTheme(nextTheme);
    try {
      window.localStorage.setItem('cybersentinel-theme', nextTheme);
    } catch {
      // Keep the in-memory theme active when storage is unavailable.
    }
  };

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const [healthResult, consentResult, fileResult, approvalResult, approvalInfo, aiInfo] = await Promise.allSettled([
        api<ApiHealth>('/api/health'),
        api<{ consents: Consent[] }>(`/api/consents?actorId=${ACTOR_ID}`),
        api<{ files: ProtectedFile[] }>(`/api/files?actorId=${ACTOR_ID}`),
        api<{ requests: Approval[] }>(`/api/approvals?actorId=${ACTOR_ID}`),
        api<{ available: boolean; deliveryChannel: string | null; otpConfigured: boolean }>('/api/approvals/status'),
        api<{ available: boolean }>('/api/ai/status'),
      ]);
      if (healthResult.status === 'fulfilled') setHealth(healthResult.value);
      if (consentResult.status === 'fulfilled') setConsents(consentResult.value.consents);
      if (fileResult.status === 'fulfilled') setFiles(fileResult.value.files);
      if (approvalResult.status === 'fulfilled') setApprovals(approvalResult.value.requests);
      if (approvalInfo.status === 'fulfilled') setApprovalStatus(approvalInfo.value);
      if (aiInfo.status === 'fulfilled') setGeminiAvailable(aiInfo.value.available);

      const results = { health: healthResult, consents: consentResult, files: fileResult, approvals: approvalResult, approvalStatus: approvalInfo, ai: aiInfo };
      const nextStates = {} as DataLoadStates;
      const nextErrors: Partial<Record<DataSource, string>> = {};
      for (const [source, result] of Object.entries(results) as Array<[DataSource, (typeof results)[DataSource]]>) {
        nextStates[source] = result.status === 'fulfilled' ? 'available' : 'unavailable';
        if (result.status === 'rejected') {
          nextErrors[source] = result.reason instanceof Error ? result.reason.message : 'The API request failed.';
        }
      }
      setDataLoadStates(nextStates);
      setDataLoadErrors(nextErrors);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const perform = async (action: () => Promise<void>, success: string) => {
    setBusy(true); setError(''); setNotice('');
    try { await action(); setNotice(success); await refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Operation failed'); }
    finally { setBusy(false); }
  };

  const addConsent = () => perform(async () => {
    const expiresAt = expiry ? new Date(expiry).toISOString() : null;
    await api('/api/consents', { method: 'POST', body: JSON.stringify({ actorId: ACTOR_ID, scope, expiresAt }) });
  }, `Consent granted for ${scope}.`);

  const revokeConsent = (subject: Consent) => perform(async () => {
    await api(`/api/consents/${encodeURIComponent(subject.actorId)}/${encodeURIComponent(subject.scope)}/revoke`, { method: 'POST' });
  }, `Consent revoked for ${subject.scope}.`);

  const expireConsent = (subject: Consent) => perform(async () => {
    await api(`/api/consents/${encodeURIComponent(subject.actorId)}/${encodeURIComponent(subject.scope)}/expire`, { method: 'POST' });
  }, `Expiration recorded for ${subject.scope}.`);

  const registerFile = () => perform(async () => {
    if (!file) throw new Error('Choose a file first.');
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    await api('/api/files', { method: 'POST', body: JSON.stringify({
      actorId: ACTOR_ID, name: file.name, size: file.size, sha256,
      contentType: file.type || 'application/octet-stream',
      permissions: Object.entries(filePermissions).filter(([, enabled]) => enabled).map(([permission]) => permission),
    }) });
    setFile(null);
    const picker = document.getElementById('protected-file-picker') as HTMLInputElement | null;
    if (picker) picker.value = '';
  }, 'File fingerprint and metadata registered. File bytes were not uploaded.');

  const verifyAudit = () => perform(async () => {
    try {
      const result = await api<AuditCheck>('/api/audit/verify', {
        method: 'POST', body: JSON.stringify({ actorId: ACTOR_ID }),
      });
      setAuditResult(result);
    } catch (reason) {
      if (reason instanceof ApiResponseError && reason.status === 409 && isAuditCheck(reason.body)) {
        setAuditResult(reason.body);
        return;
      }
      setAuditResult({
        valid: null,
        eventCount: 0,
        error: reason instanceof Error ? reason.message : 'Audit verification is unavailable.',
      });
      throw reason;
    }
  }, 'Audit verification completed. Review the result below.');

  const analyzeRisk = () => perform(async () => {
    const result = await api<{ analysis: string }>('/api/ai/analyze', {
      method: 'POST', body: JSON.stringify({ actorId: ACTOR_ID, operation: analysisText }),
    });
    setAnalysis(result.analysis);
  }, 'Gemini risk analysis completed.');

  const requestExport = (fileId: string) => perform(async () => {
    await api('/api/approvals/payment-export', { method: 'POST', body: JSON.stringify({ actorId: ACTOR_ID, fileId }) });
  }, 'Approval request sent through the configured administrator channel.');

  const approveRequest = (approvalId: string) => perform(async () => {
    if (!otp) throw new Error('Enter the administrator OTP delivered through the configured channel.');
    await api(`/api/approvals/${approvalId}/approve`, { method: 'POST', body: JSON.stringify({ otp }) });
    setOtp('');
  }, 'Administrator approval recorded.');

  const releaseExport = (approvalId: string) => perform(async () => {
    await api(`/api/approvals/${approvalId}/release`, { method: 'POST', body: JSON.stringify({ actorId: ACTOR_ID }) });
  }, 'Approved metadata export released.');

  const activeConsents = consents.filter((consent) => consent.status === 'granted').length;
  const apiUp = health?.status === 'ok';
  const viewSources: Record<View, DataSource[]> = {
    'Security Overview': ['health', 'consents', 'files', 'approvals', 'approvalStatus', 'ai'],
    'Consent Management': ['consents'],
    'Protected Files': ['files'],
    'Audit Logs': ['health'],
    'AI Risk Analysis': ['ai'],
    'Administrator Approvals': ['approvals', 'approvalStatus'],
  };
  const sourcePaths: Record<DataSource, string> = {
    health: 'GET /api/health',
    consents: 'GET /api/consents',
    files: 'GET /api/files',
    approvals: 'GET /api/approvals',
    approvalStatus: 'GET /api/approvals/status',
    ai: 'GET /api/ai/status',
  };
  const unavailableSources = viewSources[view].filter((source) => dataLoadStates[source] === 'unavailable');

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNavOpen ? 'sidebar-open' : ''}`}>
        <div className="brand-lockup"><div className="brand-mark"><Shield size={20} /></div><div className="brand-name">cyber<span>sentinel</span><small>AI SECURITY PLATFORM</small></div><button className="icon-button mobile-close" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)}><X size={18} /></button></div>
        <div className="workspace-label">WORKSPACE</div>
        <div className="workspace-switcher"><span className="workspace-avatar">D</span><span className="workspace-copy"><strong>Local demo identity</strong><small>{ACTOR_ID}</small></span><ChevronDown size={15} /></div>
        <div className="nav-caption">SECURITY OPERATIONS</div>
        <nav className="primary-nav" aria-label="Main navigation">
          {pages.map(({ name, icon: Icon }) => <button key={name} className={`nav-item ${view === name ? 'nav-active' : ''}`} aria-current={view === name ? 'page' : undefined} onClick={() => { setView(name); setMobileNavOpen(false); setError(''); setNotice(''); }}><Icon size={17} /><span>{name}</span></button>)}
        </nav>
        <div className="sidebar-bottom"><div className="sidebar-help"><CircleHelp size={16} /><span>Security status</span><span className={`side-health ${apiUp ? 'online' : ''}`} /></div><div className="user-profile"><div className="user-avatar">D</div><div className="user-copy"><strong>Development mode</strong><small>{health?.storage ?? 'Checking storage...'}</small></div><button className="icon-button profile-menu" aria-label="Refresh data" onClick={() => void refresh()}><RefreshCw size={16} /></button></div></div>
      </aside>
      {mobileNavOpen && <button className="nav-scrim" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)} />}

      <main className="main-area">
        <header className="topbar"><button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setMobileNavOpen(true)}><Menu size={20} /></button><div className="breadcrumbs"><span>CyberSentinel</span><span className="crumb-divider">/</span><strong>{view}</strong></div><div className="topbar-actions"><div className={`api-status ${apiUp ? 'api-online' : 'api-offline'}`}><span className="status-dot" />{apiUp ? 'API connected' : 'API unavailable'}</div><button className="theme-toggle" type="button" aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} onClick={toggleTheme}>{theme === 'dark' ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}</button><button className="search-button" disabled={refreshing} onClick={() => void refresh()}><Search size={15} /><span>{refreshing ? 'Refreshing…' : 'Refresh data'}</span></button></div></header>
        <div className="content-wrap app-content">
          <div className="view-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> CYBERSENTINEL AI · LIVE WORKSPACE</div><h1>{view}<span className="heading-period">.</span></h1><p className="page-subtitle">{viewDescription(view)}</p></div><button className="refresh-button" onClick={() => void refresh()} disabled={busy || refreshing}><RefreshCw size={15} /> {refreshing ? 'Refreshing' : 'Refresh'}</button></div>
          {error && <div className="notice notice-error" role="alert"><AlertTriangle size={17} />{error}</div>}
          {notice && <div className="notice notice-ok" role="status"><Check size={17} />{notice}</div>}
          {unavailableSources.length > 0 && <div className="notice notice-warning" role="status"><AlertTriangle size={17} /><span>{unavailableSources.map((source) => `${sourcePaths[source]}: ${dataLoadErrors[source] ?? 'Unavailable'}`).join(' · ')}</span><button className="text-button" disabled={refreshing} onClick={() => void refresh()}>Retry</button></div>}
          {dataLoadStates.health === 'available' && health?.database?.configured === false && <div className="notice notice-warning" role="status"><AlertTriangle size={17} /><span><strong>Database not configured.</strong> The API is using temporary in-memory storage; data is lost when it restarts. Configure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the root .env file, then restart the backend.</span></div>}
          {dataLoadStates.health === 'available' && health?.database?.configured === true && health.database.available === false && <div className="notice notice-warning" role="status"><AlertTriangle size={17} /><span><strong>Supabase is configured but unavailable.</strong> Check the backend logs, credentials, network, and database migrations. Protected operations remain fail-closed.</span></div>}

          {view === 'Security Overview' && <Overview health={health} geminiAvailable={geminiAvailable} aiState={dataLoadStates.ai} activeConsents={activeConsents} fileCount={files.length} pendingApprovals={approvals.filter((approval) => approval.status === 'pending').length} consentState={dataLoadStates.consents} filesState={dataLoadStates.files} approvalsState={dataLoadStates.approvals} healthState={dataLoadStates.health} onNavigate={setView} />}
          {view === 'Consent Management' && <ConsentPage consents={consents} loadStatus={dataLoadStates.consents} scope={scope} setScope={setScope} expiry={expiry} setExpiry={setExpiry} onGrant={addConsent} onRevoke={revokeConsent} onExpire={expireConsent} busy={busy} />}
          {view === 'Protected Files' && <FilesPage files={files} loadStatus={dataLoadStates.files} file={file} setFile={setFile} permissions={filePermissions} setPermissions={setFilePermissions} onRegister={registerFile} busy={busy} onRequestExport={requestExport} onAccess={(fileId) => perform(async () => { await api(`/api/files/${fileId}/access`, { method: 'POST', body: JSON.stringify({ actorId: ACTOR_ID }) }); }, 'Gateway allowed metadata access and recorded the decision.')} />}
          {view === 'Audit Logs' && <AuditPage audit={health?.audit} verification={auditResult} onVerify={verifyAudit} busy={busy} />}
          {view === 'AI Risk Analysis' && <AiPage available={geminiAvailable} loadStatus={dataLoadStates.ai} text={analysisText} setText={setAnalysisText} result={analysis} onAnalyze={analyzeRisk} busy={busy} />}
          {view === 'Administrator Approvals' && <ApprovalsPage requests={approvals} loadStatus={dataLoadStates.approvals} statusLoadStatus={dataLoadStates.approvalStatus} status={approvalStatus} otp={otp} setOtp={setOtp} onApprove={approveRequest} onRelease={releaseExport} busy={busy} />}

          <footer className="page-footer"><span><span className="footer-mark">C</span> CYBERSENTINEL AI <i /> {health?.storage?.toUpperCase() ?? 'STORAGE UNAVAILABLE'}</span><span>STAGE 6 <i /> <span className="footer-health"><b className={apiUp ? 'online' : 'offline'} /> {apiUp ? 'API ONLINE' : 'API OFFLINE'}</span></span></footer>
        </div>
      </main>
    </div>
  );
}

function Overview({ health, geminiAvailable, aiState, activeConsents, fileCount, pendingApprovals, consentState, filesState, approvalsState, healthState, onNavigate }: { health: ApiHealth | null; geminiAvailable: boolean; aiState: DataLoadState; activeConsents: number; fileCount: number; pendingApprovals: number; consentState: DataLoadState; filesState: DataLoadState; approvalsState: DataLoadState; healthState: DataLoadState; onNavigate: (view: View) => void }) {
  const gatewayReady = Boolean(health?.gateway?.ready && health.gateway.consistent);
  const auditReady = Boolean(health?.audit?.ready && health.audit.consistent);
  const gatewayLabel = healthState !== 'available' ? loadStateLabel(healthState) : gatewayReady ? 'Ready' : 'Fail closed';
  return <>
    <section className="hero-panel app-hero"><div className="hero-grid" /><div className="hero-copy"><div className="hero-overline"><span className="live-pip" /> SECURITY POSTURE</div><h2>Protection starts<br />with <em>verified consent.</em></h2><p>Live status from the backend policy projection, audit chain, and configured integrations.</p><button className="hero-link" onClick={() => onNavigate('Consent Management')}>Manage consent <ShieldCheck size={15} /></button></div><div className="hero-art" aria-hidden="true"><div className="orbit orbit-outer" /><div className="orbit orbit-inner" /><div className="hero-core"><ShieldCheck size={34} /></div><div className="orbit-node node-top"><Activity size={14} /></div><div className="orbit-node node-right"><Fingerprint size={14} /></div><div className="orbit-node node-left"><LockKeyhole size={14} /></div><div className="orbit-node node-bottom"><Bot size={14} /></div></div><div className="hero-index">LIVE <span>/ STATUS</span></div></section>
    <section className="metrics-grid app-metrics"><Metric label="ACTIVE CONSENTS" value={consentState === 'available' ? String(activeConsents) : loadStateLabel(consentState)} note="Current replayed grants" icon={<Fingerprint size={16} />} /><Metric label="REGISTERED FILES" value={filesState === 'available' ? String(fileCount) : loadStateLabel(filesState)} note="Metadata records · not endpoint protection" icon={<FileKey2 size={16} />} /><Metric label="PENDING APPROVALS" value={approvalsState === 'available' ? String(pendingApprovals) : loadStateLabel(approvalsState)} note="Awaiting admin action" icon={<ClipboardCheck size={16} />} /><Metric label="GATEWAY" value={gatewayLabel} note={healthState !== 'available' ? 'Health endpoint unavailable' : health?.gateway?.ageMs === null || health?.gateway?.ageMs === undefined ? 'Projection initializing' : `Synced ${Math.round(health.gateway.ageMs / 1000)}s ago`} icon={<ShieldCheck size={16} />} />
    </section>
    <section className="lower-grid app-lower"><article className="activity-panel"><div className="section-heading"><div><div className="section-kicker">SYSTEM READINESS</div><h3>Verified service status</h3></div><span className="stage-tag">LIVE</span></div><div className="signal-list"><Signal name="Consent projection" detail={healthState !== 'available' ? 'Unavailable · health endpoint not reached' : health?.gateway?.error ?? (gatewayReady ? `Ready · ${health?.storage ?? 'storage unavailable'}` : 'Unavailable or stale · protected access denied')} active={healthState === 'available' && gatewayReady} /><Signal name="Audit chain" detail={healthState !== 'available' ? 'Unavailable · health endpoint not reached' : health?.audit?.error ?? (auditReady ? 'Initialized · SHA-256 chain verified at startup' : 'Not verified · audit actions fail closed')} active={healthState === 'available' && auditReady} /><Signal name="Database" detail={healthState !== 'available' ? 'Unavailable · health endpoint not reached' : health?.database?.configured === false ? 'Database not configured · using temporary in-memory storage' : health?.database?.available ? 'Supabase connected · recent consent read verified' : 'Supabase configured but unavailable or not verified'} active={healthState === 'available' && health?.database?.available === true} /></div></article><article className="assistant-panel"><div className="assistant-top"><div className="assistant-icon"><Sparkles size={17} /></div><span>AI RISK ANALYSIS</span><span className="assistant-lock">{aiState === 'unavailable' ? 'UNAVAILABLE' : aiState === 'loading' ? 'CHECKING' : geminiAvailable ? 'READY' : 'NOT CONFIGURED'}</span></div><div className="assistant-body"><h3>{aiState === 'unavailable' ? 'Gemini status unavailable.' : aiState === 'loading' ? 'Checking Gemini status.' : geminiAvailable ? 'Gemini is ready.' : 'Configure Gemini.'}</h3><p>{aiState === 'unavailable' ? 'The API did not return AI integration status.' : aiState === 'loading' ? 'Waiting for the backend integration status.' : geminiAvailable ? 'Risk analysis is available through the server-side integration.' : 'Set GEMINI_API_KEY on the backend. No generated analysis will be fabricated.'}</p></div><button className="assistant-cta" onClick={() => onNavigate('AI Risk Analysis')}>Open AI analysis <Bot size={14} /></button><div className="assistant-lines" aria-hidden="true"><span /><span /><span /><span /><span /></div></article></section>
  </>;
}

function loadStateLabel(state: DataLoadState): string {
  if (state === 'available') return 'Available';
  return state === 'loading' ? 'Loading' : 'Unavailable';
}

function isAuditCheck(value: unknown): value is AuditCheck {
  if (typeof value !== 'object' || value === null) return false;
  const result = value as Record<string, unknown>;
  return result.valid === false &&
    result.storageAvailable === true &&
    Number.isInteger(result.eventCount) &&
    (result.error === null || typeof result.error === 'string');
}

function Metric({ label, value, note, icon }: { label: string; value: string; note: string; icon: ReactNode }) { return <article className="metric-card"><div className="metric-top"><span>{label}</span>{icon}</div><div className={`metric-value ${value.length > 10 ? 'metric-text' : ''}`}>{value}</div><div className="metric-foot"><span className="metric-note">{note}</span></div></article>; }

function Signal({ name, detail, active }: { name: string; detail: string; active: boolean }) { return <div className="signal-row"><div className="signal-icon">{active ? <Check size={16} /> : <AlertTriangle size={16} />}</div><div className="signal-copy"><strong>{name}</strong><span>{detail}</span></div><span className={`signal-pending ${active ? 'signal-good' : ''}`}>{active ? 'READY' : 'DENY'}</span></div>; }

function ConsentPage({ consents, loadStatus, scope, setScope, expiry, setExpiry, onGrant, onRevoke, onExpire, busy }: { consents: Consent[]; loadStatus: DataLoadState; scope: string; setScope: (value: string) => void; expiry: string; setExpiry: (value: string) => void; onGrant: () => void; onRevoke: (consent: Consent) => void; onExpire: (consent: Consent) => void; busy: boolean }) {
  const [history, setHistory] = useState<ConsentEvent[]>([]);
  const [historyError, setHistoryError] = useState('');
  const [historySubject, setHistorySubject] = useState<Consent | null>(null);
  const loadHistory = async (subject: Consent) => {
    setHistorySubject(subject);
    setHistoryError('');
    try { const result = await api<{ events: ConsentEvent[] }>(`/api/consents/${encodeURIComponent(subject.actorId)}/${encodeURIComponent(subject.scope)}/events`); setHistory(result.events); }
    catch (reason) { setHistory([]); setHistoryError(reason instanceof Error ? reason.message : 'Consent history is unavailable.'); }
  };
  return <>
    <section className="form-panel"><div className="section-heading"><div><div className="section-kicker">CONSENT EVENT</div><h3>Grant a scoped permission</h3></div><span className="stage-tag">APPEND ONLY</span></div><div className="form-row"><label>Scope<select value={scope} onChange={(event) => setScope(event.target.value)}><option value="files:read">Read protected files</option><option value="files:register">Register protected files</option><option value="payments:export">Request payment metadata export</option><option value="audit:read">Read audit history</option><option value="approvals:read">Read administrator approvals</option></select></label><label>Expires at <span className="optional-label">OPTIONAL</span><input type="datetime-local" value={expiry} onChange={(event) => setExpiry(event.target.value)} /></label><button className="primary-button" onClick={onGrant} disabled={busy}>Grant consent</button></div><p className="form-note">A grant creates a new immutable event. Revocation is immediate in this process and reconciled across processes through polling.</p></section>
    <DataTable title="Current consent projection" description="Status is replayed from append-only event history." columns={['Scope', 'Status', 'Last event', 'Actions']} loadStatus={loadStatus} empty={loadStatus === 'unavailable' ? 'Consent data unavailable.' : loadStatus === 'loading' ? 'Loading consent data…' : consents.length === 0 ? 'No consent events yet.' : undefined}>
      {consents.map((item) => <tr key={`${item.actorId}:${item.scope}`}><td><strong>{item.scope}</strong></td><td><StatusBadge status={item.status} /></td><td>{item.event ? `${item.event.event_type} · ${formatDate(item.event.occurred_at)}` : 'No event'}</td><td className="table-actions"><button className="text-button" onClick={() => void loadHistory(item)}>History</button>{item.status === 'granted' && <button className="text-button text-danger" onClick={() => onRevoke(item)} disabled={busy}>Revoke</button>}{item.status === 'expired' && item.event?.event_type === 'GRANTED' && <button className="text-button" onClick={() => onExpire(item)} disabled={busy}>Record expiry</button>}</td></tr>)}
    </DataTable>
    {historyError && <div className="notice notice-warning" role="alert"><AlertTriangle size={17} /><span>{historyError}</span>{historySubject && <button className="text-button" onClick={() => void loadHistory(historySubject)}>Retry</button>}</div>}
    {historySubject && !historyError && <DataTable title="Consent event history" description="Events are append-only; status is replayed in occurrence order." columns={['Event', 'Occurred', 'Expiration']} loadStatus="available" empty={history.length === 0 ? 'No events recorded for this consent scope.' : undefined}>{history.map((event) => <tr key={event.id}><td><StatusBadge status={event.event_type.toLowerCase()} /></td><td>{formatDate(event.occurred_at)}</td><td>{event.expires_at ? formatDate(event.expires_at) : 'None'}</td></tr>)}</DataTable>}
  </>;
}

function FilesPage({ files, loadStatus, file, setFile, permissions, setPermissions, onRegister, busy, onRequestExport, onAccess }: { files: ProtectedFile[]; loadStatus: DataLoadState; file: File | null; setFile: (file: File | null) => void; permissions: { read: boolean; export: boolean }; setPermissions: (value: { read: boolean; export: boolean }) => void; onRegister: () => void; busy: boolean; onRequestExport: (id: string) => void; onAccess: (id: string) => void }) {
  const [history, setHistory] = useState<Array<{ sequence: number; payload: { action: string; decision: string; occurredAt: string } | null }>>([]);
  const [historyError, setHistoryError] = useState('');
  const [historyFileId, setHistoryFileId] = useState('');
  const loadHistory = async (fileId: string) => {
    setHistoryFileId(fileId);
    setHistoryError('');
    try { const result = await api<{ events: typeof history }>(`/api/files/${encodeURIComponent(fileId)}/history?actorId=${ACTOR_ID}`); setHistory(result.events); }
    catch (reason) { setHistory([]); setHistoryError(reason instanceof Error ? reason.message : 'File history is unavailable.'); }
  };
  return <>
    <div className="notice notice-warning"><AlertTriangle size={18} /><span><strong>Browser metadata protection only.</strong> The app fingerprints the selected file in your browser and stores metadata, not file contents. This cannot prevent other desktop applications from opening or copying local files. No contents are sent to Gemini.</span></div>
    <section className="form-panel"><div className="section-heading"><div><div className="section-kicker">LOCAL FINGERPRINT</div><h3>Register file metadata</h3></div><span className="stage-tag">SHA-256</span></div><div className="file-form"><label className="file-picker"><FileKey2 size={18} /><span>{file ? file.name : 'Choose a file from this device'}</span><input id="protected-file-picker" type="file" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></label><div className="permission-checks"><label><input type="checkbox" checked={permissions.read} onChange={(event) => setPermissions({ ...permissions, read: event.target.checked })} /> Allow read</label><label><input type="checkbox" checked={permissions.export} onChange={(event) => setPermissions({ ...permissions, export: event.target.checked })} /> Allow approved metadata export</label></div><button className="primary-button" disabled={!file || busy} onClick={onRegister}>Fingerprint & register metadata</button></div></section>
    <DataTable title="Registered files" description="All protected operations are gateway-checked and audited." columns={['File', 'Fingerprint', 'Permissions', 'Registered', 'Actions']} loadStatus={loadStatus} empty={loadStatus === 'unavailable' ? 'Protected files unavailable. Check the API error above; grant files:read consent if access was denied, then retry.' : loadStatus === 'loading' ? 'Loading protected files…' : files.length === 0 ? 'No file metadata registered.' : undefined}>
      {files.map((item) => <tr key={item.id}><td><strong>{item.name}</strong><small className="cell-subtitle">{formatBytes(item.size)} · {item.content_type}</small></td><td><code className="hash-short">{item.sha256}</code></td><td>{item.permissions.join(', ') || 'None'}</td><td>{formatDate(item.created_at)}</td><td className="table-actions"><button className="text-button" onClick={() => onAccess(item.id)}>Check access</button><button className="text-button" onClick={() => void loadHistory(item.id)}>History</button>{item.permissions.includes('export') && <button className="text-button" onClick={() => onRequestExport(item.id)}>Request export</button>}</td></tr>)}
    </DataTable>
    {historyError && <div className="notice notice-warning" role="alert"><AlertTriangle size={17} /><span>{historyError}</span><button className="text-button" onClick={() => void loadHistory(historyFileId)}>Retry</button></div>}
    {historyFileId && !historyError && <DataTable title="File access history" description="Authorization decisions and file operations for the selected file." columns={['Sequence', 'Action', 'Decision', 'Time']} loadStatus="available" empty={history.length === 0 ? 'No file access events recorded.' : undefined}>{history.map((event) => <tr key={event.sequence}><td>{event.sequence}</td><td>{event.payload?.action ?? 'Unreadable event'}</td><td><StatusBadge status={event.payload?.decision ?? 'unknown'} /></td><td>{event.payload?.occurredAt ? formatDate(event.payload.occurredAt) : '—'}</td></tr>)}</DataTable>}
  </>;
}

function AuditPage({ audit, verification, onVerify, busy }: { audit: ApiHealth['audit']; verification: AuditCheck | null; onVerify: () => void; busy: boolean }) {
  const [events, setEvents] = useState<Array<{ sequence: number; event_hash: string; payload: { action: string; actorId: string | null; resource: string; operation: string; decision: string; occurredAt: string } | null }>>([]);
  const [loadError, setLoadError] = useState('');
  const [loadStatus, setLoadStatus] = useState<DataLoadState>('loading');
  const [retryCount, setRetryCount] = useState(0);
  useEffect(() => {
    let active = true;
    setLoadStatus('loading');
    void api<{ events: typeof events }>('/api/audit?actorId=' + ACTOR_ID)
      .then((result) => {
        if (!active) return;
        setEvents(result.events);
        setLoadError('');
        setLoadStatus('available');
      })
      .catch((reason) => {
        if (!active) return;
        setEvents([]);
        setLoadError(reason instanceof Error ? reason.message : 'Could not load audit history.');
        setLoadStatus('unavailable');
      });
    return () => { active = false; };
  }, [verification, retryCount]);
  const verified = verification ? verification.valid === true : audit?.ready === true && audit.consistent;
  const verificationLabel = verification?.valid === false
    ? 'Chain verification failed'
    : verification?.valid === null
      ? 'Verification unavailable'
      : verified
        ? verification ? 'Chain verification passed' : 'Chain verified at startup'
        : 'Verification unavailable or failed';
  const verificationDetails = verification
    ? verification.error ?? `${verification.eventCount} events checked`
    : audit?.error ?? (verified ? 'SHA-256 audit chain verified by the backend.' : 'Run an explicit chain verification.');
  return <>
    <section className={`verification-panel ${verified ? 'verification-valid' : 'verification-denied'}`}><div className="verification-icon">{verified ? <ShieldCheck size={22} /> : <AlertTriangle size={22} />}</div><div className="verification-copy"><strong>{verificationLabel}</strong><span>{verificationDetails}</span></div><button className="primary-button" onClick={onVerify} disabled={busy}><ShieldCheck size={15} /> Verify chain</button></section>
    {loadError && <div className="notice notice-warning" role="alert"><AlertTriangle size={17} /><span>{loadError} Ensure audit:read consent is granted before retrying.</span><button className="text-button" onClick={() => setRetryCount((count) => count + 1)}>Retry</button></div>}
    <DataTable title="Audit history" description="SHA-256 linked events · newest first" columns={['#', 'Action', 'Actor', 'Resource', 'Decision', 'Hash']} loadStatus={loadStatus} empty={loadStatus === 'unavailable' ? 'Audit history unavailable.' : loadStatus === 'loading' ? 'Loading audit history…' : events.length === 0 ? 'No audit events are recorded yet.' : undefined}>
      {events.map((event) => <tr key={event.sequence}><td>{event.sequence}</td><td><strong>{event.payload?.action ?? 'Unreadable event'}</strong><small className="cell-subtitle">{event.payload?.operation ?? ''}</small></td><td>{event.payload?.actorId ?? 'System'}</td><td>{event.payload?.resource ?? '—'}</td><td><StatusBadge status={event.payload?.decision ?? 'unknown'} /></td><td><code className="hash-short">{event.event_hash}</code></td></tr>)}
    </DataTable>
  </>;
}

function AiPage({ available, loadStatus, text, setText, result, onAnalyze, busy }: { available: boolean; loadStatus: DataLoadState; text: string; setText: (value: string) => void; result: string; onAnalyze: () => void; busy: boolean }) {
  const description = loadStatus === 'unavailable'
    ? 'AI integration status is unavailable. Retry after restoring the API connection.'
    : loadStatus === 'loading'
      ? 'Checking whether the server-side Gemini integration is configured.'
      : available
        ? 'Risk analysis is advisory; backend authorization remains authoritative.'
        : 'Set GEMINI_API_KEY in the backend environment and restart the API. No placeholder analysis will be shown.';
  const title = loadStatus === 'loading' ? 'Checking Gemini configuration.' : loadStatus === 'unavailable' ? 'Gemini status unavailable.' : available ? 'Gemini is configured server-side.' : 'Gemini API key not configured.';
  return <>
    <div className={`notice ${loadStatus === 'available' && available ? 'notice-ok' : 'notice-warning'}`}><Sparkles size={18} /><span><strong>{title}</strong> {description}</span></div>
    <section className="form-panel ai-form"><div className="section-heading"><div><div className="section-kicker">OPERATION RISK</div><h3>Describe a suspicious operation</h3></div><span className="stage-tag">ADVISORY ONLY</span></div><label className="full-label">Operation description<textarea value={text} onChange={(event) => setText(event.target.value)} maxLength={2000} placeholder="Describe the operation to assess. Do not paste personal data, secrets, or file contents." rows={5} /></label><div className="form-bottom"><span>{text.length}/2000 · Text is sent to Gemini only when you submit this form.</span><button className="primary-button" disabled={loadStatus !== 'available' || !available || busy || text.trim().length < 5} onClick={onAnalyze}><Sparkles size={15} /> Analyze risk</button></div></section>
    {result && <section className="analysis-result"><div className="result-title"><Sparkles size={17} /><strong>Gemini analysis</strong><span>Advisory · backend policies remain authoritative</span></div><p>{result}</p></section>}
  </>;
}

function ApprovalsPage({ requests, loadStatus, statusLoadStatus, status, otp, setOtp, onApprove, onRelease, busy }: { requests: Approval[]; loadStatus: DataLoadState; statusLoadStatus: DataLoadState; status: { available: boolean; deliveryChannel: string | null; otpConfigured: boolean } | null; otp: string; setOtp: (value: string) => void; onApprove: (id: string) => void; onRelease: (id: string) => void; busy: boolean }) {
  const serviceAvailable = statusLoadStatus === 'available' && status?.available;
  const statusTitle = statusLoadStatus === 'loading'
    ? 'Checking approval delivery status.'
    : statusLoadStatus === 'unavailable'
      ? 'Approval service status unavailable.'
    : serviceAvailable
      ? `Approval delivery ready via ${status?.deliveryChannel}.`
      : 'Approval service unavailable.';
  const statusDetails = statusLoadStatus === 'loading'
    ? 'Waiting for the backend approval status.'
    : statusLoadStatus === 'unavailable'
      ? 'The backend did not return approval delivery status.'
    : serviceAvailable
      ? 'OTP expires after 60 seconds. The code is delivered out-of-band and is never shown here.'
      : 'Configure OTP_SECRET and a delivery provider in backend environment variables. Exports remain denied.';
  return <>
    <div className={`notice ${serviceAvailable ? 'notice-ok' : 'notice-warning'}`}><LockKeyhole size={18} /><span><strong>{statusTitle}</strong> {statusDetails}</span></div>
    <section className="form-panel"><div className="section-heading"><div><div className="section-kicker">ADMINISTRATOR ACTION</div><h3>Approve a pending metadata export</h3></div><span className="stage-tag">60 SECOND OTP</span></div><div className="form-row approval-form"><label>Delivered OTP<input inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]{6}" value={otp} onChange={(event) => setOtp(event.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="6-digit code" /></label><span className="form-note">Select a request below to submit this code. Only an administrator with access to the configured delivery channel can approve.</span></div></section>
    <DataTable title="Approval requests" description="Expired requests are automatically denied when listed or used." columns={['Request', 'File', 'Status', 'Deadline', 'Actions']} loadStatus={loadStatus} empty={loadStatus === 'unavailable' ? 'Approval requests unavailable. Check the API error above; grant approvals:read consent if access was denied, then retry.' : loadStatus === 'loading' ? 'Loading approval requests…' : requests.length === 0 ? 'No approval requests.' : undefined}>
      {requests.map((request) => <tr key={request.id}><td><code className="id-short">{request.id}</code><small className="cell-subtitle">Created {formatDate(request.created_at)}</small></td><td>{request.file_id}</td><td><StatusBadge status={request.status} /></td><td>{formatDate(request.expires_at)}</td><td className="table-actions">{request.status === 'pending' && <button className="text-button" disabled={busy || otp.length !== 6} onClick={() => onApprove(request.id)}>Approve</button>}{request.status === 'approved' && <button className="text-button" disabled={busy} onClick={() => onRelease(request.id)}>Release metadata</button>}</td></tr>)}
    </DataTable>
  </>;
}

function DataTable({ title, description, columns, empty, loadStatus, children }: { title: string; description: string; columns: string[]; empty?: string; loadStatus?: DataLoadState; children?: ReactNode }) {
  const countLabel = loadStatus === 'unavailable' ? 'UNAVAILABLE' : loadStatus === 'loading' ? 'LOADING' : empty ? '0' : 'LIVE';
  return <section className="table-panel"><div className="section-heading"><div><div className="section-kicker">SECURE RECORDS</div><h3>{title}</h3><p className="table-description">{description}</p></div><span className="table-count">{countLabel}</span></div>{empty ? <div className="empty-state"><ClipboardCheck size={19} /><span>{empty}</span></div> : <div className="table-scroll"><table><thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{children}</tbody></table></div>}</section>;
}

function StatusBadge({ status }: { status: string }) { return <span className={`status-badge status-${status.toLowerCase().replace(/[^a-z]+/g, '-')}`}>{status.replace(/_/g, ' ')}</span>; }

function viewDescription(view: View): string {
  return ({
    'Security Overview': 'Live status from verified consent, gateway, audit, and approval services.',
    'Consent Management': 'Append-only permission events replayed into current consent state.',
    'Protected Files': 'Browser-calculated fingerprints and consent-checked metadata operations.',
    'Audit Logs': 'Review and verify tamper-evident security history.',
    'AI Risk Analysis': 'Gemini-powered risk review with backend tools and no authorization authority.',
    'Administrator Approvals': 'Out-of-band one-time approval for sensitive metadata exports.',
  })[view];
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export default App;