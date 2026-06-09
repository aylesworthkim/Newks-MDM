import { useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeftCircle, ClipboardPaste, Eye, Home, Square, X } from 'lucide-react';

import { api, ApiError, getToken } from '../lib/api';
import { useAuth } from '../lib/auth';

type Status = 'connecting' | 'waiting' | 'active' | 'ended';

interface Ripple {
  id: number;
  x: number;
  y: number;
}

/**
 * Live remote-screen view + remote control for a single session. Opens a
 * WS connection to /ws/sessions/:id, renders each incoming SESSION_FRAME
 * as a JPEG, and sends INPUT_TAP / INPUT_SWIPE / INPUT_KEY when the
 * controller clicks, drags, or presses the system-key buttons.
 *
 * Coordinate model: we send proportional [0,1] coordinates relative to the
 * captured frame. The agent multiplies by its display metrics to get
 * pixels. That keeps the protocol independent of both the browser viewport
 * size and the device's actual screen resolution.
 *
 * Tap vs. swipe: if the pointer moves more than ~2% of the image diagonal
 * between mousedown and mouseup, treat as swipe. Otherwise, tap.
 */
export function RemoteScreenPage() {
  const { id: deviceId } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const sessionId = searchParams.get('session');
  const navigate = useNavigate();
  const { user } = useAuth();

  const [status, setStatus] = useState<Status>('connecting');
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const [endReason, setEndReason] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ripples, setRipples] = useState<Ripple[]>([]);
  // Tracks whether the agent has reported its accessibility service as
  // enabled. When false we render the control buttons as disabled / labelled
  // "view-only" so the operator isn't confused about why their taps don't
  // land. Updated by tapping the agent or by reading initial device state.
  const [accessibilityEnabled, setAccessibilityEnabled] = useState<boolean | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const dragStartRef = useRef<{ x: number; y: number; time: number } | null>(null);

  // Detect whether we were opened via window.open (popup) vs direct nav.
  // window.opener would be the obvious check, but DevicesPage opens us
  // with noopener for security -- that nulls window.opener in the new
  // window. So we use a URL flag the opener sets explicitly: &popup=1.
  // When true, End Session closes the window; otherwise it navigates back.
  const isPopup = useMemo(
    () => searchParams.get('popup') === '1',
    [searchParams],
  );

  // Auto-resize the popup window once we know the device's aspect ratio.
  // DevicesPage opens us at a default 1200x900 (landscape) because it
  // doesn't know the device's orientation up front. Once the first frame
  // lands we know the real aspect; resize to fit so the screen image
  // takes up the whole window without letterboxing -- bigger image = more
  // accurate clicks. Only runs once per session.
  const popupResizedRef = useRef(false);

  // v0.7.0+ clipboard sharing: Ctrl+V reads the operator's clipboard and
  // sends INPUT_PASTE; a "Paste" button opens a textarea fallback for
  // browsers that block navigator.clipboard.readText().
  const [pasteModalOpen, setPasteModalOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [pasteHint, setPasteHint] = useState<string | null>(null);

  const hasControlRole = user?.role === 'admin' || user?.role === 'support';
  const canControl = hasControlRole && status === 'active' && accessibilityEnabled !== false;

  useEffect(() => {
    if (!canControl) return;
    function onKeyDown(e: KeyboardEvent) {
      // Cmd+V on macOS, Ctrl+V elsewhere.
      const isPaste = (e.metaKey || e.ctrlKey) && (e.key === 'v' || e.key === 'V');
      if (!isPaste) return;
      // Don't hijack paste if the user is typing into a real text field
      // (e.g., they opened DevTools or hit V in our own paste modal).
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
      e.preventDefault();
      if (!navigator.clipboard?.readText) {
        setPasteHint('Browser clipboard read is blocked. Use the Paste button instead.');
        setPasteModalOpen(true);
        return;
      }
      navigator.clipboard.readText().then((text) => {
        if (!text) return;
        sendWs({ type: 'INPUT_PASTE', text });
        setPasteHint(`Pasted ${text.length} character${text.length === 1 ? '' : 's'}.`);
        setTimeout(() => setPasteHint(null), 2500);
      }).catch((err) => {
        // Permission denied or non-HTTPS context. Show the fallback.
        console.warn('clipboard.readText failed', err);
        setPasteHint('Browser denied clipboard access. Use the Paste button instead.');
        setPasteModalOpen(true);
      });
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // canControl pulls in user role + status + accessibility; recreate
    // listener when any of those changes so we always reflect latest state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canControl]);

  function submitPasteFromModal(e: FormEvent) {
    e.preventDefault();
    if (!pasteText) {
      setPasteModalOpen(false);
      return;
    }
    sendWs({ type: 'INPUT_PASTE', text: pasteText });
    setPasteHint(`Pasted ${pasteText.length} character${pasteText.length === 1 ? '' : 's'}.`);
    setPasteText('');
    setPasteModalOpen(false);
    setTimeout(() => setPasteHint(null), 2500);
  }

  // Initial accessibility status from the device record so the UI doesn't
  // wait for the first WS message to know whether controls will work.
  useEffect(() => {
    if (!deviceId) return;
    let cancelled = false;
    api<{ device: { accessibility_enabled: boolean } }>(`/api/devices/${deviceId}`)
      .then((r) => {
        if (!cancelled) setAccessibilityEnabled(r.device.accessibility_enabled);
      })
      .catch(() => {
        // Non-fatal: assume controls are available; agent will reject inputs
        // if it can't actually dispatch them.
        if (!cancelled) setAccessibilityEnabled(null);
      });
    return () => { cancelled = true; };
  }, [deviceId]);

  useEffect(() => {
    if (!sessionId) {
      setError('Missing session id in URL');
      setStatus('ended');
      return;
    }
    const token = getToken();
    if (!token) {
      navigate('/login');
      return;
    }

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl =
      `${proto}//${window.location.host}/ws/sessions/${sessionId}` +
      `?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => setStatus((prev) => (prev === 'ended' ? prev : 'waiting'));
    ws.onmessage = (event) => {
      let data: { type?: string; jpegBase64?: string; reason?: string };
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      switch (data.type) {
        case 'SESSION_ATTACHED':
          break;
        case 'SESSION_ACTIVE':
          setStatus('active');
          break;
        case 'SESSION_FRAME':
          if (data.jpegBase64) {
            setStatus('active');
            setFrameSrc(`data:image/jpeg;base64,${data.jpegBase64}`);
          }
          break;
        case 'SESSION_ENDED':
          setStatus('ended');
          setEndReason(data.reason ?? null);
          break;
        case 'ERROR':
          setError(data.reason ?? 'Server error');
          break;
      }
    };
    // See note in chunk 5c about not setting error from onerror -- React
    // StrictMode double-mounts force-close the first WS in dev which fires
    // a misleading onerror.
    ws.onclose = () => setStatus((prev) => (prev === 'ended' ? prev : 'ended'));

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [sessionId, navigate]);

  function sendWs(msg: Record<string, unknown>) {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  function showRipple(clientX: number, clientY: number) {
    const id = Date.now() + Math.random();
    setRipples((prev) => [...prev, { id, x: clientX, y: clientY }]);
    // Drop the ripple after the animation finishes.
    setTimeout(() => {
      setRipples((prev) => prev.filter((r) => r.id !== id));
    }, 600);
  }

  function proportionalCoords(e: MouseEvent<HTMLImageElement>): { x: number; y: number } | null {
    const img = imgRef.current;
    if (!img) return null;
    const rect = img.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    return { x, y };
  }

  function onMouseDown(e: MouseEvent<HTMLImageElement>) {
    if (!canControl) return;
    const p = proportionalCoords(e);
    if (!p) return;
    dragStartRef.current = { x: p.x, y: p.y, time: Date.now() };
  }

  function onMouseUp(e: MouseEvent<HTMLImageElement>) {
    if (!canControl) return;
    const start = dragStartRef.current;
    dragStartRef.current = null;
    if (!start) return;
    const end = proportionalCoords(e);
    if (!end) return;

    // Distance in proportional units. ~0.02 = 2% of frame -> tap.
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const movedFar = Math.hypot(dx, dy) > 0.02;

    if (movedFar) {
      const durationMs = Math.min(3000, Math.max(50, Date.now() - start.time));
      sendWs({
        type: 'INPUT_SWIPE',
        fromX: clamp01(start.x),
        fromY: clamp01(start.y),
        toX: clamp01(end.x),
        toY: clamp01(end.y),
        durationMs,
      });
    } else {
      sendWs({ type: 'INPUT_TAP', x: clamp01(start.x), y: clamp01(start.y) });
    }
    showRipple(e.clientX, e.clientY);
  }

  function onMouseLeave() {
    // Cancel any in-flight drag if the pointer leaves the frame mid-swipe.
    dragStartRef.current = null;
  }

  function sendKey(key: 'BACK' | 'HOME' | 'RECENTS') {
    if (!canControl) return;
    sendWs({ type: 'INPUT_KEY', key });
  }

  async function endSession() {
    if (!sessionId) {
      // Nothing to clean up server-side; just close/navigate.
      if (isPopup) window.close();
      else navigate(`/devices/${deviceId ?? ''}`);
      return;
    }
    try {
      await api(`/api/sessions/${sessionId}`, { method: 'DELETE' });
    } catch (err) {
      if (err instanceof ApiError && err.status !== 404) {
        setError(err.message);
      }
    }
    if (isPopup) {
      window.close();
    } else {
      navigate(`/devices/${deviceId ?? ''}`);
    }
  }

  return (
    <>
      <div className="card">
        <div className="row-flex" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>Remote screen</h2>
          <StatusPill status={status} />
          {hasControlRole && accessibilityEnabled === false && status !== 'ended' && (
            <span
              className="readiness-pill warn row-flex"
              style={{ gap: 4 }}
              title="The tablet's accessibility service is not enabled. You can view the screen but tap/swipe inputs will not be dispatched."
            >
              <Eye size={12} /> View only
            </span>
          )}
          <button
            onClick={endSession}
            className="row-flex"
            style={{ marginLeft: 'auto' }}
            disabled={status === 'ended'}
          >
            <X size={14} /> {isPopup ? 'Close' : 'End session'}
          </button>
        </div>

        {error && <div className="error-text" style={{ marginBottom: 12 }}>{error}</div>}

        {status === 'connecting' && (
          <div className="muted">Opening WebSocket to the session...</div>
        )}
        {status === 'waiting' && !frameSrc && (
          <div className="muted">
            Waiting for the tablet to start sharing. The person at the device
            needs to tap <strong>Start now</strong> on the consent dialog.
          </div>
        )}
        {status === 'ended' && (
          <div>
            <p style={{ margin: 0 }}>Session ended.</p>
            {endReason && (
              <p className="muted" style={{ marginTop: 4 }}>Reason: {endReason}</p>
            )}
          </div>
        )}

        {frameSrc && (
          <>
            <div
              style={{
                background: '#000',
                borderRadius: 8,
                overflow: 'hidden',
                display: 'flex',
                justifyContent: 'center',
                marginTop: 12,
                position: 'relative',
                userSelect: 'none',
              }}
            >
              <img
                ref={imgRef}
                src={frameSrc}
                alt="Remote screen"
                draggable={false}
                onMouseDown={onMouseDown}
                onMouseUp={onMouseUp}
                onMouseLeave={onMouseLeave}
                onContextMenu={(e) => e.preventDefault()}
                onLoad={(e) => {
                  // First-frame popup resize. Reads the natural image dims,
                  // resizes the popup window to ~85% of screen with chrome
                  // padding, so the device screen fills the popup.
                  if (!isPopup) return;
                  if (popupResizedRef.current) return;
                  const img = e.currentTarget;
                  const w = img.naturalWidth;
                  const h = img.naturalHeight;
                  if (!w || !h) return;
                  popupResizedRef.current = true;
                  const availW = window.screen.availWidth;
                  const availH = window.screen.availHeight;
                  // Allow ~85% of screen, reserving chrome padding for the
                  // popup's title bar + the page's header + key buttons.
                  const chromeW = 32;
                  const chromeH = 200;
                  const usableW = availW * 0.85 - chromeW;
                  const usableH = availH * 0.85 - chromeH;
                  const fit = Math.min(usableW / w, usableH / h);
                  const newW = Math.round(w * fit + chromeW);
                  const newH = Math.round(h * fit + chromeH);
                  try {
                    window.resizeTo(newW, newH);
                  } catch {
                    // Some browsers / popup configs block resizeTo. Silent
                    // fallback: the maxHeight CSS still gives a usable view.
                  }
                }}
                style={{
                  maxWidth: '100%',
                  display: 'block',
                  // 85vh instead of 70vh so portrait-oriented devices use
                  // more of the popup vertically when resizeTo is blocked.
                  maxHeight: '85vh',
                  cursor: canControl ? 'crosshair' : 'default',
                }}
              />
              {ripples.map((r) => (
                <span
                  key={r.id}
                  style={{
                    position: 'fixed',
                    left: r.x - 12,
                    top: r.y - 12,
                    width: 24,
                    height: 24,
                    borderRadius: 24,
                    border: '2px solid #2563eb',
                    pointerEvents: 'none',
                    animation: 'rippleFade 600ms ease-out forwards',
                  }}
                />
              ))}
            </div>

            {/* System key buttons */}
            <div className="row-flex" style={{ marginTop: 12, gap: 8 }}>
              <button onClick={() => sendKey('BACK')} disabled={!canControl} className="row-flex">
                <ArrowLeftCircle size={14} /> Back
              </button>
              <button onClick={() => sendKey('HOME')} disabled={!canControl} className="row-flex">
                <Home size={14} /> Home
              </button>
              <button onClick={() => sendKey('RECENTS')} disabled={!canControl} className="row-flex">
                <Square size={14} /> Recents
              </button>
              <button
                onClick={() => {
                  setPasteText('');
                  setPasteModalOpen(true);
                }}
                disabled={!canControl}
                className="row-flex"
                title="Paste text into the focused field on the tablet (Ctrl+V also works)"
              >
                <ClipboardPaste size={14} /> Paste
              </button>
              {!canControl && user?.role === 'viewer' && (
                <span className="muted" style={{ marginLeft: 12, fontSize: 13 }}>
                  View-only role
                </span>
              )}
              {!canControl && hasControlRole && accessibilityEnabled === false && (
                <span className="muted" style={{ marginLeft: 12, fontSize: 13 }}>
                  Accessibility service disabled on tablet
                </span>
              )}
              {pasteHint && (
                <span className="muted" style={{ marginLeft: 12, fontSize: 13 }}>
                  {pasteHint}
                </span>
              )}
            </div>

            <p className="muted" style={{ marginTop: 12, fontSize: 13 }}>
              Click to tap. Click-and-drag to swipe. <strong>Ctrl+V</strong>
              {' '}pastes from your clipboard into whatever text field is
              focused on the tablet. Remote input requires the tablet's
              accessibility service (Settings → Accessibility → Newk's MDM Agent).
            </p>
          </>
        )}
      </div>

      {pasteModalOpen && (
        <div className="modal-backdrop" onClick={() => setPasteModalOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="row-flex" style={{ marginBottom: 12 }}>
              <h3 style={{ margin: 0, fontSize: 16 }}>Paste text to tablet</h3>
              <button
                className="icon-btn"
                onClick={() => setPasteModalOpen(false)}
                style={{ marginLeft: 'auto' }}
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>
            <form onSubmit={submitPasteFromModal}>
              <div className="field">
                <label htmlFor="pasteTextArea">Text</label>
                <textarea
                  id="pasteTextArea"
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  autoFocus
                  rows={6}
                  maxLength={10_000}
                  style={{ width: '100%', font: 'inherit', padding: 8 }}
                  placeholder="Paste or type the text to send to the tablet's focused field"
                />
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  The tablet must have an editable text field focused. If
                  paste isn't supported on that field, the entire field's
                  contents will be replaced with this text.
                </div>
              </div>
              <button type="submit" className="primary" disabled={!pasteText}>
                Send to tablet
              </button>
            </form>
          </div>
        </div>
      )}

      <style>{`
        @keyframes rippleFade {
          from { opacity: 1; transform: scale(0.5); }
          to { opacity: 0; transform: scale(2); }
        }
      `}</style>
    </>
  );
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function StatusPill({ status }: { status: Status }) {
  const label = {
    connecting: 'connecting',
    waiting: 'awaiting consent',
    active: 'live',
    ended: 'ended',
  }[status];
  const colorMap: Record<Status, string> = {
    connecting: '#6b7280',
    waiting: '#eab308',
    active: '#16a34a',
    ended: '#dc2626',
  };
  return (
    <span
      style={{
        marginLeft: 8,
        padding: '2px 10px',
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 500,
        background: `${colorMap[status]}1a`,
        color: colorMap[status],
      }}
    >
      {label}
    </span>
  );
}
