/* Shell loader. Owned by the orchestrator — builders must not edit this file.
 *
 * Each page declares which sections it wants:
 *     <div id="app" data-sections="hero,lineup,timetable">
 * We fetch each fragment, inject it in order, then call
 * window.Sections[name].init(rootEl, data).
 */

const DATA_FILES = ['event', 'teams', 'courts', 'djs', 'schedule', 'tickets', 'clubs'];

/* Everything this loader fetches resolves against THIS FILE's URL, never the
   page's: pages live at /, /register/ and /tickets/ (clean URLs), and a
   page-relative "data/…" would break the moment the page sits in a folder. */
const asset = rel => new URL('../' + rel, import.meta.url).href;

const Data = {};

async function loadData() {
  const results = await Promise.all(
    DATA_FILES.map(n => fetch(asset(`data/${n}.json`)).then(r => {
      if (!r.ok) throw new Error(`data/${n}.json → ${r.status}`);
      return r.json();
    }))
  );
  DATA_FILES.forEach((n, i) => { Data[n] = results[i]; });
  window.GlasData = Data;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = asset(src);
    s.async = false;
    s.dataset.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(s);
  });
}

/* Scripts that must be present before a section's own init runs. The timetable
 * calls window.Courts3D during init; without the 3D module loaded first it
 * silently falls back to the flat plan for good. */
const SECTION_DEPS = {
  timetable: ['js/courts3d.js'],
};

async function loadSection(name, mount) {
  const res = await fetch(asset(`sections/${name}.html`));
  if (!res.ok) throw new Error(`sections/${name}.html → ${res.status}`);
  const tpl = document.createElement('template');
  tpl.innerHTML = (await res.text()).trim();
  const root = tpl.content.firstElementChild;
  if (!root) throw new Error(`sections/${name}.html is empty`);
  mount.appendChild(root);

  for (const dep of SECTION_DEPS[name] || []) {
    try {
      await loadScript(dep);
    } catch (e) {
      console.warn(`[app] dependency ${dep} for ${name} failed:`, e.message);
    }
  }

  try {
    await loadScript(`js/${name}.js`);
  } catch (e) {
    console.warn(`[app] no script for ${name}:`, e.message);
  }

  const mod = window.Sections && window.Sections[name];
  if (mod && typeof mod.init === 'function') {
    try {
      await mod.init(root, Data);
    } catch (e) {
      console.error(`[app] ${name}.init() threw:`, e);
    }
  }
  document.dispatchEvent(new CustomEvent('section:ready', { detail: { name, root } }));
  return root;
}

/* Sections sit under sticky chrome, and fragments arrive after the browser has
 * already tried to scroll. So: offset every in-page jump by --anchor-offset, and
 * re-run any inbound #hash once the sections exist. */
function installAnchorScroll() {
  const offsetFor = () => {
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue('--anchor-offset').trim();
    return parseInt(v, 10) || 0;
  };

  const goTo = (el, smooth = true) => {
    if (!el) return;
    const y = el.getBoundingClientRect().top + window.scrollY - offsetFor();
    window.scrollTo({ top: Math.max(0, y), behavior: smooth ? 'smooth' : 'instant' });
  };

  document.addEventListener('click', e => {
    const a = e.target.closest('a[href^="#"]');
    if (!a) return;
    const id = a.getAttribute('href').slice(1);
    if (!id) return;
    const el = document.getElementById(id);
    if (!el) return;
    e.preventDefault();
    goTo(el, !matchMedia('(prefers-reduced-motion: reduce)').matches);
    history.replaceState(null, '', `#${id}`);
  });

  if (location.hash) {
    requestAnimationFrame(() => goTo(document.getElementById(location.hash.slice(1)), false));
  }
}

async function boot() {
  const app = document.getElementById('app');
  const mount = document.getElementById('main');
  const names = (app.dataset.sections || '').split(',').map(s => s.trim()).filter(Boolean);

  try {
    await loadData();
  } catch (e) {
    console.error('[app] data load failed:', e);
    mount.innerHTML = `<p style="padding:2rem;color:#fff">Could not load event data: ${e.message}</p>`;
    return;
  }

  for (const name of names) {
    try {
      await loadSection(name, mount);
    } catch (e) {
      console.error(`[app] section "${name}" failed:`, e);
    }
  }

  installAnchorScroll();
  app.setAttribute('aria-busy', 'false');
  document.dispatchEvent(new CustomEvent('app:ready'));
  window.__APP_READY__ = true;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
