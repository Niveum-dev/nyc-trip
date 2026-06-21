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

/* ---------- i18n ---------- */
let LANG = 'en';
// Translate a string; falls back to English (the original) when missing.
function t(s) {
  if (LANG === 'es' && s != null && window.I18N_ES && window.I18N_ES[s] != null) return window.I18N_ES[s];
  return s;
}
function parseLang() {
  const l = new URLSearchParams(location.search).get('lang');
  return l === 'es' ? 'es' : 'en';
}

const TYPE_LABELS = { food: 'Food', sight: 'Sight', transit: 'Transit', hotel: 'Hotel', summit: 'Summit' };

/* ---------- Group state ---------- */
let DATA = null;
let VIEW = 'all'; // 'all' | 1 | 2

function parseView() {
  const g = new URLSearchParams(location.search).get('group');
  if (g === '1') return 1;
  if (g === '2') return 2;
  return 'all';
}
function inView(entry) {
  if (VIEW === 'all') return true;
  const groups = entry && entry.groups;
  if (!Array.isArray(groups)) return true;
  return groups.includes(VIEW);
}
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

/* Transit directions for a single leg (point A -> point B). */
function legPoint(p) {
  return (p.lat != null && p.lng != null) ? `${p.lat},${p.lng}` : enc(p.q || p.address || p.name || '');
}
function legDirectionsUrl(from, to) {
  return `https://www.google.com/maps/dir/?api=1&origin=${legPoint(from)}&destination=${legPoint(to)}&travelmode=transit`;
}

/* Named non-place location nodes (airport, hotels, summit venue) used to
   build complete door-to-door leg chains alongside the food/sight places. */
const NODES = {
  jfk:     { key: 'jfk',     name: 'JFK Terminal 4',         q: 'JFK Airport Terminal 4, Queens, NY 11430' },
  lic:     { key: 'lic',     name: 'Holiday Inn Express LIC', q: 'Holiday Inn Express Long Island City, 39-32 27th St, Long Island City, NY 11101' },
  tryp:    { key: 'tryp',    name: 'TRYP by Wyndham',         q: 'TRYP by Wyndham Times Square South, 345 W 35th St, New York, NY 10001' },
  melrose: { key: 'melrose', name: 'Melrose Ballroom',        q: 'Melrose Ballroom, 36-08 33rd St, Long Island City, NY 11106' },
};
// The Holiday Inn shuttle picks up / drops off at this 7-train station.
const SHUTTLE_STOP = { key: 'shuttle_stop', name: 'Vernon Blvd-Jackson Av (7)', q: 'Vernon Blvd-Jackson Av Subway Station, Long Island City, NY 11101' };
// True if this node is a hotel that offers a shuttle (only Holiday Inn LIC).
function hotelHasShuttle(node) {
  return !!node && node.key === 'lic' && (DATA.trip.hotels || []).some((h) => h.shuttle && /holiday inn/i.test(h.name));
}

// Where each route leg starts — used to seed the first stop of a chain
// (e.g. the evening tours start at the summit; Sunday starts at TRYP).
const ROUTE_ORIGIN = {
  jfk_to_lic: NODES.jfk,
  melrose_to_timessq: NODES.melrose,
  melrose_to_wtc: NODES.melrose,
  melrose_to_gapstow: NODES.melrose,
  lic_to_jfk_group: NODES.lic,
  lic_to_tryp: NODES.lic,
  food_crawl: NODES.tryp,
  tryp_to_jfk: NODES.tryp,
};

function placeNode(ref) {
  const p = DATA.places[ref];
  if (!p) return null;
  return { key: 'place:' + ref, name: p.name, lat: p.lat, lng: p.lng, q: p.address };
}
// Resolve a physical location for a schedule item, or null for pure
// movement steps (e.g. "N/W to Times Square") whose endpoint is the next stop.
function nodeForItem(item) {
  if (item.place_ref && DATA.places[item.place_ref]) return placeNode(item.place_ref);
  const a = (item.activity || '').toLowerCase();
  if (item.type === 'hotel' || a.includes('holiday inn')) return a.includes('tryp') ? NODES.tryp : NODES.lic;
  if (item.type === 'summit' || a.includes('melrose')) return NODES.melrose;
  if (a.includes('jfk')) return NODES.jfk;
  if (a.includes('tryp')) return NODES.tryp;
  if (a.includes('to lic') || a.includes('back to lic')) return NODES.lic;
  return null;
}
function itemsForGroup(day, g) {
  return (day.items || []).filter((it) => !Array.isArray(it.groups) || it.groups.includes(g));
}
// Ordered, de-duplicated list of stops for one group on one day.
function buildChain(day, g) {
  const its = itemsForGroup(day, g);
  const nodes = [];
  for (const it of its) {
    const n = nodeForItem(it);
    if (n && (!nodes.length || nodes[nodes.length - 1].key !== n.key)) nodes.push(n);
  }
  const firstRouted = its.find((it) => it.route_ref && ROUTE_ORIGIN[it.route_ref]);
  if (firstRouted) {
    const o = ROUTE_ORIGIN[firstRouted.route_ref];
    if (nodes.length && nodes[0].key !== o.key) nodes.unshift(o);
  }
  return nodes;
}
function chainKey(nodes) { return nodes.map((n) => n.key).join('>'); }
function legAnchor(from, to) {
  return el('a', { class: 'leg', href: legDirectionsUrl(from, to), target: '_blank', rel: 'noopener' },
    el('span', { class: 'leg-route' }, t(from.name), el('span', { class: 'leg-arrow' }, ' → '), t(to.name)),
    el('span', { class: 'leg-go' }, t('Directions') + ' ›'));
}
// Optional shuttle directions for legs touching a hotel that has a shuttle.
function shuttleAltLink(origin, dest, label) {
  return el('a', { class: 'leg-alt', href: legDirectionsUrl(origin, dest), target: '_blank', rel: 'noopener' }, '🚐 ' + label + ' ›');
}
function legRow(from, to) {
  const main = legAnchor(from, to);
  const extras = [];
  if (hotelHasShuttle(to)) {
    extras.push(shuttleAltLink(from, SHUTTLE_STOP, t('Shuttle option: to') + ' ' + SHUTTLE_STOP.name + ' (' + t('call to schedule pickup') + ')'));
  }
  if (hotelHasShuttle(from)) {
    extras.push(shuttleAltLink(SHUTTLE_STOP, to, t('Shuttle option: continue from') + ' ' + SHUTTLE_STOP.name));
  }
  if (!extras.length) return main;
  return el('div', { class: 'leg-wrap' }, main, ...extras);
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
  for (const [kw, addr] of byKey) if (title.includes(kw)) return addr;
  const steps = route.steps || [];
  return steps.length ? steps[steps.length - 1] : (route.title || 'New York, NY');
}

function typePill(type) {
  const label = t(TYPE_LABELS[type] || type || 'Item');
  return el('span', { class: `pill t-${type || 'transit'}` },
    el('span', { class: `dot d-${type || 'transit'}` }), label);
}
function groupPill(n) {
  return el('span', { class: `pill grp grp-${n}` }, t('Group') + ' ' + n);
}

/* ---------- Toggles ---------- */
function setView(next) {
  VIEW = next;
  const url = new URL(location.href);
  if (next === 'all') url.searchParams.delete('group');
  else url.searchParams.set('group', String(next));
  history.replaceState(null, '', url);
  render();
}
function setLang(next) {
  LANG = next;
  document.documentElement.lang = next;
  const url = new URL(location.href);
  if (next === 'en') url.searchParams.delete('lang');
  else url.searchParams.set('lang', next);
  history.replaceState(null, '', url);
  render();
}

function renderToggle() {
  const bar = $('#group-toggle');
  bar.innerHTML = '';
  const opts = [
    { view: 'all', label: t('Everyone') },
    { view: '1', label: t('Group') + ' 1' },
    { view: '2', label: t('Group') + ' 2' },
  ];
  bar.append(el('div', { class: 'gtoggle' },
    opts.map((o) =>
      el('button', {
        type: 'button',
        'data-view': o.view,
        class: String(VIEW) === o.view ? 'active' : '',
        onclick: () => setView(o.view === 'all' ? 'all' : Number(o.view)),
      }, o.label))));
}

function renderLangToggle() {
  const bar = $('#lang-toggle');
  if (!bar) return;
  bar.innerHTML = '';
  const opts = [{ lang: 'en', label: 'EN' }, { lang: 'es', label: 'ES' }];
  bar.append(el('div', { class: 'langtoggle', role: 'group', 'aria-label': 'Language' },
    opts.map((o) =>
      el('button', {
        type: 'button',
        'data-lang': o.lang,
        class: LANG === o.lang ? 'active' : '',
        onclick: () => setLang(o.lang),
      }, o.label))));
}

function groupBanner() {
  if (VIEW === 'all') return null;
  const g = (DATA.groups || {})[String(VIEW)];
  if (!g) return null;
  return el('div', { class: `gbanner gbanner-${VIEW}` },
    el('div', { class: 'gb-name' }, t(g.name) || (t('Group') + ' ' + VIEW)),
    g.departure ? el('div', { class: 'gb-dep' }, '🛫 ' + t('Departs:') + ' ' + t(g.departure)) : null,
    g.description ? el('div', { class: 'gb-desc' }, t(g.description)) : null);
}

/* ---------- Renderers ---------- */
function renderOverview() {
  const t_ = DATA.trip;
  const root = $('#overview');
  root.innerHTML = '';

  const banner = groupBanner();
  if (banner) root.append(banner);

  root.append(
    el('div', { class: 'section-head' }, el('span', { class: 'eyebrow' }, t('Your trip'))),
    el('div', { class: 'hero' },
      el('h1', {}, t(t_.title)),
      el('div', { class: 'dates' }, t(t_.dates)),
      t_.travelers && el('div', { class: 'travelers' }, t(t_.travelers)))
  );

  const f = t_.flights || {};
  root.append(el('div', { class: 'card' },
    el('h3', {}, '✈️ ' + t('Flights')),
    el('div', { class: 'flight-grid' },
      f.arrival && el('div', { class: 'flight' },
        el('div', { class: 'tag' }, t('Arrival') + ' · ' + t(f.arrival.date || '')),
        el('div', { class: 'route' }, `${f.arrival.from} → ${f.arrival.to}`),
        el('div', { class: 'times' }, `${f.arrival.depart} – ${f.arrival.arrive}`),
        f.arrival.flight && el('div', { class: 'times' }, '✈ ' + f.arrival.flight),
        f.arrival.gate && el('div', { class: 'times' }, '🚪 ' + t(f.arrival.gate)),
        f.arrival.aircraft && el('div', { class: 'times' }, f.arrival.aircraft)),
      f.departure && el('div', { class: 'flight' },
        el('div', { class: 'tag' }, t('Departure') + ' · ' + t(f.departure.date || '')),
        el('div', { class: 'route' }, `${f.departure.from} → ${f.departure.to}`),
        el('div', { class: 'times' }, `${f.departure.depart} – ${f.departure.arrive}`),
        f.departure.flight && el('div', { class: 'times' }, '✈ ' + f.departure.flight),
        f.departure.gate && el('div', { class: 'times' }, '🚪 ' + t(f.departure.gate)),
        f.departure.aircraft && el('div', { class: 'times' }, f.departure.aircraft)))
  ));

  const hotelCard = el('div', { class: 'card' }, el('h3', {}, '🏨 ' + t('Hotels')));
  (t_.hotels || []).forEach((h) => {
    const block = el('div', { class: 'hotel-block' },
      el('div', { class: 'kv' }, el('span', { class: 'k' }, t(h.nights || '')),
        el('span', { class: 'v' },
          el('strong', {}, h.name), h.area ? el('div', { class: 'tl-sub' }, t(h.area)) : null)));
    const s = h.shuttle;
    if (s) {
      block.append(el('div', { class: 'shuttle' },
        el('div', { class: 'shuttle-title' }, '🚐 ' + t('Free shuttle') + ' · ' + h.name),
        s.hours ? el('div', { class: 'shuttle-row' }, '🕑 ' + t(s.hours)) : null,
        s.stop ? el('div', { class: 'shuttle-row' }, '📍 ' + t(s.stop)) : null,
        s.note ? el('div', { class: 'shuttle-note' }, t(s.note)) : null,
        s.phone ? el('a', { class: 'btn btn-teal', href: telUrl(s.phone), style: 'margin-top:10px' },
          '📞 ' + t('Call for pickup') + ' · ' + s.phone) : null));
    }
    hotelCard.append(block);
  });
  root.append(hotelCard);

  const s = t_.summit;
  if (s) {
    root.append(el('div', { class: 'card' },
      el('h3', {}, '🎤 ' + (s.name || 'Summit')),
      el('div', { class: 'meta' }, el('strong', {}, s.venue || ''), s.address ? ' · ' + s.address : ''),
      s.nearest_stations && s.nearest_stations.length
        ? el('div', { class: 'tl-sub', style: 'margin-top:6px' }, '🚇 ' + s.nearest_stations.map(t).join(' · '))
        : null,
      el('div', { class: 'btn-row' },
        s.address && el('a', { class: 'btn btn-teal', href: mapsSearchUrl({ address: s.address }), target: '_blank', rel: 'noopener' }, '📍 ' + t('Open in Maps')),
        s.phone && el('a', { class: 'btn btn-ghost', href: telUrl(s.phone) }, '📞 ' + s.phone))
    ));
  }

  if (t_.payment_notes && t_.payment_notes.length) {
    root.append(
      el('div', { class: 'notebox' },
        el('div', { class: 'nb-title' }, '💳 ' + t('Transit & payment')),
        el('ul', {}, t_.payment_notes.map((n) => el('li', {}, t(n)))))
    );
  }
}

function renderSchedule() {
  const data = DATA;
  const root = $('#schedule');
  root.innerHTML = '';
  root.append(el('div', { class: 'section-head' },
    el('span', { class: 'eyebrow' }, t('Itinerary')),
    el('h2', {}, t('Day by Day'))));

  (data.schedule || []).forEach((day) => {
    const items = (day.items || []).filter(inView);
    const dayGroups = day.groups_present;
    const dayApplies = VIEW === 'all' || !Array.isArray(dayGroups) || dayGroups.includes(VIEW);
    if (VIEW !== 'all' && !items.length && !(day.summit && day.summit.length && dayApplies)) return;

    const dayId = 'day-' + (day.day || '').toLowerCase();
    const card = el('div', { class: 'card day-card', id: dayId, 'data-date': day.date || '' });

    card.append(
      el('div', { class: 'day-head' },
        el('div', {},
          el('span', { class: 'day-name' }, t(day.day || '')),
          day.group_present ? el('span', { class: 'badge-group', style: 'margin-left:8px' }, t('Group')) : null),
        el('span', { class: 'day-date' }, t(day.date || ''))),
      day.theme && el('div', { class: 'day-theme' }, t(day.theme))
    );

    // Door-to-door train directions: one A->B leg per hop, including the JFK
    // arrival and each group's departure. Split per group on days that diverge.
    let groupsSet;
    if (VIEW !== 'all') {
      groupsSet = [VIEW];
    } else {
      const s = new Set();
      (day.items || []).forEach((it) => (Array.isArray(it.groups) ? it.groups : [1, 2]).forEach((g) => s.add(g)));
      groupsSet = [...s].sort();
      if (!groupsSet.length) groupsSet = [1];
    }
    let chains = groupsSet.map((g) => ({ g, nodes: buildChain(day, g) })).filter((c) => c.nodes.length >= 2);
    if (chains.length > 1 && chains.every((c) => chainKey(c.nodes) === chainKey(chains[0].nodes))) {
      chains = [chains[0]]; // identical for every group -> show once, unlabeled
    }
    if (chains.length) {
      const wrap = el('div', { class: 'day-legs' },
        el('div', { class: 'subhead' }, '🚆 ' + t('Train directions between stops')));
      const labelEach = chains.length > 1;
      chains.forEach((c) => {
        if (labelEach) wrap.append(el('div', { class: 'leg-group-label grp-' + c.g }, t('Group') + ' ' + c.g));
        for (let i = 0; i < c.nodes.length - 1; i++) wrap.append(legRow(c.nodes[i], c.nodes[i + 1]));
      });
      card.append(wrap);
    }

    if (day.summit && day.summit.length && dayApplies) {
      card.append(
        el('div', { class: 'subhead' }, t('Summit schedule')),
        el('div', { class: 'summit-block' },
          day.summit.map((row) =>
            el('div', { class: 'summit-row' },
              el('span', { class: 'st' }, row.time || ''),
              el('span', {}, t(row.label || '')))))
      );
    }

    if (items.length) {
      card.append(el('div', { class: 'subhead' }, t('Itinerary')));
      const tl = el('ul', { class: 'timeline' });
      items.forEach((item) => {
        const place = item.place_ref ? data.places[item.place_ref] : null;
        const route = item.route_ref ? data.routes[item.route_ref] : null;
        const type = item.type || 'transit';

        const tags = el('div', { class: 'tl-tags' }, typePill(type));
        if (VIEW === 'all' && isSplit(item)) tags.append(groupPill(item.groups[0]));

        let link = null;
        if (place) {
          link = el('a', { class: 'tl-link', href: mapsSearchUrl(place), target: '_blank', rel: 'noopener' }, '📍 ' + place.name + ' →');
        } else if (route) {
          link = el('a', { class: 'tl-link', href: '#route-' + item.route_ref }, '🚇 ' + t(route.title) + ' →');
        }

        tl.append(
          el('li', { class: 'tl-item' + (VIEW === 'all' && isSplit(item) ? ' tl-split g' + item.groups[0] : '') },
            el('div', { class: 'tl-time' }, item.time || ''),
            el('div', { class: 'tl-rail' }, el('span', { class: `dot d-${type}` })),
            el('div', { class: 'tl-body' },
              el('div', { class: 'tl-act' }, t(item.activity || '')),
              place && place.when ? el('div', { class: 'tl-sub' }, t(place.when)) : null,
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
    el('span', { class: 'eyebrow' }, t('Where to go')),
    el('h2', {}, t('Places'))));

  let visiblePlaceKeys = null;
  if (VIEW !== 'all') {
    visiblePlaceKeys = new Set();
    (data.schedule || []).forEach((day) =>
      (day.items || []).filter(inView).forEach((it) => {
        if (it.place_ref) visiblePlaceKeys.add(it.place_ref);
      }));
  }

  const groups = {
    food: { title: '🍜 ' + t('Food'), items: [] },
    sight: { title: '🏙️ ' + t('Sights'), items: [] },
  };
  Object.entries(data.places || {}).forEach(([key, p]) => {
    if (visiblePlaceKeys && !visiblePlaceKeys.has(key)) return;
    (p.category === 'sight' ? groups.sight : groups.food).items.push(p);
  });

  let any = false;
  Object.values(groups).forEach((group) => {
    if (!group.items.length) return;
    any = true;
    root.append(el('div', { class: 'cat-title' }, group.title,
      el('span', { class: 'tl-sub', style: 'font-weight:600' }, `(${group.items.length})`)));
    group.items.forEach((p) => root.append(placeCard(p)));
  });
  if (!any) root.append(el('div', { class: 'tl-sub', style: 'padding:8px 2px' }, t('No places for this group view.')));
}

function placeCard(p) {
  const card = el('div', { class: 'card place-card' });
  card.append(
    el('div', { class: 'place-top' },
      el('div', {}, el('h3', {}, p.name), p.price ? el('span', { class: 'meta' }, t(p.price)) : null),
      p.when ? el('div', { class: 'place-when' }, t(p.when)) : null)
  );
  if (p.address) card.append(el('div', { class: 'kv' }, el('span', { class: 'k' }, t('Where')), el('span', { class: 'v' }, p.address)));
  if (p.hours) card.append(el('div', { class: 'kv' }, el('span', { class: 'k' }, t('Hours')), el('span', { class: 'v' }, t(p.hours))));
  if (p.order) card.append(el('div', { class: 'place-order' }, el('b', {}, t('Order:') + ' '), t(p.order)));
  if (p.notes) card.append(el('div', { class: 'place-notes' }, t(p.notes)));
  card.append(
    el('div', { class: 'btn-row' },
      el('a', { class: 'btn btn-teal', href: mapsSearchUrl(p), target: '_blank', rel: 'noopener' }, '📍 ' + t('Open in Maps')),
      p.phone ? el('a', { class: 'btn btn-ghost', href: telUrl(p.phone) }, '📞 ' + t('Call')) : null)
  );
  return card;
}

function renderRoutes() {
  const data = DATA;
  const root = $('#routes');
  root.innerHTML = '';
  root.append(el('div', { class: 'section-head' },
    el('span', { class: 'eyebrow' }, t('Getting around')),
    el('h2', {}, t('Train Routes'))));

  let any = false;
  Object.entries(data.routes || {}).forEach(([key, r]) => {
    if (!inView(r)) return;
    any = true;
    const dest = routeDestination(r);
    const card = el('div', { class: 'card route-card', id: 'route-' + key, style: 'scroll-margin-top:80px' },
      el('h3', {}, '🚇 ' + t(r.title || key)),
      VIEW === 'all' && isSplit(r) ? el('div', { style: 'margin:2px 0 4px' }, groupPill(r.groups[0])) : null,
      el('div', { class: 'route-meta' },
        r.when && el('span', { class: 'chip' }, '🕑 ' + t(r.when)),
        r.cost && el('span', { class: 'chip' }, '💵 ' + r.cost),
        r.duration && el('span', { class: 'chip' }, '⏱️ ' + r.duration)),
      el('ol', { class: 'steps' }, (r.steps || []).map((s) => el('li', {}, t(s)))),
      r.note && el('div', { class: 'route-note' }, '💡 ' + t(r.note)),
      el('div', { class: 'btn-row' },
        el('a', { class: 'btn btn-teal', href: directionsUrl(dest), target: '_blank', rel: 'noopener' }, '🧭 ' + t('Directions')))
    );
    root.append(card);
  });
  if (!any) root.append(el('div', { class: 'tl-sub', style: 'padding:8px 2px' }, t('No routes for this group view.')));
}

function renderHighlights() {
  const data = DATA;
  const root = $('#highlights');
  root.innerHTML = '';
  const list = (data.group_highlights || []).filter(inView);
  if (!list.length) return;
  root.append(el('div', { class: 'section-head' },
    el('span', { class: 'eyebrow' }, t('First-timer must-sees')),
    el('h2', {}, t('Group Highlights'))));

  list.forEach((h, i) => {
    root.append(
      el('div', { class: 'card hl-card' },
        el('div', { class: 'hl-num' }, String(i + 1)),
        el('div', {},
          el('h3', {}, t(h.sight)),
          h.when ? el('div', { class: 'tl-sub', style: 'font-weight:700;color:var(--teal-dark)' }, t(h.when)) : null,
          h.note ? el('div', { class: 'place-notes' }, t(h.note)) : null))
    );
  });
}

/* ---------- Chrome (nav labels, brand, Today button) ---------- */
const NAV_LABELS = { overview: 'Overview', schedule: 'Schedule', places: 'Places', routes: 'Routes', highlights: 'Group' };
function applyChrome() {
  if (DATA && DATA.trip) {
    if (DATA.trip.title) $('#brand-title').textContent = t(DATA.trip.title);
    if (DATA.trip.dates) $('#brand-dates').textContent = t(DATA.trip.dates);
    document.title = (t(DATA.trip.title) || 'Trip') + ' · ' + (t(DATA.trip.dates) || '');
  }
  const tb = $('#today-btn');
  if (tb) tb.textContent = t('Today');
  document.querySelectorAll('.bottomnav a').forEach((a) => {
    const label = a.querySelector('.nav-label');
    if (label && NAV_LABELS[a.dataset.nav]) label.textContent = t(NAV_LABELS[a.dataset.nav]);
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
  const days = DATA.schedule || [];
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
    if (head && !head.querySelector('.today-tag')) head.append(el('span', { class: 'today-tag', style: 'margin-left:8px' }, t('Today')));
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
  applyChrome();
  renderLangToggle();
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
    LANG = parseLang();
    document.documentElement.lang = LANG;

    $('#loading').remove();
    render();

    window.addEventListener('popstate', () => { VIEW = parseView(); LANG = parseLang(); render(); });
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
