const firebaseConfig = {
    apiKey: "AIzaSyA777OVFMDEgGDyf5BbKSkwbweBLOputZ0",
    authDomain: "pidsvituai.firebaseapp.com",
    projectId: "pidsvituai",
    storageBucket: "pidsvituai.firebasestorage.app",
    messagingSenderId: "291103271838",
    appId: "1:291103271838:web:7df3b779433dc4c583c48f",
    measurementId: "G-8BR4E3W54K"
};

let db = null;

const requestCache = new Map();
const RATE_LIMIT = 10;
const RATE_WINDOW = 60000;

async function rateLimitedRequest(key, requestFn) {
    const now = Date.now();
    const requests = requestCache.get(key) || [];
    
    const recentRequests = requests.filter(time => now - time < RATE_WINDOW);
    
    if (recentRequests.length >= RATE_LIMIT) {
        throw new Error('⏱️ Забагато запитів. Зачекайте хвилину.');
    }
    
    recentRequests.push(now);
    requestCache.set(key, recentRequests);
    
    return await requestFn();
}

let firebaseReady = false;

document.addEventListener('DOMContentLoaded', function() {
    try {
        firebase.initializeApp(firebaseConfig);
        
        if (typeof firebase.appCheck !== 'undefined') {
            const appCheck = firebase.appCheck();
            appCheck.activate(
                '6LdM1F8sAAAAADLgpjEUlP9SSyoaM_0tXzBZtf-Z', 
                true
            );
        }
        
        db = firebase.firestore();
        
        // КРИТИЧНО: Чекаємо готовності Firebase
        db.enablePersistence({ synchronizeTabs: true })
            .then(() => {
                firebaseReady = true;
                console.log("✅ Firebase готовий до роботи");
            })
            .catch((err) => {
                console.warn("⚠️ Persistence не активовано:", err);
                firebaseReady = true; // все одно дозволяємо працювати
            });
        
        initMap();
        testFirebaseConnection();
        
    } catch (error) {
        console.error("❌ Помилка ініціалізації Firebase:", error);
        updateStatus("Помилка підключення до бази даних", 'error');
    }
});

async function testFirebaseConnection() {
    try {
        const testDoc = await db.collection('park').limit(1).get();
    } catch (error) {
    }
}

const WIDTH_ERROR = 2.0;    
const STEP_METERS = 50;     
const MAX_SEARCH_DIST = 40; 
const DENSITY_STEP = 10;
const BUILDING_SEARCH_RADIUS = 25;
const LVIV_BOUNDS = [[49.75, 23.85], [49.95, 24.15]];

const UTM_ZONE = 34;
const UTM_FALSE_EASTING = 500000;
const UTM_FALSE_NORTHING = 0;
const UTM_SCALE_FACTOR = 0.9996;
const EARTH_RADIUS = 6378137;

let savedAreaId = null;
let savedStreetName = null;
let savedStreetGeoJSON = null;
let map = null, darkLayer = null, lightLayer = null, mainLayer = null;
let crossingLayer = null, buildingLayer = null, lightsLayer = null;

function normalizeStreetName(name) {
    if (!name) {
        return "";
    }
    
    const cleanName = name
        .replace(/^(вул\.|вулиця|проспект|просп\.|площа|парк|пл\.|м-н)\s*/i, '')
        .replace(/\./g, '_')
        .trim();
    return cleanName;
}

function createFlexibleSearchPattern(searchName) {
    let cleaned = searchName
        .replace(/^(вул\.|вулиця|проспект|просп\.|площа|парк|пл\.|м-н)\s*/i, '')
        .trim();
    
    const words = cleaned.split(/\s+/).filter(w => w.length > 0);
    
    if (words.length === 0) return searchName;
    
    const flexiblePattern = words
        .map(word => {
            const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return escaped;
        })
        .join('.*');
    
    return flexiblePattern;
}

function matchesSearchQuery(name, searchQuery) {
    if (!name || !searchQuery) return false;
    
    const normalizedName = name.toLowerCase()
        .replace(/^(вул\.|вулиця|проспект|просп\.|площа|парк|пл\.|м-н)\s*/i, '')
        .trim();
    
    const normalizedSearch = searchQuery.toLowerCase()
        .replace(/^(вул\.|вулиця|проспект|просп\.|площа|парк|пл\.|м-н)\s*/i, '')
        .trim();
    
    if (normalizedName === normalizedSearch) return true;
    
    const searchWords = normalizedSearch.split(/\s+/);
    const allWordsPresent = searchWords.every(word => 
        normalizedName.includes(word)
    );
    
    if (allWordsPresent) return true;
    
    const expandedName = normalizedName
        .replace(/\bім\./gi, 'іменем')
        .replace(/\bпросп\./gi, 'проспект')
        .replace(/\bвул\./gi, 'вулиця');
    
    const expandedSearch = normalizedSearch
        .replace(/\bім\./gi, 'іменем')
        .replace(/\bпросп\./gi, 'проспект')
        .replace(/\bвул\./gi, 'вулиця');
    
    const expandedWords = expandedSearch.split(/\s+/);
    const allExpandedPresent = expandedWords.every(word => 
        expandedName.includes(word)
    );
    
    return allExpandedPresent;
}

function updateStatus(msg, type = 'normal') {
    const statusDiv = document.getElementById('status');
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
            if (text.trim().startsWith('<') && !text.includes('<osm')) {
                throw new Error("API overloaded");
            }
            return JSON.parse(text);
        } catch (err) {
            if (i === retries - 1) throw err;
            await wait(2500);
        }
    }
}

let proj4Available = false;

function initProj4() {
    if (typeof proj4 === 'undefined') {
        return false;
    }
    
    proj4.defs("EPSG:32634", "+proj=utm +zone=34 +datum=WGS84 +units=m +no_defs");
    proj4.defs("EPSG:4326", "+proj=longlat +datum=WGS84 +no_defs");
    
    proj4Available = true;
    return true;
}

function utmToLatLng(easting, northing, zone = 34) {
    if (!proj4Available && !initProj4()) {
        console.error("❌ proj4js недоступний, використовую приблизну конвертацію");
        return fallbackUtmToLatLng(easting, northing);
    }
    
    try {
        const [lng, lat] = proj4("EPSG:32634", "EPSG:4326", [easting, northing]);
        
        return { lat, lng };
    } catch (error) {
        console.error("❌ Помилка proj4 конвертації:", error);
        return fallbackUtmToLatLng(easting, northing);
    }
}

function fallbackUtmToLatLng(easting, northing) {
    if (easting > 6000000 && northing > 2600000) {
        const refEasting = 6418400;
        const refNorthing = 2673800;
        const refLat = 49.8419;
        const refLng = 24.0315;
        
        const metersPerDegreeLat = 111000;
        const metersPerDegreeLng = 73000;
        
        const deltaEasting = easting - refEasting;
        const deltaNorthing = northing - refNorthing;
        
        const lat = refLat + (deltaNorthing / metersPerDegreeLat);
        const lng = refLng + (deltaEasting / metersPerDegreeLng);
        
        return { lat, lng };
    }
    
    if (easting > 400000 && easting < 500000) {
        const centerLat = 49.84;
        const centerLng = 24.03;
        const centerEasting = 448000;
        const centerNorthing = (northing > 5000000) ? 5525000 : northing;
        
        const deltaEasting = easting - centerEasting;
        const deltaNorthing = (northing > 5000000) ? (northing - centerNorthing) : northing;
        
        const lat = centerLat + (deltaNorthing / 111000);
        const lng = centerLng + (deltaEasting / (111000 * Math.cos(centerLat * Math.PI / 180)));
        
        return { lat, lng };
    }
    
    console.error(`❌ Невідомий формат координат: ${easting}, ${northing}`);
    return { lat: 49.8419, lng: 24.0315 };
}

function isUTMCoordinate(x, y) {
    if (x > 400000 && x < 500000 && y > 5500000 && y < 5550000) {
        return true;
    }
    
    // Варіант 2: Скорочені координати (без префіксу мільйонів)
    if (x > 400000 && x < 500000 && y > 2600000 && y < 2700000) {
        return true;
    }
    
    // Варіант 3: Дуже великі числа (можлива інша проекція)
    if (x > 6000000 && x < 7000000 && y > 2600000 && y < 2700000) {
        return true;
    }
    
    return false;
}

// ==================== ІНІЦІАЛІЗАЦІЯ КАРТИ ====================
// ==================== UI ТА АНІМАЦІЯ ====================

// ==================== UI ТА АНІМАЦІЯ (ВИПРАВЛЕНО) ====================

const searchBtn = document.getElementById('analyzeBtn');

function setButtonState(state) {
    searchBtn.classList.remove('loading', 'success');
    
    if (state === 'loading') {
        searchBtn.classList.add('loading');
        searchBtn.disabled = true;
    } else if (state === 'success') {
        searchBtn.classList.add('success');
        searchBtn.disabled = true;
    } else {
        searchBtn.disabled = false;
    }
}

async function handleSearchClick() {
    const streetName = document.getElementById('streetNamePart').value;
    
    if (!streetName || streetName.trim().length < 3) {
        alert("Будь ласка, введіть назву вулиці (мінімум 3 літери)");
        return;
    }

    setButtonState('loading');

    try {
        await analyzeStreet(); 
        setButtonState('success');
        await new Promise(resolve => setTimeout(resolve, 550));
        showMap(); 

        setTimeout(() => {
            if (map && savedStreetGeoJSON) {
                map.invalidateSize();
                const bbox = turf.bbox(savedStreetGeoJSON);
                map.fitBounds([[bbox[1], bbox[0]], [bbox[3], bbox[2]]], {
                    padding: [50, 50],
                    animate: true,
                    duration: 2.5
                });
            }
        }, 100);

        setTimeout(() => {
            setButtonState('default');
        }, 500);

    } catch (error) {
        console.error("Помилка пошуку:", error);
        setButtonState('default');
        updateStatus(`Помилка: ${error.message}`, 'error');
    }
}

function showMap() {
    document.getElementById('welcomeScreen').classList.add('hidden');
    
    // Робимо контейнери активними
    const mapContainer = document.getElementById('mapContainer');
    const bottomPanel = document.getElementById('bottomPanel');
    
    mapContainer.classList.add('active');
    bottomPanel.classList.add('active');

    // КРИТИЧНО ВАЖЛИВО: Оновлюємо розміри карти після появи
    setTimeout(() => {
        if (map) {
            map.invalidateSize();
        }
    }, 400); // Чекаємо завершення CSS анімації (0.3s)
}

function initMap() {
    map = L.map('map', { 
        maxBounds: LVIV_BOUNDS, 
        maxBoundsViscosity: 1.0 
    }).setView([49.8419, 24.0315], 13);
    
    darkLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { 
        attribution: '&copy; OSM contributors' 
    });
    
    lightLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { 
        attribution: '&copy; OSM contributors' 
    });
    
    darkLayer.addTo(map);
    
    // КРИТИЧНО: Створюємо всі шари та гарантовано додаємо їх на карту
    mainLayer = L.layerGroup().addTo(map);
    crossingLayer = L.layerGroup().addTo(map);
    buildingLayer = L.layerGroup().addTo(map);
    lightsLayer = L.layerGroup().addTo(map);
}

function resetMap() {
    if (mainLayer) mainLayer.clearLayers();
    if (buildingLayer) buildingLayer.clearLayers();
    if (crossingLayer) crossingLayer.clearLayers();
    if (lightsLayer) lightsLayer.clearLayers();
    
    savedStreetGeoJSON = null; 
    savedStreetName = null;
    suggestionsList.classList.add('active'); // показати
    suggestionsList.classList.remove('active'); // сховати
    document.getElementById('recommendations').style.display = 'none';
    document.getElementById('crossingsBtn').style.display = 'none';
    document.getElementById('suggestionsList').style.display = 'none'; 
    document.getElementById('mapContainer').classList.remove('active');
    document.getElementById('bottomPanel').classList.remove('active');
    document.getElementById('streetNamePart').value = '';
    
    setTimeout(() => { 
        document.getElementById('welcomeScreen').classList.remove('hidden'); 
    }, 300);
}

// ==================== QUICK SEARCH ====================

function quickSearch(type, name) {
    const select = document.getElementById('streetPrefix');
    select.value = type;
    const input = document.getElementById('streetNamePart');
    input.value = name;
    
    // Викликаємо нову функцію з анімацією
    handleSearchClick();
}


// ==================== ГОЛОВНА ФУНКЦІЯ АНАЛІЗУ ====================

// ==================== ГОЛОВНА ФУНКЦІЯ АНАЛІЗУ ====================

// ==================== ГОЛОВНА ФУНКЦІЯ АНАЛІЗУ ====================

async function analyzeStreet() {
    const city = document.getElementById('cityInput').value;
    const namePart = document.getElementById('streetNamePart').value.trim();
    
    const typeEl = document.getElementById('streetPrefix');
    const isParkSearch = (typeEl && typeEl.value === 'Парк') || 
                          namePart.toLowerCase().includes('парк');
    
    if(!city || !namePart || namePart.length < 3) { 
        throw new Error("Некоректні дані"); 
    }
    
    updateStatus(`Шукаю ${isParkSearch ? "парк" : "вулицю"} "${namePart}"...`);

    try {
        // --- ЕТАП 1: Nominatim & OSM ---
        const nominatimUrl = `https://nominatim.openstreetmap.org/search?city=${city}&format=json&limit=1`;
        const cityRes = await fetch(nominatimUrl);
        const cityData = await cityRes.json();
        
        if (cityData.length === 0) throw new Error("Місто не знайдено");
        savedAreaId = 3600000000 + parseInt(cityData[0].osm_id);

        let query = '';
        const searchPattern = createFlexibleSearchPattern(namePart);

        // ... Формування запиту ...
        if (isParkSearch) {
             query = `[out:json][timeout:180][maxsize:20000000]; area(${savedAreaId})->.searchArea; ( way["name"~"${searchPattern}", i]["leisure"="park"](area.searchArea); relation["name"~"${searchPattern}", i]["leisure"="park"](area.searchArea); way["name"~"парк.*${searchPattern}", i]["leisure"="park"](area.searchArea); relation["name"~"парк.*${searchPattern}", i]["leisure"="park"](area.searchArea); )->.parkGeom; .parkGeom map_to_area -> .parkArea; ( way["highway"~"footway|path|pedestrian|cycleway|steps"](area.parkArea); )->.paths; ( node["leisure"="playground"](area.parkArea); way["leisure"="playground"](area.parkArea); )->.playgrounds; .parkGeom out geom; .paths out geom; .playgrounds out geom;`;
        } else {
            query = `[out:json][timeout:180][maxsize:20000000]; area(${savedAreaId})->.searchArea; ( way["name"~"${searchPattern}", i]["highway"](area.searchArea); way["name"~"вулиця.*${searchPattern}", i]["highway"](area.searchArea); way["name"~"проспект.*${searchPattern}", i]["highway"](area.searchArea); )->.street; (way["highway"~"footway|path|pedestrian|sidewalk"](around.street:${MAX_SEARCH_DIST + 20});)->.sidewalks; (way["building"](around.street:30);)->.buildings; .street out geom; .sidewalks out geom; .buildings out geom;`;
        }

        const data = await fetchWithRetry('https://overpass-api.de/api/interpreter', { method: 'POST', body: "data=" + encodeURIComponent(query) });
        
        if (!data.elements || data.elements.length === 0) throw new Error("Об'єкт не знайдено.");
        
        // --- ЕТАП 2: Обробка геометрії (малюємо на прихованій карті) ---
        if (isParkSearch) {
            await processParkVisualization(data, namePart);
        } else {
            await processStreetVisualization(data, namePart);
        }

        // --- ЕТАП 3: Завантаження Firebase ---
        if (savedStreetName) {
            await loadLightingData(savedStreetName);
        }

        // ВАЖЛИВО: Ми більше НЕ викликаємо showMap() тут.
        // Ми просто повертаємо успіх.
        return true; 

    } catch (error) {
        console.error(error);
        updateStatus(`Помилка: ${error.message}`, 'error');
        throw error;
    }
}

// ==================== ВІЗУАЛІЗАЦІЯ ПАРКУ ====================

async function processParkVisualization(data, searchName) {
    const pathFeatures = [];
    const parkFeatures = [];
    const playgroundFeatures = [];
    let foundParkName = searchName;
    let bestMatchScore = 0;

    data.elements.forEach(el => {
        const tags = el.tags || {};
        
        // Перевіряємо, чи елемент відповідає пошуку
        const elementName = tags.name || '';
        const isMatch = matchesSearchQuery(elementName, searchName);
        
        if (el.type === 'node' && tags.leisure === 'playground') {
            playgroundFeatures.push(turf.point([el.lon, el.lat], tags));
        }

        if (el.type === 'way' && el.geometry) {
            const coords = el.geometry.map(p => [p.lon, p.lat]);
            
            if (tags.leisure === 'playground') {
                if (coords.length > 2) {
                      coords.push(coords[0]);
                      playgroundFeatures.push(turf.polygon([coords], tags));
                }
            }
            else if (tags.leisure === 'park') {
                if (coords.length > 2) {
                      coords.push(coords[0]); 
                      parkFeatures.push(turf.polygon([coords], tags));
                }
                
                // Вибираємо найкращу назву парку
                if (isMatch && elementName) {
                    const score = elementName.length; // Довша назва = точніша
                    if (score > bestMatchScore) {
                        bestMatchScore = score;
                        foundParkName = elementName;
                    }
                }
            } 
            else if (tags.highway && parkFeatures.length > 0) {
                // Доріжки додаємо тільки якщо вже знайшли парк
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

    if(parkFeatures.length > 0) {
        L.geoJSON(turf.featureCollection(parkFeatures), { 
            style: { color: '#2ecc71', weight: 2, fillOpacity: 0.05, dashArray: '5, 5' } 
        }).addTo(mainLayer);
    }

    if(playgroundFeatures.length > 0) {
        L.geoJSON(turf.featureCollection(playgroundFeatures), {
            pointToLayer: function (feature, latlng) {
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

    if (pathFeatures.length > 0) {
        L.geoJSON(savedStreetGeoJSON, {
            style: { color: '#f1c40f', weight: 3, opacity: 0.8 },
            onEachFeature: function(feature, layer) {
                layer.bindPopup(`<div class="info-popup-row"><span class="info-popup-label">Доріжка парку</span></div>`);
            }
        }).addTo(mainLayer);
    }

    
}

// ==================== ВІЗУАЛІЗАЦІЯ ВУЛИЦІ (ЗМІНЕНО) ====================

// ==================== ВІЗУАЛІЗАЦІЯ ВУЛИЦІ З FIREBASE INTEGRATION ====================

async function processStreetVisualization(data, searchName) {
    const streetFeatures = [];
    const sidewalkFeatures = [];
    const buildingFeatures = [];
    let foundFullName = null;
    let bestMatchScore = 0;

    data.elements.forEach(el => {
        if (el.type === 'way' && el.geometry) {
            const coords = el.geometry.map(p => [p.lon, p.lat]);
            
            if (el.tags && el.tags.building) {
                if (coords.length > 2) { 
                    coords.push(coords[0]);
                    // Зберігаємо ID з поля id (це і є osm_id для way)
                    const props = { ...el.tags, osm_id: el.id };
                    buildingFeatures.push(turf.polygon([coords], props)); 
                }
                return;
            }
            
            const line = turf.lineString(coords, el.tags);
            const tags = el.tags || {};
            const elName = tags.name || "";
            
            const isMatch = matchesSearchQuery(elName, searchName);
            const isStreet = isMatch && 
                           tags.highway && 
                           !tags.highway.match(/footway|path|pedestrian|cycleway/);
            
            if (isStreet) {
                streetFeatures.push(line);
                
                if (elName.length > bestMatchScore) {
                    bestMatchScore = elName.length;
                    foundFullName = elName;
                }
            } else if (tags.highway) { 
                sidewalkFeatures.push(line); 
            }
        }
    });

    if (streetFeatures.length === 0) { 
        alert("Вулиця не знайдена."); 
        return; 
    }
    
    savedStreetName = foundFullName;
    savedStreetGeoJSON = turf.featureCollection(streetFeatures);

    L.geoJSON(savedStreetGeoJSON, { 
        style: { color: '#3498db', weight: 5, opacity: 0.6 },
        onEachFeature: function(feature, layer) {
            let p = feature.properties;
            layer.bindPopup(`
                <div class="info-popup-row">
                    <span class="info-popup-label">Вулиця:</span>
                    <b>${p.name || savedStreetName}</b>
                </div>
            `);
        }
    }).addTo(mainLayer);

    // ================== ІНТЕГРАЦІЯ З FIREBASE ДЛЯ БУДІВЕЛЬ (ПОШУК ЗА OSM_ID) ==================
    if(buildingFeatures.length > 0) {
        updateStatus("Перевірка будівель у базі даних...");
        
        // Створюємо масив промісів для перевірки кожної будівлі
        const buildingChecks = buildingFeatures.map(async (feature) => {
            const props = feature.properties || {};
            const osmId = props.osm_id;
            
            // Якщо будівля не має osm_id, пропускаємо пошук у Firebase
            if (!osmId) {
                console.warn('Будівля без osm_id:', props);
                return { feature, optimize: 0, firebaseData: null };
            }
            
            try {
                // Шукаємо будівлю в Firebase за полем osm_id
                const querySnapshot = await db.collection('buildings')
                    .where('osm_id', '==', String(osmId))
                    .limit(1)
                    .get();
                
                if (!querySnapshot.empty) {
                    const buildingDoc = querySnapshot.docs[0];
                    const data = buildingDoc.data();
                    console.log(`✅ Знайдено в Firebase: osm_id=${osmId}, optimize=${data.optimize}`);
                    return { 
                        feature, 
                        optimize: data.optimize || 0,
                        firebaseData: data
                    };
                } else {
                    console.log(`❌ Не знайдено в Firebase: osm_id=${osmId}`);
                    return { feature, optimize: 0, firebaseData: null };
                }
            } catch (error) {
                console.error(`Помилка перевірки будівлі з osm_id "${osmId}":`, error);
                return { feature, optimize: 0, firebaseData: null };
            }
        });
        
        // Чекаємо завершення всіх перевірок
        const checkedBuildings = await Promise.all(buildingChecks);
        
        // Підраховуємо статистику
        const stats = {
            total: checkedBuildings.length,
            optimize_1: 0,
            optimize_2: 0,
            optimize_3: 0,
            optimize_0: 0
        };
        
        // Візуалізуємо будівлі з відповідними кольорами
        L.geoJSON(turf.featureCollection(checkedBuildings.map(b => b.feature)), { 
            style: function(feature) {
                // Знаходимо відповідний запис з optimize
                const buildingData = checkedBuildings.find(
                    b => b.feature.properties.osm_id === feature.properties.osm_id
                );
                
                const optimize = buildingData ? buildingData.optimize : 0;
                const fbData = buildingData ? buildingData.firebaseData : null;
                
                // Оновлюємо статистику
                stats[`optimize_${optimize}`]++;
                
                // Визначаємо колір залежно від optimize
                let color, fillColor, fillOpacity, weight, popupText;
                
                switch(optimize) {
                    case 1: // Тільки name
                        color = '#D20A2E';
                        fillColor = '#D20A2E';
                        fillOpacity = 0.4;
                        weight = 2;
                        popupText = '🏛️ <b>Іменована будівля</b><br><small>Потенціал архітектурної підсвітки</small>';
                        break;
                    
                    case 2: // Тільки Historical
                        color = '#2E86DE';
                        fillColor = '#2E86DE';
                        fillOpacity = 0.4;
                        weight = 2;
                        popupText = '🏛️ <b>Історична будівля</b><br><small>Об\'єкт культурної спадщини</small>';
                        break;
                    
                    case 3: // name + Historical
                        color = '#8E44AD';
                        fillColor = '#8E44AD';
                        fillOpacity = 0.5;
                        weight = 3;
                        popupText = '🏛️ <b>Іменована історична будівля</b><br><small>Пріоритет для підсвітки</small>';
                        break;
                    
                    default: // optimize = 0 або немає в базі
                        color = '#555';
                        fillColor = '#555';
                        fillOpacity = 0.1;
                        weight = 1;
                        popupText = null;
                }
                
                // Зберігаємо дані для popup
                feature.properties._popupText = popupText;
                feature.properties._firebaseData = fbData;
                
                return { 
                    color: color, 
                    weight: weight, 
                    fillColor: fillColor, 
                    fillOpacity: fillOpacity 
                };
            },
            onEachFeature: function(feature, layer) {
                const popupText = feature.properties._popupText;
                const fbData = feature.properties._firebaseData;
                
                if (popupText) {
                    const props = feature.properties;
                    const name = fbData?.name || props.name || 'Без назви';
                    const osmId = props.osm_id || 'Невідомо';
                    
                    let popupContent = popupText;
                    
                    popupContent += `
                        <div class="info-popup-row" style="margin-top: 8px; padding-top: 8px; border-top: 1px solid #eee;">
                            <span class="info-popup-label">Назва:</span><b>${name}</b>
                        </div>
                    `;
                    
                    if (fbData?.Historical) {
                        popupContent += `
                            <div class="info-popup-row">
                                <span class="info-popup-label">Історичний статус:</span>${fbData.Historical}
                            </div>
                        `;
                    }
                    
                    popupContent += `
                        <div class="info-popup-row" style="font-size: 0.85em; color: #999;">
                            OSM ID: ${osmId}
                        </div>
                    `;
                    
                    layer.bindPopup(popupContent);
                }
            }
        }).addTo(buildingLayer);
        
        // Виводимо статистику
        const foundCount = stats.optimize_1 + stats.optimize_2 + stats.optimize_3;
        
        if (foundCount > 0) {
            updateStatus(
                `Будівель: ${stats.total} | ` +
                `🔴 ${stats.optimize_1} | ` +
                `🔵 ${stats.optimize_2} | ` +
                `🟣 ${stats.optimize_3}`,
                'success'
            );
        } else {
            updateStatus(`Будівель: ${stats.total} (дані в Firebase відсутні)`);
        }
        
        console.log('📊 Статистика будівель:', stats);
        console.log('📋 Перевірені будівлі:', checkedBuildings.map(b => ({
            osm_id: b.feature.properties.osm_id,
            name: b.feature.properties.name,
            optimize: b.optimize
        })));
    }
}

async function getBuildingsStatistics() {
    if (!savedStreetName) {
        console.warn("Вулиця не вибрана");
        return null;
    }
    
    const street = normalizeStreetName(savedStreetName);
    
    try {
        const snapshot = await db.collection('streets')
            .doc(street)
            .collection('buildings')
            .get();
        
        const stats = {
            total: 0,
            optimize_1: 0,
            optimize_2: 0,
            optimize_3: 0
        };
        
        const buildingDetails = [];
        
        for (const doc of snapshot.docs) {
            const streetData = doc.to_dict();
            const buildingId = streetData.buildingId;
            
            const buildingDoc = await db.collection('buildings').doc(buildingId).get();
            
            if (buildingDoc.exists) {
                const data = buildingDoc.data();
                const optimize = data.optimize || 0;
                
                stats.total++;
                stats[`optimize_${optimize}`]++;
                
                buildingDetails.push({
                    id: buildingId,
                    name: data.name,
                    optimize: optimize,
                    Historical: data.Historical
                });
            }
        }
        
        console.log('📊 Статистика будівель на вулиці:', stats);
        console.log('📋 Деталі будівель:', buildingDetails);
        
        return { stats, buildings: buildingDetails };
        
    } catch (error) {
        console.error('Помилка отримання статистики:', error);
        return null;
    }
}
// ==================== ЗАВАНТАЖЕННЯ ДАНИХ ОСВІТЛЕННЯ ====================

async function loadLightingData(streetName) {
    if (!map) {
        console.error("❌ Карта не ініціалізована! Пропускаю завантаження освітлення.");
        return;
    }
    
    if (!streetName) {
        console.error("❌ Назва вулиці/парку не передана!");
        return;
    }
    
    // КРОК 1: Спочатку пробуємо Firebase
    try {
        updateStatus("Пошук у базі даних Firebase...");
        const lightsData = await loadFromFirebase(streetName);
        
        if (lightsData && lightsData.length > 0) {
            visualizeLights(lightsData);
            updateStatus(`Завантажено ${lightsData.length} світильників з бази`, 'success');
            
            return;
        }
        
    } catch (fbError) {
    }
    
    // Якщо Firebase не повернув дані
    updateStatus("Не вдалося отримати дані про освітлення", 'error');
}

// ==================== ЗАВАНТАЖЕННЯ З FIREBASE ====================

async function loadFromFirebase(streetName) {
    if (!db) {
        throw new Error("Firebase не підключено");
    }
    
    if (!streetName) {
        throw new Error("Назва вулиці/парку не передана");
    }

    try {
        // Визначаємо, чи це парк (перевіряємо спадне меню та назву)
        const typeEl = document.getElementById('streetPrefix');
        const isParkSearch = (typeEl && typeEl.value === 'Парк') || 
                             streetName.toLowerCase().includes('парк');
        
        // Нормалізуємо назву
        const normalizedName = normalizeStreetName(streetName);
        
        // Створюємо варіанти для пошуку
        const variants = [
            streetName,                                             // Оригінальна назва "Парк ім. Івана Франка"
            normalizedName,                                         // "ім_ Івана Франка"
            normalizedName.replace(/_/g, '.'),                      // "ім. Івана Франка"
            normalizedName.replace(/ім_/gi, 'іменем '),             // "іменем Івана Франка"
            streetName.replace(/\./g, '_'),                         // "Парк ім_ Івана Франка"
        ];
        
        // Додаємо варіанти з префіксом для парків
        if (isParkSearch) {
            variants.push(
                `Парк ${normalizedName}`,                           // "Парк ім_ Івана Франка"
                `парк ${normalizedName}`,                           // "парк ім_ Івана Франка"
                `Парк ${normalizedName.replace(/_/g, '.')}`,        // "Парк ім. Івана Франка"
            );
        }
        
        // СПОЧАТКУ: Шукаємо у відповідній колекції (park або streets)
        const primaryCollection = isParkSearch ? 'park' : 'streets';
        
        for (const variant of variants) {
            const docRef = db.collection(primaryCollection).doc(variant);
            const doc = await docRef.get();
            
            if (doc.exists) {
                const data = doc.data();
                const lightsCSV = data.lights;
                
                if (lightsCSV) {
                    return parseCSVLights(lightsCSV);
                }
            }
        }
        
        // ЯКЩО НЕ ЗНАЙДЕНО: Шукаємо в альтернативній колекції
        const secondaryCollection = isParkSearch ? 'streets' : 'park';
        
        for (const variant of variants) {
            const docRef = db.collection(secondaryCollection).doc(variant);
            const doc = await docRef.get();
            
            if (doc.exists) {
                const data = doc.data();
                const lightsCSV = data.lights;
                
                if (lightsCSV) {
                    return parseCSVLights(lightsCSV);
                }
            }
        }
        
        return null;
        
    } catch (error) {
        console.error(`❌ Помилка Firebase:`, error);
        throw error;
    }
}

// ==================== ЗБЕРЕЖЕННЯ В FIREBASE ====================

async function saveToFirebase(streetName, lightsData) {
    if (!db) {
        return;
    }

    try {
        // Визначаємо, чи це парк
        const typeEl = document.getElementById('streetPrefix');
        const isPark = (typeEl && typeEl.value === 'Парк') || 
                       streetName.toLowerCase().includes('парк');
        
        let normalizedName = streetName
            .replace(/^(вул\.|вулиця|проспект|просп\.|площа|парк|пл\.|м-н)\s*/i, '')
            .replace(/\./g, '_')  // Крапки → підкреслення
            .trim();
        
        // Якщо це парк, додаємо префікс
        if (isPark && !normalizedName.toLowerCase().startsWith('парк')) {
            normalizedName = `Парк ${normalizedName}`;
        }
        
        // Конвертуємо масив у CSV формат
        const lightsCSV = lightsData.map(light => 
            `${light.lat},${light.lng},${light.height},${light.type},${light.colorTemp}`
        ).join('\n');
        
        const collection = isPark ? 'park' : 'streets';
        const docRef = db.collection(collection).doc(normalizedName);
        
        await docRef.set({
            name: streetName,
            normalized_name: normalizedName,
            lights: lightsCSV,
            light_count: lightsData.length,
            created_at: firebase.firestore.FieldValue.serverTimestamp(),
            source: 'api'
        });
        
    } catch (error) {
        console.error(`❌ Помилка збереження у Firebase:`, error);
        // Не кидаємо помилку, щоб не перервати візуалізацію
    }
}

// ==================== ПАРСИНГ CSV ====================

function parseCSVLights(csvString) {
    const lights = [];
    
    let entries = csvString.trim().split('\n');
    
    if (entries.length === 1) {
        entries = csvString.trim().split(/\s+/);
    }
    
    entries.forEach((entry, index) => {
        const parts = entry.trim().split(',');
        
        if (parts.length >= 2) {
            let x = parseFloat(parts[0]);
            let y = parseFloat(parts[1]);
            
            if (isNaN(x) || isNaN(y)) {
                return;
            }
            
            let lat, lng;
            
            // Перевіряємо, чи це UTM координати
            if (isUTMCoordinate(x, y)) {
                const converted = utmToLatLng(x, y, UTM_ZONE);
                lat = converted.lat;
                lng = converted.lng;
            } else {
                // Вже географічні координати
                lat = x;
                lng = y;
            }
            
            // Перевірка що координати в межах Львова
            if (lat < 49.7 || lat > 50.0 || lng < 23.8 || lng > 24.2) {
            }
            
            lights.push({
                lat: lat,
                lng: lng,
                height: parts[2] ? parseFloat(parts[2]) : 8.0,
                type: parts[3] || 'pole',
                colorTemp: parts[4] || '3000K'
            });
        }
    });
    
    return lights;
}

// ==================== ВІЗУАЛІЗАЦІЯ СВІТИЛЬНИКІВ ====================

function visualizeLights(lightsData) {
    // КРИТИЧНО: Очищуємо шар перед додаванням нових даних
    if (lightsLayer) {
        lightsLayer.clearLayers();
    } else {
        console.error("❌ lightsLayer не ініціалізовано!");
        return;
    }
    
    if (!map) {
        console.error("❌ Карта не ініціалізована!");
        return;
    }
    
    if (!lightsData || lightsData.length === 0) {
        return;
    }
    
    let addedCount = 0;
    
    lightsData.forEach((light, index) => {
        const { lat, lng, height, type, colorTemp } = light;
        
        // Перевірка валідності координат
        if (isNaN(lat) || isNaN(lng)) {
            return;
        }
        
        const color = colorTemp.includes('4000') ? '#eefaff' : '#ffb74d';
        const radius = height * 1.7;
        
        try {
            // Пляма світла (внутрішнє коло)
            L.circle([lat, lng], {
                radius: radius * 0.6,
                color: 'transparent',
                fillColor: color,
                fillOpacity: 0.3,
                interactive: false
            }).addTo(lightsLayer);
            
            // Пляма світла (зовнішнє коло)
            L.circle([lat, lng], {
                radius: radius,
                color: 'transparent',
                fillColor: color,
                fillOpacity: 0.15,
                interactive: false
            }).addTo(lightsLayer);
            
            // Маркер світільника
            const marker = L.circleMarker([lat, lng], {
                radius: 4,
                color: '#333',
                weight: 1,
                fillColor: '#fff',
                fillOpacity: 1,
                interactive: true
            });
            
            const typeName = type === 'suspended' ? 'Підвісний' : 'Опора';
            
            marker.bindPopup(`
                <div class="info-popup-row">
                    <span class="info-popup-label">Тип:</span><b>${typeName}</b>
                </div>
                <div class="info-popup-row">
                    <span class="info-popup-label">Температура:</span>${colorTemp}
                </div>
                <div class="info-popup-row">
                    <span class="info-popup-label">Висота:</span>~${height.toFixed(1)} м
                </div>
                <div class="info-popup-row" style="font-size: 0.85em; color: #999;">
                    ID: ${index + 1}
                </div>
            `);
            
            marker.addTo(lightsLayer);
            addedCount++;
            
        } catch (error) {
            console.error(`❌ Помилка додавання світильника ${index}:`, error);
        }
    });
    
    // КРИТИЧНО: Примусово оновлюємо карту
    if (map) {
        setTimeout(() => {
            map.invalidateSize();
        }, 100);
    }
    
    // КРИТИЧНО: Переконуємось що шар видимий
    if (!map.hasLayer(lightsLayer)) {
        lightsLayer.addTo(map);
    }
}

// ==================== ПОШУК ПЕРЕХОДІВ ====================

async function findCrossings() {
    if (!savedAreaId || !savedStreetName) return;
    
    updateStatus(`Шукаю переходи для ${savedStreetName}...`);
    
    const query = `
        [out:json][timeout:60];
        area(${savedAreaId})->.searchArea;
        way["name"="${savedStreetName}"]["highway"](area.searchArea)->.street;
        node["highway"="crossing"](around.street:2);
        out geom;
    `;
    
    try {
        const data = await fetchWithRetry(
            'https://overpass-api.de/api/interpreter', 
            {method: 'POST', body: "data=" + encodeURIComponent(query)}
        );
        
        if (!data.elements) {
            return updateStatus("Переходи не знайдено");
        }
        
        const streetLines = savedStreetGeoJSON.features; 
        let count = 0;
        
        data.elements.forEach(el => {
            if (el.type === 'node') {
                const p = turf.point([el.lon, el.lat]);
                let minD = Infinity;
                
                streetLines.forEach(l => { 
                    const d = turf.pointToLineDistance(p, l, {units: 'meters'}); 
                    if(d < minD) minD = d; 
                });
                
                if(minD <= 2) {
                    const mk = L.marker([el.lat, el.lon], {
                        icon: L.divIcon({
                            className: 'crossing-icon', 
                            html: '🟢', 
                            iconSize: [20, 20]
                        })
                    });
                    mk.bindPopup("<b>Пішохідний перехід</b>");
                    mk.addTo(crossingLayer);
                    count++;
                }
            }
        });
        
        updateStatus(`Знайдено переходів: ${count}`, 'success');
        
    } catch (error) {
        console.error("Помилка пошуку переходів:", error);
        updateStatus("Помилка пошуку переходів", 'error');
    }
}

// ==================== АВТОДОПОВНЕННЯ ====================

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
            const url = `https://nominatim.openstreetmap.org/search?street=${encodeURIComponent(query)}&city=${encodeURIComponent(city)}&format=json&limit=5&dedupe=1`;
            const response = await fetch(url);
            const data = await response.json();
            
            const uniqueStreets = [...new Set(
                data.map(item => item.name).filter(name => name)
            )];
            
            renderSuggestions(uniqueStreets);
        } catch (error) {
            console.error("Помилка автодоповнення:", error);
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
        });
        suggestionsList.appendChild(li);
    });
    
    suggestionsList.style.display = 'block';
}

document.addEventListener('click', (e) => {
    if (!streetInput.contains(e.target) && !suggestionsList.contains(e.target)) {
        suggestionsList.style.display = 'none';
    }
});

// ==================== EVENT LISTENERS ====================

document.getElementById('streetNamePart').addEventListener('keypress', function(e) { 
    if (e.key === 'Enter') {
        // Викликаємо функцію з анімацією
        handleSearchClick();
        
        // Ховаємо підказки та клавіатуру (на мобільному)
        document.getElementById('suggestionsList').style.display = 'none';
        this.blur();
    }
});


// КРИТИЧНО: Перевіряємо наявність proj4
if (typeof proj4 === 'undefined') {
    console.error("❌ ПОМИЛКА: proj4js не завантажено!");
    console.error("📝 Додайте в HTML перед основним скриптом:");
    console.error('<script src="https://cdnjs.cloudflare.com/ajax/libs/proj4js/2.9.0/proj4.js"></script>');
} else {
    initProj4();

}
