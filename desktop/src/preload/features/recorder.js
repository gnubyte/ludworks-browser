// Stream recorder, page side (isolated world of the tab preload, every frame). Idle until the browser
// asks (context menu "Record video from now", src/main/recorder.js): then it records the chosen
// <video>/<audio> from that moment on with captureStream() + MediaRecorder and streams the WebM chunks
// to the browser, which appends them to a file. Live streams work the same as anything else playing;
// DRM-protected video cannot be captured (Widevine blanks it), and is refused with a reason.

const VIDEO_TYPES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
const AUDIO_TYPES = ['audio/webm;codecs=opus', 'audio/webm'];
const CHUNK_MS = 1000;

const recordings = new Map(); // id → {rec, stream}

export function setupRecorder() {
  try {
    const { ipcRenderer } = require('electron');
    ipcRenderer.on('recorder:start', (_e, req) => start(ipcRenderer, req || {}));
    ipcRenderer.on('recorder:stop', (_e, req) => stop(String((req && req.id) || '')));
    // Leaving the page ends the recording with everything captured so far.
    addEventListener('pagehide', () => {
      for (const id of recordings.keys()) stop(id);
    });
  } catch {
    /* keep the page working without the recorder */
  }
}

/** The media element under the context-menu point, else the playing (then largest) one of the frame. */
export function pickMedia(doc, point) {
  if (point) {
    const hit = doc.elementFromPoint(point.x, point.y);
    const el = hit && hit.closest ? hit.closest('video,audio') : null;
    if (el) return el;
  }
  const area = (m) => {
    const r = m.getBoundingClientRect();
    return Math.max(0, r.width) * Math.max(0, r.height);
  };
  const playing = (m) => !m.paused && !m.ended;
  const all = [...doc.querySelectorAll('video,audio')].filter((m) => m.readyState > 0);
  return all.sort((a, b) => playing(b) - playing(a) || area(b) - area(a))[0] || null;
}

function stop(id) {
  const r = recordings.get(id);
  if (r && r.rec.state !== 'inactive') r.rec.stop();
}

function start(ipc, req) {
  const id = typeof req.id === 'string' ? req.id.slice(0, 64) : '';
  if (!id || recordings.has(id)) return;
  const fail = (message) => ipc.send('recorder:error', { id, message });
  const el = pickMedia(document, req.point && typeof req.point.x === 'number' ? req.point : null);
  if (!el) return fail('There is no video or audio in this page to record.');
  if (el.mediaKeys) return fail('This video is DRM-protected (like Netflix or Disney+): it cannot be recorded.');
  let stream;
  try {
    stream = el.captureStream();
  } catch (e) {
    return fail(e && e.name === 'SecurityError' ? 'This video comes from another site that does not allow capturing it.' : `This media cannot be recorded (${(e && e.name) || 'error'}).`);
  }
  const isVideo = el.tagName === 'VIDEO' && stream.getVideoTracks().length > 0;
  const mimeType = (isVideo ? VIDEO_TYPES : AUDIO_TYPES).find((t) => MediaRecorder.isTypeSupported(t)) || '';
  let rec;
  try {
    rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 192_000 });
  } catch (e) {
    return fail(`This media cannot be recorded (${(e && e.name) || 'error'}).`);
  }
  recordings.set(id, { rec, stream });
  // Chunks go out in order: each waits for the previous one's bytes.
  let chain = Promise.resolve();
  rec.ondataavailable = (ev) => {
    if (!ev.data || !ev.data.size) return;
    chain = chain.then(() => ev.data.arrayBuffer()).then((buf) => ipc.send('recorder:data', { id, buf: new Uint8Array(buf) }));
  };
  rec.onstop = () => {
    chain.then(() => {
      recordings.delete(id);
      for (const t of stream.getTracks()) t.stop();
      ipc.send('recorder:end', { id });
    });
  };
  rec.onerror = (ev) => fail(`Recording stopped: ${(ev && ev.error && ev.error.message) || 'the media changed'}.`);
  try {
    rec.start(CHUNK_MS);
  } catch (e) {
    recordings.delete(id);
    return fail(`This media cannot be recorded (${(e && e.name) || 'error'}).`);
  }
  ipc.send('recorder:started', { id, kind: isVideo ? 'video' : 'audio', mimeType: rec.mimeType || mimeType });
}
