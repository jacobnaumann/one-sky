// Composes a shareable image: the globe as the visitor sees it, with the day's numbers set in type.

export interface PostcardInfo { place: string; lights: number; zones: number; threads: number; km: number; question: string }

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

export async function makePostcard(shot: string, info: PostcardInfo): Promise<string> {
  const img = await loadImage(shot);
  const portrait = img.height > img.width;
  const W = portrait ? 1080 : 1600, H = portrait ? 1350 : 1000;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  try {
    await Promise.all([document.fonts.load('400 120px "Instrument Serif"'), document.fonts.load('500 22px "Hanken Grotesk Variable"')]);
  } catch { /* fall back to system fonts */ }

  const s = Math.max(W / img.width, H / img.height);
  const dw = img.width * s, dh = img.height * s;
  g.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);

  // darken the edges so type is always legible
  const v = g.createRadialGradient(W / 2, H / 2, H * 0.25, W / 2, H / 2, W * 0.72);
  v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.78)');
  g.fillStyle = v; g.fillRect(0, 0, W, H);
  const b = g.createLinearGradient(0, H * 0.55, 0, H);
  b.addColorStop(0, 'rgba(0,0,0,0)'); b.addColorStop(1, 'rgba(0,0,0,0.85)');
  g.fillStyle = b; g.fillRect(0, 0, W, H);

  const serif = '"Instrument Serif", Georgia, serif';
  const sans = '"Hanken Grotesk Variable", system-ui, sans-serif';
  const ink = '#f4efe6', dim = 'rgba(244,239,230,0.68)', amber = '#ffb86b';
  const M = 72;

  g.textBaseline = 'alphabetic';
  g.fillStyle = ink;
  g.font = `400 ${portrait ? 92 : 108}px ${serif}`;
  g.fillText('One Sky', M, M + (portrait ? 70 : 84));

  const date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const time = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  g.font = `500 21px ${sans}`;
  g.fillStyle = dim;
  if (portrait) {
    spaced(g, `${date.toUpperCase()}  ·  ${time} UTC`, M + 4, M + 108, 2.6);
    spaced(g, `SEEN FROM ${info.place.toUpperCase()}`, M + 4, M + 138, 2.6);
  } else spaced(g, `${date.toUpperCase()}  ·  ${time} UTC  ·  SEEN FROM ${info.place.toUpperCase()}`, M + 4, M + 128, 2.6);

  // numbers, bottom left
  const cols: [string, string][] = [
    [String(info.lights), info.lights === 1 ? 'light awake' : 'lights awake'],
    [`${info.zones}/24`, 'time zones lit'],
    [info.threads.toLocaleString('en-US'), info.threads === 1 ? 'thread' : 'threads'],
    [Math.round(info.km).toLocaleString('en-US'), 'km connected'],
  ];
  let x = M;
  const shown = cols.filter(([n]) => n !== '0').slice(0, portrait ? 2 : 4);
  const lift = portrait ? 150 : 0; // on a portrait card the question sits below the numbers
  for (const [n, label] of shown) {
    g.font = `400 76px ${serif}`;
    g.fillStyle = ink;
    g.fillText(n, x, H - M - 34 - lift);
    const w = g.measureText(n).width;
    g.font = `500 17px ${sans}`;
    g.fillStyle = dim;
    spaced(g, label.toUpperCase(), x + 2, H - M - lift, 2.2);
    x += Math.max(w, measureSpaced(g, label.toUpperCase(), 2.2)) + 64;
  }

  // the question, bottom right
  g.textAlign = 'right';
  g.font = `italic 400 34px ${serif}`;
  g.fillStyle = amber;
  const lines = wrap(g, `“${info.question}”`, portrait ? W - 2 * M : 520);
  lines.forEach((ln, i) => g.fillText(ln, W - M, H - M - 34 - (lines.length - 1 - i) * 42));
  g.font = `500 17px ${sans}`;
  g.fillStyle = dim;
  g.textAlign = 'left';
  const tag = 'TODAY’S QUESTION';
  spaced(g, tag, W - M - measureSpaced(g, tag, 2.2), H - M, 2.2);

  return c.toDataURL('image/png');
}

function measureSpaced(g: CanvasRenderingContext2D, text: string, gap: number) {
  let w = 0;
  for (const ch of text) w += g.measureText(ch).width + gap;
  return w - gap;
}
function spaced(g: CanvasRenderingContext2D, text: string, x: number, y: number, gap: number) {
  for (const ch of text) { g.fillText(ch, x, y); x += g.measureText(ch).width + gap; }
}
function wrap(g: CanvasRenderingContext2D, text: string, max: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const t = line ? `${line} ${word}` : word;
    if (g.measureText(t).width > max && line) { out.push(line); line = word; } else line = t;
  }
  if (line) out.push(line);
  return out.slice(0, 4);
}
