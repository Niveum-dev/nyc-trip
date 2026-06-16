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

/* Pick a sensible destination for a route's "Directions" button. */
function routeDestination(route, places) {
  // Try to find a place referenced in the title; else use last step's address-ish text.
  const title = (route.title || '').toLowerCase();
  for (const p of Object.values(places)) {
    if (p.name && title.includes(p.name.toLowerCase().split(' ')[0]) && p.address) {
      // weak match; prefer explicit below
    }
  }
  // Heuristic by known keywords -> address
  const byKey = [
    ['jfk', 'JFK Airport Terminal 4, Queens, NY'],
    ['gapstow', 'Gapstow Bridge, Central Park, New York, NY'],
    ['rockefeller', '45 Rockefeller Plaza, New York, NY 10111'],
    ['times', 'Times Square, New York, NY 10036'],
    ['tryp', 'TRYP by Wyndham, W 36th St, New York, NY'],
    ['levain', '167 W 74th St, New York, NY 10023'],
    ['holiday inn', 'Holiday Inn Express, Long Island City, NY'],
    ['lic', 'Court Sq, Long Island City, NY'],
  ];
  for (const [kw, addr] of byKey) {
    if (title.includes(kw)) return addr;
  }
  // Fallback: last step text
  const steps = route.steps || [];
  return steps.length ? steps[steps.length - 1] : (route.title || 'New York, NY');
}

function typePill(type) {
  const label = TYPE_LABELS[type] || type || 'Item';
  return el('span', { class: `pill t-${type || 'transit'}` },
    el('span', { class: `dot d-${type || 'transit'}` }), label);
}

/* ---------- Renderers ---------- */
function renderOverview(data) {
  const t = data.trip;
  const root = $('#overview');
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
  const flightCard = el('div', { class: 'card' },
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
  );
  root.append(flightCard);

  // Hotels
  const hotels = t.hotels || [];
  const hotelCard = el('div', { class: 'card' }, el('h3', {}, '🏨 Hotels'));
  hotels.forEach((h) => {
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
    const summitCard = el('div', { class: 'card' },
      el('h3', {}, '🎤 ' + (s.name || 'Summit')),
      el('div', { class: 'meta' }, el('strong', {}, s.venue || ''), s.address ? ' · ' + s.address : ''),
      s.nearest_stations && s.nearest_stations.length
        ? el('div', { class: 'tl-sub', style: 'margin-top:6px' }, '🚇 ' + s.nearest_stations.join(' · '))
        : null,
      el('div', { class: 'btn-row' },
        s.address && el('a', { class: 'btn btn-teal', href: mapsSearchUrl({ address: s.address }), target: '_blank', rel: 'noopener' }, '📍 Open in Maps'),
        s.phone && el('a', { class: 'btn btn-ghost', href: telUrl(s.phone) }, '📞 ' + s.phone))
    );
    root.append(summitCard);
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

function renderSchedule(data) {
  const root = $('#schedule');
  root.append(el('div', { class: 'section-head' },
    el('span', { class: 'eyebrow' }, 'Itinerary'),
    el('h2', {}, 'Day by Day')));

  (data.schedule || []).forEach((day) => {
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

    // Summit block
    if (day.summit && day.summit.length) {
      const sb = el('div', {},
        el('div', { class: 'subhead' }, 'Summit schedule'),
        el('div', { class: 'summit-block' },
          day.summit.map((row) =>
            el('div', { class: 'summit-row' },
              el('span', { class: 'st' }, row.time || ''),
              el('span', {}, row.label || '')))));
      card.append(sb);
    }

    // Personal itinerary
    if (day.items && day.items.length) {
      card.append(el('div', { class: 'subhead' }, 'Itinerary'));
      const tl = el('ul', { class: 'timeline' });
      day.items.forEach((item) => {
        const place = item.place_ref ? data.places[item.place_ref] : null;
        const route = item.route_ref ? data.routes[item.route_ref] : null;
        const type = item.type || 'transit';

        const tags = el('div', { class: 'tl-tags' }, typePill(type));

        let link = null;
        if (place) {
          link = el('a', { class: 'tl-link', href: mapsSearchUrl(place), target: '_blank', rel: 'noopener' }, '📍 ' + place.name + ' →');
        } else if (route) {
          link = el('a', { class: 'tl-link', href: '#route-' + item.route_ref }, '🚇 ' + route.title + ' →');
        }

        tl.append(
          el('li', { class: 'tl-item' },
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

function renderPlaces(data) {
  const root = $('#places');
  root.append(el('div', { class: 'section-head' },
    el('span', { class: 'eyebrow' }, 'Where to go' ),
    el('h2', {}, 'Places')));

  const entries = Object.entries(data.places || {});
  const groups = {
    food: { title: '🍜 Food', items: [] },
    sight: { title: '🏙️ Sights', items: [] },
  };
  entries.forEach(([key, p]) => {
    const cat = p.category === 'sight' ? 'sight' : 'food';
    groups[cat].items.push(p);
  });

  Object.values(groups).forEach((group) => {
    if (!group.items.length) return;
    root.append(el('div', { class: 'cat-title' }, group.title,
      el('span', { class: 'tl-sub', style: 'font-weight:600' }, `(${group.items.length})`)));
    group.items.forEach((p) => root.append(placeCard(p)));
  });
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

function renderRoutes(data) {
  const root = $('#routes');
  root.append(el('div', { class: 'section-head' },
    el('span', { class: 'eyebrow' }, 'Getting around'),
    el('h2', {}, 'Train Routes')));

  Object.entries(data.routes || {}).forEach(([key, r]) => {
    const dest = routeDestination(r, data.places || {});
    const card = el('div', { class: 'card route-card', id: 'route-' + key, style: 'scroll-margin-top:80px' },
      el('h3', {}, '🚇 ' + (r.title || key)),
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
}

function renderHighlights(data) {
  const root = $('#highlights');
  const list = data.group_highlights || [];
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

  const spy = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) {
        const id = e.target.id;
        links.forEach((a) => a.classList.toggle('active', a.dataset.nav === id));
      }
    });
  }, { rootMargin: '-45% 0px -50% 0px', threshold: 0 });
  sections.forEach((s) => spy.observe(s));
}

function setupToday(data) {
  const btn = $('#today-btn');
  const days = data.schedule || [];

  // Build date -> element map. Trip is June 18-21, 2026.
  const monthMap = { january:0,february:1,march:2,april:3,may:4,june:5,july:6,august:7,september:8,october:9,november:10,december:11 };
  function parseTripDate(dateStr) {
    // e.g. "June 18"
    const m = String(dateStr).trim().match(/([A-Za-z]+)\s+(\d+)/);
    if (!m) return null;
    const mon = monthMap[m[1].toLowerCase()];
    if (mon == null) return null;
    return new Date(2026, mon, parseInt(m[2], 10));
  }

  function findTodayCard() {
    const now = new Date();
    const todayKey = now.getFullYear() * 10000 + now.getMonth() * 100 + now.getDate();
    let best = null;
    days.forEach((day) => {
      const d = parseTripDate(day.date);
      if (!d) return;
      const key = d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate();
      const card = document.getElementById('day-' + (day.day || '').toLowerCase());
      if (!card) return;
      if (key === todayKey) best = { card, exact: true };
      // if no exact match yet, track the first upcoming day
      if (!best && key >= todayKey) best = { card, exact: false };
    });
    // mark today's card
    if (best && best.exact) best.card.classList.add('is-today');
    return best ? best.card : (days.length ? document.getElementById('day-' + (days[0].day || '').toLowerCase()) : null);
  }

  const todayCard = findTodayCard();
  // Add a "Today" tag to the matching card header
  const marked = document.querySelector('.day-card.is-today .day-head > div');
  if (marked) marked.append(el('span', { class: 'today-tag', style: 'margin-left:8px' }, 'Today'));

  btn.addEventListener('click', () => {
    const target = document.querySelector('.day-card.is-today') || todayCard;
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else document.getElementById('schedule').scrollIntoView({ behavior: 'smooth' });
  });
}

/* ---------- Boot ---------- */
async function boot() {
  try {
    const res = await fetch('./trip-data.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();

    // brand
    if (data.trip) {
      if (data.trip.title) $('#brand-title').textContent = data.trip.title;
      if (data.trip.dates) $('#brand-dates').textContent = data.trip.dates;
      document.title = (data.trip.title || 'Trip') + ' · ' + (data.trip.dates || '');
    }

    $('#loading').remove();
    renderOverview(data);
    renderSchedule(data);
    renderPlaces(data);
    renderRoutes(data);
    renderHighlights(data);
    setupNav();
    setupToday(data);
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
