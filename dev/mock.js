// Backend falso pra testar a interface no navegador: imita window.__TAURI__ e os comandos do Rust.
(async () => {
  const SEP = '\\';
  const ROOT = 'C:\\Users\\editor\\B-roll';
  const ROOT2 = 'D:\\Clientes\\Paulo Aguiar';
  const THUMBS = 'C:\\cache\\thumbs\\';
  const EMPTY = location.search.includes('vazio');

  // ---------- mídia sintética ----------

  function recordClip(w, h, hue, label, secs = 2) {
    return new Promise((resolve) => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const g = c.getContext('2d');
      const stream = c.captureStream(30);
      const type = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
      const rec = new MediaRecorder(stream, { mimeType: type });
      const chunks = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.onstop = () => resolve(URL.createObjectURL(new Blob(chunks, { type: 'video/webm' })));
      let t = 0;
      const frame = () => {
        const k = t / (secs * 30);
        const grad = g.createLinearGradient(0, 0, w, h);
        grad.addColorStop(0, `hsl(${hue}, 60%, ${22 + 18 * k}%)`);
        grad.addColorStop(1, `hsl(${hue + 50}, 70%, ${40 + 10 * k}%)`);
        g.fillStyle = grad;
        g.fillRect(0, 0, w, h);
        g.fillStyle = 'rgba(255,255,255,.85)';
        g.beginPath();
        g.arc(w * (0.15 + 0.7 * k), h * 0.55, Math.min(w, h) * 0.12, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#fff';
        g.font = `600 ${Math.round(Math.min(w, h) * 0.08)}px system-ui`;
        g.fillText(label, w * 0.06, h * 0.16);
        g.font = `${Math.round(Math.min(w, h) * 0.05)}px monospace`;
        g.fillText(`00:0${Math.floor(t / 30)}:${String(t % 30).padStart(2, '0')}`, w * 0.06, h * 0.92);
        t++;
      };
      frame();
      rec.start();
      const timer = setInterval(() => {
        frame();
        if (t > secs * 30) { clearInterval(timer); rec.stop(); }
      }, 1000 / 30);
    });
  }

  function makeImage(w, h, hue, label) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(w * 0.3, h * 0.3, 10, w * 0.5, h * 0.5, Math.max(w, h));
    grad.addColorStop(0, `hsl(${hue}, 70%, 62%)`);
    grad.addColorStop(1, `hsl(${hue + 40}, 50%, 18%)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 30; i++) {
      g.fillStyle = `hsla(${hue + i * 7}, 60%, 70%, .12)`;
      g.beginPath();
      g.arc(((i * 97) % w), ((i * 61) % h), 20 + (i * 13) % 120, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#fff';
    g.font = `600 ${Math.round(Math.min(w, h) * 0.07)}px system-ui`;
    g.fillText(label, w * 0.06, h * 0.9);
    return new Promise((r) => c.toBlob((b) => r(URL.createObjectURL(b)), 'image/jpeg', 0.85));
  }

  function makeWav(freq, secs = 3) {
    const rate = 22050, n = rate * secs;
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const str = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
      const env = Math.min(1, i / 2000, (n - i) / 4000);
      v.setInt16(44 + i * 2, Math.sin((2 * Math.PI * freq * i) / rate) * 9000 * env, true);
    }
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }

  const bogus = URL.createObjectURL(new Blob([new Uint8Array(4096).map((_, i) => i * 7)], { type: 'video/quicktime' }));
  const [vDrone, vOndas, vAvenida, vVert, vNeon, vCach, vLogo] = await Promise.all([
    recordClip(640, 360, 185, 'Drone praia'),
    recordClip(640, 360, 210, 'Ondas'),
    recordClip(640, 360, 25, 'Timelapse avenida'),
    recordClip(360, 640, 330, 'Trânsito'),
    recordClip(360, 640, 280, 'Neon'),
    recordClip(640, 360, 140, 'Cachoeira'),
    recordClip(640, 360, 15, 'Logo'),
  ]);
  const [iAreia, iPredios, iFloresta, iFolhas, iPessoa, iCliente] = await Promise.all([
    makeImage(1600, 900, 40, 'Areia'),
    makeImage(1600, 1000, 220, 'Prédios'),
    makeImage(1920, 1080, 120, 'Floresta'),
    makeImage(1080, 1920, 90, 'Folhas'),
    makeImage(1600, 900, 300, 'Escritório'),
    makeImage(1080, 1350, 10, 'Cliente'),
  ]);

  // ---------- sistema de arquivos falso ----------

  const nodes = new Map();
  const day = 86400000;
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const parentOf = (p) => p.slice(0, p.lastIndexOf(SEP));
  const nameOf = (p) => p.slice(p.lastIndexOf(SEP) + 1);
  const KINDS = { mp4: 'video', mov: 'video', webm: 'video', jpg: 'image', png: 'image', mp3: 'audio', wav: 'audio', m4a: 'audio' };

  function addDir(p) { nodes.set(p, { dir: true, modified: Date.now() }); }
  function addFile(p, src, mb) {
    nodes.set(p, { dir: false, src, size: Math.round(mb * 1048576), modified: Date.now() - Math.round(rnd() * 60 * day) });
  }

  [ROOT, `${ROOT}\\Praia`, `${ROOT}\\Cidade`, `${ROOT}\\Cidade\\Noite`, `${ROOT}\\Natureza`, `${ROOT}\\Trilhas e efeitos`, 'D:\\Clientes', ROOT2].forEach(addDir);
  addFile(`${ROOT}\\Praia\\drone_praia_01.mp4`, vDrone, 248);
  addFile(`${ROOT}\\Praia\\ondas_quebrando.mp4`, vOndas, 96);
  addFile(`${ROOT}\\Praia\\por_do_sol_iphone.mov`, bogus, 412);
  addFile(`${ROOT}\\Praia\\areia_textura.jpg`, iAreia, 3.2);
  addFile(`${ROOT}\\Cidade\\timelapse_avenida.mp4`, vAvenida, 180);
  addFile(`${ROOT}\\Cidade\\transito_vertical.mp4`, vVert, 64);
  addFile(`${ROOT}\\Cidade\\predios_centro.png`, iPredios, 7.8);
  addFile(`${ROOT}\\Cidade\\Noite\\neon_rua.mp4`, vNeon, 71);
  addFile(`${ROOT}\\Natureza\\floresta_neblina.jpg`, iFloresta, 4.4);
  addFile(`${ROOT}\\Natureza\\cachoeira.mp4`, vCach, 302);
  addFile(`${ROOT}\\Natureza\\folhas_vertical.jpg`, iFolhas, 2.9);
  addFile(`${ROOT}\\Trilhas e efeitos\\trilha_inspiradora.mp3`, makeWav(330), 6.1);
  addFile(`${ROOT}\\Trilhas e efeitos\\whoosh_transicao.wav`, makeWav(880, 2), 0.9);
  addFile(`${ROOT}\\Trilhas e efeitos\\ambiente_cidade.m4a`, makeWav(196, 4), 3.4);
  addFile(`${ROOT}\\abertura_logo.mp4`, vLogo, 22);
  addFile(`${ROOT}\\pessoa_trabalhando.jpg`, iPessoa, 5.1);
  addFile(`${ROOT2}\\depoimento_cliente.jpg`, iCliente, 2.2);

  const thumbs = new Map();
  const metas = new Map();
  const key = (p, n) => {
    let h = 0x811c9dc5;
    for (const ch of `${p}|${n.size}|${n.modified}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    return (h.toString(16).padStart(8, '0') + (h ^ 0x5bd1e995).toString(16).padStart(8, '0')).slice(0, 16);
  };
  const extOf = (p) => (p.includes('.') ? p.split('.').pop().toLowerCase() : '');

  function media(p) {
    const n = nodes.get(p);
    if (!n || n.dir || !KINDS[extOf(p)]) return null;
    const k = key(p, n);
    return {
      name: nameOf(p), path: p, kind: KINDS[extOf(p)], ext: extOf(p), size: n.size, modified: n.modified, key: k,
      thumb: thumbs.has(k) ? `${THUMBS}${k}.jpg` : null, meta: metas.get(k) || null,
    };
  }
  const children = (dir) => [...nodes.keys()].filter((p) => parentOf(p) === dir);
  const folder = (p) => ({ name: nameOf(p), path: p, hasChildren: children(p).some((c) => nodes.get(c).dir) });
  const inside = (p, root) => p === root || p.startsWith(root + SEP);
  const unique = (dir, name) => {
    if (!nodes.has(`${dir}${SEP}${name}`)) return `${dir}${SEP}${name}`;
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
    for (let i = 2; ; i++) if (!nodes.has(`${dir}${SEP}${stem} (${i})${ext}`)) return `${dir}${SEP}${stem} (${i})${ext}`;
  };
  const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[_\-.]/g, ' ');

  const listeners = {};
  const emit = (name, payload) => (listeners[name] || []).forEach((cb) => cb({ payload }));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const commands = {
    async load_state() {
      if (EMPTY) return null;
      try { return JSON.parse(localStorage.getItem('acervo-mock')) || { roots: [ROOT], expanded: [ROOT] }; } catch { return null; }
    },
    async save_state({ state }) { if (!EMPTY) localStorage.setItem('acervo-mock', JSON.stringify(state)); },
    async list_dir({ path }) {
      if (!nodes.has(path)) throw new Error('A pasta não existe');
      const kids = children(path);
      return {
        folders: kids.filter((p) => nodes.get(p).dir).map(folder).sort((a, b) => a.name.localeCompare(b.name)),
        files: kids.map(media).filter(Boolean),
      };
    },
    async subfolders({ path }) { return children(path).filter((p) => nodes.get(p).dir).map(folder).sort((a, b) => a.name.localeCompare(b.name)); },
    async search({ roots, query }) {
      const terms = norm(query).split(/\s+/).filter(Boolean);
      await wait(120);
      return [...nodes.keys()].filter((p) => {
        const root = roots.find((r) => inside(p, r));
        return root && terms.every((t) => norm(p.slice(root.length)).includes(t));
      }).map(media).filter(Boolean);
    },
    async recent({ roots, limit }) {
      return [...nodes.keys()].filter((p) => roots.some((r) => inside(p, r))).map(media).filter(Boolean)
        .sort((a, b) => b.modified - a.modified).slice(0, limit);
    },
    async files_info({ pathsList }) { return pathsList.map(media).filter(Boolean); },
    async create_folder({ parent, name }) { const p = unique(parent, name.trim()); addDir(p); return p; },
    async rename_path({ path, newName }) {
      const target = `${parentOf(path)}${SEP}${newName}`;
      if (nodes.has(target)) throw new Error('Já existe um item com esse nome aqui');
      for (const [p, n] of [...nodes]) if (inside(p, path)) { nodes.delete(p); nodes.set(target + p.slice(path.length), n); }
      return target;
    },
    async trash_paths({ pathsList }) { for (const p of [...nodes.keys()]) if (pathsList.some((x) => inside(p, x))) nodes.delete(p); },
    async transfer({ pathsList, dest, mode }) {
      const r = { done: [], failed: [], skipped: 0 };
      let i = 0;
      for (const src of pathsList) {
        if (parentOf(src) === dest || inside(dest, src)) { r.skipped++; continue; }
        const target = unique(dest, nameOf(src));
        await wait(350);
        emit('transfer-progress', { done: ++i, total: pathsList.length, name: nameOf(src) });
        const n = nodes.get(src) || { dir: false, src: iCliente, size: 3e6, modified: Date.now() };
        for (const [p, node] of [...nodes]) {
          if (!inside(p, src)) continue;
          nodes.set(target + p.slice(src.length), { ...node });
          if (mode === 'move') nodes.delete(p);
        }
        if (!nodes.has(target)) nodes.set(target, { ...n, modified: Date.now() });
        r.done.push(target);
      }
      return r;
    },
    async pick_folder() { await wait(300); return ROOT2; },
    async pick_files() { await wait(300); return ['C:\\Users\\editor\\Downloads\\novo_clipe.mp4']; },
    async create_default_library() {
      const p = 'C:\\Users\\editor\\Videos\\Acervo B-roll';
      ['C:\\Users\\editor\\Videos', p, `${p}\\Vídeos`, `${p}\\Imagens`, `${p}\\Áudios`].forEach(addDir);
      return p;
    },
    async save_thumb({ key: k, data, meta }) {
      metas.set(k, meta);
      if (!data) return null;
      thumbs.set(k, `data:image/jpeg;base64,${data}`);
      return `${THUMBS}${k}.jpg`;
    },
    async path_kinds({ pathsList }) { return pathsList.map((p) => !extOf(p)); },
    async reveal({ path }) { console.log('[mock] mostrar na pasta', path); },
    async open_default({ path }) { console.log('[mock] abrir no programa padrão', path); },
    async 'plugin:drag|start_drag'(args) {
      window.__lastDrag = { item: args.item, imageBytes: args.image?.length || 0, options: args.options };
      console.log('[mock] arrastar pra fora', args.item);
      await wait(80);
      args.onEvent?.onmessage?.({ result: 'Dropped', cursorPos: { x: 0, y: 0 } });
    },
  };

  let dropCb = null;
  window.__TAURI__ = {
    core: {
      async invoke(cmd, args = {}) {
        if (!commands[cmd]) throw new Error(`comando desconhecido: ${cmd}`);
        return commands[cmd](args);
      },
      convertFileSrc(p) {
        if (p.startsWith(THUMBS)) return thumbs.get(p.slice(THUMBS.length, -4));
        return nodes.get(p)?.src || bogus;
      },
      Channel: class { constructor() { this.onmessage = () => {}; } },
    },
    event: {
      async listen(name, cb) {
        (listeners[name] ||= []).push(cb);
        return () => { listeners[name] = listeners[name].filter((x) => x !== cb); };
      },
    },
    webview: {
      getCurrentWebview: () => ({ onDragDropEvent: async (cb) => { dropCb = cb; return () => {}; } }),
    },
  };

  // Simula soltar arquivos do Explorer em (x, y) da janela, em pixels CSS.
  window.__mockDrop = (paths, x, y, phase = 'all') => {
    const position = { x: x * devicePixelRatio, y: y * devicePixelRatio };
    if (phase === 'all' || phase === 'enter') dropCb?.({ payload: { type: 'enter', paths, position } });
    if (phase === 'all' || phase === 'over') dropCb?.({ payload: { type: 'over', position } });
    if (phase === 'all' || phase === 'drop') dropCb?.({ payload: { type: 'drop', paths, position } });
  };

  const s = document.createElement('script');
  s.src = 'app.js';
  document.body.append(s);
})();
