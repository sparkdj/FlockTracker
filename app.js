(function () {
  "use strict";

  const OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
  ];

  const DEFAULT_RADIUS = 8000;
  const CACHE_TTL_MS = 5 * 60 * 1000;
  const DEBOUNCE_MS = 600;
  const FALLBACK_CENTER = [39.8283, -98.5795]; // continental US

  const el = {
    map: document.getElementById("map"),
    status: document.getElementById("status"),
    radius: document.getElementById("radius"),
    refresh: document.getElementById("btn-refresh"),
    locate: document.getElementById("btn-locate"),
    toggleList: document.getElementById("btn-toggle-list"),
    sheet: document.getElementById("sheet"),
    list: document.getElementById("camera-list"),
    empty: document.getElementById("list-empty"),
    count: document.getElementById("camera-count"),
  };

  /** @type {L.Map} */
  let map;
  /** @type {L.Marker|null} */
  let userMarker = null;
  /** @type {L.Circle|null} */
  let searchCircle = null;
  /** @type {L.LayerGroup} */
  let cameraLayer;
  /** @type {{lat:number, lon:number}|null} */
  let userPos = null;
  /** @type {Array<object>} */
  let cameras = [];
  let debounceTimer = null;
  let abortController = null;
  const cache = new Map();

  function setStatus(message, kind) {
    el.status.textContent = message;
    el.status.classList.remove("hidden", "error", "ok");
    if (kind) el.status.classList.add(kind);
  }

  function hideStatusSoon() {
    window.setTimeout(function () {
      el.status.classList.add("hidden");
    }, 2200);
  }

  function haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = Math.PI / 180;
    const dLat = (lat2 - lat1) * toRad;
    const dLon = (lon2 - lon1) * toRad;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function formatDistance(m) {
    if (m < 1000) return Math.round(m) + " m";
    return (m / 1000).toFixed(m < 10000 ? 1 : 0) + " km";
  }

  function isFlock(tags) {
    if (!tags) return false;
    const blob = [
      tags.manufacturer,
      tags.brand,
      tags.operator,
      tags.name,
      tags["operator:wikidata"],
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return blob.includes("flock");
  }

  function cameraLabel(tags) {
    if (!tags) return "ALPR camera";
    if (isFlock(tags)) return "Flock Safety ALPR";
    if (tags.manufacturer) return tags.manufacturer + " ALPR";
    if (tags.brand) return tags.brand + " ALPR";
    if (tags.operator) return tags.operator + " ALPR";
    if (tags.name) return tags.name;
    return "ALPR camera";
  }

  function buildOverpassQuery(lat, lon, radius) {
    // Common OSM tagging for license-plate / ALPR cameras
    return [
      "[out:json][timeout:30];",
      "(",
      '  node["man_made"="surveillance"]["surveillance:type"="ALPR"](around:' + radius + "," + lat + "," + lon + ");",
      '  way["man_made"="surveillance"]["surveillance:type"="ALPR"](around:' + radius + "," + lat + "," + lon + ");",
      '  node["man_made"="surveillance"]["surveillance:type"="alpr"](around:' + radius + "," + lat + "," + lon + ");",
      '  way["man_made"="surveillance"]["surveillance:type"="alpr"](around:' + radius + "," + lat + "," + lon + ");",
      '  node["man_made"="surveillance"]["surveillance:type"="ANPR"](around:' + radius + "," + lat + "," + lon + ");",
      '  way["man_made"="surveillance"]["surveillance:type"="ANPR"](around:' + radius + "," + lat + "," + lon + ");",
      '  node["man_made"="surveillance"]["surveillance:type"="anpr"](around:' + radius + "," + lat + "," + lon + ");",
      '  node["man_made"="surveillance"]["surveillance:type"="license_plate_recognition"](around:' + radius + "," + lat + "," + lon + ");",
      '  way["man_made"="surveillance"]["surveillance:type"="license_plate_recognition"](around:' + radius + "," + lat + "," + lon + ");",
      '  node["camera:type"="ALPR"](around:' + radius + "," + lat + "," + lon + ");",
      '  node["camera:type"="alpr"](around:' + radius + "," + lat + "," + lon + ");",
      '  node["camera:type"="ANPR"](around:' + radius + "," + lat + "," + lon + ");",
      '  node["manufacturer"="Flock Safety"](around:' + radius + "," + lat + "," + lon + ");",
      '  node["brand"="Flock Safety"](around:' + radius + "," + lat + "," + lon + ");",
      ");",
      "out center tags;",
    ].join("\n");
  }

  function cacheKey(lat, lon, radius) {
    return lat.toFixed(3) + "," + lon.toFixed(3) + "," + radius;
  }

  function getCached(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > CACHE_TTL_MS) {
      cache.delete(key);
      return null;
    }
    return hit.data;
  }

  function setCached(key, data) {
    cache.set(key, { at: Date.now(), data: data });
  }

  async function fetchOverpass(query) {
    let lastError = null;
    for (let i = 0; i < OVERPASS_ENDPOINTS.length; i++) {
      if (abortController) abortController.abort();
      abortController = new AbortController();
      try {
        const res = await fetch(OVERPASS_ENDPOINTS[i], {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
          body: "data=" + encodeURIComponent(query),
          signal: abortController.signal,
        });
        if (!res.ok) {
          lastError = new Error("Overpass HTTP " + res.status);
          continue;
        }
        return await res.json();
      } catch (err) {
        if (err && err.name === "AbortError") throw err;
        lastError = err;
      }
    }
    throw lastError || new Error("Overpass request failed");
  }

  function elementCoords(el) {
    if (el.type === "node" && typeof el.lat === "number" && typeof el.lon === "number") {
      return { lat: el.lat, lon: el.lon };
    }
    if (el.center && typeof el.center.lat === "number") {
      return { lat: el.center.lat, lon: el.center.lon };
    }
    return null;
  }

  function normalizeElements(elements, origin) {
    const seen = new Set();
    const out = [];
    for (let i = 0; i < elements.length; i++) {
      const raw = elements[i];
      const coords = elementCoords(raw);
      if (!coords) continue;
      const key = raw.type + "/" + raw.id;
      if (seen.has(key)) continue;
      seen.add(key);
      const tags = raw.tags || {};
      const dist = origin
        ? haversineMeters(origin.lat, origin.lon, coords.lat, coords.lon)
        : null;
      out.push({
        id: key,
        lat: coords.lat,
        lon: coords.lon,
        tags: tags,
        flock: isFlock(tags),
        label: cameraLabel(tags),
        distance: dist,
      });
    }
    out.sort(function (a, b) {
      if (a.distance == null) return 1;
      if (b.distance == null) return -1;
      return a.distance - b.distance;
    });
    return out;
  }

  function markerIcon(flock) {
    return L.divIcon({
      className: "",
      html: '<div class="cam-marker' + (flock ? " flock" : "") + '"></div>',
      iconSize: flock ? [16, 16] : [14, 14],
      iconAnchor: flock ? [8, 8] : [7, 7],
      popupAnchor: [0, -8],
    });
  }

  function userIcon() {
    return L.divIcon({
      className: "",
      html: '<div class="user-marker"></div>',
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    });
  }

  function popupHtml(cam) {
    const tags = cam.tags;
    const rows = [];
    if (tags.manufacturer) rows.push("<div class=\"popup-row\">Manufacturer: " + escapeHtml(tags.manufacturer) + "</div>");
    if (tags.brand && tags.brand !== tags.manufacturer) {
      rows.push("<div class=\"popup-row\">Brand: " + escapeHtml(tags.brand) + "</div>");
    }
    if (tags.operator) rows.push("<div class=\"popup-row\">Operator: " + escapeHtml(tags.operator) + "</div>");
    if (tags["surveillance:type"]) {
      rows.push("<div class=\"popup-row\">Type: " + escapeHtml(tags["surveillance:type"]) + "</div>");
    }
    if (cam.distance != null) {
      rows.push("<div class=\"popup-row\">Distance: " + formatDistance(cam.distance) + "</div>");
    }
    rows.push("<div class=\"popup-row\">OSM: " + escapeHtml(cam.id) + "</div>");
    return (
      '<div class="popup-title' + (cam.flock ? " flock" : "") + '">' +
      escapeHtml(cam.label) +
      "</div>" +
      rows.join("")
    );
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderMarkers(list) {
    cameraLayer.clearLayers();
    for (let i = 0; i < list.length; i++) {
      const cam = list[i];
      const m = L.marker([cam.lat, cam.lon], { icon: markerIcon(cam.flock) });
      m.bindPopup(popupHtml(cam));
      m._flockCamId = cam.id;
      cameraLayer.addLayer(m);
    }
  }

  function renderList(list) {
    el.list.innerHTML = "";
    el.count.textContent = String(list.length);
    if (!list.length) {
      el.empty.classList.remove("hidden");
      return;
    }
    el.empty.classList.add("hidden");
    const frag = document.createDocumentFragment();
    for (let i = 0; i < list.length; i++) {
      const cam = list[i];
      const li = document.createElement("li");
      li.tabIndex = 0;
      li.setAttribute("role", "button");
      li.dataset.id = cam.id;
      li.innerHTML =
        '<span class="dot' + (cam.flock ? " flock" : "") + '" aria-hidden="true"></span>' +
        '<div class="cam-meta">' +
        '<div class="cam-title">' + escapeHtml(cam.label) + "</div>" +
        '<div class="cam-sub">' +
        escapeHtml(
          [cam.tags.operator, cam.tags.manufacturer, cam.tags["surveillance:type"]]
            .filter(Boolean)
            .filter(function (v, idx, arr) { return arr.indexOf(v) === idx; })
            .join(" · ") || "OpenStreetMap"
        ) +
        "</div></div>" +
        '<div class="cam-dist">' +
        (cam.distance != null ? formatDistance(cam.distance) : "—") +
        "</div>";
      li.addEventListener("click", function () {
        focusCamera(cam.id);
      });
      li.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          focusCamera(cam.id);
        }
      });
      frag.appendChild(li);
    }
    el.list.appendChild(frag);
  }

  function focusCamera(id) {
    const cam = cameras.find(function (c) { return c.id === id; });
    if (!cam) return;
    map.setView([cam.lat, cam.lon], Math.max(map.getZoom(), 16), { animate: true });
    cameraLayer.eachLayer(function (layer) {
      if (layer._flockCamId === id) layer.openPopup();
    });
    if (window.matchMedia("(max-width: 767px)").matches) {
      setSheetOpen(false);
    }
  }

  function updateSearchCircle(lat, lon, radius) {
    if (searchCircle) {
      searchCircle.setLatLng([lat, lon]);
      searchCircle.setRadius(radius);
    } else {
      searchCircle = L.circle([lat, lon], {
        radius: radius,
        color: "#38bdf8",
        weight: 1,
        fillColor: "#38bdf8",
        fillOpacity: 0.06,
        interactive: false,
      }).addTo(map);
    }
  }

  function setUserMarker(lat, lon) {
    if (userMarker) {
      userMarker.setLatLng([lat, lon]);
    } else {
      userMarker = L.marker([lat, lon], {
        icon: userIcon(),
        zIndexOffset: 1000,
        title: "Your location",
      }).addTo(map);
      userMarker.bindPopup("You are here");
    }
  }

  async function loadCameras(force) {
    if (!userPos) {
      setStatus("Waiting for location…", "error");
      return;
    }
    const radius = Number(el.radius.value) || DEFAULT_RADIUS;
    const key = cacheKey(userPos.lat, userPos.lon, radius);
    updateSearchCircle(userPos.lat, userPos.lon, radius);

    if (!force) {
      const cached = getCached(key);
      if (cached) {
        cameras = normalizeElements(cached, userPos);
        renderMarkers(cameras);
        renderList(cameras);
        setStatus(
          cameras.length
            ? "Showing " + cameras.length + " camera" + (cameras.length === 1 ? "" : "s") + " (cached)"
            : "No ALPR cameras in this radius",
          cameras.length ? "ok" : undefined
        );
        hideStatusSoon();
        return;
      }
    }

    setStatus("Querying OpenStreetMap Overpass…");
    try {
      const query = buildOverpassQuery(userPos.lat, userPos.lon, radius);
      const data = await fetchOverpass(query);
      const elements = (data && data.elements) || [];
      setCached(key, elements);
      cameras = normalizeElements(elements, userPos);
      renderMarkers(cameras);
      renderList(cameras);
      if (!cameras.length) {
        setStatus("No ALPR cameras tagged nearby in OSM", undefined);
      } else {
        setStatus(
          "Found " + cameras.length + " ALPR camera" + (cameras.length === 1 ? "" : "s"),
          "ok"
        );
      }
      hideStatusSoon();
    } catch (err) {
      if (err && err.name === "AbortError") return;
      console.error(err);
      setStatus("Could not reach Overpass. Try again in a moment.", "error");
    }
  }

  function scheduleLoad(force) {
    window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(function () {
      loadCameras(!!force);
    }, DEBOUNCE_MS);
  }

  function setSheetOpen(open) {
    el.sheet.classList.toggle("open", open);
    document.body.classList.toggle("sheet-open", open);
    el.toggleList.setAttribute("aria-expanded", open ? "true" : "false");
    el.toggleList.textContent = open ? "Map" : "List";
  }

  function initMap() {
    map = L.map(el.map, {
      zoomControl: false,
      attributionControl: true,
    }).setView(FALLBACK_CENTER, 4);

    L.control.zoom({ position: "bottomright" }).addTo(map);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);

    cameraLayer = L.layerGroup().addTo(map);
  }

  function requestLocation() {
    if (!navigator.geolocation) {
      setStatus("Geolocation is not supported in this browser.", "error");
      return;
    }
    setStatus("Locating you…");
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        userPos = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        setUserMarker(userPos.lat, userPos.lon);
        map.setView([userPos.lat, userPos.lon], 13);
        scheduleLoad(false);
      },
      function (err) {
        console.warn(err);
        let msg = "Location permission denied or unavailable.";
        if (err && err.code === 3) msg = "Location timed out. Try again.";
        setStatus(msg + " You can still pan the map, then tap ↻ after enabling location.", "error");
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
    );
  }

  function bindUi() {
    el.radius.addEventListener("change", function () {
      scheduleLoad(false);
    });
    el.refresh.addEventListener("click", function () {
      scheduleLoad(true);
    });
    el.locate.addEventListener("click", function () {
      if (userPos) {
        map.setView([userPos.lat, userPos.lon], Math.max(map.getZoom(), 13));
      }
      requestLocation();
    });
    el.toggleList.addEventListener("click", function () {
      setSheetOpen(!el.sheet.classList.contains("open"));
    });
    // Open sheet by default on larger screens (CSS already shows it)
    if (window.matchMedia("(min-width: 768px)").matches) {
      setSheetOpen(true);
    }
  }

  initMap();
  bindUi();
  requestLocation();
})();
