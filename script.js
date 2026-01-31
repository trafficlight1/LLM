// --- JS ЛОГІКА (БЕЗ ЗМІН ОСНОВНОГО ФУНКЦІОНАЛУ) ---
const WIDTH_ERROR = 2.0;    
const STEP_METERS = 50;     
const MAX_SEARCH_DIST = 40; 
const DENSITY_STEP = 10;
const BUILDING_SEARCH_RADIUS = 25;
const LVIV_BOUNDS = [[49.75, 23.85], [49.95, 24.15]];

let savedAreaId = null;
let savedStreetName = null;
let savedStreetGeoJSON = null;
// --- ГЛОБАЛЬНІ ЗМІННІ ---
let lastSimulatedPoints = []; // Тут зберігаємо результат роботи алгоритму
document.getElementById('harmonizeBtn').addEventListener('click', harmonizeLights);
let globalAnalysis = { avgWidth: 0, highwayType: 'residential', mountType: 'pole', colorTemp: '3000K' };
let map = null, darkLayer = null, lightLayer = null, mainLayer = null, crossingLayer = null, buildingLayer = null, lightsLayer = null;

function quickSearch(type, name) {
    // 1. Встановлюємо тип (Парк або Вулиця) у випадаючому списку
    const select = document.getElementById('streetPrefix');
    select.value = type;

    // 2. Вписуємо назву в поле вводу
    const input = document.getElementById('streetNamePart');
    input.value = name;

    // 3. Запускаємо основну функцію аналізу
    analyzeStreet();
}
function showMap() {
    document.getElementById('welcomeScreen').classList.add('hidden');
    setTimeout(() => {
        document.getElementById('mapContainer').classList.add('active');
        document.getElementById('bottomPanel').classList.add('active');
        if (!map) initMap();
    }, 300);
}
function initMap() {
    map = L.map('map', { maxBounds: LVIV_BOUNDS, maxBoundsViscosity: 1.0 }).setView([49.8419, 24.0315], 13);
    darkLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { attribution: '&copy; OSM contributors' });
    lightLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { attribution: '&copy; OSM contributors' });
    darkLayer.addTo(map);
    mainLayer = L.layerGroup().addTo(map);
    crossingLayer = L.layerGroup().addTo(map);
    buildingLayer = L.layerGroup().addTo(map);
    lightsLayer = L.layerGroup().addTo(map);
}

function updateStatus(msg, type = 'normal') {
    const statusDiv = document.getElementById('status');
    // statusDiv.style.display = 'inline-block'; // Закоментовано логікою CSS !important
    statusDiv.className = ''; 
    if (type === 'error') {
        statusDiv.innerHTML = `⚠️ ${msg}`;
        statusDiv.classList.add('error-msg');
    } else if (type === 'success') {
        statusDiv.innerHTML = `✅ ${msg}`;
        statusDiv.classList.add('success-msg');
    } else {
        statusDiv.innerHTML = `${msg}`;
    }
}

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchWithRetry(url, options, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url, options);
            const text = await response.text();
            if (text.trim().startsWith('<') && !text.includes('<osm')) throw new Error("API overloaded");
            return JSON.parse(text);
        } catch (err) {
            if (i === retries - 1) throw err;
            console.log(`Retry ${i+1}/${retries}...`);
            await wait(2500);
        }
    }
}

function resetMap() {
    if (mainLayer) mainLayer.clearLayers();
    if (buildingLayer) buildingLayer.clearLayers();
    if (crossingLayer) crossingLayer.clearLayers();
    if (lightsLayer) lightsLayer.clearLayers();
    
    savedStreetGeoJSON = null; 
    savedStreetName = null;
    lastSimulatedPoints = []; // Скидаємо збережені точки гармонізації

    // Ховаємо рекомендації
    document.getElementById('recommendations').style.display = 'none';
    
    // --- ВИПРАВЛЕННЯ ТУТ ---
    // Знаходимо групу кнопок
    const simGroup = document.getElementById('simGroup');
    if (simGroup) {
        simGroup.style.display = 'none';    // Ховаємо фізично
        simGroup.classList.remove('active'); // Скидаємо анімацію розширення
    }

    // Ховаємо інші кнопки
    document.getElementById('crossingsBtn').style.display = 'none';
    // -----------------------

    document.getElementById('suggestionsList').style.display = 'none'; 
    document.getElementById('mapContainer').classList.remove('active');
    document.getElementById('bottomPanel').classList.remove('active');
    document.getElementById('streetNamePart').value = '';
    
    setTimeout(() => { document.getElementById('welcomeScreen').classList.remove('hidden'); }, 300);
}

async function analyzeStreet() {
    const city = document.getElementById('cityInput').value;
    const namePart = document.getElementById('streetNamePart').value.trim();
    const btn = document.getElementById('analyzeBtn');

    // Перевірка, чи вибрав користувач "Парк"
    const typeEl = document.getElementById('streetPrefix');
    const isParkSearch = (typeEl && typeEl.value === 'Парк') || namePart.toLowerCase().includes('парк');
    
    if(!city || !namePart || namePart.length < 3) { alert("Перевірте введені дані"); return; }
    btn.disabled = true;
    showMap();
    await wait(400);
    updateStatus(`Шукаю ${isParkSearch ? "парк" : "вулицю"} "${namePart}"...`);

    try {
        const nominatimUrl = `https://nominatim.openstreetmap.org/search?city=${city}&format=json&limit=1`;
        const cityRes = await fetch(nominatimUrl);
        const cityData = await cityRes.json();
        if (cityData.length === 0) throw new Error("Місто не знайдено");
        savedAreaId = 3600000000 + parseInt(cityData[0].osm_id);

        let query = '';

        if (isParkSearch) {
            // --- ОНОВЛЕНИЙ ЗАПИТ ДЛЯ ПАРКУ (+PLAYGROUND) ---
            query = `
                [out:json][timeout:180][maxsize:20000000];
                area(${savedAreaId})->.searchArea;
                // 1. Шукаємо сам парк
                (
                  way["name"~"${namePart}", i]["leisure"="park"](area.searchArea);
                  relation["name"~"${namePart}", i]["leisure"="park"](area.searchArea);
                )->.parkGeom;
                .parkGeom map_to_area -> .parkArea;
                
                // 2. Шукаємо доріжки в парку
                (
                  way["highway"~"footway|path|pedestrian|cycleway|steps"](area.parkArea);
                )->.paths;

                // 3. Шукаємо майданчики (точки і полігони)
                (
                  node["leisure"="playground"](area.parkArea);
                  way["leisure"="playground"](area.parkArea);
                )->.playgrounds;

                .parkGeom out geom;
                .paths out geom;
                .playgrounds out geom;
            `;
        } else {
            // --- СТАРИЙ ЗАПИТ ДЛЯ ВУЛИЦІ ---
            query = `
                [out:json][timeout:180][maxsize:20000000];
                area(${savedAreaId})->.searchArea;
                (way["name"~"${namePart}", i]["highway"](area.searchArea);)->.street;
                (way["highway"~"footway|path|pedestrian|sidewalk"](around.street:${MAX_SEARCH_DIST + 20});)->.sidewalks;
                (way["building"](around.street:30);)->.buildings;
                .street out geom; .sidewalks out geom; .buildings out geom;
            `;
        }

        const data = await fetchWithRetry('https://overpass-api.de/api/interpreter', { method: 'POST', body: "data=" + encodeURIComponent(query) });
        if (!data.elements || data.elements.length === 0) throw new Error(isParkSearch ? "Парк або доріжки не знайдено." : "Вулиця не знайдена.");
        
        updateStatus("Аналіз геометрії...");
        
        if (isParkSearch) {
            setTimeout(() => { processParkGeometry(data, namePart); }, 100);
        } else {
            setTimeout(() => { processGeometry(data, namePart); }, 100);
        }

    } catch (error) {
        console.error(error);
        updateStatus(`Помилка: ${error.message}`, 'error');
    } finally { btn.disabled = false; }
}

function processParkGeometry(data, searchName) {
    const pathFeatures = [];
    const parkFeatures = [];
    const playgroundFeatures = []; // Масив для майданчиків
    let foundParkName = searchName;

    data.elements.forEach(el => {
        const tags = el.tags || {};
        
        // 1. Обробка точок (майданчики можуть бути точками)
        if (el.type === 'node' && tags.leisure === 'playground') {
            playgroundFeatures.push(turf.point([el.lon, el.lat], tags));
        }

        // 2. Обробка ліній/полігонів
        if (el.type === 'way' && el.geometry) {
            const coords = el.geometry.map(p => [p.lon, p.lat]);
            
            // Якщо це дитячий майданчик (полігон)
            if (tags.leisure === 'playground') {
                if (coords.length > 2) {
                     coords.push(coords[0]); // Замикаємо
                     playgroundFeatures.push(turf.polygon([coords], tags));
                }
            }
            // Якщо це межа парку
            else if (tags.leisure === 'park') {
                if (coords.length > 2) {
                     coords.push(coords[0]); 
                     parkFeatures.push(turf.polygon([coords], tags));
                }
                if (tags.name) foundParkName = tags.name;
            } 
            // Якщо це доріжка
            else if (tags.highway) {
                pathFeatures.push(turf.lineString(coords, tags));
            }
        }
    });

    if (pathFeatures.length === 0 && parkFeatures.length === 0) { 
        alert("Дані парку неповні."); 
        return;
    }

    savedStreetName = foundParkName;
    savedStreetGeoJSON = turf.featureCollection(pathFeatures);

    // Налаштування для парку
    globalAnalysis.avgWidth = 3.0;
    globalAnalysis.highwayType = 'park';
    globalAnalysis.mountType = 'pole';
    globalAnalysis.colorTemp = '3000K';

    // 1. Візуалізація меж парку (зелений пунктир)
    if(parkFeatures.length > 0) {
        L.geoJSON(turf.featureCollection(parkFeatures), { 
            style: { color: '#2ecc71', weight: 2, fillOpacity: 0.05, dashArray: '5, 5' } 
        }).addTo(mainLayer);
    }

    // 2. Візуалізація майданчиків (помаранчевий)
    if(playgroundFeatures.length > 0) {
        L.geoJSON(turf.featureCollection(playgroundFeatures), {
            pointToLayer: function (feature, latlng) {
                // Для точкових майданчиків - помаранчевий кружечок
                return L.circleMarker(latlng, {
                    radius: 8,
                    fillColor: "#03d3fc",
                    color: "#03d3fc",
                    weight: 1,
                    opacity: 1,
                    fillOpacity: 0.8
                });
            },
            style: { 
                color: '#03d3fc', 
                weight: 2, 
                fillColor: '#03d3fc', 
                fillOpacity: 0.5 
            },
            onEachFeature: function(feature, layer) {
                layer.bindPopup(`<div class="info-popup-row">⚽ <b>Дитячий майданчик</b></div>`);
            }
        }).addTo(mainLayer);
    }

    // 3. Візуалізація доріжок (жовті лінії)
    if (pathFeatures.length > 0) {
        L.geoJSON(savedStreetGeoJSON, {
            style: { color: '#f1c40f', weight: 3, opacity: 0.8 },
            onEachFeature: function(feature, layer) {
                layer.bindPopup(`<div class="info-popup-row"><span class="info-popup-label">Доріжка парку</span></div>`);
            }
        }).addTo(mainLayer);
    }

    // Фокусування карти
    // Об'єднуємо всі фічі (парк, доріжки, майданчики) щоб виставити правильний зум
    const allFeatures = [...parkFeatures, ...pathFeatures, ...playgroundFeatures];
    if (allFeatures.length > 0) {
        const bbox = turf.bbox(turf.featureCollection(allFeatures));
        map.fitBounds([[bbox[1], bbox[0]], [bbox[3], bbox[2]]]);
    }
    
    // UI оновлення
    const card = document.getElementById('recommendations');
    document.getElementById('rec-density').innerHTML = `— <small>(Парк)</small>`;
    document.getElementById('rec-temp').innerText = `3000K (Паркова зона)`;
    document.getElementById('rec-mount').innerText = `Паркові опори`;
    card.style.display = 'block';

    const simGroup = document.getElementById('simGroup');
    if (simGroup) {
        simGroup.style.display = 'flex';       // Робимо видимим
        simGroup.classList.remove('active');   // Гарантуємо, що кнопка "Harmonize" схована
    }
    // -----------------------

    document.getElementById('crossingsBtn').style.display = 'none'; 
    updateStatus(`Парк: ${foundParkName}. Майданчиків: ${playgroundFeatures.length}`, 'success');
}


function processGeometry(data, searchName) {
    const streetFeatures = [];
    const sidewalkFeatures = [];
    const buildingFeatures = [];
    let foundFullName = null;
    let streetMaxLanes = 0;
    let streetHighwayType = 'residential';
    let hasTrolleybus = false;
    const lowerSearch = searchName.toLowerCase();

    data.elements.forEach(el => {
        if (el.type === 'way' && el.geometry) {
            const coords = el.geometry.map(p => [p.lon, p.lat]);
            if (el.tags && el.tags.building) {
                if (coords.length > 2) { coords.push(coords[0]); buildingFeatures.push(turf.polygon([coords], el.tags)); }
                return;
            }
            const line = turf.lineString(coords, el.tags);
            const tags = el.tags || {};
            const elName = tags.name ? tags.name.toLowerCase() : "";
            const isStreet = elName.includes(lowerSearch) && tags.highway && !tags.highway.match(/footway|path|pedestrian|cycleway/);
            if (isStreet) {
                streetFeatures.push(line);
                if (!foundFullName) foundFullName = tags.name;
                if (tags.highway) streetHighwayType = tags.highway;
                if (tags.lanes) { const l = parseInt(tags.lanes); if (!isNaN(l) && l > streetMaxLanes) streetMaxLanes = l; }
                if (tags.trolley_wire === 'yes' || tags.trolleybus === 'yes') hasTrolleybus = true;
            } else if (tags.highway) { sidewalkFeatures.push(line); }
        }
    });

    if (streetFeatures.length === 0) { alert("Вулиця не знайдена."); return; }
    savedStreetName = foundFullName;
    savedStreetGeoJSON = turf.featureCollection(streetFeatures);
    const density = calculateDensity(streetFeatures, buildingFeatures);

    let totalWidth = 0, measurements = 0;
    streetFeatures.forEach(streetLine => {
        const length = turf.length(streetLine, {units: 'meters'});
        for (let dist = 10; dist < length - 10; dist += STEP_METERS) {
            const pointOnStreet = turf.along(streetLine, dist, {units: 'meters'});
            const pointAhead = turf.along(streetLine, dist + 5, {units: 'meters'});
            const streetBearing = turf.bearing(pointOnStreet, pointAhead);
            let leftP = null, rightP = null;
            let minL = MAX_SEARCH_DIST, minR = MAX_SEARCH_DIST;
            sidewalkFeatures.forEach(sw => {
                const snapped = turf.nearestPointOnLine(sw, pointOnStreet, {units: 'meters'});
                const d = snapped.properties.dist;
                if (d > MAX_SEARCH_DIST || d < 2) return;
                const bearingToSW = turf.bearing(pointOnStreet, snapped);
                let rel = bearingToSW - streetBearing;
                while (rel < -180) rel += 360; while (rel > 180) rel -= 360;
                if (rel < -45 && rel > -135) { if (d < minL) { minL = d; leftP = snapped; } }
                else if (rel > 45 && rel < 135) { if (d < minR) { minR = d; rightP = snapped; } }
            });
            if (leftP && rightP) {
                const w = turf.distance(leftP, rightP, {units: 'meters'}) + WIDTH_ERROR;
                totalWidth += w; measurements++;
                const poly = L.polyline([[leftP.geometry.coordinates[1], leftP.geometry.coordinates[0]], [rightP.geometry.coordinates[1], rightP.geometry.coordinates[0]]], {color: '#e74c3c', weight: 2, opacity: 0.5});
                poly.bindPopup(`<div class="info-popup-row"><span class="info-popup-label">Розрахункова ширина:</span><b>${w.toFixed(2)} м</b></div>`);
                poly.addTo(mainLayer);
            }
        }
    });

    const avgWidth = measurements > 0 ? (totalWidth / measurements) : 8; 
    globalAnalysis.avgWidth = avgWidth;
    globalAnalysis.highwayType = streetHighwayType;
    let recs = generateRecommendationsData(streetHighwayType, streetMaxLanes, hasTrolleybus, density);
    globalAnalysis.mountType = recs.mountType; 
    globalAnalysis.colorTemp = recs.colorTemp;

    L.geoJSON(savedStreetGeoJSON, { 
        style: { color: '#3498db', weight: 5, opacity: 0.6 },
        onEachFeature: function(feature, layer) {
            let p = feature.properties;
            layer.bindPopup(`<div class="info-popup-row"><span class="info-popup-label">Вулиця:</span><b>${p.name || savedStreetName}</b></div>`);
        }
    }).addTo(mainLayer);

    if(buildingFeatures.length > 0) L.geoJSON(turf.featureCollection(buildingFeatures), { style: { color: '#555', weight: 1, fillOpacity: 0.1 } }).addTo(buildingLayer);
    const bbox = turf.bbox(savedStreetGeoJSON);
    map.fitBounds([[bbox[1], bbox[0]], [bbox[3], bbox[2]]]);
    
    const simGroup = document.getElementById('simGroup');
    if (simGroup) {
        simGroup.style.display = 'flex';       // Робимо видимим
        simGroup.classList.remove('active');   // Гарантуємо, що кнопка "Harmonize" схована
    }
    // -----------------------

    document.getElementById('crossingsBtn').style.display = 'block';
    updateStatus(`Додано: ${foundFullName}. Ширина: ${avgWidth.toFixed(1)}м`, 'success');
}

function calculateDensity(streetLines, buildingPolys) {
    if (buildingPolys.length === 0) return 0;
    const buildingPoints = buildingPolys.map(poly => turf.centroid(poly));
    let total = 0, double = 0;
    streetLines.forEach(line => {
        const len = turf.length(line, {units: 'meters'});
        for (let d = 5; d < len - 5; d += DENSITY_STEP) {
            total++;
            const p1 = turf.along(line, d, {units: 'meters'});
            const p2 = turf.along(line, d + 1, {units: 'meters'});
            const bearing = turf.bearing(p1, p2);
            let l = false, r = false;
            buildingPoints.forEach(bp => {
                if (turf.distance(p1, bp, {units: 'meters'}) <= BUILDING_SEARCH_RADIUS) {
                    let rel = turf.bearing(p1, bp) - bearing;
                    while (rel < -180) rel += 360; while (rel > 180) rel -= 360;
                    if (rel < 0) l = true; else r = true;
                }
            });
            if (l && r) double++;
        }
    });
    return total > 0 ? Math.round((double / total) * 100) : 0;
}

function generateRecommendationsData(type, lanes, trolley, density) {
    const card = document.getElementById('recommendations');
    let temp = "3000K", tempColor = "#ffb74d", reasonT = "Житлова вулиця";
    if (['primary', 'trunk'].includes(type)) { temp = "4000K"; tempColor = "#f5f5f5"; reasonT = "Магістраль"; }
    let mount = "Підвісне", mountCode = "suspended", usePoles = false;
    if (lanes > 3 || trolley || density < 30) usePoles = true;
    if (usePoles) { mount = "Опори"; mountCode = "pole"; }

    document.getElementById('rec-density').innerHTML = `${density}% <small>(Потрібно >30% для підвісу)</small>`;
    document.getElementById('rec-temp').innerText = `${temp} (${reasonT})`;
    document.getElementById('rec-mount').innerText = mount;
    card.style.display = 'block';
    return { mountType: mountCode, colorTemp: temp };
}

function preprocessDualCarriageways(features) {
    let processedFeatures = [], usedIndices = new Set();
    const MERGE_DIST = 25; 
    features.sort((a, b) => turf.length(b) - turf.length(a));
    for (let i = 0; i < features.length; i++) {
        if (usedIndices.has(i)) continue;
        const lineA = features[i];
        let foundPair = false;
        for (let j = i + 1; j < features.length; j++) {
            if (usedIndices.has(j)) continue;
            const lineB = features[j];
            const midA = turf.along(lineA, turf.length(lineA) / 2);
            const nearPointOnB = turf.nearestPointOnLine(lineB, midA);
            const dist = nearPointOnB.properties.dist * 1000; 
            if (dist < MERGE_DIST && dist > 4) {
                const medianLine = createMedianLine(lineA, lineB);
                if (medianLine) {
                    medianLine.properties.isMedian = true; 
                    processedFeatures.push(medianLine);
                    usedIndices.add(i); usedIndices.add(j);
                    foundPair = true; break; 
                }
            }
        }
        if (!foundPair) { processedFeatures.push(lineA); usedIndices.add(i); }
    }
    return processedFeatures;
}

function createMedianLine(line1, line2) {
    const coords = [], length = turf.length(line1), steps = Math.max(10, Math.floor(length / 10)); 
    for (let k = 0; k <= steps; k++) {
        const p1 = turf.along(line1, (length / steps) * k);
        const p2 = turf.nearestPointOnLine(line2, p1);
        const mid = turf.midpoint(p1, p2);
        coords.push(mid.geometry.coordinates);
    }
    if (coords.length > 1) return turf.lineString(coords);
    return null;
}

function drawDoubleArmLight(pos, r, color, height) { drawLightBase(pos, r, color); addInteractiveMarker(pos, "Дворіжкова опора", height); }
// --- НОВИЙ АЛГОРИТМ ДЛЯ ПАРКІВ (SMART GRID) ---
// --- ВДОСКОНАЛЕНИЙ АЛГОРИТМ "FLEXIBLE GRID" ---
// --- АЛГОРИТМ "ARCHITECTURAL MOOD" ---
// --- АЛГОРИТМ "ARCHITECTURAL TOPOLOGY" (Виправлений) ---
// --- АЛГОРИТМ "GLOBAL SPATIAL CHECK" ---
// --- АЛГОРИТМ "ARCHITECTURAL CLUSTERED" ---
function generateParkLighting(features) {
    // === НАЛАШТУВАННЯ ===
    const SPACING = 30;              // Крок між ліхтарями на алеях
    const JUNCTION_MERGE_DIST = 10;  // Якщо перехрестя ближче ніж 25м -> це ОДИН ліхтар
    const FILL_EXCLUSION = 20;       // Не ставити на алеї ближче ніж 20м до будь-якого ліхтаря

    let placedLights = []; // Глобальний список
    const pointHash = {};  
    const getKey = (coords) => `${coords[0].toFixed(5)},${coords[1].toFixed(5)}`;

    // === ЕТАП 1: ЗНАХОДИМО СИРІ ВУЗЛИ (ТОПОЛОГІЯ) ===
    let rawJunctions = [];

    features.forEach(f => {
        if (f.geometry.type !== 'LineString') return;
        const coords = f.geometry.coordinates;
        const startKey = getKey(coords[0]);
        const endKey = getKey(coords[coords.length - 1]);
        
        pointHash[startKey] = (pointHash[startKey] || 0) + 1;
        pointHash[endKey] = (pointHash[endKey] || 0) + 1;
    });

    Object.keys(pointHash).forEach(key => {
        const count = pointHash[key];
        // count !== 2 -> це тупик або перехрестя
        if (count !== 2) { 
            const [lng, lat] = key.split(',').map(Number);
            rawJunctions.push(turf.point([lng, lat]));
        }
    });

    // === ЕТАП 2: КЛАСТЕРИЗАЦІЯ ВУЗЛІВ (SMART MERGE) ===
    // Якщо вузлів немає, пропускаємо
    if (rawJunctions.length > 0) {
        const junctionCollection = turf.featureCollection(rawJunctions);
        
        // Використовуємо DBSCAN. maxDistance в кілометрах (25м = 0.025км)
        const clustered = turf.clustersDbscan(junctionCollection, JUNCTION_MERGE_DIST / 1000, {
            units: 'kilometers', 
            minPoints: 1 
        });

        // Групуємо результати
        const clusters = {}; // ID -> [points]
        const noise = [];

        clustered.features.forEach(f => {
            const clusterId = f.properties.cluster;
            if (clusterId !== undefined) {
                if (!clusters[clusterId]) clusters[clusterId] = [];
                clusters[clusterId].push(f);
            } else {
                noise.push(f); // Точки, що не мають близьких сусідів
            }
        });

        // 1. Додаємо одиночні вузли (які далеко від інших)
        noise.forEach(f => placedLights.push(f));

        // 2. Додаємо ЦЕНТРОЇДИ для груп
        Object.keys(clusters).forEach(id => {
            const clusterPoints = turf.featureCollection(clusters[id]);
            // Знаходимо центр мас групи перехресть
            const center = turf.center(clusterPoints);
            placedLights.push(center);
        });
    }

    // === ЕТАП 3: ЗАПОВНЕННЯ АЛЕЙ (З УРАХУВАННЯМ НОВИХ ЦЕНТРІВ) ===
    
    // Сортуємо: довгі алеї мають пріоритет
    const sortedFeatures = features.slice().sort((a, b) => turf.length(b) - turf.length(a));

    sortedFeatures.forEach(line => {
        const length = turf.length(line, {units: 'meters'});
        
        // Пропускаємо дуже короткі відрізки
        if (length < SPACING * 0.5) return;

        let spans = Math.round(length / SPACING);
        if (spans < 1) spans = 1;

        const actualStep = length / spans;

        for (let k = 1; k < spans; k++) {
            const dist = actualStep * k;
            const candidate = turf.along(line, dist, {units: 'meters'});

            // ПЕРЕВІРКА: Чи не занадто близько ми до БУДЬ-ЯКОГО вже поставленого ліхтаря?
            // (Це включає в себе і змерджені перехрестя, і ліхтарі на сусідніх алеях)
            let isTooClose = false;
            
            for (let existing of placedLights) {
                if (turf.distance(candidate, existing, {units: 'meters'}) < FILL_EXCLUSION) {
                    isTooClose = true;
                    break;
                }
            }

            if (!isTooClose) {
                placedLights.push(candidate);
            }
        }
    });

    return placedLights;
}

// Глобальна змінна для збереження результатів симуляції (для кнопки Harmonize)
// --- ОСНОВНА ФУНКЦІЯ СИМУЛЯЦІЇ ---
function simulateLighting() {
    // 1. Очищення карти перед малюванням
    if (map.hasLayer(lightLayer)) map.removeLayer(lightLayer);
    lightsLayer.clearLayers(); 
    
    // Очищаємо масив розміщених ліхтарів (локальний для вулиць, глобальний для збереження)
    let placedLights = []; 
    lastSimulatedPoints = []; // Скидаємо попередній результат гармонізації

    updateStatus(`Симуляція: генерація схеми освітлення...`);

    // --- РОЗГАЛУЖЕННЯ: ПАРК чи ВУЛИЦЯ? ---
    if (globalAnalysis.highwayType === 'park') {
        
        // >>> ЛОГІКА ДЛЯ ПАРКІВ (Архітектурний алгоритм) <<<
        const parkFeatures = savedStreetGeoJSON.features;
        
        // Викликаємо алгоритм розрахунку точок
        const smartPointsFeatures = generateParkLighting(parkFeatures);
        
        // Параметри для парку (Тепле світло, низькі опори)
        const H = 4.5;       
        const color = '#ffb74d'; 
        const visualRadius = 14; 

        // Малюємо точки
        smartPointsFeatures.forEach(feature => {
            drawLight(feature, visualRadius, color, 'pole', H);
        });

        // Зберігаємо для гармонізації
        lastSimulatedPoints = smartPointsFeatures;

        updateStatus(`Парк: розраховано ${smartPointsFeatures.length} точок (Архітектурний ритм).`, 'success');

    } else {
        // >>> ЛОГІКА ДЛЯ ВУЛИЦЬ (Стандартна інженерна) <<<
        const rawFeatures = savedStreetGeoJSON.features;
        const featuresToLight = preprocessDualCarriageways(rawFeatures);
        const COLLISION_THRESHOLD = 8;

        featuresToLight.forEach(feature => {
            const props = feature.properties;
            const length = turf.length(feature, {units: 'meters'});
            
            // Розрахунок параметрів вулиці
            let W = props.originalWidth || globalAnalysis.avgWidth || 8;
            let H, S, color;
            const isMedian = props.isMedian;
            
            // Визначення висоти та кроку
            if (globalAnalysis.mountType === 'suspended') { H = 8.0; } 
            else if (isMedian) { H = 10.0; } 
            else { H = Math.max(6, Math.min(10, W)); }
            
            let spacingRatio = (W < 8) ? 4.0 : 4.5;
            S = H * spacingRatio;
            if (isMedian) S = H * 4.0;
            else if (globalAnalysis.mountType === 'suspended') S = H * 3.5;
            
            color = globalAnalysis.colorTemp.includes('4000') ? '#eefaff' : '#ffb74d';
            let visualRadius = H * 1.7;

            // Цикл розстановки по вулиці
            for (let d = S / 2; d < length; d += S) {
                const centerP = turf.along(feature, d, {units: 'meters'});
                const nextP = turf.along(feature, d + 1, {units: 'meters'});
                const bearing = turf.bearing(centerP, nextP);
                
                let arrangement;
                const ratio = W / H;
                
                if (isMedian) arrangement = 'median_double';
                else if (globalAnalysis.mountType === 'suspended') arrangement = 'axis';
                else { 
                    if (ratio <= 1.0) arrangement = 'single'; 
                    else if (ratio <= 1.5) arrangement = 'staggered'; 
                    else arrangement = 'opposite'; 
                }

                const tryPlaceLight = (point, type) => {
                    if (!isTooClose(point, placedLights, COLLISION_THRESHOLD)) {
                        drawLight(point, visualRadius, color, type, H); 
                        placedLights.push(point);
                    }
                };
                const offsetDist = (W / 2) + 0.5;

                switch (arrangement) {
                    case 'median_double': 
                        drawDoubleArmLight(centerP, visualRadius, color, H); 
                        placedLights.push(centerP); 
                        break;
                    case 'axis': 
                        tryPlaceLight(centerP, 'suspended'); 
                        break;
                    case 'single': 
                        tryPlaceLight(turf.destination(centerP, offsetDist / 1000, bearing + 90, {units: 'kilometers'}), 'pole'); 
                        break;
                    case 'staggered': 
                        tryPlaceLight(turf.destination(centerP, offsetDist / 1000, bearing + ((Math.floor(d/S) % 2 === 0) ? 90 : -90), {units: 'kilometers'}), 'pole'); 
                        break;
                    case 'opposite':
                        tryPlaceLight(turf.destination(centerP, offsetDist / 1000, bearing - 90, {units: 'kilometers'}), 'pole');
                        tryPlaceLight(turf.destination(centerP, offsetDist / 1000, bearing + 90, {units: 'kilometers'}), 'pole');
                        break;
                }
            }
        });

        // Зберігаємо результат вулиць для гармонізації
        lastSimulatedPoints = placedLights;
        updateStatus(`Вулиця: розміщено ${placedLights.length} ліхтарів`, 'success');
    }

    // 2. ВІДОБРАЖЕННЯ КНОПКИ ГАРМОНІЗАЦІЇ
    // Показуємо панель, щоб користувач міг завантажити файл
    const simWrapper = document.getElementById('simGroup');

if (simWrapper) {
    // Додаємо клас 'active'. 
    // Це запускає CSS-анімацію: кнопка симуляції звужується, Harmonize виїжджає.
    simWrapper.classList.add('active');
}
}
// --- ДОПОМІЖНИЙ АЛГОРИТМ ДЛЯ ПАРКІВ (Вставте це також, щоб все працювало) ---
function generateParkLighting(features) {
    // === НАЛАШТУВАННЯ ===
    const SPACING = 45;              // Крок між ліхтарями на алеях
    const JUNCTION_MERGE_DIST = 25;  // Радіус об'єднання перехресть (метрів)
    const FILL_EXCLUSION = 20;       // Не ставити на алеї ближче ніж Х до будь-якого ліхтаря

    let placedLights = []; 
    const pointHash = {};  
    const getKey = (coords) => `${coords[0].toFixed(5)},${coords[1].toFixed(5)}`;

    // 1. Топологія: знаходимо всі кінці ліній
    let rawJunctions = [];
    features.forEach(f => {
        if (f.geometry.type !== 'LineString') return;
        const coords = f.geometry.coordinates;
        const startKey = getKey(coords[0]);
        const endKey = getKey(coords[coords.length - 1]);
        
        pointHash[startKey] = (pointHash[startKey] || 0) + 1;
        pointHash[endKey] = (pointHash[endKey] || 0) + 1;
    });

    // Відбираємо ті, що не є просто стиком (count !== 2)
    Object.keys(pointHash).forEach(key => {
        const count = pointHash[key];
        if (count !== 2) { 
            const [lng, lat] = key.split(',').map(Number);
            rawJunctions.push(turf.point([lng, lat]));
        }
    });

    // 2. Кластеризація вузлів (об'єднуємо складні розв'язки в один центр)
    if (rawJunctions.length > 0) {
        const junctionCollection = turf.featureCollection(rawJunctions);
        const clustered = turf.clustersDbscan(junctionCollection, JUNCTION_MERGE_DIST / 1000, {
            units: 'kilometers', 
            minPoints: 1 
        });

        const clusters = {};
        const noise = [];

        clustered.features.forEach(f => {
            const clusterId = f.properties.cluster;
            if (clusterId !== undefined) {
                if (!clusters[clusterId]) clusters[clusterId] = [];
                clusters[clusterId].push(f);
            } else {
                noise.push(f);
            }
        });

        // Додаємо одиночні точки
        noise.forEach(f => placedLights.push(f));

        // Додаємо центри кластерів
        Object.keys(clusters).forEach(id => {
            const center = turf.center(turf.featureCollection(clusters[id]));
            placedLights.push(center);
        });
    }

    // 3. Заповнення алей (з урахуванням відстані до ВЖЕ встановлених вузлів)
    const sortedFeatures = features.slice().sort((a, b) => turf.length(b) - turf.length(a));

    sortedFeatures.forEach(line => {
        const length = turf.length(line, {units: 'meters'});
        if (length < SPACING * 0.5) return;

        let spans = Math.round(length / SPACING);
        if (spans < 1) spans = 1;

        const actualStep = length / spans;

        for (let k = 1; k < spans; k++) {
            const dist = actualStep * k;
            const candidate = turf.along(line, dist, {units: 'meters'});
            
            // Глобальна перевірка на близькість
            let isTooClose = false;
            for (let existing of placedLights) {
                if (turf.distance(candidate, existing, {units: 'meters'}) < FILL_EXCLUSION) {
                    isTooClose = true;
                    break;
                }
            }

            if (!isTooClose) {
                placedLights.push(candidate);
            }
        }
    });

    return placedLights;
}
async function harmonizeLights() {
    // 1. Перевірка: чи була симуляція
    if (!lastSimulatedPoints || lastSimulatedPoints.length === 0) {
        alert("Спочатку запустіть симуляцію (жовта кнопка), щоб було з чим порівнювати.");
        return;
    }

    updateStatus("Гармонізація: завантаження 1.geojson...", 'normal');

    try {
        // 2. АВТОМАТИЧНЕ ЗАВАНТАЖЕННЯ ФАЙЛУ З СЕРВЕРА
        const response = await fetch('https://raw.githubusercontent.com/trafficlight1/register/d5cc7bb87d54a5e0e3f1c56b993798283d6507fd/park.geojson');
        if (!response.ok) {
            throw new Error(`Файл не знайдено (Status: ${response.status})`);
        }

        const geojson = await response.json();

        // Витягуємо точки (з перевіркою на null geometry)
        let existingPoints = [];
        
        if (geojson.type === 'FeatureCollection' && Array.isArray(geojson.features)) {
            // === ВИПРАВЛЕННЯ ТУТ ===
            // Ми додаємо перевірку: f.geometry && ... 
            // Це гарантує, що ми не намагаємось читати type у null
            existingPoints = geojson.features.filter(f => f.geometry && f.geometry.type === 'Point');
        
        } else if (Array.isArray(geojson)) {
            existingPoints = geojson.filter(f => f.geometry && f.geometry.type === 'Point');
        }

        if (existingPoints.length === 0) throw new Error("У файлі немає коректних точок");

        // 3. АЛГОРИТМ ГАРМОНІЗАЦІЇ
        const MERGE_THRESHOLD = 15; // Радіус поглинання (метри)
        
        const finalProposed = []; 
        const keptExisting = existingPoints; 
        let removedCount = 0;

        lastSimulatedPoints.forEach(simPoint => {
            let isRedundant = false;
            // Перевіряємо конфлікти з існуючими
            for (let existPoint of existingPoints) {
                // Додатковий захист, якщо в симуляції проскочив null (малоймовірно, але безпечно)
                if (!simPoint || !existPoint) continue;

                const dist = turf.distance(simPoint, existPoint, {units: 'meters'});
                if (dist < MERGE_THRESHOLD) {
                    isRedundant = true;
                    break; 
                }
            }
            if (!isRedundant) finalProposed.push(simPoint);
            else removedCount++;
        });

        // 4. ВІЗУАЛІЗАЦІЯ
        lightsLayer.clearLayers(); 

        // Малюємо ІСНУЮЧІ (Сині)
        keptExisting.forEach(f => {
            // Перестраховка при малюванні
            if (f.geometry && f.geometry.coordinates) {
                const pos = f.geometry ? f : { geometry: { coordinates: f } };
                drawHarmonizedLight(pos, '#3498db', 'ІСНУЮЧИЙ', 1.0); 
            }
        });

        // Малюємо ПРОПОНОВАНІ (Жовті)
        finalProposed.forEach(f => {
            if (f.geometry && f.geometry.coordinates) {
                const pos = f.geometry ? f : { geometry: { coordinates: f } };
                drawHarmonizedLight(pos, '#ffb74d', 'ПРОЄКТНИЙ (СИМУЛЯЦІЯ)', 0.6);
            }
        });

        updateStatus(`Гармонізація: Збережено ${keptExisting.length} існуючих. Додано ${finalProposed.length} нових.`, 'success');

    } catch (err) {
        console.error(err);
        updateStatus(`Помилка: ${err.message}`, 'error');
        alert("Помилка обробки файлу");
    }
}
// Допоміжна функція малювання для режиму Гармонізації
function drawHarmonizedLight(pos, color, typeLabel, opacity) {
    const lat = pos.geometry.coordinates[1];
    const lng = pos.geometry.coordinates[0];
    
    // Пляма світла
    L.circle([lat, lng], {
        radius: 12,
        color: 'transparent',
        fillColor: color,
        fillOpacity: 0.15 * opacity,
        interactive: false
    }).addTo(lightsLayer);

    // Точка (Маркер)
    const marker = L.circleMarker([lat, lng], {
        radius: 5,
        color: '#fff',
        weight: 1,
        fillColor: color,
        fillOpacity: 0.9,
        interactive: true
    });

    marker.bindPopup(`
        <div class="info-popup-row" style="border-bottom: 2px solid ${color}">
            <b>${typeLabel}</b>
        </div>
        <div class="info-popup-row">
            <span class="info-popup-label">Статус:</span> ${typeLabel === 'ІСНУЮЧИЙ' ? 'Зберегти' : 'Встановити'}
        </div>
    `);
    
    marker.addTo(lightsLayer);
}
function isTooClose(newPoint, existingPoints, threshold) {
    for (let pt of existingPoints) { if (turf.distance(newPoint, pt, {units: 'meters'}) < threshold) return true; }
    return false;
}

function drawLight(pos, radius, color, type, height) { drawLightBase(pos, radius, color); addInteractiveMarker(pos, type === 'suspended' ? 'Підвісний' : 'Опора', height); }

function drawLightBase(pos, radius, color) {
    const lat = pos.geometry.coordinates[1], lng = pos.geometry.coordinates[0];
    L.circle([lat, lng], { radius: radius, color: 'transparent', fillColor: color, fillOpacity: 0.15, interactive: false }).addTo(lightsLayer);
    L.circle([lat, lng], { radius: radius * 0.6, color: 'transparent', fillColor: color, fillOpacity: 0.3, interactive: false }).addTo(lightsLayer);
}

function addInteractiveMarker(pos, typeName, height) {
    const lat = pos.geometry.coordinates[1], lng = pos.geometry.coordinates[0];
    const marker = L.circleMarker([lat, lng], { radius: 4, color: '#333', weight: 1, fillColor: '#fff', fillOpacity: 1, interactive: true });
    marker.bindPopup(`<div class="info-popup-row"><span class="info-popup-label">Тип:</span><b>${typeName}</b></div><div class="info-popup-row"><span class="info-popup-label">Температура:</span>${globalAnalysis.colorTemp}</div><div class="info-popup-row"><span class="info-popup-label">Висота:</span>~${height.toFixed(1)} м</div>`);
    marker.addTo(lightsLayer);
}

async function findCrossings() {
    if (!savedAreaId || !savedStreetName) return;
    updateStatus(`Шукаю переходи для ${savedStreetName}...`);
    const query = `[out:json][timeout:60];area(${savedAreaId})->.searchArea;way["name"="${savedStreetName}"]["highway"](area.searchArea)->.street;node["highway"="crossing"](around.street:2);out geom;`;
    const data = await fetchWithRetry('https://overpass-api.de/api/interpreter', {method: 'POST', body: "data=" + encodeURIComponent(query)});
    if (!data.elements) return updateStatus("Не знайдено.");
    const streetLines = savedStreetGeoJSON.features; 
    let count = 0;
    data.elements.forEach(el => {
        if (el.type === 'node') {
            const p = turf.point([el.lon, el.lat]);
            let minD = Infinity;
            streetLines.forEach(l => { const d = turf.pointToLineDistance(p, l, {units: 'meters'}); if(d<minD) minD = d; });
            if(minD <= 2) {
                const mk = L.marker([el.lat, el.lon], {icon: L.divIcon({className: 'crossing-icon', html: '🟢', iconSize: [20, 20]})});
                mk.bindPopup("<b>Пішохідний перехід</b>"); mk.addTo(crossingLayer); count++;
            }
        }
    });
    updateStatus(`Знайдено переходів: ${count}`, 'success');
}

document.getElementById('streetNamePart').addEventListener('keypress', function(e) { if (e.key === 'Enter') analyzeStreet(); });

// --- НОВА ЛОГІКА ДЛЯ АВТОДОПОВНЕННЯ (AUTOCOMPLETE) ---
const streetInput = document.getElementById('streetNamePart');
const suggestionsList = document.getElementById('suggestionsList');
let debounceTimer;

streetInput.addEventListener('input', function() {
    const query = this.value.trim();
    const city = document.getElementById('cityInput').value || 'Львів'; 
    clearTimeout(debounceTimer);
    suggestionsList.style.display = 'none';

    if (query.length < 3) return;

    debounceTimer = setTimeout(async () => {
        try {
            // Використовуємо Nominatim з пошуком по місту
            const url = `https://nominatim.openstreetmap.org/search?street=${encodeURIComponent(query)}&city=${encodeURIComponent(city)}&format=json&limit=5&dedupe=1`;
            const response = await fetch(url);
            const data = await response.json();
            
            // Фільтруємо унікальні імена
            const uniqueStreets = [...new Set(data.map(item => item.name).filter(name => name))];
            renderSuggestions(uniqueStreets);
        } catch (error) {
            console.error("Помилка при пошуку вулиць:", error);
        }
    }, 250);
});

function renderSuggestions(streets) {
    suggestionsList.innerHTML = '';
    if (streets.length === 0) {
        suggestionsList.style.display = 'none';
        return;
    }
    streets.forEach(streetName => {
        const li = document.createElement('li');
        li.textContent = streetName;
        li.addEventListener('click', () => {
            streetInput.value = streetName;
            suggestionsList.style.display = 'none';
            // Опціонально: можна розкоментувати, щоб шукало відразу після кліку
            // analyzeStreet(); 
        });
        suggestionsList.appendChild(li);
    });
    suggestionsList.style.display = 'block';
}

// Закриття списку при кліку поза ним
document.addEventListener('click', (e) => {
    if (!streetInput.contains(e.target) && !suggestionsList.contains(e.target)) {
        suggestionsList.style.display = 'none';
    }
});