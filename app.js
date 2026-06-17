'use strict';

/* ---------- Helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, props = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return node;
};
const esc = (s) => String(s ?? '');
const enc = encodeURIComponent;

const TYPE_LABELS = { food: 'Food', sight: 'Sight', transit: 'Transit', hotel: 'Hotel', summit: 'Summit' };

/* ---------- Group state ---------- */
// view: 'all' | 1 | 2
let DATA = null;
let VIEW = 'all';

function parseView() {
  const params = new URLSearchParams(location.search);
  const g = params.get('group');
  if (g === '1') return 1;
  if (g === '2') return 2;
  return 'all';
}
// Does an entry (with .groups array) belong in the current view?
function inView(entry) {
  if (VIEW === 'all') return true;
  const groups = entry && entry.groups;
  if (!Array.isArray(groups)) return true; // no group tag = applies to everyone
  return groups.includes(VIEW);
}
// Is this entry split (applies to only one group)? Used for badging in "Everyone" view.
function isSplit(entry) {
  const g = entry && entry.groups;
  return Array.isArray(g) && g.length === 1;
}

/* ---------- Maps / link builders ---------- */
function mapsSearchUrl(place) {
  if (place && place.lat != null && place.lng != null) {
    return `https://www.google.com/maps/search/?api=1&query=${place.lat},${place.lng}`;
  }
  const addr = place && place.address ? place.address : (place && place.name) || '';
  return `https://www.google.com/maps/search/?api=1&query=${enc(addr)}`;
}
function directionsUrl(destination) {
  return `https://www.google.com/maps/dir/?api=1&destination=${enc(destination)}&travelmode=transit`;
}
function telUrl(phone) {
  return 'tel:' + String(phone).replace(/[^\d+]/g, '');
}

/* Build a multi-stop Google Maps route through an ordered list of places.
   Uses lat,lng when available, else the URL-encoded address. */
function dayRouteUrl(places) {
  if (!places.length) return null;
  const pt = (p) => (p.lat != null && p.lng != null) ? `${p.lat},${p.lng}` : enc(p.address || p.name || '');
  const base = 'https://www.google.com/maps/dir/?api=1&travelmode=transit';
  if (places.length === 1) return `${base}&destination=${pt(places[0])}`;
  const origin = pt(places[0]);
  const destination = pt(places[places.length - 1]);
  const mid = places.slice(1, -1).map(pt); // api=1 supports up to 9 waypoints
  let url = `${base}&origin=${origin}&destination=${destination}`;
  if (mid.length) url += `&waypoints=${mid.join('|')}`;
  return url;
}

/* Pick a sensible destination for a route's "Directions" button. */
function routeDestination(route) {
  const title = (route.title || '').toLowerCase();
  const byKey = [
    ['jfk', 'JFK Airport Terminal 4, Queens, NY'],
    ['gapstow', 'Gapstow Bridge, Central Park, New York, NY'],
    ['rockefeller', '45 Rockefeller Plaza, New York, NY 10111'],
    ['times', 'Times Square, New York, NY 10036'],
    ['tryp', 'TRYP by Wyndham, W 36th St, New York, NY'],
    ['levain', '167 W 74th St, New York, NY 10023'],
    ['food crawl', '79 Chrystie St, New York, NY 10002'],
    ['holiday inn', 'Holiday Inn Express, Long Island City, NY'],
    ['lic', 'Court Sq, Long Island City, NY'],
  ];
  for (const [kw, addr] of byKey) {
    if (title.includes(kw)) return addr;
  }
  const steps = route.steps || [];
  return steps.length ? steps[steps.length - 1] : (route.title || 'New York, NY');
}

function typePill(type) {
  const label = TYPE_LABELS[type] || type || 'Item';
  return el('span', { class: `pill t-${type || 'transit'}` },
    el('span', { class: `dot d-${type || 'transit'}` }), label);
}
function groupPill(n) {
  return el('span', { class: `pill grp grp-${n}` }, 'Group ' + n);
}

/* ---------- Group toggle + banner ---------- */
function setView(next, push = true) {
  VIEW = next;
  // update URL
  const url = new URL(location.href);
  if (next === 'all') url.searchParams.delete('group');
  else url.searchParams.set('group', String(next));
  if (push) history.replaceState(null, '', url);
  // re-render
  render();
  // reflect toggle state
  document.querySelectorAll('.gtoggle button').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === String(next));
  });
}

function renderToggle() {
  const bar = $('#group-toggle');
  bar.innerHTML = '';
  const groups = DATA.groups || {};
  const opts = [
    { view: 'all', label: 'Everyone' },
    { view: '1', label: groups['1'] ? 'Group 1' : 'Group 1' },
    { view: '2', label: groups['2'] ? 'Group 2' : 'Group 2' },
  ];
  const wrap = el('div', { class: 'gtoggle' },
    opts.map((o) =>
      el('button', {
        type: 'button',
        'data-view': o.view,
        class: String(VIEW) === o.view ? 'active' : '',
        onclick: () => setView(o.view === 'all' ? 'all' : Number(o.view)),
      }, o.label)));
  bar.append(wrap);
}

function groupBanner() {
  if (VIEW === 'all') return null;
  const g = (DATA.groups || {})[String(VIEW)];
  if (!g) return null;
  return el('div', { class: `gbanner gbanner-${VIEW}` },
    el('div', { class: 'gb-name' }, g.name || ('Group ' + VIEW)),
    g.departure ? el('div', { class: 'gb-dep' }, '🛫 Departs: ' + g.departure) : null,
    g.description ? el('div', { class: 'gb-desc' }, g.description) : null);
}

/* ---------- Renderers ---------- */
function renderOverview() {
  const data = DATA;
  const t = data.trip;
  const root = $('#overview');
  root.innerHTML = '';

  const banner = groupBanner();
  if (banner) root.append(banner);

  root.append(
    el('div', { class: 'section-head' },
      el('span', { class: 'eyebrow' }, 'Your trip')),
    el('div', { class: 'hero' },
      el('h1', {}, t.title),
      el('div', { class: 'dates' }, t.dates),
      t.travelers && el('div', { class: 'travelers' }, t.travelers))
  );

  // Flights
  const f = t.flights || {};
  root.append(el('div', { class: 'card' },
    el('h3', {}, '✈️ Flights'),
    el('div', { class: 'flight-grid' },
      f.arrival && el('div', { class: 'flight' },
        el('div', { class: 'tag' }, 'Arrival · ' + (f.arrival.date || '')),
        el('div', { class: 'route' }, `${f.arrival.from} → ${f.arrival.to}`),
        el('div', { class: 'times' }, `${f.arrival.depart} – ${f.arrival.arrive}`),
        f.arrival.aircraft && el('div', { class: 'times' }, f.arrival.aircraft)),
      f.departure && el('div', { class: 'flight' },
        el('div', { class: 'tag' }, 'Departure · ' + (f.departure.date || '')),
        el('div', { class: 'route' }, `${f.departure.from} → ${f.departure.to}`),
        el('div', { class: 'times' }, `${f.departure.depart} – ${f.departure.arrive}`),
        f.departure.aircraft && el('div', { class: 'times' }, f.departure.aircraft)))
  ));

  // Hotels
  const hotelCard = el('div', { class: 'card' }, el('h3', {}, '🏨 Hotels'));
  (t.hotels || []).forEach((h) => {
    hotelCard.append(
      el('div', { class: 'kv' }, el('span', { class: 'k' }, h.nights || ''),
        el('span', { class: 'v' },
          el('strong', {}, h.name), h.area ? el('div', { class: 'tl-sub' }, h.area) : null))
    );
  });
  root.append(hotelCard);

  // Summit venue
  const s = t.summit;
  if (s) {
    root.append(el('div', { class: 'card' },
      el('h3', {}, '🎤 ' + (s.name || 'Summit')),
      el('div', { class: 'meta' }, el('strong', {}, s.venue || ''), s.address ? ' · ' + s.address : ''),
      s.nearest_stations && s.nearest_stations.length
        ? el('div', { class: 'tl-sub', style: 'margin-top:6px' }, '🚇 ' + s.nearest_stations.join(' · '))
        : null,
      el('div', { class: 'btn-row' },
        s.address && el('a', { class: 'btn btn-teal', href: mapsSearchUrl({ address: s.address }), target: '_blank', rel: 'noopener' }, '📍 Open in Maps'),
        s.phone && el('a', { class: 'btn btn-ghost', href: telUrl(s.phone) }, '📞 ' + s.phone))
    ));
  }

  // Payment notes
  if (t.payment_notes && t.payment_notes.length) {
    root.append(
      el('div', { class: 'notebox' },
        el('div', { class: 'nb-title' }, '💳 Transit & payment'),
        el('ul', {}, t.payment_notes.map((n) => el('li', {}, n))))
    );
  }
}

function renderSchedule() {
  const data = DATA;
  const root = $('#schedule');
  root.innerHTML = '';
  root.append(el('div', { class: 'section-head' },
    el('span', { class: 'eyebrow' }, 'Itinerary'),
    el('h2', {}, 'Day by Day')));

  (data.schedule || []).forEach((day) => {
    const items = (day.items || []).filter(inView);
    // In single-group view, hide a day entirely if it has no items for this group
    // (keep summit-only days only if summit exists AND group present that day).
    const dayGroups = day.groups_present;
    const dayApplies = VIEW === 'all' || !Array.isArray(dayGroups) || dayGroups.includes(VIEW);
    if (VIEW !== 'all' && !items.length && !(day.summit && day.summit.length && dayApplies)) return;

    const dayId = 'day-' + (day.day || '').toLowerCase();
    const card = el('div', { class: 'card day-card', id: dayId, 'data-date': day.date || '' });

    card.append(
      el('div', { class: 'day-head' },
        el('div', {},
          el('span', { class: 'day-name' }, day.day || ''),
          day.group_present ? el('span', { class: 'badge-group', style: 'margin-left:8px' }, 'Group') : null),
        el('span', { class: 'day-date' }, day.date || '')),
      day.theme && el('div', { class: 'day-theme' }, day.theme)
    );

    // "Map all stops" — multi-stop Google Maps route through the day's places, in time order
    const dayPlaces = items
      .filter((it) => it.place_ref && data.places[it.place_ref])
      .map((it) => data.places[it.place_ref]);
    if (dayPlaces.length >= 2) {
      card.append(el('div', { class: 'btn-row' },
        el('a', {
          class: 'btn btn-day',
          href: dayRouteUrl(dayPlaces),
          target: '_blank',
          rel: 'noopener',
        }, `🗺️ Map all ${dayPlaces.length} stops`)));
    }

    // Summit block (only when present & relevant)
    if (day.summit && day.summit.length && dayApplies) {
      card.append(
        el('div', { class: 'subhead' }, 'Summit schedule'),
        el('div', { class: 'summit-block' },
          day.summit.map((row) =>
            el('div', { class: 'summit-row' },
              el('span', { class: 'st' }, row.time || ''),
              el('span', {}, row.label || ''))))
      );
    }

    // Personal itinerary (filtered)
    if (items.length) {
      card.append(el('div', { class: 'subhead' }, 'Itinerary'));
      const tl = el('ul', { class: 'timeline' });
      items.forEach((item) => {
        const place = item.place_ref ? data.places[item.place_ref] : null;
        const route = item.route_ref ? data.routes[item.route_ref] : null;
        const type = item.type || 'transit';

        const tags = el('div', { class: 'tl-tags' }, typePill(type));
        // In "Everyone" view, badge split items so it's clear who does what.
        if (VIEW === 'all' && isSplit(item)) tags.append(groupPill(item.groups[0]));

        let link = null;
        if (place) {
          link = el('a', { class: 'tl-link', href: mapsSearchUrl(place), target: '_blank', rel: 'noopener' }, '📍 ' + place.name + ' →');
        } else if (route) {
          link = el('a', { class: 'tl-link', href: '#route-' + item.route_ref }, '🚇 ' + route.title + ' →');
        }

        tl.append(
          el('li', { class: 'tl-item' + (VIEW === 'all' && isSplit(item) ? ' tl-split g' + item.groups[0] : '') },
            el('div', { class: 'tl-time' }, item.time || ''),
            el('div', { class: 'tl-rail' }, el('span', { class: `dot d-${type}` })),
            el('div', { class: 'tl-body' },
              el('div', { class: 'tl-act' }, item.activity || ''),
              place && place.when ? el('div', { class: 'tl-sub' }, place.when) : null,
              tags,
              link))
        );
      });
      card.append(tl);
    }

    root.append(card);
  });
}

function renderPlaces() {
  const data = DATA;
  const root = $('#places');
  root.innerHTML = '';
  root.append(el('div', { class: 'section-head' },
    el('span', { class: 'eyebrow' }, 'Where to go'),
    el('h2', {}, 'Places')));

  // Which places are referenced by items in the current view?
  let visiblePlaceKeys = null;
  if (VIEW !== 'all') {
    visiblePlaceKeys = new Set();
    (data.schedule || []).forEach((day) =>
      (day.items || []).filter(inView).forEach((it) => {
        if (it.place_ref) visiblePlaceKeys.add(it.place_ref);
      }));
  }

  const groups = {
    food: { title: '🍜 Food', items: [] },
    sight: { title: '🏙️ Sights', items: [] },
  };
  Object.entries(data.places || {}).forEach(([key, p]) => {
    if (visiblePlaceKeys && !visiblePlaceKeys.has(key)) return;
    const cat = p.category === 'sight' ? 'sight' : 'food';
    groups[cat].items.push(p);
  });

  let any = false;
  Object.values(groups).forEach((group) => {
    if (!group.items.length) return;
    any = true;
    root.append(el('div', { class: 'cat-title' }, group.title,
      el('span', { class: 'tl-sub', style: 'font-weight:600' }, `(${group.items.length})`)));
    group.items.forEach((p) => root.append(placeCard(p)));
  });
  if (!any) root.append(el('div', { class: 'tl-sub', style: 'padding:8px 2px' }, 'No places for this group view.'));
}

function placeCard(p) {
  const card = el('div', { class: 'card place-card' });
  card.append(
    el('div', { class: 'place-top' },
      el('div', {}, el('h3', {}, p.name), p.price ? el('span', { class: 'meta' }, p.price) : null),
      p.when ? el('div', { class: 'place-when' }, p.when) : null)
  );
  if (p.address) card.append(el('div', { class: 'kv' }, el('span', { class: 'k' }, 'Where'), el('span', { class: 'v' }, p.address)));
  if (p.hours) card.append(el('div', { class: 'kv' }, el('span', { class: 'k' }, 'Hours'), el('span', { class: 'v' }, p.hours)));
  if (p.order) card.append(el('div', { class: 'place-order' }, el('b', {}, 'Order: '), p.order));
  if (p.notes) card.append(el('div', { class: 'place-notes' }, p.notes));
  card.append(
    el('div', { class: 'btn-row' },
      el('a', { class: 'btn btn-teal', href: mapsSearchUrl(p), target: '_blank', rel: 'noopener' }, '📍 Open in Maps'),
      p.phone ? el('a', { class: 'btn btn-ghost', href: telUrl(p.phone) }, '📞 Call') : null)
  );
  return card;
}

function renderRoutes() {
  const data = DATA;
  const root = $('#routes');
  root.innerHTML = '';
  root.append(el('div', { class: 'section-head' },
    el('span', { class: 'eyebrow' }, 'Getting around'),
    el('h2', {}, 'Train Routes')));

  let any = false;
  Object.entries(data.routes || {}).forEach(([key, r]) => {
    if (!inView(r)) return;
    any = true;
    const dest = routeDestination(r);
    const titleRow = el('h3', {}, '🚇 ' + (r.title || key));
    const card = el('div', { class: 'card route-card', id: 'route-' + key, style: 'scroll-margin-top:80px' },
      titleRow,
      VIEW === 'all' && isSplit(r) ? el('div', { style: 'margin:2px 0 4px' }, groupPill(r.groups[0])) : null,
      el('div', { class: 'route-meta' },
        r.when && el('span', { class: 'chip' }, '🕑 ' + r.when),
        r.cost && el('span', { class: 'chip' }, '💵 ' + r.cost),
        r.duration && el('span', { class: 'chip' }, '⏱️ ' + r.duration)),
      el('ol', { class: 'steps' }, (r.steps || []).map((s) => el('li', {}, s))),
      r.note && el('div', { class: 'route-note' }, '💡 ' + r.note),
      el('div', { class: 'btn-row' },
        el('a', { class: 'btn btn-teal', href: directionsUrl(dest), target: '_blank', rel: 'noopener' }, '🧭 Directions'))
    );
    root.append(card);
  });
  if (!any) root.append(el('div', { class: 'tl-sub', style: 'padding:8px 2px' }, 'No routes for this group view.'));
}

function renderHighlights() {
  const data = DATA;
  const root = $('#highlights');
  root.innerHTML = '';
  const list = (data.group_highlights || []).filter(inView);
  if (!list.length) return;
  root.append(el('div', { class: 'section-head' },
    el('span', { class: 'eyebrow' }, 'First-timer must-sees'),
    el('h2', {}, 'Group Highlights')));

  list.forEach((h, i) => {
    root.append(
      el('div', { class: 'card hl-card' },
        el('div', { class: 'hl-num' }, String(i + 1)),
        el('div', {},
          el('h3', {}, h.sight),
          h.when ? el('div', { class: 'tl-sub', style: 'font-weight:700;color:var(--teal-dark)' }, h.when) : null,
          h.note ? el('div', { class: 'place-notes' }, h.note) : null))
    );
  });
}

/* ---------- Nav: scroll spy + Today ---------- */
function setupNav() {
  const links = Array.from(document.querySelectorAll('.bottomnav a'));
  const sections = links.map((a) => document.getElementById(a.dataset.nav)).filter(Boolean);
  if (window.__spy) window.__spy.disconnect();
  const spy = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) {
        const id = e.target.id;
        links.forEach((a) => a.classList.toggle('active', a.dataset.nav === id));
      }
    });
  }, { rootMargin: '-45% 0px -50% 0px', threshold: 0 });
  sections.forEach((s) => spy.observe(s));
  window.__spy = spy;
}

function setupToday() {
  const data = DATA;
  const days = data.schedule || [];
  const monthMap = { january:0,february:1,march:2,april:3,may:4,june:5,july:6,august:7,september:8,october:9,november:10,december:11 };
  function parseTripDate(dateStr) {
    const m = String(dateStr).trim().match(/([A-Za-z]+)\s+(\d+)/);
    if (!m) return null;
    const mon = monthMap[m[1].toLowerCase()];
    if (mon == null) return null;
    return new Date(2026, mon, parseInt(m[2], 10));
  }
  const now = new Date();
  const todayKey = now.getFullYear() * 10000 + now.getMonth() * 100 + now.getDate();
  let exactCard = null, fallbackCard = null;
  days.forEach((day) => {
    const d = parseTripDate(day.date);
    if (!d) return;
    const key = d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate();
    const card = document.getElementById('day-' + (day.day || '').toLowerCase());
    if (!card) return;
    if (key === todayKey) exactCard = card;
    if (!fallbackCard && key >= todayKey) fallbackCard = card;
  });
  if (exactCard) {
    exactCard.classList.add('is-today');
    const head = exactCard.querySelector('.day-head > div');
    if (head && !head.querySelector('.today-tag')) head.append(el('span', { class: 'today-tag', style: 'margin-left:8px' }, 'Today'));
  }
  const target = exactCard || fallbackCard || (days.length ? document.getElementById('day-' + (days[0].day || '').toLowerCase()) : null);
  const btn = $('#today-btn');
  btn.onclick = () => {
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else document.getElementById('schedule').scrollIntoView({ behavior: 'smooth' });
  };
}

/* ---------- Render all ---------- */
function render() {
  document.body.classList.toggle('view-group', VIEW !== 'all');
  document.body.setAttribute('data-view', String(VIEW));
  renderToggle();
  renderOverview();
  renderSchedule();
  renderPlaces();
  renderRoutes();
  renderHighlights();
  setupNav();
  setupToday();
}

/* ---------- Boot ---------- */
async function boot() {
  try {
    const res = await fetch('./trip-data.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    DATA = await res.json();
    VIEW = parseView();

    if (DATA.trip) {
      if (DATA.trip.title) $('#brand-title').textContent = DATA.trip.title;
      if (DATA.trip.dates) $('#brand-dates').textContent = DATA.trip.dates;
      document.title = (DATA.trip.title || 'Trip') + ' · ' + (DATA.trip.dates || '');
    }

    $('#loading').remove();
    render();

    // sync if user navigates back/forward
    window.addEventListener('popstate', () => { VIEW = parseView(); render(); });
  } catch (err) {
    const loading = $('#loading');
    if (loading) {
      loading.innerHTML = '⚠️ Could not load <code>trip-data.json</code>.<br>' +
        'Serve this folder over HTTP (e.g. <code>python3 -m http.server</code>) and reload.<br>' +
        '<small style="color:#888">' + esc(err.message) + '</small>';
      loading.style.color = '#b01e54';
    }
    console.error(err);
  }
}

document.addEventListener('DOMContentLoaded', boot);
